const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const AdblockerPlugin = require("puppeteer-extra-plugin-adblocker");
const UserAgent = require("user-agents");
const net = require("net");

puppeteer.use(StealthPlugin());
puppeteer.use(AdblockerPlugin({ blockTrackers: true }));

const { formatDateForDB } = require("../../utils/dateHelpers.js");
const {
  storePosts,
  checkPostsCount,
  initializeDatabase,
  closeDatabase,
  getTopProxies,
  recordProxySuccess,
  recordProxyFail,
  pruneProxyCache,
} = require("./academy-db.js");

/* ------------------------------------------------------------------ */
/*  Configuration – tuned for Render free tier (0.1 vCPU / 512 MB)    */
/* ------------------------------------------------------------------ */

const PROXY_SOURCE_URL = "https://spys.me/proxy.txt";
const MAX_PAGES = 10;
const LINKS_PER_PAGE = 30;
const BROWSER_RESTART_EVERY = 18;
const MEMORY_LIMIT_MB = 400;
const PROXY_TEST_CONCURRENCY = 1;          // MUST stay 1 on free tier
const PROXY_TEST_TIMEOUT_MS = 22000;
const COOLDOWN_MS = 700;
const DETAIL_NAV_TIMEOUT = 25000;
const LISTING_NAV_TIMEOUT = 28000;

/* ------------------------------------------------------------------ */
/*  Process-lifetime state                                            */
/* ------------------------------------------------------------------ */

let lastWorkingProxy = null;
let allProxies = [];
let proxyCursor = 0;

/* ------------------------------------------------------------------ */
/*  Utility helpers                                                   */
/* ------------------------------------------------------------------ */

function logMemory(label = "") {
  const used = process.memoryUsage();
  const mb = (b) => (b / 1024 / 1024).toFixed(1);
  console.log(
    `🧠 Memory${label ? " [" + label + "]" : ""}: ` +
      `rss=${mb(used.rss)}MB  heap=${mb(used.heapUsed)}MB`
  );
}

function isCloudflareChallenge(page) {
  return page
    .evaluate(() => {
      const title = document.title || "";
      const body = document.body ? document.body.innerText : "";
      return (
        title.includes("Just a moment") ||
        body.includes("Performing security verification") ||
        body.includes(
          "This website uses a security service to protect against malicious bots"
        ) ||
        !!document.querySelector("#cf-chl-widget") ||
        !!document.querySelector("[name='cf-turnstile-response']")
      );
    })
    .catch(() => false);
}

function isValidDeadline(dateString) {
  if (!dateString || dateString === "Unspecified") return true;
  if (!/^\d{4}-\d{2}-\d{2}/.test(dateString)) return true;
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return true;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date >= today;
}

function filterExpiredDeadlines(jobArray) {
  return jobArray.filter((job) => {
    const ok = isValidDeadline(job.application_deadline);
    if (!ok) {
      console.log(
        `⏭️ SKIPPING expired: ${job.application_deadline} – ${job.post_title}`
      );
    }
    return ok;
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
        .trim();
    };

    const cleanDeadline = (deadline) => {
      if (!deadline || deadline === "Unspecified") return deadline;
      const lines = deadline
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const unique = [...new Set(lines)];
      return unique[0]?.split(" ")[0] || deadline;
    };

    return {
      ...job,
      field: cleanText(job.field),
      application_deadline: cleanDeadline(job.application_deadline),
    };
  });
}

/* ------------------------------------------------------------------ */
/*  Lightweight TCP connectivity check                                */
/* ------------------------------------------------------------------ */

function tcpConnectCheck(proxy, timeout = 3000) {
  return new Promise((resolve) => {
    const [host, portStr] = proxy.split(":");
    const port = parseInt(portStr, 10);
    if (!host || !port) return resolve(false);

    const socket = new net.Socket();
    let settled = false;

    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeout);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));

    try {
      socket.connect(port, host);
    } catch {
      done(false);
    }
  });
}

/* ------------------------------------------------------------------ */
/*  Proxy list loading                                                */
/* ------------------------------------------------------------------ */

