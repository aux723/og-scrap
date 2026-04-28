//remove posts that are in the past
//develop models for telegram and x
//before adding to own db, check if link is contained in main-posted-db and main-db to ensure that only unique links are added to the db
//add tag to scrap-obj eg. from: predoc-x or from: predox-tg
//add posts from both collections to main-posted-db
//if no new post; delete posts from main-posted-db using their tags

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker')
puppeteer.use(AdblockerPlugin({ blockTrackers: true }))
const UserAgent = require("user-agents");
//const { generateJobPost } = require("./gen_post.js");
//const { storeJob, initializeDatabase, closeDatabase } = require('../db.js');
//const { getCurrentLagosTime, formatDateForDB, isJobDeadlineValid } = require('../utils/dateHelpers.js');
/**
 * Parses a deadline string and returns a Date object if a valid future date is found
 * @param {string} deadlineText - The deadline text to parse
 * @returns {Object} - { isValid: boolean, date: Date|null, displayText: string }
 */
function parseDeadline(deadlineText) {
    // Check if it's rolling basis (no fixed deadline)
    const rollingKeywords = ['rolling', 'rolling basis', 'accepted on a rolling basis', 'considered on a rolling basis'];
    if (rollingKeywords.some(keyword => deadlineText.toLowerCase().includes(keyword))) {
        return { isValid: true, date: null, displayText: 'Rolling' };
    }

    // Extract date patterns
    const patterns = [
        // Month Day, Year (e.g., April 1st, 2026)
        { regex: /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,\s+(\d{4})/,
          parse: (m) => new Date(`${m[1]} ${m[2]}, ${m[3]}`) },
        // Month Day (e.g., December 18) - assume current year or next year
        { regex: /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?!,\s+\d{4})/,
          parse: (m) => {
            let year = new Date().getFullYear();
            let date = new Date(`${m[1]} ${m[2]}, ${year}`);
            if (date < new Date()) {
                date = new Date(`${m[1]} ${m[2]}, ${year + 1}`);
            }
            return date;
          } },
        // MM/DD/YY or MM/DD/YYYY (e.g., 3/19/25, 12/14/25)
        { regex: /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/,
          parse: (m) => {
            let year = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
            return new Date(year, parseInt(m[1]) - 1, parseInt(m[2]));
          } },
        // DD.MM.YYYY (e.g., 31.01.2026)
        { regex: /(\d{1,2})\.(\d{1,2})\.(\d{4})/,
          parse: (m) => new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1])) },
        // Day Month Year (e.g., 4 January 2026)
        { regex: /(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/,
          parse: (m) => new Date(`${m[2]} ${m[1]}, ${m[3]}`) },
        // Month Day, Year with time (e.g., October 27, 5pm)
        { regex: /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,\s+\d{1,2}(?:am|pm)/i,
          parse: (m) => {
            let year = new Date().getFullYear();
            let date = new Date(`${m[1]} ${m[2]}, ${year}`);
            if (date < new Date()) {
                date = new Date(`${m[1]} ${m[2]}, ${year + 1}`);
            }
            return date;
          } },
        // Month Day, Year with "for applications" or similar (e.g., February 1st 2026 for applications)
        { regex: /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?\s+(\d{4})/,
          parse: (m) => new Date(`${m[1]} ${m[2]}, ${m[3]}`) }
    ];

    for (const pattern of patterns) {
        const match = deadlineText.match(pattern.regex);
        if (match) {
            try {
                const date = pattern.parse(match);
                if (!isNaN(date.getTime())) {
                    // Check if date is in the future
                    const now = new Date();
                    now.setHours(0, 0, 0, 0);
                    if (date >= now) {
                        // Format date nicely
                        const formattedDate = date.toLocaleDateString('en-US', {
                            year: 'numeric',
                            month: 'long',
                            day: 'numeric'
                        });
                        return { isValid: true, date, displayText: formattedDate };
                    } else {
                        return { isValid: false, date: null, displayText: null };
                    }
                }
            } catch (e) {
                continue;
            }
        }
    }

    // If no date pattern matches, check if it might be a valid rolling basis variant
    if (deadlineText.toLowerCase().includes('first review')) {
        return { isValid: true, date: null, displayText: 'Rolling' };
    }

    // Default: treat as invalid (past or unrecognizable)
    return { isValid: false, date: null, displayText: null };
}

/**
 * Filters posts to keep only those with future deadlines or rolling basis
 * @param {Array} posts - Array of post objects with deadline field
 * @returns {Array} - Filtered posts with updated deadline display text
 */
function filterFutureDeadlines(posts) {
    const filteredPosts = [];

    for (const post of posts) {
        // Find the deadline field in the post
        let deadlineIndex = -1;
        let deadlineValue = '';

        for (let i = 0; i < post.length; i++) {
            if (post[i].toLowerCase().includes('deadline') ||
                post[i].toLowerCase().includes('first review')) {
                deadlineIndex = i;
                deadlineValue = post[i];
                break;
            }
        }

        if (deadlineIndex === -1) {
            // No deadline field, treat as rolling
            filteredPosts.push(post);
            continue;
        }

        // Extract the deadline text (remove the label)
        let deadlineText = deadlineValue.replace(/deadline:?\s*/i, '').replace(/first review date:?\s*/i, '').trim();

        // Parse the deadline
        const result = parseDeadline(deadlineText);

        if (result.isValid) {
            // Update the deadline field with the standardized display text
            const updatedPost = [...post];
            const newDeadlineText = `Deadline: ${result.displayText}`;
            updatedPost[deadlineIndex] = newDeadlineText;
            filteredPosts.push(updatedPost);
        }
        // If not valid (date in the past), skip this post entirely
    }

    return filteredPosts;
}

