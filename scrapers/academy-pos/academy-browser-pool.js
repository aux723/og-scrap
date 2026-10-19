/**
 * academy-browser-pool.js
 * -----------------------
 * Single-browser, multi-page pool with memory guardrails.
 *
 * DESIGN GOALS
 * ------------
 *   1. Launch Chromium ONCE per scrape session (not once per 6 posts).
 *   2. Hand out reusable Pages from a small bounded pool.
 *   3. Recycle pages after N navigations to avoid DOM/heap bloat.
 *   4. Hard-fail gracefully if memory pressure exceeds Render's 512MB.
 *
 * ALGORITHMS
 * ----------
 *   A. Page Pool (object pool pattern)
 *      - Pre-create `poolSize` Pages on launch.
 *      - acquire() returns a Promise that resolves when a Page is free.
 *      - release() returns the Page; if it has been used `recycleAfter` times,
 *        close it and open a fresh one in its slot (cheap: no browser restart).
 *      - Why: spinning up a Page is ~50ms; spinning up a Browser is ~1.5s and
 *        ~80MB RAM. We pay the Browser cost once, amortize Pages.
 *
 *   B. Adaptive Memory Guard
 *      - Before each acquire(), check `process.memoryUsage().rss`.
 *      - If rss > softLimitMb (default 420MB on Render's 512MB), force GC
 *        (if --expose-gc) and pause briefly. If rss > hardLimitMb (480MB),
 *        trigger an emergency browser restart.
 *      - Why: Render free tier OOM-kills at ~512MB. We must stay under.
 *
 *   C. Page Recycling (cheap GC)
 *      - Each Page tracks navigationCount. After `recycleAfter` (default 12),
 *        we close the Page and open a new one. This sheds detached DOM nodes,
 *        event listeners, and JS heap that puppeteer accumulates.
 *      - Why: a Page that has visited 30 sites can carry 20–40MB of stale
 *        heap; a fresh Page is ~15MB. Recycling is invisible to the caller.
 *
 *   D. Circuit Breaker
 *      - If the browser dies (process crash, SIGKILL), the next acquire()
 *        detects it and re-launches transparently.
 */

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const AdblockerPlugin = require("puppeteer-extra-plugin-adblocker");
puppeteer.use(StealthPlugin());
puppeteer.use(AdblockerPlugin({ blockTrackers: true }));
const UserAgent = require("user-agents");

const DEFAULTS = {
  poolSize: 3,                // 3 concurrent pages — sweet spot for 512MB / 0.1 vCPU
  recycleAfter: 12,           // recycle page after N navigations
  softLimitMb: 420,           // soft RSS threshold
  hardLimitMb: 480,           // hard RSS threshold — triggers browser restart
  navTimeoutMs: 30000,        // per-navigation budget (down from 45s)
  userAgent: null,            // set externally or randomized desktop UA
};

class BrowserPool {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.browser = null;
    this.pages = [];           // active pool
    this.queue = [];           // waiters waiting for a free page
    this.useCount = new WeakMap();
  }

  /**
   * Launch Chromium once with the proxy arg and pre-create the page pool.
   * Detach signal handlers so Render's SIGTERM doesn't kill us mid-scrape.
   */
  async launch(proxy) {
    if (this.browser) await this.close().catch(() => {});

    const args = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--disable-extensions",
      "--disable-default-apps",
      "--no-first-run",
      "--disable-blink-features=AutomationControlled",
      "--js-flags=--max-old-space-size=256",
      "--font-render-hinting=none",
      "--blink-settings=imagesEnabled=false",
    ];
    if (proxy) args.push(`--proxy-server=http://${proxy}`);
    console.log(`🌐 Launching browser (proxy: ${proxy || "direct"})`);

    this.browser = await puppeteer.launch({
      headless: "new",
      args,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      defaultViewport: { width: 1366, height: 768 },
    });

    this.pages = [];
    for (let i = 0; i < this.opts.poolSize; i++) {
      const page = await this._newPage();
      this.pages.push({ page, free: true });
    }
    console.log(`🧪 Browser pool ready with ${this.pages.length} pages`);
  }

  /**
   * Acquire a free page. Resolves immediately if one is available,
   * otherwise queues until another caller releases.
   */
  async acquire() {
    await this._memoryGuard();

    // Circuit breaker: relaunch if browser died
    if (!this.browser || !this.browser.isConnected()) {
      console.log("⚠️ Browser disconnected — relaunching");
      await this.launch(this._lastProxy);
    }

    const free = this.pages.find((p) => p.free);
    if (free) {
      free.free = false;
      return free.page;
    }
    // Wait for one
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  /**
   * Return a page. If it's been used a lot, recycle it transparently.
   */
  async release(page) {
    const slot = this.pages.find((p) => p.page === page);
    if (!slot) {
      // Page was recycled/replaced; just close it
      await page.close().catch(() => {});
      return;
    }

    const count = (this.useCount.get(page) || 0) + 1;
    this.useCount.set(page, count);

    if (count >= this.opts.recycleAfter) {
      // Recycle: close old, open new in same slot
      await page.close().catch(() => {});
      try {
        const fresh = await this._newPage();
        slot.page = fresh;
        slot.free = true;
      } catch (err) {
        console.error(`Recycle failed: ${err.message}`);
        slot.page = null;
        slot.free = true;
      }
    } else {
      slot.free = true;
    }

    // Wake next waiter
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      const waiter = this.pages.find((p) => p.free);
      if (waiter) {
        waiter.free = false;
        next(waiter.page);
      }
    }
  }

  async close() {
    for (const slot of this.pages) {
      if (slot.page) await slot.page.close().catch(() => {});
    }
    this.pages = [];
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
  }

  /* ------------------------------------------------------------------ */
  /* INTERNALS                                                           */
  /* ------------------------------------------------------------------ */

  async _newPage() {
    const page = await this.browser.newPage();
    page.setDefaultNavigationTimeout(this.opts.navTimeoutMs);

    // Block heavy resource types to save bandwidth + memory + CPU
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (type === "image" || type === "stylesheet" || type === "font" ||
          type === "media" || type === "websocket") {
        return req.abort();
      }
      // Third-party trackers/scripts we don't need
      const url = req.url();
      if (/google-analytics|googletagmanager|doubleclick|facebook\.com\/tr|hotjar/.test(url)) {
        return req.abort();
      }
      req.continue();
    });

    // Desktop UA — mobile UA + datacenter IP is a Cloudflare red flag
    const ua = this.opts.userAgent || new UserAgent({ deviceCategory: "desktop" }).toString();
    await page.setUserAgent(ua);
    await page.evaluateOnNewDocument(() => {
      // Mask webdriver flag
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      // Realistic languages
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      // Realistic plugins length
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    });

    return page;
  }

  async _memoryGuard() {
    const rssMb = process.memoryUsage().rss / 1024 / 1024;
    if (rssMb < this.opts.softLimitMb) return;

    if (global.gc) {
      global.gc();
      console.log("🗑️  Forced GC (soft memory limit)");
    }

    const rssAfterMb = process.memoryUsage().rss / 1024 / 1024;
    if (rssAfterMb > this.opts.hardLimitMb) {
      console.log(`🚨 Hard memory limit hit (${rssAfterMb.toFixed(0)}MB) — emergency browser restart`);
      const proxy = this._lastProxy;
      await this.close().catch(() => {});
      await this.launch(proxy);
      if (global.gc) global.gc();
    }
  }
}

module.exports = { BrowserPool };