async function fetchFreshProxies() {
  console.log(`📡 Fetching fresh proxies from ${PROXY_SOURCE_URL} ...`);
  try {
    const res = await fetch(PROXY_SOURCE_URL, {
      signal: AbortSignal.timeout(12000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; proxy-fetcher/1.0)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();

    const list = [];
    for (const line of text.split("\n")) {
      const m = line.trim().match(/^(\d{1,3}(?:\.\d{1,3}){3}:\d{2,5})\b/);
      if (m) list.push(m[1]);
    }

    const unique = [...new Set(list)];
    console.log(`✅ Loaded ${unique.length} fresh proxies`);
    return unique;
  } catch (err) {
    console.error(`⚠️ Failed to fetch proxies: ${err.message}`);
    return [];
  }
}

async function buildProxyCandidateList() {
  const known = await getTopProxies(40);
  const fresh = await fetchFreshProxies();

  const seen = new Set();
  const ordered = [];

  for (const p of known) {
    if (!seen.has(p)) {
      seen.add(p);
      ordered.push(p);
    }
  }
  for (const p of fresh) {
    if (!seen.has(p)) {
      seen.add(p);
      ordered.push(p);
    }
  }

  console.log(
    `📋 Candidate list: ${known.length} known-good + ${fresh.length} fresh → ${ordered.length} total`
  );
  return ordered;
}

/* ------------------------------------------------------------------ */
/*  Browser launch                                                    */
/* ------------------------------------------------------------------ */

async function launchBrowserWithProxy(proxy = null) {
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-accelerated-2d-canvas",
    "--disable-gpu",
    "--disable-web-security",
    "--disable-features=VizDisplayCompositor,AudioServiceOutOfProcess",
    "--js-flags=--max-old-space-size=192",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-translate",
    "--mute-audio",
    "--no-first-run",
    "--safebrowsing-disable-auto-update",
    "--disable-ipc-flooding-protection",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-client-side-phishing-detection",
    "--disable-component-update",
    "--metrics-recording-only",
    "--no-default-browser-check",
    "--no-pings",
  ];

  if (proxy) {
    args.push(`--proxy-server=http://${proxy}`);
  }

  return puppeteer.launch({
    headless: true,
    args,
    protocolTimeout: 60000, // critical on low-resource hosts
    timeout: 45000,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
}

/* ------------------------------------------------------------------ */
/*  Single proxy test (sequential only)                               */
/* ------------------------------------------------------------------ */

async function tryOneProxy(targetUrl, proxy) {
  let browser = null;
  let page = null;
  let success = false;

  try {
    browser = await launchBrowserWithProxy(proxy);
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(0);

    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (
        ["image", "stylesheet", "font", "media", "websocket", "manifest"].includes(
          type
        )
      ) {
        req.abort().catch(() => {});
      } else {
        req.continue().catch(() => {});
      }
    });

    const ua = new UserAgent({ deviceCategory: "desktop" });
    await page.setUserAgent(ua.toString());

    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: PROXY_TEST_TIMEOUT_MS,
    });

    await new Promise((r) => setTimeout(r, 2000));

    if (await isCloudflareChallenge(page)) {
      console.log(`🚫 CF challenge → ${proxy || "direct"}`);
      await recordProxyFail(proxy);
      return null;
    }

    try {
      await page.waitForSelector("h2", { visible: true, timeout: 9000 });
    } catch {
      console.log(`⚠️ No h2 → soft block ${proxy || "direct"}`);
      await recordProxyFail(proxy);
      return null;
    }

    console.log(`✅ Working proxy found: ${proxy || "direct"}`);
    await recordProxySuccess(proxy);
    success = true;
    return { browser, page, proxy };
  } catch (err) {
    const msg = (err.message || "").slice(0, 120);
    console.log(`❌ Proxy failed ${proxy || "direct"}: ${msg}`);
    await recordProxyFail(proxy);
    return null;
  } finally {
    if (!success) {
      try {
        if (page) await page.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
      } catch (_) {}
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Find a working browser                                            */
/* ------------------------------------------------------------------ */

async function createWorkingBrowserAndPage(targetUrl) {
  // Fast path – reuse last working proxy from this process
  if (lastWorkingProxy) {
    console.log(`🔁 Trying last working proxy: ${lastWorkingProxy}`);
    const result = await tryOneProxy(targetUrl, lastWorkingProxy);
    if (result) return result;
    console.log("⚠️ Last working proxy died");
    lastWorkingProxy = null;
  }

  if (allProxies.length === 0) {
    console.log("⚠️ No proxies available – trying direct");
    const direct = await tryOneProxy(targetUrl, null);
    if (direct) return direct;
    throw new Error("No proxies and direct connection blocked");
  }

  // Sequential testing (concurrency = 1)
  while (proxyCursor < allProxies.length) {
    const proxy = allProxies[proxyCursor];
    proxyCursor++;

    console.log(
      `\n📦 Testing proxy ${proxyCursor}/${allProxies.length}: ${proxy}`
    );

    const alive = await tcpConnectCheck(proxy, 2800);
    if (!alive) {
      console.log("   TCP failed – skipping");
      await recordProxyFail(proxy);
      continue;
    }

    const result = await tryOneProxy(targetUrl, proxy);
    if (result) {
      lastWorkingProxy = result.proxy;
      // Move winner to front of list
      allProxies = allProxies.filter((p) => p !== result.proxy);
      allProxies.unshift(result.proxy);
      proxyCursor = 0;
      return result;
    }

    await new Promise((r) => setTimeout(r, COOLDOWN_MS));
  }

  // Last resort
  console.log("⚠️ Exhausted proxy list – trying direct connection");
  const direct = await tryOneProxy(targetUrl, null);
  if (direct) {
    lastWorkingProxy = null;
    return direct;
  }

  throw new Error("Could not obtain a working browser after testing all proxies");
}

/* ------------------------------------------------------------------ */
/*  Detail page extraction                                            */
/* ------------------------------------------------------------------ */

async function extractPostDetails(postLink, page) {
  try {
    await page.goto(postLink, {
      waitUntil: "domcontentloaded",
      timeout: DETAIL_NAV_TIMEOUT,
    });

    if (await isCloudflareChallenge(page)) {
      console.log("🚫 CF on detail page – skip");
      return null;
    }

    await page.waitForSelector("#jobDetails", {
      visible: true,
      timeout: 10000,
    });

    const data = await page.evaluate(() => {
      const getText = (sel) => {
        const el = document.querySelector(sel);
        return el ? el.textContent.trim() : null;
      };

      return {
        post_title: getText(
          "#jobDetails > div > div:nth-child(1) > div.col-auto.col-md-8"
        ),
        institution: getText(
          "#jobDetails > div > div:nth-child(2) > div.col-auto.col-md-8"
        ),
        field: getText(
          "#jobDetails > div > div:nth-child(7) > div.col-auto.col-md-8"
        ),
        application_deadline: getText(
          "#jobDetails > div > div:nth-child(5) > div.col-auto.col-md-8"
        ),
        application_link:
          document.querySelector("#gtm-job-ad-apply-now-bottom-section")
            ?.href || null,
      };
    });

    if (!data.post_title || !data.institution) {
      console.log("⚠️ Missing title or institution – skip");
      return null;
    }

    return {
      post_title: data.post_title,
      institution: data.institution,
      field: data.field || "Unspecified",
      application_link: data.application_link,
      application_deadline: data.application_deadline || "Unspecified",
      postLink,
      insertionDate: formatDateForDB(),
    };
  } catch (err) {
    console.error(`extractPostDetails error: ${err.message}`);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Main scraping loop                                                */
/* ------------------------------------------------------------------ */

async function scrapeAllPages(startUrl, maxPages = MAX_PAGES) {
  let browser = null;
  let page = null;
  let postsSinceRestart = 0;
  let currentUrl = startUrl;
  let pageNum = 1;

  const stockLink = "https://academicpositions.com/jobs/position/phd?page=";

  try {
    while (pageNum <= maxPages) {
      console.log(`\n========== PAGE ${pageNum}/${maxPages} ==========`);
      logMemory(`start page ${pageNum}`);

      // Obtain (or re-obtain) a working browser
      if (!browser || !page) {
        try {
          const result = await createWorkingBrowserAndPage(currentUrl);
          browser = result.browser;
          page = result.page;
          postsSinceRestart = 0;
        } catch (err) {
          console.error(
            `🚫 Cannot get working browser for page ${pageNum}: ${err.message}`
          );
          break;
        }
      } else {
        // Reuse existing browser
        try {
          await page.goto(currentUrl, {
            waitUntil: "domcontentloaded",
            timeout: LISTING_NAV_TIMEOUT,
          });
          if (await isCloudflareChallenge(page)) {
            console.log("🚫 CF reappeared – forcing new proxy");
            await page.close().catch(() => {});
            await browser.close().catch(() => {});
            browser = null;
            page = null;
            continue;
          }
        } catch (navErr) {
          console.error("Listing navigation failed – restarting browser");
          await page.close().catch(() => {});
          await browser.close().catch(() => {});
          browser = null;
          page = null;
          continue;
        }
      }

      // Extract links
      let links = await page
        .evaluate(() => {
          const els = document.querySelectorAll(
            ".list-group-item.text-reset.text-decoration-none > a"
          );
          return Array.from(els)
            .map((a) => a.href)
            .filter(Boolean);
        })
        .catch(() => []);

      if (links.length > LINKS_PER_PAGE) {
        links = links.slice(0, LINKS_PER_PAGE);
      }
      console.log(`Found ${links.length} job links`);

      const postsDetailsArr = [];

      for (let i = 0; i < links.length; i++) {
        // Memory / restart guard
        const mem = process.memoryUsage().rss / 1024 / 1024;
        if (
          postsSinceRestart >= BROWSER_RESTART_EVERY ||
          mem > MEMORY_LIMIT_MB
        ) {
          console.log(
            `♻️ Restarting browser (posts=${postsSinceRestart}, rss=${mem.toFixed(
              0
            )}MB)`
          );
          logMemory("before restart");

          await page.close().catch(() => {});
          await browser.close().catch(() => {});
          if (global.gc) global.gc();

          await new Promise((r) => setTimeout(r, 2500));

          try {
            const result = await createWorkingBrowserAndPage(currentUrl);
            browser = result.browser;
            page = result.page;
            postsSinceRestart = 0;
            logMemory("after restart");
          } catch (err) {
            console.error(`Could not restart: ${err.message}`);
            break;
          }
        }

        console.log(`📌 ${i + 1}/${links.length}`);
        const detail = await extractPostDetails(links[i], page);
        if (detail) {
          postsDetailsArr.push(detail);
          console.log(`✅ ${detail.post_title.slice(0, 65)}...`);
        }

        postsSinceRestart++;
        await new Promise((r) => setTimeout(r, 1000));
      }

      // Clean + store
      let cleaned = cleanJobData(postsDetailsArr);
      cleaned = filterExpiredDeadlines(cleaned);
      cleaned = cleaned.filter((p) => p.application_deadline !== "Unspecified");

      console.log(`✅ Valid posts this page: ${cleaned.length}`);

      try {
        await checkPostsCount();
        const result = await storePosts(cleaned);
        console.log(
          result?.success
            ? `Stored ${result.inserted} new documents`
            : `Store result: ${JSON.stringify(result)}`
        );
      } catch (dbErr) {
        console.error("DB error (continuing):", dbErr.message);
      }

      // Next page
      if (pageNum < maxPages) {
        pageNum++;
        currentUrl = stockLink + pageNum;
        console.log(`🔗 Next: ${currentUrl}`);
      } else {
        break;
      }

      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (error) {
    console.error("scrapeAllPages fatal:", error.message);
  } finally {
    try {
      if (page) await page.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    } catch (_) {}
    if (global.gc) global.gc();
    logMemory("final cleanup");
  }
}

/* ------------------------------------------------------------------ */
/*  Entry point                                                       */
/* ------------------------------------------------------------------ */

async function academy() {
  try {
    await initializeDatabase();
    await pruneProxyCache();

    allProxies = await buildProxyCandidateList();
    proxyCursor = 0;

    const baseUrl = "https://academicpositions.com/jobs/position/phd?page=1";
    await scrapeAllPages(baseUrl, MAX_PAGES);

    await closeDatabase();
    console.log("Academy scraper finished cleanly.");
  } catch (error) {
    console.error("Academy top-level error:", error.message);
    throw error;
  }
}

module.exports = { academy };