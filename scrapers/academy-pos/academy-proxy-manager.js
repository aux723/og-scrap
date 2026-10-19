/**
 * academy-proxy-manager.js
 * ------------------------
 * High-throughput, memory-safe proxy discovery + caching layer.
 *
 * DESIGN GOALS
 * ------------
 *   1. Find a working proxy in SECONDS, not minutes.
 *   2. Survive Render hard-restarts by persisting working proxies in MongoDB.
 *   3. Never launch a browser to test a proxy — use raw TCP CONNECT tunneling.
 *   4. Self-heal: feedback loop promotes good proxies, evicts dead ones.
 *
 * ALGORITHMS
 * ----------
 *   A. Parallel TCP CONNECT Validation (PCV)
 *      - For each candidate proxy, open a raw TCP socket to proxyIp:proxyPort,
 *        send an HTTP CONNECT request for the target HTTPS host, and read the
 *        first response line. A "HTTP/1.x 200" status means the proxy can
 *        tunnel HTTPS — exactly what we need for the target site.
 *      - Why: a Chromium launch costs ~150–300ms CPU + 30–80MB RAM. A TCP
 *        socket costs <1ms CPU and ~2KB RAM. We can test 50 proxies in
 *        parallel for the price of one browser launch.
 *      - Concurrency is bounded (default 25) to respect Render's 0.1 vCPU.
 *
 *   B. Mongo-Backed Proxy Cache (MBPC)
 *      - Collection `academy-proxy-cache` holds documents:
 *          { _id: "ip:port", lastOk: ISODate, ok: N, fail: N, region: "..." }
 *      - TTL index expires entries after 6h (proxies churn fast).
 *      - On startup we read cache first; only if cache is empty or all stale
 *        do we hit spys.me again. This collapses the "120 tries to find one"
 *        scenario into "1 try using a known-good proxy".
 *
 *   C. Weighted Round-Robin Selection
 *      - score(proxy) = ok - 2*fail, decayed by age.
 *      - Working proxies are returned in score order; ties broken by recency.
 *
 *   D. Split-Channel Feedback Loop
 *      Free proxies fail in two qualitatively different ways, and conflating
 *      them produces either false evictions (good proxies burned on noise) or
 *      slow evictions (bad proxies kept too long). We split them:
 *
 *      • Transport failures (timeout, ECONNRESET, ERR_TUNNEL_CONNECTION_FAILED)
 *        — extremely common on free proxies (~5–10% per request). A working
 *          proxy will still hit several of these across 300 detail pages.
 *          Threshold: maxTransportFailures (default 5) before eviction.
 *          Counter is reset to 0 on every reportSuccess() — the proxy has
 *          to fail 5 times IN A ROW to be evicted.
 *
 *      • Cloudflare blocks (challenge page detected, or h2 selector timeout
 *        on a known-good page = silent soft-block)
 *        — Strong signal that the proxy IP is on Cloudflare's reputation
 *          blocklist for this site. Unlikely to recover within this session.
 *          Threshold: maxCloudflareBlocks (default 1) — immediate eviction.
 *
 *      Why split: under a unified "2 failures = evict" rule, a proxy with a
 *      7% per-request transport failure rate would be falsely evicted on ~63%
 *      of healthy proxies within a single 30-link listing page. Splitting
 *      lets transport noise accumulate harmlessly while Cloudflare blocks
 *      trigger instant eviction.
 */

const net = require("net");
const { URL } = require("url");

const PROXY_SOURCE_URL = "https://spys.me/proxy.txt";
const TARGET_HOST = "academicpositions.com";
const TARGET_PORT = 443;

// Tunables — calibrated for Render free tier (0.1 vCPU, 512MB)
const DEFAULTS = {
  connectTimeoutMs: 6000,        // per-proxy TCP+CONNECT test budget
  validateConcurrency: 25,       // parallel socket tests
  minWorkingPool: 3,             // keep at least this many good proxies on hand
  maxCacheAgeMin: 360,           // 6h TTL on cached proxies (matches Mongo TTL)
  maxTransportFailures: 5,       // consecutive transport fails before eviction
  maxCloudflareBlocks: 1,        // Cloudflare blocks before eviction (1 = instant)
  fetchTimeoutMs: 12000,         // spys.me fetch budget
};

