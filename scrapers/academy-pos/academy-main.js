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
// Dynamic proxy loading from https://spys.me/proxy.txt
// Proxies kept in the exact order they appear on the site.
// Walk the full list in batches of BATCH_SIZE until a working
// proxy is found, then reuse that proxy for the rest of the run.
//
// Only the BATCH INDEX is persisted to MongoDB (not the proxy).
// When a working proxy fails after PROXY_MAX_TRIES attempts,
// it is discarded and search resumes from that same batch.
//
// Lifecycle per listing page:
//   open browser -> scrape details (recycle page every 10) ->
//   store posts -> close browser
// Then move to the next listing page and open a fresh browser.
// -------------------------------------------------------
const PROXY_SOURCE_URL = "https://spys.me/proxy.txt";
const BATCH_SIZE = 25; // try 25 at a time
const PAGE_RECYCLE_EVERY = 10; // recreate page every N detail posts (cheap)
const LINKS_PER_PAGE = 20; // max job links per listing page
const COOLDOWN_MS = 2000; // pause between failed proxy attempts
const DETAIL_CF_RETRIES = 2; // how many times to rotate proxy + retry a CF'd detail page
const PROXY_MAX_TRIES = 2; // discard a working proxy after this many consecutive failures

// Process-lifetime state
let lastWorkingProxy = null;
let proxyFailCount = 0; // consecutive failures of lastWorkingProxy
let allProxies = []; // full list from spys.me (website order)
let proxyCursor = 0; // where we are in the full list (aligned to batch starts when searching)
let lastGoodBatchIndex = 0; // batch start index that produced the last working proxy (persisted)

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

    console.log(`✅ Loaded ${unique.length} proxies (website order)`);
    return unique;
  } catch (err) {
    console.error(`⚠️ Failed to fetch proxies: ${err.message}`);
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

/**
 * Extract post details. Returns:
 *   - object on success
 *   - null on hard skip (missing fields, navigation error)
 *   - { __cloudflare: true } when CF challenge detected (caller should rotate proxy + retry)
 */
async function extractPostDetails(postLink, page) {
  try {
    console.log(`post link: ${postLink}`);

    await page.goto(postLink, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    if (await isCloudflareChallenge(page)) {
      console.log("🚫 Cloudflare challenge on detail page");
      return { __cloudflare: true };
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
 * Create a fresh page on an existing browser (cheap).
 * Applies request interception + mobile UA.
 */
async function createFreshPage(browser) {
  const page = await browser.newPage();
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
  return page;
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
    page = await createFreshPage(browser);

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
 * Discard the current working proxy (after PROXY_MAX_TRIES failures)
 * and reset the search cursor to the batch that produced it.
 */
function discardWorkingProxy() {
  console.log(
    `🗑️ Discarding proxy ${lastWorkingProxy} after ${proxyFailCount} failure(s) – resuming search from batch index ${lastGoodBatchIndex}`
  );
  lastWorkingProxy = null;
  proxyFailCount = 0;
  // Resume from the same batch that produced the previous working proxy
  proxyCursor = lastGoodBatchIndex;
}

/**
 * Walk the full proxy list in batches of BATCH_SIZE until a working proxy is found.
 * Only the batch index is persisted – not the proxy itself.
 * On failure after PROXY_MAX_TRIES, discard and resume from lastGoodBatchIndex.
 */
async function createWorkingBrowserAndPage(targetUrl) {
  // Fast path: reuse in-memory working proxy (not loaded from DB)
  if (lastWorkingProxy) {
    console.log(
      `🔁 Reusing last working proxy: ${lastWorkingProxy} (fail count: ${proxyFailCount}/${PROXY_MAX_TRIES})`
    );
    const result = await tryOneProxy(targetUrl, lastWorkingProxy);
    if (result) {
      proxyFailCount = 0; // success resets failure counter
      return result;
    }

    proxyFailCount++;
    console.log(
      `⚠️ Working proxy failed (attempt ${proxyFailCount}/${PROXY_MAX_TRIES})`
    );

    if (proxyFailCount >= PROXY_MAX_TRIES) {
      discardWorkingProxy();
    }
    await new Promise((r) => setTimeout(r, COOLDOWN_MS));
  }

  if (allProxies.length === 0) {
    console.log("⚠️ No proxies loaded – trying direct connection");
    const direct = await tryOneProxy(targetUrl, null);
    if (direct) return direct;
    throw new Error("No proxies available and direct connection blocked");
  }

  // Clamp cursor in case the proxy list shrank since last run
  if (proxyCursor >= allProxies.length) {
    console.log(
      `ℹ️ Cursor ${proxyCursor} is past list length ${allProxies.length} – wrapping to 0`
    );
    proxyCursor = 0;
    lastGoodBatchIndex = 0;
  }

  // Walk the list in batches, starting from proxyCursor (aligned to last good batch)
  while (proxyCursor < allProxies.length) {
    const batchStart = proxyCursor;
    const batchEnd = Math.min(proxyCursor + BATCH_SIZE, allProxies.length);
    const batch = allProxies.slice(batchStart, batchEnd);

    console.log(
      `\n📦 Trying proxy batch starting at index ${batchStart} ` +
        `(indices ${batchStart}-${batchEnd - 1} of ${allProxies.length})`
    );
    console.log(`📋 Batch proxies:`, JSON.stringify(batch, null, 2));

    for (let i = 0; i < batch.length; i++) {
      const proxy = batch[i];
      const result = await tryOneProxy(targetUrl, proxy);
      if (result) {
        lastWorkingProxy = result.proxy;
        proxyFailCount = 0;
        lastGoodBatchIndex = batchStart; // remember which batch produced this proxy
        proxyCursor = batchStart; // keep cursor at batch start for future resume
        console.log(
          `🎉 Found working proxy: ${result.proxy} from batch index ${batchStart}`
        );
        await saveProxyBatchIndex(batchStart);
        return result;
      }
      await new Promise((r) => setTimeout(r, COOLDOWN_MS));
    }

    // Whole batch failed – move to next batch
    proxyCursor = batchEnd;
    console.log(`📦 Batch exhausted. Cursor advanced to ${proxyCursor}. Moving to next batch...`);
  }

  // Entire list exhausted – last resort direct
  console.log("⚠️ Entire proxy list exhausted. Trying direct connection...");
  const direct = await tryOneProxy(targetUrl, null);
  if (direct) {
    lastWorkingProxy = null;
    proxyFailCount = 0;
    return direct;
  }

  throw new Error(
    "Could not obtain a working browser/page after trying all proxies"
  );
}

/**
 * Close page + browser safely.
 */
async function closeBrowserResources(browser, page) {
  try {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  } catch (_) {}
}

async function scrapeAllPages(startUrl, maxPages = 10) {
  let browser = null;
  let page = null;
  let postsSincePageRecycle = 0;

  try {
    let currentUrl = startUrl;
    let pageNum = 1;
    const stockLink = "https://academicpositions.com/jobs/position/phd?page=";

    while (pageNum <= maxPages) {
      console.log(`\n📄 Scraping listing page ${pageNum}`);
      logMemory(`start page ${pageNum}`);

      // 1) OPEN BROWSER for this listing page
      try {
        const result = await createWorkingBrowserAndPage(currentUrl);
        browser = result.browser;
        page = result.page;
        postsSincePageRecycle = 0;
        console.log(`🌐 Browser opened for listing page ${pageNum}`);
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
        await closeBrowserResources(browser, page);
        browser = null;
        page = null;
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

      // 2) SCRAPE DETAILS (recycle page every PAGE_RECYCLE_EVERY posts)
      let postsDetailsArr = [];

      for (let i = 0; i < links.length; i++) {
        console.log(`\n📌 Processing post ${i + 1}/${links.length}`);

        if (postsSincePageRecycle >= PAGE_RECYCLE_EVERY) {
          console.log(
            `♻️ Recycling page after ${postsSincePageRecycle} posts (cheap)`
          );
          try {
            if (page) await page.close().catch(() => {});
            page = await createFreshPage(browser);
            postsSincePageRecycle = 0;
          } catch (recycleErr) {
            console.error(
              `Page recycle failed: ${recycleErr.message} – rotating browser`
            );
            await closeBrowserResources(browser, page);
            browser = null;
            page = null;
            try {
              const rotated = await createWorkingBrowserAndPage(currentUrl);
              browser = rotated.browser;
              page = rotated.page;
              postsSincePageRecycle = 0;
            } catch (err) {
              console.error(`🚫 Could not recover browser: ${err.message}`);
              break;
            }
          }
        }

        // Detail scrape with CF retry
        let result = null;
        let cfAttempts = 0;

        while (cfAttempts <= DETAIL_CF_RETRIES) {
          try {
            result = await extractPostDetails(links[i], page);

            if (result && result.__cloudflare) {
              cfAttempts++;
              console.log(
                `🔄 CF on detail page – rotating proxy (attempt ${cfAttempts}/${DETAIL_CF_RETRIES})`
              );

              proxyFailCount++;
              if (proxyFailCount >= PROXY_MAX_TRIES) {
                discardWorkingProxy();
              } else {
                lastWorkingProxy = null;
              }

              await closeBrowserResources(browser, page);
              browser = null;
              page = null;

              await new Promise((r) => setTimeout(r, COOLDOWN_MS));

              try {
                const rotated = await createWorkingBrowserAndPage(currentUrl);
                browser = rotated.browser;
                page = rotated.page;
                postsSincePageRecycle = 0;
              } catch (rotateErr) {
                console.error(
                  `🚫 Could not obtain new proxy after CF: ${rotateErr.message}`
                );
                result = null;
                break;
              }
              continue;
            }

            break;
          } catch (err) {
            console.error(
              `❌ Unexpected error on post ${i + 1}: ${err.message}`
            );
            try {
              if (page) await page.close().catch(() => {});
              page = await createFreshPage(browser);
              console.log("🔄 Recreated page after error");
              postsSincePageRecycle = 0;
            } catch (recoverErr) {
              console.error(`Could not recover page: ${recoverErr.message}`);
              await closeBrowserResources(browser, page);
              browser = null;
              page = null;
              try {
                const rotated = await createWorkingBrowserAndPage(currentUrl);
                browser = rotated.browser;
                page = rotated.page;
                postsSincePageRecycle = 0;
              } catch (e) {
                console.error(`🚫 Could not recover browser: ${e.message}`);
              }
            }
            result = null;
            break;
          }
        }

        if (result && !result.__cloudflare) {
          postsDetailsArr.push(result);
          console.log(`✅ Post ${i + 1} added successfully`);
        } else {
          console.log(`⏭️ Post ${i + 1} skipped`);
        }

        postsSincePageRecycle++;
        await new Promise((resolve) => setTimeout(resolve, 1500));

        if ((i + 1) % 5 === 0) {
          logMemory(`after post ${i + 1}`);
        }
      }

      console.log(`\n🎉 Extraction complete for listing page ${pageNum}!`);
      console.log(`Total posts collected: ${postsDetailsArr.length}`);

      postsDetailsArr = cleanJobData(postsDetailsArr);
      postsDetailsArr = filterExpiredDeadlines(postsDetailsArr);
      postsDetailsArr = postsDetailsArr.filter(
        (p) => p.application_deadline !== "Unspecified"
      );

      console.log(
        `✅ Total valid posts after filtering: ${postsDetailsArr.length}`
      );

      // 3) STORE POSTS
      try {
        await checkPostsCount();
        let storeResult = await storePosts(postsDetailsArr);
        if (storeResult && storeResult.success && storeResult.inserted) {
          console.log(
            `successfully stored posts ..${storeResult.inserted}\nDetails: \n`,
            storeResult
          );
        } else {
          console.log(
            "No new documents available to insert at this time..",
            storeResult
          );
        }
      } catch (dbErr) {
        console.error("DB error (continuing):", dbErr.message);
      }

      // 4) CLOSE BROWSER for this listing page
      await closeBrowserResources(browser, page);
      browser = null;
      page = null;
      console.log(`🔌 Browser closed after listing page ${pageNum}`);

      if (global.gc) global.gc();
      await new Promise((r) => setTimeout(r, 4000));

      // Advance to next listing page (next iteration opens a fresh browser)
      if (pageNum < maxPages) {
        pageNum++;
        const nextPageLink = stockLink + `${pageNum}`;
        console.log(`🔗 Next listing page: ${nextPageLink}`);
        currentUrl = nextPageLink;
      } else {
        console.log(`📌 Reached max pages (${maxPages})`);
        break;
      }
    }
  } catch (error) {
    console.error("scrapeAllPages fatal error:", error.message);
  } finally {
    await closeBrowserResources(browser, page);
    if (global.gc) global.gc();
    logMemory("final cleanup");
  }
}

async function academy() {
  try {
    // DB first so we can restore the batch index across restarts
    await initializeDatabase();

    // Restore only the batch index (proxies are never persisted)
    lastGoodBatchIndex = await getProxyBatchIndex();
    proxyCursor = lastGoodBatchIndex;
    lastWorkingProxy = null;
    proxyFailCount = 0;

    // Fetch the FULL list once per run (website order)
    allProxies = await fetchFreshProxies();

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