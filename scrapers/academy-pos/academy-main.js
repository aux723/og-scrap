const fs = require("fs");
const http = require("http");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const AdblockerPlugin = require("puppeteer-extra-plugin-adblocker");
puppeteer.use(AdblockerPlugin({ blockTrackers: true }));
const UserAgent = require("user-agents");
const { formatDateForDB } = require("../../utils/dateHelpers.js");
const {
  storePosts,
  checkPostsCount,
  initializeDatabase,
  closeDatabase,
  getProxyBatchIndex,
  saveProxyBatchIndex,
} = require("./academy-db.js");

// -------------------------------------------------------
// Config
// -------------------------------------------------------
const PROXY_SOURCE_URL = "https://maximilianfeix.github.io/proxy-scraper/http.txt";
const TARGET_HOST = "academicpositions.com";

const BATCH_SIZE = 25;                    // proxies pre-checked per round
const PRECHECK_CONCURRENCY = 8;           // parallel lightweight tunnel checks
const PRECHECK_TIMEOUT_MS = 8000;         // per-proxy tunnel check timeout
const MAX_BROWSER_ATTEMPTS = 15;          // max Chromium launches per proxy search
const PAGE_RESTART_EVERY_POSTS = 10;      // fresh tab (same browser) after this many posts
const BROWSER_RESTART_EVERY_PAGES = 2;    // fresh Chromium after this many listing pages
const LINKS_PER_PAGE = 20;                // max job links per listing page
const COOLDOWN_MS = 2000;                 // pause between failed proxy attempts
const PROXY_MAX_TRIALS = 2;               // a proxy that fails this many times in a row is discarded
const MAX_BLOCK_RETRIES = 3;              // retries allowed for ONE post hit by Cloudflare
const NAV_TIMEOUT_MS = 45000;
const POST_HARD_TIMEOUT_MS = 90000;       // absolute cap for one detail page
const MEMORY_LIMIT_MB = Number(process.env.ACADEMY_MEMORY_LIMIT_MB) || 430;   // Render free = 512MB
const MAX_RUN_MS = Number(process.env.ACADEMY_MAX_RUN_MS) || 30 * 60 * 1000;  // overall run budget

// Per-run state (reset at the start of every academy() call). Nothing here is stored in MongoDB
// except the batch index that last produced a working proxy.
let lastWorkingProxy = null;   // proxy currently in use
let allProxies = [];           // full list from the source (source order)
let runDeadProxies = new Set();// proxies rejected/discarded during this run
const proxyStrikes = new Map();// proxy -> consecutive failed trials (in memory)
let runDeadline = 0;
let searchBatch = 0;           // batch where the next proxy search starts
let persistedBatch = null;     // batch index currently stored in MongoDB

// -------------------------------------------------------
// Small utilities
// -------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, label = "operation") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length).fill(false);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (_) {
        results[i] = false;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function assertTimeLeft() {
  if (Date.now() > runDeadline) throw new Error("Run time budget exhausted");
}

function logMemory(label = "") {
  const used = process.memoryUsage();
  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);
  console.log(
    `🧠 Memory${label ? " [" + label + "]" : ""}: ` +
    `node rss=${mb(used.rss)}MB  heapUsed=${mb(used.heapUsed)}MB  ` +
    `container≈${containerMemoryMB().toFixed(0)}MB`
  );
}

/**
 * Whole-container memory (Node + Chromium children), via cgroups.
 * process.memoryUsage() alone cannot see Chromium, which is what actually kills the instance.
 * Falls back to Node's rss if cgroup files aren't readable.
 */
