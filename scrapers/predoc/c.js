const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker');
puppeteer.use(AdblockerPlugin({ blockTrackers: true }));
const UserAgent = require("user-agents");
const { formatDateForDB } = require('../../utils/dateHelpers.js');

function parseDeadline(deadlineText) {
    const rollingKeywords = ['rolling', 'rolling basis', 'accepted on a rolling basis', 'considered on a rolling basis', 'first review'];
    if (rollingKeywords.some(keyword => deadlineText.toLowerCase().includes(keyword))) {
        return { isValid: true, date: null, displayText: 'Rolling' };
    }

    const patterns = [
        // 1. ADD THIS: Specific DD/MM/YYYY or D/M/YYYY (European/Global format)
        {
          regex: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
          parse: (m) => new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]))
        },
        // 2. Month Day, Year (e.g., April 1st, 2026)
        {
          regex: /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,\s+(\d{4})/,
          parse: (m) => new Date(`${m[1]} ${m[2]}, ${m[3]}`)
        },
        // 3. MM/DD/YY (American short format) - keep this as a fallback
        {
          regex: /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/,
          parse: (m) => {
            let year = 2000 + parseInt(m[3]);
            return new Date(year, parseInt(m[1]) - 1, parseInt(m[2]));
          }
        }
    ];

    for (const pattern of patterns) {
        const match = deadlineText.match(pattern.regex);
        if (match) {
            try {
                const date = pattern.parse(match);
                if (!isNaN(date.getTime())) {
                    const now = new Date();
                    now.setHours(0, 0, 0, 0); // Reset time to compare only dates

                    // CRITICAL: Ensure the date is strictly today or in the future
                    if (date >= now) {
                        return {
                            isValid: true,
                            date,
                            displayText: date.toLocaleDateString('en-GB') // Standardize to DD/MM/YYYY for display
                        };
                    }
                }
            } catch (e) { continue; }
        }
    }
    return { isValid: false, date: null, displayText: null };
}

function filterFutureDeadlines(posts) {
    return posts.filter(post => {
        // Find the line containing the deadline keywords
        let deadlineIndex = post.textLines.findIndex(line =>
            line.toLowerCase().includes('deadline') || line.toLowerCase().includes('first review')
        );

        // If no deadline info is found, we assume it's rolling/permanent
        if (deadlineIndex === -1) return true;

        let deadlineValue = post.textLines[deadlineIndex];

        // Clean the label to get just the date string
        let deadlineText = deadlineValue
            .replace(/deadline:?\s*/i, '')
            .replace(/first review date:?\s*/i, '')
            .trim();

        const result = parseDeadline(deadlineText);

        if (result.isValid) {
            // Update the line in the original object with the cleaned date
            post.textLines[deadlineIndex] = `Deadline: ${result.displayText}`;
            return true; // Keep the post
        }

        return false; // Remove the post because the date is in the past
    });
}

