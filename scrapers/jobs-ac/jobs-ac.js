

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
    await page.goto("https://www.jobs.ac.uk/search/?academicDisciplineFacet[0]=psychology&academicDisciplineFacet[1]=physical-and-environmental-sciences&subDisciplineFacet[0]=geography&academicDisciplineFacet[2]=mathematics-and-statistics&subDisciplineFacet[1]=mathematics&subDisciplineFacet[2]=statistics&academicDisciplineFacet[3]=computer-sciences&subDisciplineFacet[3]=computer-science&subDisciplineFacet[4]=information-systems&subDisciplineFacet[5]=artificial-intelligence&subDisciplineFacet[6]=cyber-security&academicDisciplineFacet[4]=engineering-and-technology&subDisciplineFacet[7]=other-engineering&academicDisciplineFacet[5]=architecture-building-and-planning&subDisciplineFacet[8]=urban-and-rural-planning&academicDisciplineFacet[6]=economics&academicDisciplineFacet[7]=social-sciences-and-social-care&subDisciplineFacet[9]=sociology&subDisciplineFacet[10]=social-policy&subDisciplineFacet[11]=human-and-social-geography&academicDisciplineFacet[8]=information-management-and-librarianship&subDisciplineFacet[12]=information-science&jobTypeFacet[0]=phds&expired-job-redirect=true", {
      waitUntil: "domcontentloaded",
    });

    await page.waitForSelector("h2", {
      visible: true,
      timeout: 0,
    });


    let links = await page.evaluate(() => {
      let jobListingElements = document.querySelectorAll(".swiss-text>a");
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
        console.log(links)
    }

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