async function scrap_predoc () {

    //await initializeDatabase();


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
    await page.goto("https://www.predoc.org/opportunities", {
      waitUntil: "domcontentloaded",
    });

    await page.waitForSelector("h2", {
      visible: true,
      timeout: 0,
    });


    let textData = await page.evaluate(() => {
      // Target the p tags within the .swiss-text container
      let containers = document.querySelectorAll(".swiss-text");
      let results = [];

      containers.forEach((p) => {
        // Option A: Get all text content combined
        // results.push(p.innerText.trim());

        // Option B: Get text of specific child elements individually

          const text = p.textContent.trim();
          if (text) {
            results.push([text]);
          }
      });

      return results;
    });

    //run fnc to get links here;

    /*if (textData.length > 0) {
        console.log(textData);
    }*/

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

    console.log(`totl ln length: ${links.length}\ntotl text length: ${textData.length}`);
    //move link to textData arr;
    //2d iteration
    textData = textData.map(x=>x[0].split('\n'))


    let new_arr = [];

    textData.forEach(t => {
      let text_cy = [...t];
      let h = text_cy[text_cy.length - 1];
      h = h.trim();
      let ext = text_cy.splice(0, (text_cy.length - 2));
      let new_text = [h, ...ext];
      new_arr.push(new_text)
    });


    new_arr = new_arr.map(x=>{
      x = x.filter(st => /\S/.test(st));//remove element if it contains NOTE: Link is currently down but will be up again next week
      x = x.filter(st => !st.includes('NOTE:'));
      x = x.filter(st => !st.includes('INFO SESSION'));
      x = x.filter(st => !st.includes('Expected Start Date:'));
      x = [...new Set(x)];
      return x;
    });

    //new_arr = new_arr.slice(0, 15);
    //console.log(new_arr);
    let filteredPosts = filterFutureDeadlines(new_arr);

    console.log(`\n=== Original posts: ${new_arr.length} ===`);
    console.log(`=== Posts with future deadlines: ${filteredPosts.length} ===\n`);

    //write fn for tg; formats and sends to db;
    //fn for x; formats and also sends to db;
    //convert the code below to a fn

    /*function telegram () {

      let finalPosts = filteredPosts.map((post, index) => {
        if (index < links.length) {
          let deadline_index = post.findIndex(item => item.includes('Deadline:'));
          let post_deadline = post[deadline_index];
          let post_heading = post[0];
          post.splice(deadline_index, 1);
          post.splice(0, 1);
          post = post.filter(item => item.includes(':'));
          let visa_index = post.findIndex(item => item.includes('Visa:'));
          if (visa_index!==-1) {
            post[visa_index] = 'Visa sponsorship available'
          };

          post = post.map(x => '🔰 ' + x);
          post = 'Hiring: ' + post_heading + '\n\n' + post.join('\n') + '\n\n' + post_deadline + '\n' + links[index]
         //let post_body = post.splice(1, post.length-1);
          console.log(post)
            return { title: post_heading, body:post, link: links[index], deadline: post_deadline, source: 'predoc-web', target: 'tg' };
        }
        //return { ...post, tag: 'from: predoc-web' };
    });

    finalPosts = finalPosts.slice(0, 6);
    console.log(finalPosts);
    };*/


  function twitter () {

    let finalPosts = filteredPosts.map((post, index) => {
      if (index < links.length) {
        let deadline_index = post.findIndex(item => item.includes('Deadline:'));
        let post_deadline = post[deadline_index];
        let post_heading = post[0];
        //post.splice(deadline_index, 1);
        //post.splice(0, 1);
        let field_index = post.findIndex(item => item.includes('Fields of Research:')); post.splice(field_index, 1);
        let field_index_2 = post.findIndex(item => item.includes('Field(s) of Research:')); post.splice(field_index_2, 1);
        post = post.filter(item => item.includes(':'));
        let visa_index = post.findIndex(item => item.includes('Visa:'));
        if (visa_index!==-1) {
          post[visa_index] = 'Visa sponsorship available'
        };
        //reduce to 2 sponsor researchers
        let sponsor_researchers_index = post.findIndex(item => item.includes('Sponsoring Researcher(s):'));
        if (sponsor_researchers_index!==-1) {
          //check for , len
          let com_arr = post[sponsor_researchers_index].split(',');
          if(com_arr.length > 2) {
            post[sponsor_researchers_index] = com_arr.splice(0, 2)
          }
          post[visa_index] = 'Visa sponsorship available'
        };

        post = post.map(x => '🔰 ' + x);
        post = 'HIRING: ' + post_heading + '\n\n' + post.join('\n') + '\n\n' + post_deadline + '\n\n' + links[index]
       //let post_body = post.splice(1, post.length-1);
        //console.log(post)
          return { title: post_heading, body:post, link: links[index], deadline: post_deadline, source: 'predoc-web', target: 'tg' };
      }
      //return { ...post, tag: 'from: predoc-web' };
  });

  finalPosts = finalPosts.slice(0, 6);
  console.log(finalPosts);
  }

    twitter();
    await page.close();
    await browser.close();
    console.log('returning to outer cron scope?...')
    return;

//title; sponsoring researchers, sponsoring institution, deadline:
  } catch (error) {
    console.error(error);
  }
}

//console.profile();
scrap_predoc();
//module.exports = {scrapJobs}