async function scrap_predoc() {

    let browser = await puppeteer.launch({
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

    try {
        const page = await browser.newPage();
        let userAgent = new UserAgent({ deviceCategory: "mobile" });
        await page.setUserAgent(userAgent.toString());

        await page.goto("https://www.predoc.org/opportunities", { waitUntil: "domcontentloaded" });
        await page.waitForSelector(".swiss-text", { timeout: 30000 });

        let textData = await page.evaluate(() => {
            const containers = document.querySelectorAll(".swiss-text");
            return Array.from(containers).map(container => {
                const link = container.querySelector("a")?.href || null;
                const rawText = container.textContent.trim();
                const textLines = rawText.split('\n').map(line => line.trim()).filter(line => line.length > 0);
                return { textLines, link };
            }).filter(item => item.textLines.length > 0);
        });

        // Clean and Reformat lines
        let cleanedData = textData.map(obj => {
            let lines = obj.textLines;
            // Extract the heading (usually the last line in the raw swiss-text block)
            let heading = lines[lines.length - 1];
            let details = lines.slice(0, lines.length - 1);

            let processedLines = [heading, ...details]
                .filter(st => !/NOTE:|INFO SESSION|Start Date:|Expected Start Date:/i.test(st));

            return {
                textLines: [...new Set(processedLines)],
                link: obj.link
            };
        });

        let filteredPosts = filterFutureDeadlines(cleanedData);

        console.log(`\n=== Original posts: ${cleanedData.length} ===`);
        console.log(`=== Valid future posts: ${filteredPosts.length} ===\n`);

        /*function telegram () {

        let finalPosts = filteredPosts.map((post, index) => {
            let postLink = post.link;
            post = post.textLines
            let deadline_index = post.findIndex(item => item.includes('Deadline:'));
            let post_deadline = post[deadline_index];
            let post_heading = post[0];
            //post.splice(deadline_index, 1);
            //post.splice(0, 1);
            post = post.filter(item => item.includes(':'));
            let visa_index = post.findIndex(item => item.includes('Visa:'));
            if (visa_index!==-1) {
              post[visa_index] = 'Visa sponsorship available'
            };

            let dlIndex = post.findIndex(item => item.includes('Deadline:'));
            if (dlIndex!==-1) {
                post[dlIndex] = '';
              };

            post = post.map(x => '🔰 ' + x);
            post = 'HIRING: ' + post_heading + '\n\n' + post.join('\n') + '\n\n' + post_deadline + '\n' + postLink
           //let post_body = post.splice(1, post.length-1);
            //console.log(post)
            //add insertion date
              return { title: post_heading, body:post, link: postLink, deadline: post_deadline, source: 'predoc-web', target: 'telegram', insertionDate: formatDateForDB() };

          //return { ...post, tag: 'from: predoc-web' };
      });

      finalPosts = finalPosts.slice(0, 6);
      console.log(finalPosts);
      };*/


      function twitter() {
        let finalPosts = filteredPosts.map((postObj) => {
            let postLink = postObj.link;
            // Use a copy to avoid mutating the original data structure
            let lines = [...postObj.textLines];

            let deadline_index = lines.findIndex(item => item.includes('Deadline:'));
            let post_deadline = deadline_index !== -1 ? lines[deadline_index] : 'Rolling';
            let post_heading = lines[0];

            let twitterDisplayLines = [];

            // 1. Handle Sponsoring Researcher
            let resIdx = lines.findIndex(item => item && item.includes('Sponsoring Researcher'));
            if (resIdx !== -1 && lines[resIdx]) {
                let val = lines[resIdx].split(':')[1] || "";

                // Logic: Split by comma OR the word 'and', then take the first result
                let firstResearcher = val.split(/,| and /i)[0].trim();

                twitterDisplayLines.push('Sponsor: ' + firstResearcher);
            }

            // 2. Handle Sponsoring Institution
            let instIdx = lines.findIndex(item => item && item.includes('Sponsoring Institution'));
            if (instIdx !== -1 && lines[instIdx]) {
                let instVal = lines[instIdx].split(':')[1] || "";
                twitterDisplayLines.push('Institution: ' + instVal.trim());
            }

            // 3. Clean up the heading
            if (post_heading && post_heading.includes('Pre-Doctoral Research Fellow')) {
                post_heading = 'Pre-Doctoral Research Fellow';
            }

            // 4. Final Formatting
            let formattedBody = twitterDisplayLines.map(x => '🔰 ' + x);
            let fullBodyText = 'HIRING: ' + post_heading + '\n\n' +
                               formattedBody.join('\n') + '\n\n' +
                               post_deadline + '\n' + postLink;

            return {
                title: post_heading,
                body: fullBodyText,
                link: postLink,
                deadline: post_deadline,
                source: 'predoc-web',
                target: 'twitter',
                insertionDate: formatDateForDB()
            };
        });

        // Output a small sample to verify
        console.log(finalPosts.slice(15, 28));
    }

            twitter();
            await page.close();
            await browser.close();
            console.log('returning to outer cron scope?...')
            return;

    } catch (error) {
        console.error("Scraping failed:", error);
    }
}

scrap_predoc();