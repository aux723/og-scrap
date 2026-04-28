const cron = require("node-cron");


// Import the optimized database and AI functions
const {makePost} = require("./poster/poster.js"); //poster
const { scrapJobs } = require("./scraper/scraper.js"); //scraper
const { getNigerianTime, formatNigerianTime } = require("./utils/dateHelpers.js");

// --- Core Application Logic ---


// --- HTTP Server for Health Checks ---
const server = http.createServer((req, res) => {
  if (req.url === '/' && req.method === 'GET') {
    const serverTime = formatNigerianTime();
    const html = `
      <div style="font-family: monospace; line-height: 1.6;">
        <p>✅ [VSPPM] Server is running.</p>
        <p><strong>Server Time (Nigerian):</strong> ${serverTime}</p>
        <p><strong>Daily Schedule:</strong></p>
        <ul>
          <li>4:00 AM - Scrape new jobs</li>
          <li>10:00 AM - First post</li>
          <li>12:00 PM - Second post</li>
          <li>3:00 PM - Third post</li>
          <li>7:00 PM - Evening post</li>
        </ul>
      </div>
    `;

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

// --- Cron Jobs Setup ---
async function setupCronJobs() {
  // 4:00 AM - Early morning scraping job
  cron.schedule('0 4 * * *', async () => {
    console.log('🌅 4:00 AM - Scraping new jobs - executing scrapJobs()');
    await scrapJobs();
  }, {
    scheduled: true,
    timezone: "Africa/Lagos"
  });

  // 10:00 AM - First posting of the day
  cron.schedule('0 10 * * *', async () => {
    console.log('🌞 10:00 AM - Morning post - executing makePost()');
    await makePost();
  }, {
    scheduled: true,
    timezone: "Africa/Lagos"
  });

  // 12:00 PM - Second posting
  cron.schedule('0 12 * * *', async () => {
    console.log('☀️ 12:00 PM - Noon post - executing makePost()');
    await makePost();
  }, {
    scheduled: true,
    timezone: "Africa/Lagos"
  });

  // 3:00 PM - Third posting
  cron.schedule('0 15 * * *', async () => {
    console.log('🌤️ 3:00 PM - Afternoon post - executing makePost()');
    await makePost();
  }, {
    scheduled: true,
    timezone: "Africa/Lagos"
  });

  // 7:00 PM - Final posting of the day
  cron.schedule('0 19 * * *', async () => {
    console.log('🌙 7:00 PM - Evening post - executing makePost()');
    await makePost();
  }, {
    scheduled: true,
    timezone: "Africa/Lagos"
  });

  console.log('📅 Daily Schedule:');
  console.log('   - 4:00 AM: Scraping new jobs');
  console.log('   - 10:00 AM: First post');
  console.log('   - 12:00 PM: Second post');
  console.log('   - 3:00 PM: Third post');
  console.log('   - 7:00 PM: Final post');
}

// --- Server Startup and Graceful Shutdown ---
async function startServer() {
  try {
    const PORT = process.env.PORT || 5100;
    server.listen(PORT, async () => {
      console.log(`🟢 Server is live on port ${PORT}`);
      console.log(`⏰ Current Nigerian time: ${formatNigerianTime()}`);
      await setupCronJobs();
    });

    // Handle shutdown signals gracefully
    const shutdown = async () => {
      console.log("🔄 Shutting down server...");

      // Stop accepting new connections
      server.close(async (err) => {
        if (err) {
          console.error("❌ Error closing HTTP server:", err);
        } else {
          console.log("✅ HTTP server closed.");
        }

        process.exit(0);
      });

      // Force shutdown after 10 seconds
      setTimeout(() => {
        console.log("⚠️ Forcing shutdown...");
        process.exit(1);
      }, 10000);
    };

    process.on('SIGINT', shutdown);  // For local Ctrl+C
    process.on('SIGTERM', shutdown); // For hosting platform stop commands
    process.on('SIGQUIT', shutdown); // For additional graceful shutdown

  } catch (error) {
    console.error("❌ Failed to start the server:", error);
    process.exit(1);
  }
}

// Unhandled promise rejection handler
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Uncaught exception handler
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

startServer();