function containerMemoryMB() {
  const read = (p) => fs.readFileSync(p, "utf8");
  try { // cgroup v2
    const current = Number(read("/sys/fs/cgroup/memory.current"));
    let inactive = 0;
    try {
      const m = read("/sys/fs/cgroup/memory.stat").match(/^inactive_file (\d+)/m);
      if (m) inactive = Number(m[1]);
    } catch (_) {}
    if (Number.isFinite(current)) return (current - inactive) / 1048576;
  } catch (_) {}
  try { // cgroup v1
    const current = Number(read("/sys/fs/cgroup/memory/memory.usage_in_bytes"));
    let inactive = 0;
    try {
      const m = read("/sys/fs/cgroup/memory/memory.stat").match(/^total_inactive_file (\d+)/m);
      if (m) inactive = Number(m[1]);
    } catch (_) {}
    if (Number.isFinite(current)) return (current - inactive) / 1048576;
  } catch (_) {}
  return process.memoryUsage().rss / 1048576;
}

/**
 * Stop stray async errors (e.g. puppeteer "Target closed" firing after a page died)
 * from killing the whole process. Only installed if the host app has not set its own.
 */
function installProcessGuards() {
  if (process.listenerCount("unhandledRejection") === 0) {
    process.on("unhandledRejection", (reason) => {
      console.error("⚠️ Unhandled rejection (ignored):", reason && reason.message ? reason.message : reason);
    });
  }
  if (process.listenerCount("uncaughtException") === 0) {
    process.on("uncaughtException", (err) => {
      console.error("⚠️ Uncaught exception (ignored):", err && err.message ? err.message : err);
    });
  }
}

// -------------------------------------------------------
// Proxy list (source: maximilianfeix proxy-scraper, plain "ip:port" per line)
// -------------------------------------------------------
function parseProxyList(text) {
  const seen = new Set();
  const list = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.trim().match(/^(?:https?:\/\/)?(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})$/);
    if (!m) continue;
    const octetsOk = m[1].split(".").every((o) => Number(o) <= 255);
    const port = Number(m[2]);
    if (!octetsOk || port < 1 || port > 65535) continue;
    const proxy = `${m[1]}:${port}`;
    if (!seen.has(proxy)) {
      seen.add(proxy);
      list.push(proxy); // keep source order
    }
  }
  return list;
}

async function fetchFreshProxies() {
  console.log(`📡 Fetching fresh proxies from ${PROXY_SOURCE_URL} ...`);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(PROXY_SOURCE_URL, {
        signal: AbortSignal.timeout(15000),
        headers: { "User-Agent": "Mozilla/5.0 (compatible; proxy-fetcher/1.0)" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = parseProxyList(await res.text());
      console.log(`✅ Loaded ${list.length} proxies (source order)`);
      return list;
    } catch (err) {
      console.error(`⚠️ Proxy fetch attempt ${attempt}/2 failed: ${err.message}`);
      if (attempt < 2) await sleep(2000);
    }
  }
  return [];
}

/**
 * Cheap pre-check: can this proxy open an HTTPS tunnel to the target?
 * Costs a few KB instead of a full Chromium launch (~150MB+).
 */
function checkProxyTunnel(proxy, timeoutMs = PRECHECK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const [host, port] = proxy.split(":");
    let settled = false;
    let req;
    let timer;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { req && req.destroy(); } catch (_) {}
      resolve(ok);
    };

    try {
      req = http.request({
        host,
        port: Number(port),
        method: "CONNECT",
        path: `${TARGET_HOST}:443`,
        headers: { Host: `${TARGET_HOST}:443` },
      });
      timer = setTimeout(() => finish(false), timeoutMs);
      req.on("connect", (res, socket) => {
        socket.on("error", () => {});
        socket.destroy();
        finish(res.statusCode === 200);
      });
      req.on("error", () => finish(false));
      req.end();
    } catch (_) {
      finish(false);
    }
  });
}

// -------------------------------------------------------
// Proxy state helpers (memory + DB kept in sync)
// -------------------------------------------------------
function batchCount() {
  return Math.ceil(allProxies.length / BATCH_SIZE);
}

