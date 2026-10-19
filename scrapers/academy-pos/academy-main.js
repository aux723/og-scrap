/**
 * academy-main-optimized.js  (v2 — cheap proxy discovery, rare session rotation)
 * ------------------------------------------------------------------
 * Problem observed in production: ~120 browser-launched probes are needed to
 * find one working proxy, and each probe costs 20-30 s of Chromium time.
 * Rotating the browser session was therefore catastrophically expensive.
 *
 * v2 fixes:
 *   A) LIGHTWEIGHT PROXY PRE-FILTER. Before any Chromium is launched, each
 *      candidate proxy is tested with a raw HTTP CONNECT + TLS handshake and
 *      a minimal HTTPS request to the target (~0.5-6 s, no browser). Tests
 *      run 15-in-parallel, so a 25-proxy batch is cleared in ~6 s worst case.
 *      Only pre-filtered survivors ever trigger a browser launch.
 *   B) PERSISTENT PROXY CACHE (MongoDB). Working proxies are upserted into
 *      a 'proxy-cache' collection and re-validated first at startup and
 *      rotation — so the expensive hunt is paid once and amortized
 *      across runs, restarts and Render redeploys (DB outlives the
 *      ephemeral free-tier filesystem). Falls back to the fresh list
      if the DB is unreachable.
 *   C) SESSION ROTATION IS A LAST RESORT. A Cloudflare challenge on a DETAIL
 *      page just retries in the same browser (new tab + backoff). The session
 *      is only rotated when the LISTING page is challenged or an entire page
 *      of details is overwhelmingly blocked (>= SESSION_CHALLENGE_LIMIT).
 *
 * Core scraping architecture (unchanged from v1, still the speed source):
 *   - ONE browser per session, fixed pool of CONCURRENCY tabs.
 *   - Bounded-concurrency worker pool (semaphore) over post links.
 *   - Tab recycling on error (never browser restarts for hygiene).
 * ------------------------------------------------------------------
 */

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
// Adblocker duplicates what request interception already does (media classes are
// aborted per-tab) and costs 1-2s launch time + ~30-50MB resident memory on a
// 0.1 vCPU / 512MB box. Disable it by setting DISABLE_ADBLOCKER=1 if tight.
if (process.env.DISABLE_ADBLOCKER !== "1") {
  const AdblockerPlugin = require("puppeteer-extra-plugin-adblocker");
  puppeteer.use(AdblockerPlugin({ blockTrackers: true }));
}
const UserAgent = require("user-agents");
const http = require("http");
const tls = require("tls");
const { formatDateForDB } = require("../../utils/dateHelpers.js");
const {
  storePosts,
  checkPostsCount,
  initializeDatabase,
  closeDatabase,
  getCachedProxies,
  recordProxySuccess,
  removeProxyFromCache,
} = require("./academy-db.js");

// ----------------------------- Tuning knobs -----------------------------
const CONCURRENCY = Math.max(2, Math.min(8, Number(process.env.SCRAPE_CONCURRENCY) || 6));
// 6 tabs ~= 300MB Chromium RSS; drop to 4 via SCRAPE_CONCURRENCY=4 if Render OOMs
const MAX_PAGES = 10;
const LINKS_PER_PAGE = 30;
const MAX_RETRIES_PER_POST = 3;      // detail-level retries within same session
const RETRY_BACKOFF_MS = 4000;       // linear backoff base for CF retries
const SESSION_CHALLENGE_LIMIT = 25;  // per listing page before rotating session
const NAV_TIMEOUT = 30000;
const DETAIL_SELECTOR_TIMEOUT = 12000;
const PAGE_POOL_WARMUP_MS = 800;

const PROXY_SOURCE_URL = "https://spys.me/proxy.txt";
const PROXY_PREFILTER_CONCURRENCY = 15;   // parallel lightweight checks
const PROXY_CHECK_TIMEOUT = 6000;         // ms per lightweight check

const TARGET_HOST = "academicpositions.com";
const LISTING_PATH = "/jobs/position/phd?page=1";

// --------------------------- Process state ------------------------------
let lastWorkingProxy = null;
let proxyCursor = 0;
let freshProxies = [];
let session = null;
let challengesThisPage = 0;

function logMemory(label = "") {
  const u = process.memoryUsage();
  const mb = (b) => (b / 1024 / 1024).toFixed(1);
  console.log(
    `🧠 Memory[${label}]: rss=${mb(u.rss)}MB heapUsed=${mb(u.heapUsed)}MB external=${mb(u.external)}MB`
  );
}