class ProxyManager {
  /**
   * @param {object} dbLayer  academy-db instance (must expose getProxyCache / updateProxyCache)
   * @param {object} opts     override DEFAULTS
   */
  constructor(dbLayer, opts = {}) {
    this.db = dbLayer;
    this.opts = { ...DEFAULTS, ...opts };

    // In-memory state. Each entry tracks transport and Cloudflare failures
    // SEPARATELY so the eviction policy can be type-aware.
    //   transportFail: consecutive transport errors (resets on any success)
    //   cloudflareFail: cumulative Cloudflare blocks (does NOT reset — burned IP)
    this.working = [];        // [{ proxy, ok, transportFail, cloudflareFail, lastOk }]
    this.cursor = 0;          // round-robin index into `working`
    this.fresh = [];          // freshly-fetched candidate list (website order)
    this.discovering = null;  // promise guard to prevent concurrent discovery
  }

  /* ------------------------------------------------------------------ */
  /* PUBLIC API                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Called once at startup. Loads cached working proxies from Mongo;
   * if none, kicks off a background discovery.
   */
  async warm() {
    const cached = await this.db.getProxyCache().catch(() => []);
    const now = Date.now();
    const fresh = cached
      .filter((c) => now - c.lastOk.getTime() < this.opts.maxCacheAgeMin * 60_000)
      .map((c) => ({
        proxy: c._id,
        ok: c.ok || 1,
        transportFail: 0,       // start clean — past failures don't predict future
        cloudflareFail: c.cloudflareFail || 0,  // but a burned IP stays burned
        lastOk: c.lastOk,
      }))
      .sort((a, b) => score(b) - score(a));

    this.working = fresh;
    console.log(`🌐 ProxyManager warmed with ${this.working.length} cached proxies`);

    // If cache is thin, top up in the background — non-blocking.
    if (this.working.length < this.opts.minWorkingPool) {
      this.discoverInBackground();
    }
    return this.working.length;
  }

  /**
   * Returns a working proxy. If we have one in `working`, hand it out
   * (round-robin). Otherwise synchronously discover.
   */
  async acquire() {
    if (this.working.length > 0) {
      const p = this.working[this.cursor % this.working.length];
      this.cursor = (this.cursor + 1) % this.working.length;
      return p.proxy;
    }
    await this.discoverInBackground();
    if (this.working.length === 0) return null;
    return this.working[0].proxy;
  }

  /**
   * Positive feedback: a request succeeded through this proxy.
   * Resets the transport-failure streak (transient errors are forgiven)
   * but does NOT reset cloudflareFail — a burned IP is still burned even
   * if it later served one request. Bumps ok + lastOk, persists async.
   */
  reportSuccess(proxy) {
    const entry = this.working.find((w) => w.proxy === proxy);
    if (entry) {
      entry.ok += 1;
      entry.transportFail = 0;   // forgive transport noise on any success
      entry.lastOk = new Date();
    }
    this.db
      .upsertProxyCache(proxy, {
        okInc: 1,
        transportFailReset: true,
        lastOk: new Date(),
      })
      .catch(() => {});
  }

