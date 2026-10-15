const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker')
puppeteer.use(AdblockerPlugin({ blockTrackers: true }))
const UserAgent = require("user-agents");
const { formatDateForDB } = require('../../utils/dateHelpers.js');
const { storePosts, checkPostsCount, initializeDatabase,
  closeDatabase } = require('./academy-db.js');

// -------------------------------------------------------
// Free proxies – known-good ones first.
// Free public proxies die fast; prefer the one that already worked.
// -------------------------------------------------------
const PROXY_LIST = [
  "104.129.203.85:9480",     // known working from previous run
  "74.91.117.249:3128",
  "108.161.135.118:80",
  "143.198.135.176:80",
  "96.1.101.113:80",
  "163.172.167.48:80",
  "107.161.178.244:3128",
  "137.184.76.67:3128",
  "162.214.74.29:8085",
  "5.8.41.106:3128",
  "154.9.254.25:58080",
  "64.181.247.193:443",
  "167.99.124.118:80",
  "198.111.166.184:80",
  "45.125.64.215:443",
  "91.103.120.48:80",
  "69.165.75.99:8080",
  "217.162.8.134:80",
  "207.180.254.198:8080",
  "62.210.215.36:80",
  "109.199.119.160:80",
  "34.140.137.151:80",
  "194.14.207.87:8001",
  "159.195.194.242:8080",
  "104.225.220.233:80",
];

let lastWorkingProxy = "104.129.203.85:9480"; // remember what worked
let currentProxyIndex = 0;

// Restart browser every N detail pages to keep memory low on free tier
const BROWSER_RESTART_EVERY = 6;
// Max proxy attempts per browser creation (keeps free-tier from spawning too many Chromiums)
const MAX_PROXY_ATTEMPTS = 8;

function getNextProxy() {
  if (PROXY_LIST.length === 0) return null;
  const proxy = PROXY_LIST[currentProxyIndex % PROXY_LIST.length];
  currentProxyIndex++;
  return proxy;
}

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

function logMemory(label = "") {
  const used = process.memoryUsage();
  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);
  console.log(
    `🧠 Memory${label ? " [" + label + "]" : ""}: ` +
    `rss=${mb(used.rss)}MB  heapUsed=${mb(used.heapUsed)}MB  external=${mb(used.external)}MB`
  );
}

function isValidDeadline(dateString) {
  if (!dateString || dateString === 'Unspecified') return true;
  const isoPattern = /^\d{4}-\d{2}-\d{2}/;
  if (!isoPattern.test(dateString)) return true;
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return true;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date >= today;
}

function filterExpiredDeadlines(jobArray) {
  return jobArray.filter(job => {
    const isValid = isValidDeadline(job.application_deadline);
    if (!isValid) {
      console.log(`⏭️ SKIPPING: Deadline "${job.application_deadline}" is expired - ${job.post_title}`);
    }
    return isValid;
  });
}