// =========================================================================
// A) Lightweight proxy pre-filter  (no browser involved)
// -------------------------------------------------------------------------
// Opens a TCP CONNECT tunnel through the proxy, upgrades it with TLS, and
// sends one minimal HTTPS GET. ~200 ms for dead proxies, <6 s timeout cap.
// This turns a 120 x 25 s Chromium hunt into 120 x ~1 s parallel probes.
// =========================================================================
function checkProxy(proxy) {
  return new Promise((resolve) => {
    const [host, port] = proxy.split(":");
    const done = (ok) => resolve(ok);

    const req = http.request({
      host,
      port: Number(port),
      method: "CONNECT",
      path: `${TARGET_HOST}:443`,
      timeout: PROXY_CHECK_TIMEOUT,
    });

    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return done(false);
      }
      const secure = tls.connect(
        { socket, servername: TARGET_HOST, timeout: PROXY_CHECK_TIMEOUT,
          ALPNProtocols: ["http/1.1"] },
        () => {
          secure.write(
            `GET ${LISTING_PATH} HTTP/1.1\r\nHost: ${TARGET_HOST}\r\n` +
              `User-Agent: Mozilla/5.0\r\nConnection: close\r\n\r\n`
          );
        }
      );
      let settled = false;
      // Any complete HTTP status line proves liveness: with CONNECT, the TLS
      // session is end-to-end with the TARGET, so the proxy cannot forge this
      // response. Cloudflare answers our (deliberately non-browser) probe with
      // a 403 challenge / reset — which still proves the proxy tunnels to the
      // target fine. Requiring "200" here would falsely reject good proxies.
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        secure.destroy();
        done(ok);
      };
      secure.on("data", (d) => finish(/^HTTP\/1\.[01] \d{3}/.test(d.toString())));
      secure.on("error", () => finish(false));
      secure.on("timeout", () => finish(false));
      secure.on("end", () => finish(false));
    });

    req.on("timeout", () => { req.destroy(); done(false); });
    req.on("error", () => done(false));
    req.end();
  });
}

/** Run `fn` over `items` with at most `limit` in flight (semaphore). */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

/** Keep only proxies that tunnel + return HTTP 200 from the target. */
async function prefilterProxies(proxies) {
  if (proxies.length === 0) return [];
  const checks = await mapWithConcurrency(proxies, PROXY_PREFILTER_CONCURRENCY, async (p) => ({
    p,
    ok: await checkProxy(p),
  }));
  return checks.filter((c) => c.ok).map((c) => c.p);
}

// =========================================================================
// B) Persistent proxy cache
// =========================================================================
/**
 * Cached-good proxies that still tunnel right now, most recent first.
 * Backed by MongoDB so the cache survives restarts and redeploys; if the
 * DB is unreachable we simply return [] and fall back to hunting.
 */
async function liveCachedProxies() {
  const entries = await getCachedProxies();
  if (entries.length === 0) return [];
  const checks = await mapWithConcurrency(
    entries.map((e) => e.proxy),
    PROXY_PREFILTER_CONCURRENCY,
    async (p) => ({ p, ok: await checkProxy(p) })
  );
  const live = checks.filter((c) => c.ok).map((c) => c.p);
  if (live.length > 0) console.log(`💾 ${live.length} cached proxy(ies) still alive`);
  return live;
}

async function fetchFreshProxies() {
  console.log(`📡 Fetching proxy list from ${PROXY_SOURCE_URL} ...`);
  try {
    const res = await fetch(PROXY_SOURCE_URL, {
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; proxy-fetcher/1.0)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const list = [];
    for (const line of text.split("\n")) {
      const m = line.trim().match(/^(\d{1,3}(?:\.\d{1,3}){3}:\d{2,5})\b/);
      if (m) list.push(m[1]);
    }
    freshProxies = [...new Set(list)];
    console.log(`✅ Loaded ${freshProxies.length} proxies from list`);
  } catch (err) {
    console.error(`⚠️ Failed to fetch proxy list: ${err.message}`);
    freshProxies = [];
  }
}

// =========================================================================
// Browser session — launched only for PRE-FILTERED candidates
// =========================================================================
const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-accelerated-2d-canvas",
  "--disable-gpu",
  "--disable-web-security",
  "--disable-features=VizDisplayCompositor",
  "--js-flags=--max-old-space-size=256",
];

async function launchBrowser(proxy) {
  const args = [...BROWSER_ARGS];
  if (proxy) args.push(`--proxy-server=http://${proxy}`);
  console.log(`🌐 Launching browser (proxy: ${proxy || "direct"})`);
  return puppeteer.launch({
    headless: true,
    args,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
}

async function configurePage(page) {
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const t = req.resourceType();
    if (t === "image" || t === "stylesheet" || t === "font" || t === "media") req.abort();
    else req.continue();
  });
  const ua = new UserAgent({ deviceCategory: "mobile" });
  await page.setUserAgent(ua.toString());
}