  /**
   * Transport failure feedback (timeout / reset / tunnel / refused).
   * Increment the consecutive-failure streak; evict if it crosses
   * maxTransportFailures. Streak resets to 0 on the next reportSuccess().
   *
   * Use this for: page.goto throwing net::ERR_*, socket errors, navigation
   * timeouts. Do NOT use this for Cloudflare challenge detections — those
   * go to reportCloudflareBlock().
   *
   * IMPORTANT: writes through to DB even if the proxy is no longer in
   * `this.working`. This covers two cases:
   *   1. Race: another worker evicted the proxy between acquire() and
   *      reportFailure(). We still want the DB to know it failed.
   *   2. Stale reference: a worker holds a proxy string across a rotation.
   *      Reporting the failure prevents the next session's warm() from
   *      resurrecting a known-bad IP from a stale DB record.
   */
  reportFailure(proxy) {
    const idx = this.working.findIndex((w) => w.proxy === proxy);
    if (idx === -1) {
      // Proxy already evicted from memory — but make sure DB knows too.
      // We can't track the streak anymore, so just delete the DB record.
      // A re-discovery later will re-add it from scratch if it works again.
      console.log(`📝 Proxy ${proxy} already evicted — cleaning DB record`);
      this.db.removeProxyCache(proxy).catch(() => {});
      return;
    }
    const entry = this.working[idx];
    entry.transportFail = (entry.transportFail || 0) + 1;

    if (entry.transportFail >= this.opts.maxTransportFailures) {
      console.log(
        `🗑️  Evicting ${proxy} after ${entry.transportFail} consecutive transport failures`
      );
      this.working.splice(idx, 1);
      this.db.removeProxyCache(proxy).catch(() => {});
    } else {
      this.db
        .upsertProxyCache(proxy, { transportFailInc: 1 })
        .catch(() => {});
    }
  }

  /**
   * Cloudflare block feedback (challenge page, turnstile widget, or h2
   * selector timeout on a known-good URL = silent soft-block).
   *
   * This is a STRONG signal that the proxy IP is on Cloudflare's reputation
   * blocklist for the target site. Default policy: evict immediately
   * (maxCloudflareBlocks = 1). A burned IP almost never recovers within
   * the same scrape session, so retrying it just wastes time.
   *
   * The cloudflareFail counter is CUMULATIVE (does not reset on success)
   * because IP reputation doesn't reset on a single successful request.
   *
   * IMPORTANT: writes through to DB even if the proxy is no longer in
   * `this.working` — same reasoning as reportFailure(). A stale "good"
   * DB record for a Cloudflare-burned IP would be resurrected on the next
   * session's warm() and immediately re-blocked. Better to delete it now.
   */
  reportCloudflareBlock(proxy) {
    const idx = this.working.findIndex((w) => w.proxy === proxy);
    if (idx === -1) {
      console.log(`📝 Proxy ${proxy} already evicted — cleaning DB record`);
      this.db.removeProxyCache(proxy).catch(() => {});
      return true;   // treat as evicted — caller should rotate
    }
    const entry = this.working[idx];
    entry.cloudflareFail = (entry.cloudflareFail || 0) + 1;

    if (entry.cloudflareFail >= this.opts.maxCloudflareBlocks) {
      console.log(
        `🚫 Evicting ${proxy} — Cloudflare block (IP burned for target site)`
      );
      this.working.splice(idx, 1);
      this.db.removeProxyCache(proxy).catch(() => {});
      return true;
    }
    this.db
      .upsertProxyCache(proxy, { cloudflareFailInc: 1 })
      .catch(() => {});
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* DISCOVERY                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Background-safe discovery. Uses a promise guard so multiple concurrent
   * callers share the same discovery round.
   */
  async discoverInBackground() {
    if (this.discovering) return this.discovering;
    this.discovering = (async () => {
      try {
        if (this.fresh.length === 0) {
          this.fresh = await fetchFreshProxies(this.opts.fetchTimeoutMs);
        }
        const needed = Math.max(this.opts.minWorkingPool - this.working.length, 5);
        const candidates = this.fresh.splice(0, needed * 4); // 4x oversample
        const verified = await validateBatch(
          candidates,
          this.opts.validateConcurrency,
          this.opts.connectTimeoutMs
        );
        for (const proxy of verified) {
          if (!this.working.find((w) => w.proxy === proxy)) {
            this.working.push({
              proxy,
              ok: 1,
              transportFail: 0,
              cloudflareFail: 0,
              lastOk: new Date(),
            });
            this.db
              .upsertProxyCache(proxy, {
                okInc: 1,
                lastOk: new Date(),
                cloudflareFailInit: 0,
              })
              .catch(() => {});
          }
        }
        console.log(`🌐 Discovery round: ${verified.length} new working proxies (total ${this.working.length})`);
      } catch (err) {
        console.error(`⚠️ Proxy discovery error: ${err.message}`);
      } finally {
        this.discovering = null;
      }
    })();
    return this.discovering;
  }
}

/* ------------------------------------------------------------------ */
/* HELPERS                                                              */
/* ------------------------------------------------------------------ */

function score(p) {
  const ageMin = (Date.now() - (p.lastOk?.getTime() || 0)) / 60_000;
  const ageDecay = Math.max(0, 1 - ageMin / 360); // 6h half-life-ish
  // Cloudflare-blocked IPs are heavily penalized but not auto-zeroed —
  // they may still be useful for OTHER sites in a multi-target scraper.
  const cloudflarePenalty = (p.cloudflareFail || 0) * 50;
  // Transport noise is mildly penalized; the streak resets on any success.
  const transportPenalty = (p.transportFail || 0) * 2;
  return (p.ok - transportPenalty - cloudflarePenalty) * ageDecay;
}

/**
 * Fetch the spys.me list, return deduped "ip:port" strings in website order.
 */
async function fetchFreshProxies(timeoutMs) {
  console.log(`📡 Fetching proxies from ${PROXY_SOURCE_URL}`);
  const res = await fetch(PROXY_SOURCE_URL, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": "Mozilla/5.0 (compatible; proxy-fetcher/2.0)" },
  });
  if (!res.ok) throw new Error(`proxy source HTTP ${res.status}`);
  const text = await res.text();
  const list = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\d{1,3}(?:\.\d{1,3}){3}:\d{2,5})\b/);
    if (m) list.push(m[1]);
  }
  const unique = [...new Set(list)];
  console.log(`✅ Fetched ${unique.length} candidate proxies`);
  return unique;
}

