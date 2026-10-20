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
  getWorkingProxy,
  saveWorkingProxy,
  clearWorkingProxy,
} = require("./academy-db.js");

// -------------------------------------------------------
// Dynamic proxy loading from https://spys.me/proxy.txt
// Proxies kept in the exact order they appear on the site.
// Walk the full list in batches of BATCH_SIZE until a working
// proxy is found, then reuse that proxy for the rest of the run.
// The working proxy is also persisted to MongoDB so it survives
// process restarts.
// -------------------------------------------------------
const PROXY_SOURCE_URL = "https://spys.me/proxy.txt";
const BATCH_SIZE = 25; // try 25 at a time
const BROWSER_RESTART_EVERY = 6; // restart Chromium every N detail pages
const LINKS_PER_PAGE = 20; // max job links per listing page
const COOLDOWN_MS = 2000; // pause between failed proxy attempts

// Process-lifetime state
let lastWorkingProxy = null;
let allProxies = []; // full list from spys.me (website order)
let proxyCursor = 0; // where we are in the full list

/**
 * Fetch + parse the entire proxy list from spys.me.
 * Keeps the exact order as listed on the website (no scoring).
 * Memory cost is tiny (just strings).
 */
async function fetchFreshProxies() {
  console.log(`📡 Fetching fresh proxies from ${PROXY_SOURCE_URL} ...`);
  try {
    const res = await fetch(PROXY_SOURCE_URL, {
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; proxy-fetcher/1.0)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();

    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const list = [];

    // Keep exact order as listed on the website (no scoring / reordering)
    for (const line of lines) {
      // Format: 45.125.64.215:443 HK-H-S +
      const m = line.match(/^(\d{1,3}(?:\.\d{1,3}){3}:\d{2,5})\b/);
      if (!m) continue;
      list.push(m[1]); // "ip:port" only
    }

    // Deduplicate while preserving website order
    const unique = [...new Set(list)];

    // Put lastWorkingProxy at the very front if we have one
    if (lastWorkingProxy) {
      const without = unique.filter((p) => p !== lastWorkingProxy);
      without.unshift(lastWorkingProxy);
      console.log(
        `✅ Loaded ${without.length} proxies (website order, last-working first)`
      );
      return without;
    }

    console.log(`✅ Loaded ${unique.length} proxies (website order)`);
    return unique;
  } catch (err) {
    console.error(`⚠️ Failed to fetch proxies: ${err.message}`);
    if (lastWorkingProxy) {
      console.log(
        `🔁 Falling back to last known good proxy: ${lastWorkingProxy}`
      );
      return [lastWorkingProxy];
    }
    return [];
  }
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

function logMemory(label = "") {
  const used = process.memoryUsage();
  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);
  console.log(
    `🧠 Memory${label ? " [" + label + "]" : ""}: ` +
      `rss=${mb(used.rss)}MB  heapUsed=${mb(used.heapUsed)}MB  external=${mb(
        used.external
      )}MB`
  );
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
      console.log(
        `⏭️ SKIPPING: Deadline "${job.application_deadline}" is expired - ${job.post_title}`
      );
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
      const lines = deadline
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && line.length > 0);
      const uniqueLines = [];
      for (const line of lines) {
        if (!uniqueLines.includes(line)) uniqueLines.push(line);
      }
      return uniqueLines[0].split(" ")[0] || deadline;
    };

    return {
      ...job,
      field: cleanText(job.field),
      application_deadline: cleanDeadline(job.application_deadline),
    };
  });
}

