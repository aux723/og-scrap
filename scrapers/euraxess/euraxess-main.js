

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker')
puppeteer.use(AdblockerPlugin({ blockTrackers: true }))
const UserAgent = require("user-agents");
const { formatDateForDB } = require('../../utils/dateHelpers.js');

{/**UTILITIES START */}

function isDateInFuture(dateString) {
  const months = {
      'jan': 0, 'feb': 1, 'mar': 2, 'apr': 3, 'may': 4, 'jun': 5,
      'jul': 6, 'aug': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dec': 11
  };

  const [day, monthName, year] = dateString.trim().split(' ');
  const date = new Date(year, months[monthName.toLowerCase()], parseInt(day, 10));
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // If date is in the future, return the original date string
  if (date > today) {
      return dateString;
  }

  // Otherwise return false
  return false;
}

async function scrapeAllPages(page, startUrl, maxPages = 2) {
  let allLinks = [];
  let currentUrl = startUrl;
  let pageNum = 1;

  while (pageNum <= maxPages) {
    console.log(`\n📄 Scraping page ${pageNum}: `); //${currentUrl}

    // Navigate to the current page
    await page.goto(currentUrl, {
      waitUntil: "domcontentloaded",
    });

    await page.waitForSelector(".ecl-page-header__title", {
      visible: true,
      timeout: 0,
    });

    // Extract links from current page
    let links = await page.evaluate(() => {
      let jobListingElements = document.querySelectorAll(".ecl-content-block__title>a");
      let extractedLinks = [];

      jobListingElements.forEach((link) => {
        if (link.href) {
          extractedLinks.push(link.href);
        }
      });

      return extractedLinks;
    });

    console.log(`✅ Found ${links.length} links on page ${pageNum}`);
    allLinks.push(...links);

    // Try to find the next page link
    const nextPageLink = await page.evaluate(() => {
      const nextButton = document.querySelector("#oe-list-container > div:nth-child(4) > div > nav > ul > li:nth-child(2) > a");
      if (nextButton && nextButton.href) {
        return nextButton.href;
      }
      return null;
    });

    if (nextPageLink && pageNum < maxPages) {
      console.log(`🔗 Next page link found: `); //${nextPageLink}
      currentUrl = nextPageLink;
      pageNum++;

      // Add delay between page requests
      await new Promise(resolve => setTimeout(resolve, 2000));
    } else {
      console.log(`📌 No more pages or reached max pages (${maxPages})`);
      break;
    }
  }

  console.log(`\n📊 Total links collected from ${pageNum} page(s): ${allLinks.length}`);
  return allLinks;
}

{/**UTILITIES END */}


async function scrap_euro () {


    let browser;
    browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
      '--single-process',
    ],
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });


  let page;

  try {
    page = await browser.newPage();
    // remove timeout limit
    page.setDefaultNavigationTimeout(0);

    // Block images, stylesheets, and fonts to save memory and bandwidth
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    let userAgent = new UserAgent({ deviceCategory: "mobile" }); //desktop
    let randomAgent = userAgent.toString();
    await page.setUserAgent(randomAgent);


    const baseUrl = "https://euraxess.ec.europa.eu/jobs/search?f%5B0%5D=positions%3Aphp_positions";

    // Scrape all pages (max 8 pages as requested)
    let links = await scrapeAllPages(page, baseUrl, 3);

    //links = links.slice(0, 10); //limit to first 10 links for testing

   //extract text body here
   //see if the iterations can be all run in parallel to save time? - but will that crash the memory? can db accept paralallel writes?
    if (links.length > 0) {
        console.log(`total links extracted: ${links.length}`)
    }

    links = links.slice(8, 20);
    let postsDetailsArr = [];

    async function extractPostDetails (postLink) {
      //extraction of post details in second page from the post primary link scrapped from first page
      console.log(`post link: ${postLink}`);
      await page.goto(`${postLink}`, {
        waitUntil: "domcontentloaded",
      });

      await page.waitForSelector(".ecl-content-block__title", {
        visible: true,
        timeout: 0,
      });

      let post_title = await page.evaluate(() => {
        const element = document.querySelector('.ecl-content-block__title');
        return element ? element.textContent : null;
      });

      //post_title = cleanPhdTitle(post_title);

      //check if post_title contains this string, "Phd Studentship:", replace with empty string and trim
      let post_position = "Graduate Program"


      let post_Inst = await page.evaluate(() => {
        const element = document.querySelector('#block-rtd-euraxess-main-page-content > article > div > div.ecl-row.ecl-u-mt-l > div.ecl-col-l-9 > div:nth-child(2) > dl > dd:nth-child(2) > div');
        return element ? element.textContent : null;
      });

      //post_Inst = trimInst(post_Inst);

      let app_link = await page.evaluate(() => {
        const element = document.querySelector('#block-rtd-euraxess-euraxesspageheader > div > div > div > div > div > a');
        return element ? element.href : null;
      });

      let post_deadline = await page.evaluate(() => {
        const element = document.querySelector('time');
        return element ? element.textContent : '';
      });

      const validDeadline = isDateInFuture(post_deadline.split("-")[0].trim());

      if (!validDeadline) {
        console.log(`⏭️ SKIPPING: Deadline ${post_deadline} is expired or invalid FOR POST: ${postLink}`);
        return null; // Skip this post
      }

      let data = {
        position: post_position,
        title: post_title,
        institution: post_Inst,
        application_link: app_link,
        application_deadline: validDeadline,     //rolling posts deleted at the end of the scrap year
        postLink: `${postLink}`,
        insertionDate: formatDateForDB()
      };

      return data;

    };

    for (let i = 0; i < links.length; i++) {
      console.log(`\n📌 Processing post ${i + 1}/${links.length}`);
      try {
        const result = await extractPostDetails(links[i]);
        if (result) {
          postsDetailsArr.push(result);
          console.log(`✅ Post ${i + 1} added successfully`);
        } else {
          console.log(`⏭️ Post ${i + 1} skipped (deadline expired)`);
        }
      } catch (err) {
        console.error(`❌ Failed to extract post ${i + 1}:`, err.message);
      }

      // Wait between requests
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log(`\n🎉 Extraction complete!`); //filter out post with Professor/lecturer in their title
    console.log(`Total posts collected: ${postsDetailsArr.length}`);
    let totalFiltered = 0;
    postsDetailsArr = postsDetailsArr.filter(post=>{
      if(post.title.toLowerCase().includes("professor")||post.title.includes("lecturer")||post.title.includes("phd or equivalent")) {
        console.log(`filtered out post title: ${post.title}`); totalFiltered++;
        return
      } else {
        return post
      }
    });

    if (totalFiltered>0) {console.log(`total filtered out posts: ${totalFiltered}`)};
    console.log(postsDetailsArr);
    //add to db here

    await page.close();
    await browser.close();
    console.log('returning to outer cron scope?...')
    return;


  } catch (error) {
    console.error(error);
  }
}

//console.profile();
scrap_euro();
//module.exports = {scrapJobs}

//#block-rtd-euraxess-main-page-content > article > div > div.ecl-row.ecl-u-mt-l > div.ecl-col-l-9 > div:nth-child(2) > dl > dd:nth-child(12) > div > time
//#block-rtd-euraxess-main-page-content > article > div > div.ecl-row.ecl-u-mt-l > div.ecl-col-l-9 > div:nth-child(2) > dl > dd:nth-child(10) > div > time