/**
 * Validate a batch of proxies in parallel by issuing a raw TCP CONNECT
 * to the target HTTPS host. Returns the subset that answered 200.
 *
 * Why CONNECT and not HTTP GET?
 *   - The target site is HTTPS. HTTP proxies forward HTTPS via CONNECT.
 *   - A 200 response to CONNECT proves the proxy can tunnel to our target.
 *   - It's protocol-accurate: if CONNECT works, puppeteer's `--proxy-server`
 *     will work too.
 */
async function validateBatch(proxies, concurrency, timeoutMs) {
  const ok = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, proxies.length) }, async () => {
    while (idx < proxies.length) {
      const proxy = proxies[idx++];
      const good = await testConnect(proxy, timeoutMs);
      if (good) ok.push(proxy);
    }
  });
  await Promise.all(workers);
  return ok;
}

/**
 * Raw socket CONNECT test. Resolves true if proxy returns "HTTP/1.x 200".
 */
function testConnect(proxy, timeoutMs) {
  return new Promise((resolve) => {
    const [host, portStr] = proxy.split(":");
    const port = +portStr;
    if (!host || !port) return resolve(false);

    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      clearTimeout(timer);
      resolve(val);
    };

    const timer = setTimeout(() => done(false), timeoutMs);

    const socket = net.connect({ host, port, timeout: timeoutMs });
    socket.on("connect", () => {
      // Send CONNECT for the target HTTPS host
      socket.write(
        `CONNECT ${TARGET_HOST}:${TARGET_PORT} HTTP/1.1\r\n` +
        `Host: ${TARGET_HOST}:${TARGET_PORT}\r\n` +
        `User-Agent: Mozilla/5.0\r\n` +
        `\r\n`
      );
    });
    socket.on("data", (buf) => {
      const head = buf.toString("ascii", 0, Math.min(buf.length, 64));
      // First status line tells us if tunnel was established
      if (/HTTP\/1\.[01] 2\d\d/.test(head)) {
        done(true);
      } else {
        done(false);
      }
    });
    socket.on("error", () => done(false));
    socket.on("timeout", () => done(false));
  });
}

module.exports = { ProxyManager, fetchFreshProxies, validateBatch };