async function extractPostDetails(postLink, page) {
  try {
    console.log(`post link: ${postLink}`);

    await page.goto(postLink, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    if (await isCloudflareChallenge(page)) {
      console.log("🚫 Cloudflare challenge on detail page – skipping this post");
      return null;
    }

    await page.waitForSelector("#jobDetails", {
      visible: true,
      timeout: 15000,
    });

    let post_title = await page.evaluate(() => {
      const element = document.querySelector(
        "#jobDetails > div > div:nth-child(1) > div.col-auto.col-md-8"
      );
      return element ? element.textContent : null;
    });

    let post_Inst = await page.evaluate(() => {
      const element = document.querySelector(
        "#jobDetails > div > div:nth-child(2) > div.col-auto.col-md-8"
      );
      return element ? element.textContent : null;
    });

    let field = await page.evaluate(() => {
      const element = document.querySelector(
        "#jobDetails > div > div:nth-child(7) > div.col-auto.col-md-8"
      );
      return element ? element.textContent : null;
    });

    let app_link = await page.evaluate(() => {
      const element = document.querySelector(
        "#gtm-job-ad-apply-now-bottom-section"
      );
      return element ? element.href : null;
    });

    let post_deadline = await page.evaluate(() => {
      const element = document.querySelector(
        "#jobDetails > div > div:nth-child(5) > div.col-auto.col-md-8"
      );
      return element ? element.textContent : null;
    });

    if (!post_title || !post_Inst) {
      console.log("⚠️ Missing title or institution – skipping");
      return null;
    }

    return {
      post_title: post_title.trim(),
      institution: post_Inst.trim(),
      field: field ? field.trim() : "Unspecified",
      application_link: app_link,
      application_deadline: post_deadline ? post_deadline.trim() : "Unspecified",
      postLink: postLink,
      insertionDate: formatDateForDB(),
    };
  } catch (error) {
    console.error(`extractPostDetails error: ${error.message}`);
    return null;
  }
}

async function launchBrowserWithProxy(proxy = null) {
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-accelerated-2d-canvas",
    "--disable-gpu",
    "--disable-web-security",
    "--disable-features=VizDisplayCompositor",
    "--js-flags=--max-old-space-size=384",
  ];

  if (proxy) {
    args.push(`--proxy-server=http://${proxy}`);
    console.log(`🌐 Using proxy: ${proxy}`);
  } else {
    console.log(`🌐 No proxy (direct connection)`);
  }

  return puppeteer.launch({
    headless: true,
    args,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
}

/**
 * Try one proxy. Returns {browser, page, proxy} or null.
 * Always closes resources on failure.
 */
async function tryOneProxy(targetUrl, proxy) {
  let browser = null;
  let page = null;

  try {
    browser = await launchBrowserWithProxy(proxy);
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(0);

    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (["image", "stylesheet", "font", "media"].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    const userAgent = new UserAgent({ deviceCategory: "mobile" });
    await page.setUserAgent(userAgent.toString());

    console.log(`📄 Navigating to: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });

    await new Promise((r) => setTimeout(r, 3500));

    if (await isCloudflareChallenge(page)) {
      console.log(`🚫 Cloudflare challenge with proxy ${proxy || "direct"}`);
      await page.close().catch(() => {});
      await browser.close().catch(() => {});
      return null;
    }

    try {
      await page.waitForSelector("h2", { visible: true, timeout: 12000 });
    } catch (e) {
      console.log(`⚠️ h2 not found with proxy ${proxy || "direct"} – soft block`);
      await page.close().catch(() => {});
      await browser.close().catch(() => {});
      return null;
    }

    console.log(`✅ Browser ready (proxy: ${proxy || "direct"})`);
    return { browser, page, proxy };
  } catch (err) {
    console.error(`❌ Failed with proxy ${proxy || "direct"}: ${err.message}`);
    try {
      if (page) await page.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    } catch (_) {}
    return null;
  }
}

/**
 * Walk the full proxy list in batches of BATCH_SIZE until a working proxy is found.
 * Once found, that proxy is remembered (in-memory + DB) and reused for the rest of the run.
 */
async function createWorkingBrowserAndPage(targetUrl) {
  // Fast path: already have a known-good proxy from earlier in this process (or loaded from DB)
  if (lastWorkingProxy) {
    console.log(`🔁 Reusing last working proxy: ${lastWorkingProxy}`);
    const result = await tryOneProxy(targetUrl, lastWorkingProxy);
    if (result) return result;
    console.log(
      `⚠️ Last working proxy died – clearing from DB and searching for a new one...`
    );
    lastWorkingProxy = null;
    await clearWorkingProxy(); // persist the failure so next run doesn't reuse a dead proxy
    await new Promise((r) => setTimeout(r, COOLDOWN_MS));
  }

  if (allProxies.length === 0) {
    console.log("⚠️ No proxies loaded – trying direct connection");
    const direct = await tryOneProxy(targetUrl, null);
    if (direct) return direct;
    throw new Error("No proxies available and direct connection blocked");
  }

  // Walk the list in batches
  while (proxyCursor < allProxies.length) {
    const batchStart = proxyCursor;
    const batchEnd = Math.min(proxyCursor + BATCH_SIZE, allProxies.length);
    const batch = allProxies.slice(batchStart, batchEnd);

    console.log(
      `\n📦 Trying proxy batch ${Math.floor(batchStart / BATCH_SIZE) + 1} ` +
        `(indices ${batchStart}-${batchEnd - 1} of ${allProxies.length})`
    );
    console.log(`📋 Batch proxies:`, JSON.stringify(batch, null, 2));

    for (const proxy of batch) {
      const result = await tryOneProxy(targetUrl, proxy);
      if (result) {
        lastWorkingProxy = result.proxy;
        // Move this working proxy to the front for future restarts
        allProxies = allProxies.filter((p) => p !== result.proxy);
        allProxies.unshift(result.proxy);
        proxyCursor = 0; // next time we start from the good one
        console.log(`🎉 Found working proxy: ${result.proxy} – will reuse it`);
        await saveWorkingProxy(result.proxy); // persist so it survives process restarts
        return result;
      }
      await new Promise((r) => setTimeout(r, COOLDOWN_MS));
    }

    proxyCursor = batchEnd;
    console.log(`📦 Batch exhausted. Moving to next batch...`);
  }

  // Entire list exhausted – last resort direct
  console.log("⚠️ Entire proxy list exhausted. Trying direct connection...");
  const direct = await tryOneProxy(targetUrl, null);
  if (direct) {
    lastWorkingProxy = null;
    await clearWorkingProxy(); // no proxy in use
    return direct;
  }

  throw new Error(
    "Could not obtain a working browser/page after trying all proxies"
  );
}

async function scrapeAllPages(startUrl, maxPages = 10) {
  let browser = null;
  let page = null;
  let postsSinceRestart = 0;

  try {
    let currentUrl = startUrl;
    let pageNum = 1;
    const stockLink = "https://academicpositions.com/jobs/position/phd?page=";

    while (pageNum <= maxPages) {
      console.log(`\n📄 Scraping page ${pageNum}`);
      logMemory(`start page ${pageNum}`);

      try {
        const result = await createWorkingBrowserAndPage(currentUrl);
        browser = result.browser;
        page = result.page;
        postsSinceRestart = 0;
      } catch (err) {
        console.error(
          `🚫 Failed to get working page for listing ${pageNum}: ${err.message}`
        );
        break;
      }

      if (await isCloudflareChallenge(page)) {
        console.log(
          "🚫 Still blocked by Cloudflare after all attempts. Aborting."
        );
        break;
      }

      await page
        .waitForSelector("h2", {
          visible: true,
          timeout: 20000,
        })
        .catch(() => console.log("h2 wait timed out"));

      let links = await page
        .evaluate(() => {
          let jobListingElements = document.querySelectorAll(
            ".list-group-item.text-reset.text-decoration-none > a"
          );
          let extractedLinks = [];
          jobListingElements.forEach((link) => {
            if (link.href) extractedLinks.push(link.href);
          });
          return extractedLinks;
        })
        .catch(() => []);

      if (links.length > LINKS_PER_PAGE) {
        console.log(
          `Found ${links.length} job links – limiting to first ${LINKS_PER_PAGE}`
        );
        links = links.slice(0, LINKS_PER_PAGE);
      } else {
        console.log(`Found ${links.length} job links on page ${pageNum}`);
      }

      if (links.length === 0) {
        const debug = await page
          .evaluate(() => ({
            title: document.title,
            url: location.href,
            bodyText: document.body ? document.body.innerText.slice(0, 500) : "",
            listItems: document.querySelectorAll(".list-group-item").length,
          }))
          .catch(() => ({}));
        console.log("DEBUG (empty links):", JSON.stringify(debug, null, 2));
      }

      let postsDetailsArr = [];

      for (let i = 0; i < links.length; i++) {
        console.log(`\n📌 Processing post ${i + 1}/${links.length}`);

        if (postsSinceRestart >= BROWSER_RESTART_EVERY) {
          console.log(
            `♻️ Restarting browser after ${postsSinceRestart} posts (memory hygiene)`
          );
          logMemory("before restart");

          try {
            if (page) await page.close().catch(() => {});
            if (browser) await browser.close().catch(() => {});
          } catch (_) {}

          if (global.gc) {
            global.gc();
            console.log("🗑️ Forced garbage collection");
          }

          await new Promise((r) => setTimeout(r, 3000));

          try {
            // Will reuse lastWorkingProxy if still alive
            const result = await createWorkingBrowserAndPage(currentUrl);
            browser = result.browser;
            page = result.page;
            postsSinceRestart = 0;
            logMemory("after restart");
          } catch (err) {
            console.error(`🚫 Could not restart browser: ${err.message}`);
            break;
          }
        }

        try {
          const result = await extractPostDetails(links[i], page);
          if (result) {
            postsDetailsArr.push(result);
            console.log(`✅ Post ${i + 1} added successfully`);
          } else {
            console.log(`⏭️ Post ${i + 1} skipped`);
          }
        } catch (err) {
          console.error(
            `❌ Unexpected error on post ${i + 1}: ${err.message}`
          );

          try {
            if (page) await page.close().catch(() => {});
            page = await browser.newPage();
            page.setDefaultNavigationTimeout(0);
            await page.setRequestInterception(true);
            page.on("request", (req) => {
              if (
                ["image", "stylesheet", "font", "media"].includes(
                  req.resourceType()
                )
              ) {
                req.abort();
              } else {
                req.continue();
              }
            });
            const userAgent = new UserAgent({ deviceCategory: "mobile" });
            await page.setUserAgent(userAgent.toString());
            console.log("🔄 Recreated page after error");
          } catch (recoverErr) {
            console.error(`Could not recover page: ${recoverErr.message}`);
            postsSinceRestart = BROWSER_RESTART_EVERY;
          }
        }

        postsSinceRestart++;
        await new Promise((resolve) => setTimeout(resolve, 1500));

        if ((i + 1) % 5 === 0) {
          logMemory(`after post ${i + 1}`);
        }
      }

      console.log(`\n🎉 Extraction complete for page ${pageNum}!`);
      console.log(`Total posts collected: ${postsDetailsArr.length}`);

      postsDetailsArr = cleanJobData(postsDetailsArr);
      postsDetailsArr = filterExpiredDeadlines(postsDetailsArr);
      postsDetailsArr = postsDetailsArr.filter(
        (p) => p.application_deadline !== "Unspecified"
      );

      console.log(
        `✅ Total valid posts after filtering: ${postsDetailsArr.length}`
      );

      try {
        await checkPostsCount();
        let result = await storePosts(postsDetailsArr);
        if (result && result.success && result.inserted) {
          console.log(
            `successfully stored posts ..${result.inserted}\nDetails: \n`,
            result
          );
        } else {
          console.log(
            "No new documents available to insert at this time..",
            result
          );
        }
      } catch (dbErr) {
        console.error("DB error (continuing):", dbErr.message);
      }

      try {
        if (page) await page.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        browser = null;
        page = null;
      } catch (_) {}

      if (global.gc) global.gc();
      await new Promise((r) => setTimeout(r, 4000));

      if (pageNum < maxPages) {
        pageNum++;
        const nextPageLink = stockLink + `${pageNum}`;
        console.log(`🔗 Next page link: ${nextPageLink}`);
        currentUrl = nextPageLink;
      } else {
        console.log(`📌 Reached max pages (${maxPages})`);
        break;
      }
    }
  } catch (error) {
    console.error("scrapeAllPages fatal error:", error.message);
  } finally {
    try {
      if (page) await page.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    } catch (_) {}
    if (global.gc) global.gc();
    logMemory("final cleanup");
  }
}

async function academy() {
  try {
    // DB first so we can restore the last working proxy across restarts
    await initializeDatabase();

    // Restore persisted working proxy (if any) before building the proxy list
    lastWorkingProxy = await getWorkingProxy();

    // Fetch the FULL list once per run (website order).
    // fetchFreshProxies() will put lastWorkingProxy at the front when present.
    allProxies = await fetchFreshProxies();
    proxyCursor = 0;

    const baseUrl = "https://academicpositions.com/jobs/position/phd?page=";
    await scrapeAllPages(baseUrl + "1", 2);

    await closeDatabase();
    console.log("Academy scraper finished cleanly. Returning to outer scope...");
    return;
  } catch (error) {
    console.error("Academy top-level error:", error.message);
    throw error;
  }
}

module.exports = { academy };