/** Start from the stored batch index (clamped to the current list size), else the first batch. */
function resolveStartBatch(storedBatchIndex) {
  if (allProxies.length === 0) return 0;
  if (Number.isInteger(storedBatchIndex)) return Math.min(Math.max(storedBatchIndex, 0), batchCount() - 1);
  return 0;
}

/** A working proxy was found in `batchIndex`: remember it and store the batch index in MongoDB. */
async function rememberWorkingProxy(proxy, batchIndex) {
  lastWorkingProxy = proxy;
  proxyStrikes.delete(proxy);
  searchBatch = batchIndex;
  if (persistedBatch !== batchIndex) {
    const saved = await saveProxyBatchIndex(batchIndex, { batchSize: BATCH_SIZE });
    if (saved) persistedBatch = batchIndex;
  }
}

/**
 * A trial with this proxy failed. After PROXY_MAX_TRIALS failures in a row the proxy is discarded
 * and the next search starts from the same batch (searchBatch is left untouched).
 * Returns true if the proxy was discarded.
 */
function recordProxyFailure(proxy, reason) {
  if (!proxy) return false;
  const strikes = (proxyStrikes.get(proxy) || 0) + 1;
  proxyStrikes.set(proxy, strikes);

  if (strikes >= PROXY_MAX_TRIALS) {
    runDeadProxies.add(proxy);
    if (lastWorkingProxy === proxy) lastWorkingProxy = null;
    console.log(`🗑️ Proxy ${proxy} discarded after ${strikes} failed trials (${reason})`);
    return true;
  }
  console.log(`⚠️ Proxy ${proxy} trial ${strikes}/${PROXY_MAX_TRIALS} failed (${reason})`);
  return false;
}

/** The proxy scraped a post successfully – it starts again with a clean slate. */
function clearProxyStrikes(proxy) {
  if (proxy) proxyStrikes.delete(proxy);
}

// -------------------------------------------------------
// Page / data helpers
// -------------------------------------------------------
function isCloudflareChallenge(page) {
  return page.evaluate(() => {
    const title = document.title || "";
    const body = document.body ? document.body.innerText : "";
    return (
      title.includes("Just a moment") ||
      body.includes("Performing security verification") ||
      body.includes("This website uses a security service to protect against malicious bots") ||
      !!document.querySelector("#cf-chl-widget") ||
      !!document.querySelector("[name='cf-turnstile-response']")
    );
  }).catch(() => false);
}

function isValidDeadline(dateString) {
  if (!dateString || dateString === "Unspecified") return true;
  const isoPattern = /^\d{4}-\d{2}-\d{2}/;
  if (!isoPattern.test(dateString)) return true;
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return true;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date >= today;
}

function filterExpiredDeadlines(jobArray) {
  return jobArray.filter((job) => {
    const isValid = isValidDeadline(job.application_deadline);
    if (!isValid) {
      console.log(`⏭️ SKIPPING: Deadline "${job.application_deadline}" is expired - ${job.post_title}`);
    }
    return isValid;
  });
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
      const lines = deadline.split("\n").map((l) => l.trim()).filter((l) => l && l.length > 0);
      const uniqueLines = [];
      for (const line of lines) {
        if (!uniqueLines.includes(line)) uniqueLines.push(line);
      }
      return (uniqueLines[0] || deadline).split(" ")[0] || deadline;
    };

    return {
      ...job,
      field: cleanText(job.field),
      application_deadline: cleanDeadline(job.application_deadline),
    };
  });
}

/**
 * Returns { status, data }
 *   status: "ok" | "empty" (page loaded but fields missing) | "blocked" | "error"
 * "blocked" and "error" count towards the proxy-failure streak; "empty" does not.
 */