function cleanJobData(jobArray) {
  return jobArray.map(job => {
    const cleanText = (text) => {
      if (!text || text === 'Unspecified') return text;
      return text
        .replace(/\s*\n\s*/g, ' ')
        .replace(/,\s*,/g, ',')
        .replace(/\s+/g, ' ')
        .replace(/,\s+(and\s+\d+\s+more)/i, ', $1')
        .replace(/\s*,\s*/g, ', ')
        .replace(/,\s*,/g, ',')
        .replace(/,\s+(?![^,]*and\s+\d+\s+more)/g, ', ')
        .trim();
    };

    const cleanDeadline = (deadline) => {
      if (!deadline || deadline === 'Unspecified') return deadline;
      const lines = deadline.split('\n')
        .map(line => line.trim())
        .filter(line => line && line.length > 0);
      const uniqueLines = [];
      for (const line of lines) {
        if (!uniqueLines.includes(line)) uniqueLines.push(line);
      }
      return uniqueLines[0].split(" ")[0] || deadline;
    };

    return {
      ...job,
      field: cleanText(job.field),
      application_deadline: cleanDeadline(job.application_deadline)
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
      const element = document.querySelector('#jobDetails > div > div:nth-child(1) > div.col-auto.col-md-8');
      return element ? element.textContent : null;
    });

    let post_Inst = await page.evaluate(() => {
      const element = document.querySelector('#jobDetails > div > div:nth-child(2) > div.col-auto.col-md-8');
      return element ? element.textContent : null;
    });

    let field = await page.evaluate(() => {
      const element = document.querySelector('#jobDetails > div > div:nth-child(7) > div.col-auto.col-md-8');
      return element ? element.textContent : null;
    });

    let app_link = await page.evaluate(() => {
      const element = document.querySelector('#gtm-job-ad-apply-now-bottom-section');
      return element ? element.href : null;
    });

    let post_deadline = await page.evaluate(() => {
      const element = document.querySelector('#jobDetails > div > div:nth-child(5) > div.col-auto.col-md-8');
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
      insertionDate: formatDateForDB()
    };
  } catch (error) {
    console.error(`extractPostDetails error: ${error.message}`);
    return null;
  }
}

async function launchBrowserWithProxy(proxy = null) {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
    '--disable-web-security',
    '--disable-features=VizDisplayCompositor',
    // Removed --single-process – it makes Chromium less stable under proxy failures
    '--js-flags=--max-old-space-size=384',
  ];

  if (proxy) {
    args.push(`--proxy-server=http://${proxy}`);
    console.log(`🌐 Using proxy: ${proxy}`);
  } else {
    console.log(`🌐 No proxy (direct connection)`);
  }

  const browser = await puppeteer.launch({
    headless: true,
    args,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });

  return browser;
}

/**
 * Try a single proxy (or direct). Returns {browser, page, proxy} or null on failure.
 * Never throws – caller decides what to do.
 */
