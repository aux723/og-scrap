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
// Free proxies from https://spys.me/proxy.txt (selected ones with Google-passed + and/or SSL)
// These die quickly – replace often or switch to paid residential proxies for production.
// -------------------------------------------------------
const PROXY_LIST = [
  "74.91.117.249:3128",      // US-H-S +
  "108.161.135.118:80",      // US-H +
  "143.198.135.176:80",      // US-H +
  "96.1.101.113:80",         // CA-H +
  "163.172.167.48:80",       // FR-H +
  "104.129.203.85:9480",     // US-N-S +
  "107.161.178.244:3128",    // US-H-S +
  "137.184.76.67:3128",      // US-H +
  "162.214.74.29:8085",      // US-H +
  "5.8.41.106:3128",         // US-H-S +
  "154.9.254.25:58080",      // US-H-S +
  "64.181.247.193:443",      // US-H-S +
  "167.99.124.118:80",       // US-A +
  "198.111.166.184:80",      // US-H +
  "45.125.64.215:443",       // HK-H-S +
  "91.103.120.48:80",        // HK-H! +
  "69.165.75.99:8080",       // HK-H-S +
  "217.162.8.134:80",        // CH-H +
  "207.180.254.198:8080",    // FR-H +
  "62.210.215.36:80",        // FR-A +
  "109.199.119.160:80",      // FR-H +
  "34.140.137.151:80",       // BE-H +
  "194.14.207.87:8001",      // SE-H +
  "159.195.194.242:8080",    // DE-H-S! +
  "104.225.220.233:80",      // US-H +
];

let currentProxyIndex = 0;

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
  });
}

function isValidDeadline(dateString) {
  // If date is unspecified, assume it's valid
  if (!dateString || dateString === 'Unspecified') return true;

  // Extract ISO date (YYYY-MM-DD) from deadline string
  const isoPattern = /^\d{4}-\d{2}-\d{2}/;
  if (!isoPattern.test(dateString)) return true; // Keep if not ISO format

  // No need to split - dateString is already just "YYYY-MM-DD"
  const date = new Date(dateString);

  // Check if date is valid
  if (isNaN(date.getTime())) return true;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Return true if date is in the future or today, false if in the past
  return date >= today;
};

// Reusable filter function
function filterExpiredDeadlines(jobArray) {
  return jobArray.filter(job => {
    const isValid = isValidDeadline(job.application_deadline);

    if (!isValid) {
      console.log(`⏭️ SKIPPING: Deadline "${job.application_deadline}" is expired - ${job.post_title}`);
    }

    return isValid;
  });
};

function cleanJobData(jobArray) {
  return jobArray.map(job => {
    // Helper function to clean text
    const cleanText = (text) => {
      if (!text || text === 'Unspecified') return text;

      return text
        .replace(/\s*\n\s*/g, ' ')  // Replace newlines with spaces
        .replace(/,\s*,/g, ',')      // Remove empty commas (,,)
        .replace(/\s+/g, ' ')        // Collapse multiple spaces to single space
        .replace(/,\s+(and\s+\d+\s+more)/i, ', $1')  // Clean up "and X more"
        .replace(/\s*,\s*/g, ', ')   // Standardize comma spacing
        .replace(/,\s*,/g, ',')      // Remove any remaining empty commas
        .replace(/,\s+(?![^,]*and\s+\d+\s+more)/g, ', ') // Normalize comma spacing
        .trim();                      // Trim leading/trailing whitespace
    };

    // Clean deadline: remove duplicate date entries and extra whitespace
    const cleanDeadline = (deadline) => {
      if (!deadline || deadline === 'Unspecified') return deadline;

      // Get unique lines, filter out empty ones, take first valid date
      const lines = deadline.split('\n')
        .map(line => line.trim())
        .filter(line => line && line.length > 0);

      // Remove duplicates while preserving order
      const uniqueLines = [];
      for (const line of lines) {
        if (!uniqueLines.includes(line)) {
          uniqueLines.push(line);
        }
      }

      return uniqueLines[0].split(" ")[0] || deadline; // Return first unique date
    };

    return {
      ...job,
      field: cleanText(job.field),
      application_deadline: cleanDeadline(job.application_deadline)
    };
  });
};

async function extractPostDetails (postLink, page) {
  //extraction of post details in second page from the post primary link scrapped from first page
  try {
    console.log(`post link: ${postLink}`);
    await page.goto(`${postLink}`, {
      waitUntil: "domcontentloaded",
    });

    // Quick Cloudflare check on detail pages too
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

    //post_Inst = trimInst(post_Inst);

    let app_link = await page.evaluate(() => {
      const element = document.querySelector('#gtm-job-ad-apply-now-bottom-section'); //if link == apply; app_Link = Post_Link
      return element ? element.href : null;
    });

    let post_deadline = await page.evaluate(() => {
      const element = document.querySelector('#jobDetails > div > div:nth-child(5) > div.col-auto.col-md-8');
      return element ? element.textContent : null;
    }); //deadline format: 2026-06-14 || Unspecified


    let data = {
      post_title: post_title.trim(),
      institution: post_Inst.trim(),
      field: field.trim(),
      application_link: app_link,
      application_deadline: post_deadline.trim(),     //rolling posts deleted at the end of the scrap year (db code using the extracted year to delete post from db)
      postLink: `${postLink}`,
      insertionDate: formatDateForDB()
    };

    return data;
  } catch (error) {
    console.error(error.message)
    return null;
  }

};