async function extractPostDetails(postLink, page) {
  try {
    console.log(`post link: ${postLink}`);

    await page.goto(postLink, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });

    if (await isCloudflareChallenge(page)) {
      console.log("🚫 Cloudflare challenge on detail page – skipping this post");
      return { status: "blocked", data: null };
    }

    await page.waitForSelector("#jobDetails", { visible: true, timeout: 15000 });

    // One round-trip instead of five
    const raw = await page.evaluate(() => {
      const text = (sel) => {
        const el = document.querySelector(sel);
        return el ? el.textContent : null;
      };
      const applyEl = document.querySelector("#gtm-job-ad-apply-now-bottom-section");
      return {
        title: text("#jobDetails > div > div:nth-child(1) > div.col-auto.col-md-8"),
        institution: text("#jobDetails > div > div:nth-child(2) > div.col-auto.col-md-8"),
        field: text("#jobDetails > div > div:nth-child(7) > div.col-auto.col-md-8"),
        deadline: text("#jobDetails > div > div:nth-child(5) > div.col-auto.col-md-8"),
        applyLink: applyEl ? applyEl.href : null,
      };
    });

    if (!raw.title || !raw.institution) {
      console.log("⚠️ Missing title or institution – skipping");
      return { status: "empty", data: null };
    }

    return {
      status: "ok",
      data: {
        post_title: raw.title.trim(),
        institution: raw.institution.trim(),
        field: raw.field ? raw.field.trim() : "Unspecified",
        application_link: raw.applyLink,
        application_deadline: raw.deadline ? raw.deadline.trim() : "Unspecified",
        postLink,
        insertionDate: formatDateForDB(),
      },
    };
  } catch (error) {
    console.error(`extractPostDetails error: ${error.message}`);
    return { status: "error", data: null };
  }
}

// -------------------------------------------------------
// Browser management
// -------------------------------------------------------
async function launchBrowserWithProxy(proxy = null) {
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-accelerated-2d-canvas",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--disable-web-security",
    "--disable-features=VizDisplayCompositor",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-default-apps",
    "--no-first-run",
    "--mute-audio",
    "--no-zygote",
    "--js-flags=--max-old-space-size=256",
  ];

  if (proxy) {
    args.push(`--proxy-server=http://${proxy}`);
    console.log(`🌐 Using proxy: ${proxy}`);
  } else {
    console.log("🌐 No proxy (direct connection)");
  }

  const browser = await puppeteer.launch({
    headless: true,
    args,
    timeout: 45000,           // launch timeout
    protocolTimeout: 60000,   // any single CDP call (evaluate etc.) can't hang forever
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });

  browser.on("disconnected", () => console.log("⚠️ Browser disconnected"));
  return browser;
}

/** Close a browser without ever throwing or hanging; SIGKILL if it won't close. */
async function safeCloseBrowser(browser) {
  if (!browser) return;
  const proc = typeof browser.process === "function" ? browser.process() : null;
  try {
    await withTimeout(browser.close(), 8000, "browser.close");
  } catch (_) {
    try { if (proc) proc.kill("SIGKILL"); } catch (__) {}
  }
}

async function safeClosePage(page) {
  if (!page) return;
  try { await withTimeout(page.close(), 5000, "page.close"); } catch (_) {}
}

async function configurePage(page) {
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);   // (was 0 = wait forever)
  page.setDefaultTimeout(30000);

  page.on("error", (err) => console.error("⚠️ Page crashed:", err && err.message));

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    try {
      if (req.isInterceptResolutionHandled && req.isInterceptResolutionHandled()) return;
      if (["image", "stylesheet", "font", "media"].includes(req.resourceType())) {
        req.abort().catch(() => {});
      } else {
        req.continue().catch(() => {});
      }
    } catch (_) { /* request already handled / page closed */ }
  });

  const userAgent = new UserAgent({ deviceCategory: "mobile" });
  await page.setUserAgent(userAgent.toString());
}

/**
 * Navigate to a listing URL and confirm it is the real page (no Cloudflare, no soft block).
 * Throws on navigation errors; returns false on a block.
 */