async function tryOneProxy(targetUrl, proxy) {
  let browser = null;
  let page = null;

  try {
    browser = await launchBrowserWithProxy(proxy);
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(0);

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    const userAgent = new UserAgent({ deviceCategory: "mobile" });
    await page.setUserAgent(userAgent.toString());

    console.log(`📄 Navigating to: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });

    // Short wait for possible Cloudflare JS
    await new Promise(r => setTimeout(r, 3500));

    if (await isCloudflareChallenge(page)) {
      console.log(`🚫 Cloudflare challenge with proxy ${proxy || "direct"}`);
      await page.close().catch(() => {});
      await browser.close().catch(() => {});
      return null;
    }

    try {
      await page.waitForSelector("h2", { visible: true, timeout: 12000 });
    } catch (e) {
      console.log(`⚠️ h2 not found with proxy ${proxy || "direct"} – treating as soft block`);
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
 * Creates a working browser+page.
 * Strategy:
 *  1. Try lastWorkingProxy first (fast path)
 *  2. Then try up to MAX_PROXY_ATTEMPTS other proxies
 *  3. Finally try direct connection
 * Adds a small delay between attempts to avoid hammering the free tier.
 */
async function createWorkingBrowserAndPage(targetUrl) {
  // 1. Prefer the last proxy that actually worked
  if (lastWorkingProxy) {
    console.log(`🔁 Trying last working proxy first: ${lastWorkingProxy}`);
    const result = await tryOneProxy(targetUrl, lastWorkingProxy);
    if (result) {
      lastWorkingProxy = result.proxy;
      return result;
    }
    // small cooldown after failure
    await new Promise(r => setTimeout(r, 2000));
  }

  // 2. Try a limited number of other proxies
  let attempts = 0;
  while (attempts < MAX_PROXY_ATTEMPTS) {
    const proxy = getNextProxy();
    // skip if it is the same as lastWorkingProxy (already tried)
    if (proxy === lastWorkingProxy) {
      attempts++;
      continue;
    }

    const result = await tryOneProxy(targetUrl, proxy);
    if (result) {
      lastWorkingProxy = result.proxy;
      return result;
    }

    attempts++;
    // cooldown between launches – critical on free tier
    await new Promise(r => setTimeout(r, 2500));
  }

  // 3. Last resort – direct connection
  console.log("⚠️ All limited proxies failed. Trying direct connection...");
  const direct = await tryOneProxy(targetUrl, null);
  if (direct) {
    lastWorkingProxy = null;
    return direct;
  }

  throw new Error("Could not obtain a working browser/page after limited proxy attempts");
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
        console.error(`🚫 Failed to get working page for listing ${pageNum}: ${err.message}`);
        break;
      }

      if (await isCloudflareChallenge(page)) {
        console.log("🚫 Still blocked by Cloudflare after all attempts. Aborting.");
        break;
      }

      await page.waitForSelector("h2", {
        visible: true,
        timeout: 20000,
      }).catch(() => console.log("h2 wait timed out"));

      let links = await page.evaluate(() => {
        let jobListingElements = document.querySelectorAll(".list-group-item.text-reset.text-decoration-none > a");
        let extractedLinks = [];
        jobListingElements.forEach((link) => {
          if (link.href) extractedLinks.push(link.href);
        });
        return extractedLinks;
      }).catch(() => []);

      // Limit to 20 links per page to reduce memory / runtime pressure on free tier
      if (links.length > 20) {
        console.log(`Found ${links.length} job links – limiting to first 20`);
        links = links.slice(0, 20);
      } else {
        console.log(`Found ${links.length} job links on page ${pageNum}`);
      }

      if (links.length === 0) {
        const debug = await page.evaluate(() => ({
          title: document.title,
          url: location.href,
          bodyText: document.body ? document.body.innerText.slice(0, 500) : "",
          listItems: document.querySelectorAll('.list-group-item').length,
        })).catch(() => ({}));
        console.log('DEBUG (empty links):', JSON.stringify(debug, null, 2));
      }

      let postsDetailsArr = [];

      for (let i = 0; i < links.length; i++) {
        console.log(`\n📌 Processing post ${i + 1}/${links.length}`);

        // Restart browser every N posts
        if (postsSinceRestart >= BROWSER_RESTART_EVERY) {
          console.log(`♻️ Restarting browser after ${postsSinceRestart} posts (memory hygiene)`);
          logMemory("before restart");

          try {
            if (page) await page.close().catch(() => {});
            if (browser) await browser.close().catch(() => {});
          } catch (_) {}

          if (global.gc) {
            global.gc();
            console.log("🗑️ Forced garbage collection");
          }

          // Important: give the OS a moment to reclaim memory before launching again
          await new Promise(r => setTimeout(r, 3000));

          try {
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
          console.error(`❌ Unexpected error on post ${i + 1}: ${err.message}`);

          // Try to recover the page
          try {
            if (page) await page.close().catch(() => {});
            page = await browser.newPage();
            page.setDefaultNavigationTimeout(0);
            await page.setRequestInterception(true);
            page.on('request', (req) => {
              if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
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
            postsSinceRestart = BROWSER_RESTART_EVERY; // force full restart next time
          }
        }

        postsSinceRestart++;
        await new Promise(resolve => setTimeout(resolve, 1500));

        if ((i + 1) % 5 === 0) {
          logMemory(`after post ${i + 1}`);
        }
      }

      console.log(`\n🎉 Extraction complete for page ${pageNum}!`);
      console.log(`Total posts collected: ${postsDetailsArr.length}`);

      postsDetailsArr = cleanJobData(postsDetailsArr);
      postsDetailsArr = filterExpiredDeadlines(postsDetailsArr);
      postsDetailsArr = postsDetailsArr.filter(p => p.application_deadline !== "Unspecified");

      console.log(`✅ Total valid posts after filtering: ${postsDetailsArr.length}`);

      try {
        await checkPostsCount();
        let result = await storePosts(postsDetailsArr);
        if (result && result.success && result.inserted) {
          console.log(`successfully stored posts ..${result.inserted}\nDetails: \n`, result);
        } else {
          console.log('No new documents available to insert at this time..', result);
        }
      } catch (dbErr) {
        console.error("DB error (continuing):", dbErr.message);
      }

      // Clean up before next listing page
      try {
        if (page) await page.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        browser = null;
        page = null;
      } catch (_) {}

      if (global.gc) global.gc();

      // Extra pause between listing pages – reduces chance of Render kill
      await new Promise(r => setTimeout(r, 4000));

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
    await initializeDatabase();

    const baseUrl = "https://academicpositions.com/jobs/position/phd?page=";
    await scrapeAllPages(baseUrl + "1", 2);

    await closeDatabase();
    console.log('Academy scraper finished cleanly. Returning to outer scope...');
    return;
  } catch (error) {
    console.error("Academy top-level error:", error.message);
    throw error;
  }
}

module.exports = { academy };