async function launchBrowserWithProxy(proxy = null) {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
    '--disable-web-security',
    '--disable-features=VizDisplayCompositor',
    '--single-process',
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


async function scrapeAllPages (startUrl, maxPages = 10) {

  let browser;
  let page;
  let proxyAttempts = 0;
  const maxProxyAttempts = PROXY_LIST.length; // try all proxies once if needed

  // Helper to (re)start browser + page with a new proxy when Cloudflare blocks us
  async function getWorkingPage(currentUrl) {
    while (proxyAttempts < maxProxyAttempts) {
      const proxy = getNextProxy();
      proxyAttempts++;

      try {
        if (browser) {
          await browser.close().catch(() => {});
        }

        browser = await launchBrowserWithProxy(proxy);
        page = await browser.newPage();
        page.setDefaultNavigationTimeout(0);

        // Block images, stylesheets, and fonts
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
            req.abort();
          } else {
            req.continue();
          }
        });

        let userAgent = new UserAgent({ deviceCategory: "mobile" });
        let randomAgent = userAgent.toString();
        await page.setUserAgent(randomAgent);

        console.log(`📄 Navigating to: ${currentUrl}`);
        await page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

        // Wait a bit for possible Cloudflare JS challenge
        await new Promise(r => setTimeout(r, 4000));

        const challenged = await isCloudflareChallenge(page);
        if (challenged) {
          console.log(`🚫 Cloudflare challenge detected with proxy ${proxy} – trying next...`);
          continue; // try next proxy
        }

        // Extra safety: wait for real content
        try {
          await page.waitForSelector("h2", { visible: true, timeout: 15000 });
        } catch (e) {
          console.log(`⚠️ h2 selector not found – possible soft block. Trying next proxy.`);
          continue;
        }

        console.log(`✅ Proxy ${proxy} appears to work (no Cloudflare challenge)`);
        return page; // success
      } catch (err) {
        console.error(`❌ Failed with proxy ${proxy}: ${err.message}`);
        continue;
      }
    }

    // Last resort – try without any proxy
    console.log("⚠️ All proxies failed or exhausted. Trying direct connection...");
    if (browser) await browser.close().catch(() => {});
    browser = await launchBrowserWithProxy(null);
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
    let userAgent = new UserAgent({ deviceCategory: "mobile" });
    await page.setUserAgent(userAgent.toString());
    await page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    return page;
  }


  try {
    let currentUrl = startUrl;
    let pageNum = 1;
    const stockLink = "https://academicpositions.com/jobs/position/phd?page=";

    while (pageNum <= maxPages) {
      console.log(`\n📄 Scraping page ${pageNum}`);

      page = await getWorkingPage(currentUrl);

      // Final Cloudflare check
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
          if (link.href) {
            extractedLinks.push(link.href);
          }
        });

        return extractedLinks;
      });

      console.log(`Found ${links.length} job links on page ${pageNum}`);

      if (links.length === 0) {
        const debug = await page.evaluate(() => ({
          title: document.title,
          url: location.href,
          bodyText: document.body.innerText.slice(0, 500),
          hasJobDetails: !!document.querySelector('#jobDetails'),
          listItems: document.querySelectorAll('.list-group-item').length,
        }));
        console.log('DEBUG (empty links):', JSON.stringify(debug, null, 2));
      }

      let postsDetailsArr = [];

      for (let i = 0; i < links.length; i++) {
        console.log(`\n📌 Processing post ${i + 1}/${links.length}`);
        try {
          const result = await extractPostDetails(links[i], page);
          if (result) {
            postsDetailsArr.push(result);
            console.log(`✅ Post ${i + 1} added successfully`);
          } else {
            console.log(`⏭️ Post ${i + 1} skipped`);
          }
        } catch (err) {
          console.error(`❌ Failed to extract post ${i + 1}:`, err.message);
        }

        // Wait between requests
        await new Promise(resolve => setTimeout(resolve, 1200));
      };

      console.log(`\n🎉 Extraction complete!`);
      console.log(`Total posts collected: ${postsDetailsArr.length}`);
      postsDetailsArr = cleanJobData(postsDetailsArr);
      postsDetailsArr = filterExpiredDeadlines(postsDetailsArr);
      postsDetailsArr = postsDetailsArr.filter(p => {
        if (p.application_deadline != "Unspecified") {
          return p;
        }
      });

      console.log(`✅ Total valid posts after filtering: ${postsDetailsArr.length}`);

      await checkPostsCount();
      let result = await storePosts(postsDetailsArr);
      if (result && result.success && result.inserted) {
        console.log(`successfully stored posts ..${result.inserted}\nDetails: \n`, result);
      } else {
        console.log('No new documents available to insert at this time..', result);
      }

      if (pageNum < maxPages) {
        pageNum++;
        const nextPageLink = stockLink + `${pageNum}`;
        console.log(`🔗 Next page link: ${nextPageLink}`);
        currentUrl = nextPageLink;

        // Small delay between pages
        await new Promise(resolve => setTimeout(resolve, 2500));
      } else {
        console.log(`📌 Reached max pages (${maxPages})`);
        break;
      }
    }

    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    return;

  } catch (error) {
    console.error(error);
    if (browser) await browser.close().catch(() => {});
  }
};


async function academy () {

  try {
    await initializeDatabase();

    const baseUrl = "https://academicpositions.com/jobs/position/phd?page=";

    // Start with page 1
    await scrapeAllPages(baseUrl + "1", 2);

    await closeDatabase();
    console.log('returning to outer cron scope?...')
    return;

  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}


//console.profile();
//(async ()=> await academy())();
module.exports = { academy }