async function gotoAndVerify(page, url, label) {
  console.log(`📄 Navigating to: ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await sleep(3500);

  if (await isCloudflareChallenge(page)) {
    console.log(`🚫 Cloudflare challenge (${label})`);
    return false;
  }
  try {
    await page.waitForSelector("h2", { visible: true, timeout: 12000 });
  } catch (_) {
    console.log(`⚠️ h2 not found (${label}) – soft block`);
    return false;
  }
  return true;
}

/**
 * Try one proxy end-to-end in Chromium. Returns {browser, page, proxy} or null.
 * Always cleans up after itself on failure.
 */
async function tryOneProxy(targetUrl, proxy) {
  let browser = null;
  let ok = false;

  try {
    browser = await launchBrowserWithProxy(proxy);
    const page = await browser.newPage();
    await configurePage(page);

    if (!(await gotoAndVerify(page, targetUrl, proxy || "direct"))) return null;

    console.log(`✅ Browser ready (proxy: ${proxy || "direct"})`);
    ok = true;
    return { browser, page, proxy };
  } catch (err) {
    console.error(`❌ Failed with proxy ${proxy || "direct"}: ${err.message}`);
    return null;
  } finally {
    if (!ok) await safeCloseBrowser(browser);
  }
}

/**
 * Search the proxy list batch by batch, STARTING from the batch that produced the last working
 * proxy (searchBatch, persisted in MongoDB), moving forward and wrapping around to earlier batches.
 * For each batch:
 *   1. cheap tunnel pre-check (parallel, no Chromium)
 *   2. Chromium only for proxies that passed
 */
async function discoverWorkingBrowser(targetUrl) {
  const total = batchCount();
  let browserAttempts = 0;

  for (let step = 0; step < total; step++) {
    assertTimeLeft();

    const batchIndex = (searchBatch + step) % total;
    const start = batchIndex * BATCH_SIZE;
    const batch = allProxies.slice(start, start + BATCH_SIZE).filter((p) => !runDeadProxies.has(p));
    if (batch.length === 0) continue;

    console.log(
      `\n📦 Batch ${batchIndex + 1}/${total} (list indices ${start}-${Math.min(start + BATCH_SIZE, allProxies.length) - 1})` +
      `${step === 0 ? " – batch of the last working proxy" : ""}: pre-checking ${batch.length} proxies`
    );
    const checks = await mapLimit(batch, PRECHECK_CONCURRENCY, (p) => checkProxyTunnel(p));

    const deadNow = batch.filter((_, i) => !checks[i]);
    const alive = batch.filter((_, i) => checks[i]);
    deadNow.forEach((p) => runDeadProxies.add(p));
    console.log(`🔎 ${alive.length} passed tunnel check, ${deadNow.length} rejected`);

    for (const proxy of alive) {
      assertTimeLeft();
      if (browserAttempts >= MAX_BROWSER_ATTEMPTS) {
        throw new Error(`Gave up after ${MAX_BROWSER_ATTEMPTS} browser attempts`);
      }
      browserAttempts++;

      const result = await tryOneProxy(targetUrl, proxy);
      if (result) {
        await rememberWorkingProxy(proxy, batchIndex); // stores the batch index in MongoDB
        console.log(`🎉 Found working proxy: ${proxy} (batch ${batchIndex + 1}/${total})`);
        return result;
      }

      runDeadProxies.add(proxy);
      await sleep(COOLDOWN_MS);
    }
  }

  console.log("⚠️ Proxy list exhausted. Trying direct connection...");
  const direct = await tryOneProxy(targetUrl, null);
  if (direct) {
    lastWorkingProxy = null;
    return direct;
  }

  throw new Error("Could not obtain a working browser/page after trying all proxies");
}

/**
 * Re-use the current working proxy while it still has trials left; once it is discarded
 * (2 failed trials) search for a new one from the batch the old one came from.
 */
async function createWorkingBrowserAndPage(targetUrl) {
  assertTimeLeft();

  while (lastWorkingProxy) {
    const proxy = lastWorkingProxy;
    console.log(`🔁 Reusing working proxy: ${proxy}`);
    const result = await tryOneProxy(targetUrl, proxy);
    if (result) return result;

    recordProxyFailure(proxy, "failed health check"); // 2nd failure discards it and ends this loop
    await sleep(COOLDOWN_MS);
    assertTimeLeft();
  }

  return discoverWorkingBrowser(targetUrl);
}

// -------------------------------------------------------
// Scraping
// -------------------------------------------------------
async function scrapeAllPages(startUrl, maxPages = 10) {
  let browser = null;
  let page = null;
  let postsSincePageRestart = 0;     // -> fresh tab every PAGE_RESTART_EVERY_POSTS posts
  let postsSinceBrowserRestart = 0;  // only used as a guard for the memory check
  let pagesSinceBrowserRestart = 0;  // -> fresh Chromium every BROWSER_RESTART_EVERY_PAGES listing pages
  let browserTainted = false;        // current proxy was discarded -> browser must be replaced

  const closeSession = async () => {
    await safeClosePage(page);
    await safeCloseBrowser(browser);
    page = null;
    browser = null;
  };

  const openSession = async (url) => {
    const result = await createWorkingBrowserAndPage(url);
    browser = result.browser;
    page = result.page;
    postsSincePageRestart = 0;
    postsSinceBrowserRestart = 0;
    pagesSinceBrowserRestart = 0;
    browserTainted = false;
  };

  /** Close the browser and open a fresh one (new proxy search if the old proxy was discarded). */
  const restartSession = async (reason, url) => {
    console.log(`♻️ ${reason}`);
    await closeSession();
    if (global.gc) global.gc();
    await sleep(3000);
    try {
      await openSession(url);
      logMemory("after browser restart");
      return true;
    } catch (err) {
      console.error(`🚫 Could not open a browser: ${err.message}`);
      return false;
    }
  };

  /** Fresh tab in the SAME browser (cheap). New tab is opened first so the browser never has 0 tabs. */
  const restartPage = async () => {
    const fresh = await browser.newPage();
    await configurePage(fresh);
    const old = page;
    page = fresh;
    await safeClosePage(old);
    postsSincePageRestart = 0;
  };

  /** Page restart; if even that fails, fall back to a full browser restart. */
  const refreshPage = async (url) => {
    try {
      await restartPage();
      return true;
    } catch (err) {
      console.error(`Could not restart page: ${err.message}`);
      return restartSession("Page restart failed – restarting browser", url);
    }
  };

  /** Get a verified listing page: reuse the browser unless it is due for a restart. */
  const ensureListingPage = async (url) => {
    if (!browser) {
      try {
        await openSession(url);
        return true;
      } catch (err) {
        console.error(`🚫 Could not open a browser: ${err.message}`);
        return false;
      }
    }

    if (!browser.isConnected() || browserTainted || pagesSinceBrowserRestart >= BROWSER_RESTART_EVERY_PAGES) {
      const reason = !browser.isConnected()
        ? "Browser disconnected – restarting"
        : browserTainted
          ? "Proxy discarded – restarting browser"
          : `Restarting browser after ${pagesSinceBrowserRestart} listing pages`;
      return restartSession(reason, url);
    }

    // Same browser, new tab
    try {
      await restartPage();
      if (await gotoAndVerify(page, url, lastWorkingProxy || "direct")) return true;
      recordProxyFailure(lastWorkingProxy, "listing page blocked");
    } catch (err) {
      console.error(`Listing navigation failed: ${err.message}`);
      recordProxyFailure(lastWorkingProxy, "listing navigation error");
    }
    return restartSession("Listing page failed – restarting browser", url);
  };

  try {
    let currentUrl = startUrl;
    let pageNum = 1;
    const stockLink = "https://academicpositions.com/jobs/position/phd?page=";

    while (pageNum <= maxPages) {
      if (Date.now() > runDeadline) {
        console.log("⏱️ Run time budget reached – stopping before next page");
        break;
      }

      console.log(`\n📄 Scraping page ${pageNum}`);
      logMemory(`start page ${pageNum}`);

      if (!(await ensureListingPage(currentUrl))) {
        console.error(`🚫 Failed to get a working page for listing ${pageNum}`);
        break;
      }

      let links = await page.evaluate(() => {
        const els = document.querySelectorAll(".list-group-item.text-reset.text-decoration-none > a");
        const out = [];
        els.forEach((a) => { if (a.href) out.push(a.href); });
        return out;
      }).catch(() => []);

      if (links.length > LINKS_PER_PAGE) {
        console.log(`Found ${links.length} job links – limiting to first ${LINKS_PER_PAGE}`);
        links = links.slice(0, LINKS_PER_PAGE);
      } else {
        console.log(`Found ${links.length} job links on page ${pageNum}`);
      }

      if (links.length === 0) {
        const debug = await page.evaluate(() => ({
          title: document.title,
          url: location.href,
          bodyText: document.body ? document.body.innerText.slice(0, 500) : "",
          listItems: document.querySelectorAll(".list-group-item").length,
        })).catch(() => ({}));
        console.log("DEBUG (empty links):", JSON.stringify(debug, null, 2));

        // An empty listing through a proxy is a soft-block signal: counts as a failed trial
        if (recordProxyFailure(lastWorkingProxy, "empty listing page")) browserTainted = true;
      }

      let postsDetailsArr = [];

      for (let i = 0; i < links.length; i++) {
        if (Date.now() > runDeadline) {
          console.log("⏱️ Run time budget reached – saving what we have");
          break;
        }

        console.log(`\n📌 Processing post ${i + 1}/${links.length}`);

        // Browser restart: dead browser, discarded proxy, or memory pressure
        const memMB = containerMemoryMB();
        const memoryPressure = postsSinceBrowserRestart >= 2 && memMB > MEMORY_LIMIT_MB;

        if (!browser || !browser.isConnected() || browserTainted || memoryPressure) {
          const reason = memoryPressure
            ? `Memory pressure (${memMB.toFixed(0)}MB > ${MEMORY_LIMIT_MB}MB) – restarting browser`
            : browserTainted
              ? "Proxy discarded – restarting browser with a new proxy"
              : "Browser not available – restarting";
          if (!(await restartSession(reason, currentUrl))) break; // keep what we already collected
        } else if (postsSincePageRestart >= PAGE_RESTART_EVERY_POSTS) {
          // Routine maintenance: only the tab, not the whole browser
          console.log(`🔄 Restarting page after ${postsSincePageRestart} posts`);
          if (!(await refreshPage(currentUrl))) break;
        }

        // Scrape this post. If Cloudflare challenges it, that counts as a failed trial for the
        // proxy; we retry the SAME post (the same proxy gets one more trial, then a new proxy
        // is searched from the same batch) up to MAX_BLOCK_RETRIES times.
        let outcome;
        let blockRetries = 0;
        let sessionLost = false;

        while (true) {
          try {
            outcome = await withTimeout(
              extractPostDetails(links[i], page),
              POST_HARD_TIMEOUT_MS,
              "extractPostDetails"
            );
          } catch (err) {
            console.error(`❌ Unexpected error on post ${i + 1}: ${err.message}`);
            outcome = { status: "error", data: null };
          }

          if (outcome.status === "blocked" && blockRetries < MAX_BLOCK_RETRIES) {
            blockRetries++;
            console.log(`🚫 Cloudflare on detail page – retrying post ${i + 1} (${blockRetries}/${MAX_BLOCK_RETRIES})`);
            recordProxyFailure(lastWorkingProxy, "cloudflare challenge on detail page");
            if (!(await restartSession("Restarting browser to retry the blocked post", currentUrl))) {
              sessionLost = true;
              break;
            }
            continue; // same link again
          }
          break;
        }

        if (sessionLost) break; // no working proxy/browser left – keep what we already collected

        if (outcome.status === "ok") {
          postsDetailsArr.push(outcome.data);
          clearProxyStrikes(lastWorkingProxy);
          console.log(`✅ Post ${i + 1} added successfully`);
        } else {
          console.log(`⏭️ Post ${i + 1} skipped (${outcome.status})`);
          if (outcome.status === "blocked" || outcome.status === "error") {
            if (recordProxyFailure(lastWorkingProxy, `${outcome.status} on detail page`)) {
              browserTainted = true; // replaced before the next post
            } else if (!(await refreshPage(currentUrl))) {
              break; // can't get a browser at all
            }
          }
        }

        postsSincePageRestart++;
        postsSinceBrowserRestart++;
        await sleep(1500);

        if ((i + 1) % 5 === 0) logMemory(`after post ${i + 1}`);
      }

      console.log(`\n🎉 Extraction complete for page ${pageNum}!`);
      console.log(`Total posts collected: ${postsDetailsArr.length}`);

      postsDetailsArr = cleanJobData(postsDetailsArr);
      postsDetailsArr = filterExpiredDeadlines(postsDetailsArr);
      postsDetailsArr = postsDetailsArr.filter((p) => p.application_deadline !== "Unspecified");
      postsDetailsArr = postsDetailsArr.filter(
        (p) => p.application_link !== null
      );

      console.log(`✅ Total valid posts after filtering: ${postsDetailsArr.length}`);

      // Stored after every listing page so a later crash never loses finished work
      try {
        await checkPostsCount();
        const result = await storePosts(postsDetailsArr);
        if (result && result.success && result.inserted) {
          console.log(`successfully stored posts ..${result.inserted}\nDetails: \n`, result);
        } else {
          console.log("No new documents available to insert at this time..", result);
        }
      } catch (dbErr) {
        console.error("DB error (continuing):", dbErr.message);
      }

      // The browser stays open: the next listing page reuses it (fresh tab) until
      // BROWSER_RESTART_EVERY_PAGES listing pages have been scraped.
      pagesSinceBrowserRestart++;
      await sleep(2000);

      if (pageNum < maxPages) {
        pageNum++;
        currentUrl = stockLink + pageNum;
        console.log(`🔗 Next page link: ${currentUrl}`);
      } else {
        console.log(`📌 Reached max pages (${maxPages})`);
        break;
      }
    }
  } catch (error) {
    console.error("scrapeAllPages fatal error:", error.message);
  } finally {
    await closeSession();
    if (global.gc) global.gc();
    logMemory("final cleanup");
  }
}

async function academy() {
  installProcessGuards();

  // Reset per-run state (module stays loaded between invocations)
  runDeadline = Date.now() + MAX_RUN_MS;
  lastWorkingProxy = null;
  allProxies = [];
  runDeadProxies = new Set();
  proxyStrikes.clear();
  searchBatch = 0;
  persistedBatch = null;

  let dbReady = false;

  try {
    await initializeDatabase();
    dbReady = true;

    // The only thing persisted about proxies: the batch that last produced a working one
    const storedBatch = await getProxyBatchIndex();
    persistedBatch = storedBatch;

    allProxies = await fetchFreshProxies();

    searchBatch = resolveStartBatch(storedBatch);
    console.log(
      `📍 Proxy search will start at batch ${searchBatch + 1}/${Math.max(batchCount(), 1)}` +
      (storedBatch === null ? " (no stored batch yet)" : ` (stored batch index: ${storedBatch})`)
    );

    const baseUrl = "https://academicpositions.com/jobs/position/phd?page=";
    await scrapeAllPages(baseUrl + "1", 2);

    console.log("Academy scraper finished cleanly. Returning to outer scope...");
  } catch (error) {
    console.error("Academy top-level error:", error.message);
    throw error;
  } finally {
    if (dbReady) await closeDatabase();
  }
}

module.exports = { academy };