async function isCloudflareChallenge(page) {
  return page.evaluate(() => {
    const title = document.title || "";
    const body = document.body ? document.body.innerText : "";
    return (
      title.includes("Just a moment") ||
      body.includes("Performing security verification") ||
      body.includes("This website uses a security service") ||
      !!document.querySelector("#cf-chl-widget") ||
      !!document.querySelector("[name='cf-turnstile-response']")
    );
  }).catch(() => false);
}

/**
 * Browser-level probe. Only called for proxies that already passed the
 * lightweight HTTP pre-filter, so most launches succeed on the first try.
 */
async function probeCandidate(targetUrl, proxy) {
  let browser;
  try {
    browser = await launchBrowser(proxy);
    const page = await browser.newPage();
    await configurePage(page);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    await new Promise((r) => setTimeout(r, 1500));
    if (await isCloudflareChallenge(page)) {
      console.log(`🚫 Cloudflare challenge (browser probe: ${proxy || "direct"})`);
      await browser.close().catch(() => {});
      return null;
    }
    const ok = await page
      .waitForSelector("h2", { visible: true, timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    await page.close().catch(() => {});
    if (!ok) {
      await browser.close().catch(() => {});
      return null;
    }
    console.log(`✅ Working browser obtained (proxy: ${proxy || "direct"})`);
    return { browser, proxy };
  } catch (err) {
    console.error(`❌ Browser probe failed (${proxy || "direct"}): ${err.message}`);
    if (browser) await browser.close().catch(() => {});
    return null;
  }
}

/**
 * Build a candidate queue: cached-good first, then walk the fresh list in
 * batches, pre-filtering each batch in parallel BEFORE any browser launch.
 */
async function nextCandidateBatch() {
  // 1) Try cached proxies that still tunnel
  const cached = await liveCachedProxies();
  if (cached.length > 0) return { candidates: cached, exhausted: false };

  // 2) Walk fresh list: pre-filter a window, browser-probe survivors
  while (proxyCursor < freshProxies.length) {
    const end = Math.min(proxyCursor + 25, freshProxies.length);
    const batch = freshProxies.slice(proxyCursor, end);
    proxyCursor = end;
    console.log(`🔍 Pre-filtering proxies ${proxyCursor - batch.length}-${proxyCursor - 1}/${freshProxies.length}`);
    const alive = await prefilterProxies(batch);
    console.log(`🔍 ${alive.length}/${batch.length} passed lightweight check`);
    if (alive.length > 0) return { candidates: alive, exhausted: false };
  }

  return { candidates: [], exhausted: true };
}

async function establishSession(targetUrl) {
  if (lastWorkingProxy) {
    // Fast path: re-validate previous proxy cheaply before a browser launch
    if (await checkProxy(lastWorkingProxy)) {
      const s = await probeCandidate(targetUrl, lastWorkingProxy);
      if (s) {
        session = s;
        await recordProxySuccess(lastWorkingProxy);
        return session;
      }
    }
    console.log(`⚠️ Last working proxy ${lastWorkingProxy} no longer tunnels`);
    lastWorkingProxy = null;
  }

  while (true) {
    const { candidates, exhausted } = await nextCandidateBatch();
    for (const proxy of candidates) {
      const s = await probeCandidate(targetUrl, proxy);
      if (s) {
        lastWorkingProxy = proxy;
        session = s;
        await recordProxySuccess(proxy);
        challengesThisPage = 0;
        return session;
      }
    }
    if (exhausted) break;
  }

  console.log("⚠️ All proxy paths exhausted – trying direct connection");
  const direct = await probeCandidate(targetUrl, null);
  if (direct) return (session = direct);
  throw new Error("Could not establish any browser session");
}

async function rotateSession(targetUrl) {
  console.log("🔃 Rotating session (last-resort)...");
  if (session) {
    await session.browser.close().catch(() => {});
    session = null;
  }
  // Deliberately drop the dead proxy from cache
  if (lastWorkingProxy) {
    await removeProxyFromCache(lastWorkingProxy);
    lastWorkingProxy = null;
  }
  await establishSession(targetUrl);
}

// =========================================================================
// Tab pool + bounded-concurrency workers
// =========================================================================
class TabPool {
  constructor(browser, size) {
    this.browser = browser;
    this.size = size;
    this.free = [];
    this.waiters = [];
  }
  async init() {
    for (let i = 0; i < this.size; i++) {
      this.free.push(await this._makeTab());
      await new Promise((r) => setTimeout(r, PAGE_POOL_WARMUP_MS));
    }
    logMemory("tab pool ready");
  }
  async _makeTab() {
    const page = await this.browser.newPage();
    await configurePage(page);
    return page;
  }
  async acquire() {
    if (this.free.length > 0) return this.free.pop();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  release(tab) {
    if (this.waiters.length > 0) this.waiters.shift()(tab);
    else this.free.push(tab);
  }
  async recycle(tab) {
    await tab.close().catch(() => {});
    this.release(await this._makeTab());
  }
  async closeAll() {
    await Promise.allSettled(this.free.map((t) => t.close()));
    this.free = [];
    this.waiters = [];
  }
}

// =========================================================================
// Scraping
// =========================================================================
async function scrapeListingPage(listingUrl, pool) {
  const tab = await pool.acquire();
  try {
    await tab.goto(listingUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    await tab.waitForSelector("h2", { visible: true, timeout: 15000 }).catch(() => {});
    if (await isCloudflareChallenge(tab)) {
      pool.release(tab);
      throw Object.assign(new Error("Cloudflare on listing page"), { code: "CF_LISTING" });
    }
    let links = await tab.evaluate(() => {
      const out = [];
      document
        .querySelectorAll(".list-group-item.text-reset.text-decoration-none > a")
        .forEach((a) => a.href && out.push(a.href));
      return out;
    });
    pool.release(tab);
    if (links.length > LINKS_PER_PAGE) links = links.slice(0, LINKS_PER_PAGE);
    console.log(`Found ${links.length} links on ${listingUrl}`);
    return links;
  } catch (err) {
    if (err.code !== "CF_LISTING") pool.release(tab);
    throw err;
  }
}

async function extractPostDetails(postLink, tab) {
  await tab.goto(postLink, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
  if (await isCloudflareChallenge(tab)) {
    const e = new Error("Cloudflare challenge on detail page");
    e.code = "CF_DETAIL";
    throw e;
  }
  await tab.waitForSelector("#jobDetails", { visible: true, timeout: DETAIL_SELECTOR_TIMEOUT });

  const data = await tab.evaluate(() => {
    const q = (sel) => document.querySelector(sel);
    const grab = (sel) => {
      const el = q(sel);
      return el ? el.textContent.trim() : null;
    };
    const applyBtn = q("#gtm-job-ad-apply-now-bottom-section");
    return {
      post_title: grab("#jobDetails > div > div:nth-child(1) > div.col-auto.col-md-8"),
      institution: grab("#jobDetails > div > div:nth-child(2) > div.col-auto.col-md-8"),
      field: grab("#jobDetails > div > div:nth-child(7) > div.col-auto.col-md-8"),
      application_link: applyBtn ? applyBtn.href : null,
      application_deadline: grab("#jobDetails > div > div:nth-child(5) > div.col-auto.col-md-8"),
    };
  });

  if (!data.post_title || !data.institution) return null;
  return {
    ...data,
    field: data.field || "Unspecified",
    application_deadline: data.application_deadline || "Unspecified",
    postLink,
    insertionDate: formatDateForDB(),
  };
}

/**
 * Detail-page Cloudflare is TRANSIENT: same browser, new tab, backoff, retry.
 * We only escalate when the whole page is drowning in challenges.
 */
async function scrapePostWithRetry(postLink, pool) {
  for (let attempt = 1; attempt <= MAX_RETRIES_PER_POST; attempt++) {
    let tab = null;
    try {
      tab = await pool.acquire();
      const result = await extractPostDetails(postLink, tab);
      pool.release(tab);
      if (result) console.log(`✅ ${result.post_title.slice(0, 60)}`);
      return result;
    } catch (err) {
      if (tab) pool.recycle(tab).catch(() => {});
      if (err.code === "CF_DETAIL") {
        challengesThisPage++;
        console.log(`🚫 CF on detail (attempt ${attempt}/${MAX_RETRIES_PER_POST})`);
        if (challengesThisPage >= SESSION_CHALLENGE_LIMIT) {
          throw Object.assign(new Error("Session overwhelmingly challenged"), {
            code: "CF_SESSION",
          });
        }
      } else {
        console.log(`⚠️ Attempt ${attempt} failed: ${err.message.slice(0, 120)}`);
      }
      if (attempt < MAX_RETRIES_PER_POST) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * attempt));
      }
    }
  }
  console.log(`⏭️ Giving up on ${postLink}`);
  return null;
}

// =========================================================================
// Data cleaning
// =========================================================================
function isValidDeadline(dateString) {
  if (!dateString || dateString === "Unspecified") return true;
  if (!/^\d{4}-\d{2}-\d{2}/.test(dateString)) return true;
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return true;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date >= today;
}

function cleanJobData(jobArray) {
  return jobArray.map((job) => {
    const cleanText = (text) => {
      if (!text || text === "Unspecified") return text;
      return text
        .replace(/\s*\n\s*/g, " ")
        .replace(/,\s*,/g, ",")
        .replace(/\s+/g, " ")
        .replace(/,\s+(and\s+\d+\s+more)/i, ", $1")
        .replace(/\s*,\s*/g, ", ")
        .replace(/,\s*,/g, ",")
        .replace(/,\s+(?![^,]*and\s+\d+\s+more)/g, ", ")
        .trim();
    };
    const cleanDeadline = (deadline) => {
      if (!deadline || deadline === "Unspecified") return deadline;
      const lines = deadline.split("\n").map((l) => l.trim()).filter(Boolean);
      const unique = [];
      for (const line of lines) if (!unique.includes(line)) unique.push(line);
      return unique[0].split(" ")[0] || deadline;
    };
    return {
      ...job,
      field: cleanText(job.field),
      application_deadline: cleanDeadline(job.application_deadline),
    };
  });
}

function filterPosts(posts) {
  return cleanJobData(posts).filter((p) => {
    const ok = isValidDeadline(p.application_deadline) && p.application_deadline !== "Unspecified";
    if (!ok) console.log(`⏭️ Filtered out: ${p.post_title}`);
    return ok;
  });
}

// =========================================================================
// Main orchestrator
// =========================================================================
async function scrapeAllPages(startUrl) {
  const base = startUrl.replace(/page=\d+$/, "page=");
  let pool = null;
  let pageNum = 1;

  try {
    await establishSession(startUrl);
    pool = new TabPool(session.browser, CONCURRENCY);
    await pool.init();

    while (pageNum <= MAX_PAGES) {
      const listingUrl = base + pageNum;
      console.log(`\n📄 Listing page ${pageNum}/${MAX_PAGES}: ${listingUrl}`);
      logMemory(`page ${pageNum} start`);
      challengesThisPage = 0;

      let links;
      try {
        links = await scrapeListingPage(listingUrl, pool);
      } catch (err) {
        if (err.code === "CF_LISTING") {
          await rotateSession(listingUrl);
          pool = new TabPool(session.browser, CONCURRENCY);
          await pool.init();
          continue; // retry this listing page with the new session
        }
        console.error(`Listing page failed: ${err.message}`);
        break;
      }

      if (links.length === 0) {
        console.log("No links found — assuming end of results.");
        break;
      }

      const t0 = Date.now();
      let posts = await mapWithConcurrency(links, CONCURRENCY, (link) =>
        scrapePostWithRetry(link, pool).catch((err) => {
          if (err.code === "CF_SESSION") throw err;
          return null;
        })
      );
      posts = filterPosts(posts.filter(Boolean));
      console.log(
        `✅ Page ${pageNum}: ${posts.length} valid posts in ${((Date.now() - t0) / 1000).toFixed(0)}s ` +
          `(CF challenges this page: ${challengesThisPage})`
      );

      try {
        await checkPostsCount();
        const result = await storePosts(posts);
        if (result?.success && result.inserted) {
          console.log(`💾 Stored ${result.inserted} (dupes: ${result.duplicates})`);
        } else {
          console.log("No new documents inserted:", result?.message);
        }
      } catch (dbErr) {
        console.error("DB error (continuing):", dbErr.message);
      }

      pageNum++;
      if (global.gc) global.gc();
      logMemory(`page ${pageNum - 1} done`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (err) {
    if (err.code === "CF_SESSION") {
      console.error("🚫 Session-level Cloudflare block — aborting run cleanly.");
    } else {
      console.error("scrapeAllPages fatal error:", err.message);
    }
  } finally {
    if (pool) await pool.closeAll().catch(() => {});
    if (session) await session.browser.close().catch(() => {});
    session = null;
    if (global.gc) global.gc();
    logMemory("final cleanup");
  }
}

async function academy() {
  try {
    await fetchFreshProxies();
    proxyCursor = 0;
    await initializeDatabase();
    await scrapeAllPages(`https://${TARGET_HOST}${LISTING_PATH}`);
    await closeDatabase();
    console.log("Academy scraper finished cleanly.");
  } catch (error) {
    console.error("Academy top-level error:", error.message);
    throw error;
  }
}

module.exports = { academy };