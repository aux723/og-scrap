

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker')
puppeteer.use(AdblockerPlugin({ blockTrackers: true }))
const UserAgent = require("user-agents");


async function scrap_predoc () {


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
    await page.goto("https://euraxess.ec.europa.eu/jobs/search?f%5B0%5D=positions%3Aphp_positions&page=1", {
      waitUntil: "domcontentloaded",
    });

    await page.waitForSelector(".ecl-page-header__title", {
      visible: true,
      timeout: 0,
    });


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

    //links = links.slice(0, 10); //limit to first 10 links for testing

   //extract text body here
   //see if the iterations can be all run in parallel to save time? - but will that crash the memory? can db accept paralallel writes?
    if (links.length > 0) {
        console.log('links extracted..')
    }

    links = links.slice(0, 3);
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
      let post_position = "PhD Program"


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
        return element ? element.textContent : null;
      });

      //const validDeadline = getValidDeadline(post_deadline);

      /*if (!validDeadline) {
        console.log(`⏭️ SKIPPING: Deadline "${post_deadline}" is expired or invalid - ${post_title}`);
        return null; // Skip this post
      }*/

      let data = {
        position: post_position,
        title: post_title,
        institution: post_Inst,
        application_link: app_link,
        application_deadline: post_deadline.split("-")[0].trim(),     //rolling posts deleted at the end of the scrap year
        postLink: `${postLink}`,
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

    console.log(`\n🎉 Extraction complete!`);
    console.log(`Total posts collected: ${postsDetailsArr.length}`);
    console.log(postsDetailsArr);


    await page.close();
    await browser.close();
    console.log('returning to outer cron scope?...')
    return;


  } catch (error) {
    console.error(error);
  }
}

//console.profile();
scrap_predoc();
//module.exports = {scrapJobs}
