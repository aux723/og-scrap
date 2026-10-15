const cron = require("node-cron");

const { base_scraper } = require("./scrapers/scholarships-future/sft-main.js");
const { sa_base_scraper } = require("./scrapers/scholarships-aid/sa-main.js");
const { get_jobs_ac_data } = require("./scrapers/jobs-ac/jobs-ac-main.js");
const { scrap_predoc } = require("./scrapers/predoc/predoc-main.js");
const { academy } = require("./scrapers/academy-pos/academy-main.js");
const { getNigerianTime, formatNigerianTime } = require("./utils/dateHelpers.js");
const http = require("http");

// --- Core Application Logic ---
let isJobRunning = false;

// --- HTTP Server for Health Checks ---
const server = http.createServer((req, res) => {
  if (req.url === "/" && req.method === "GET") {
    const serverTime = formatNigerianTime();
    const html = `
      <div style="font-family: monospace; line-height: 1.6; font-weight: bold; font-size: 16px;">
        <p>&#9989 [VSPPM] Server is running.</p>
        <p><strong>Server Time (Nigerian):</strong> ${serverTime}</p>
        <p><strong>Daily Schedule for OG-Scrap:</strong></p>
        <ul>
          <li>3:00 AM - Scholarship-aid</li>
          <li>5:00 AM - SFT</li>
          <li>8:00 AM - AcademicPositions (academy)</li>
          <li>6:00 PM - Predoc</li>
          <li>10:00 PM - Jobs-ac</li>
        </ul>
      </div>
    `;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

/**
 * Ensures only one scraper runs at a time.
 * Always resolves (never throws) so the caller can safely exit the process.
 */
async function runWithLock(fn, label) {
  if (isJobRunning) {
    console.log(`⚠️ Skipping ${label} — another job is still running.`);
    return { skipped: true };
  }

  isJobRunning = true;
  console.log(`▶️ Starting ${label}...`);

  try {
    await fn();
    console.log(`✅ ${label} completed successfully`);
    return { success: true };
  } catch (err) {
    console.error(`❌ ${label} failed:`, err.message || err);
    return { success: false, error: err.message || String(err) };
  } finally {
    isJobRunning = false;
  }
}

/**
 * Run a scraper then exit the process.
 * Exiting after each job clears Chromium/memory on Render free tier.
 * Always exit(0) so the platform does not treat a finished job as a crash.
 */
async function runAndExit(fn, label) {
  try {
    await runWithLock(fn, label);
  } finally {
    console.log(`🛑 ${label} finished. Exiting process to clear memory...`);
    // Small delay so logs flush
    await new Promise((r) => setTimeout(r, 500));
    process.exit(0);
  }
}

// --- Cron Jobs (Africa/Lagos = GMT+1) ---
// Schedule:
//   3:00 AM  – sa_base_scraper
//   5:00 AM  – base_scraper (sft)
//   8:00 AM  – academy (academicpositions.com)
//   6:00 PM  – scrap_predoc
//  10:00 PM  – get_jobs_ac_data
async function setupCronJobs() {
  cron.schedule(
    "0 3 * * *",
    async () => {
      console.log("🌅 3:00 AM - Scholarship-aid scraper running..");
      await runAndExit(sa_base_scraper, "sa_base_scraper");
    },
    { scheduled: true, timezone: "Africa/Lagos" }
  );

  cron.schedule(
    "0 5 * * *",
    async () => {
      console.log("🌅 5:00 AM - SFT scraper running..");
      await runAndExit(base_scraper, "base_scraper");
    },
    { scheduled: true, timezone: "Africa/Lagos" }
  );

  cron.schedule(
    "0 8 * * *",
    async () => {
      console.log("🌅 8:00 AM - academicpositions.com scraper running..");
      await runAndExit(academy, "academy");
    },
    { scheduled: true, timezone: "Africa/Lagos" }
  );

  cron.schedule(
    "0 18 * * *",
    async () => {
      console.log("🌅 6:00 PM - predoc scraper running..");
      await runAndExit(scrap_predoc, "scrap_predoc");
    },
    { scheduled: true, timezone: "Africa/Lagos" }
  );

  cron.schedule(
    "0 22 * * *",
    async () => {
      console.log("🌅 10:00 PM - Jobs-ac scraper running..");
      await runAndExit(get_jobs_ac_data, "get_jobs_ac_data");
    },
    { scheduled: true, timezone: "Africa/Lagos" }
  );

  console.log("📅 Daily Schedule (Africa/Lagos):");
  console.log("   - 3:00 AM  → Scholarship-aid");
  console.log("   - 5:00 AM  → SFT");
  console.log("   - 8:00 AM  → AcademicPositions (academy)");
  console.log("   - 6:00 PM  → Predoc");
  console.log("   - 10:00 PM → Jobs-ac");
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

    const shutdown = async () => {
      console.log("🔄 Shutting down server...");
      server.close((err) => {
        if (err) {
          console.error("❌ Error closing HTTP server:", err);
        } else {
          console.log("✅ HTTP server closed.");
        }
        process.exit(0);
      });

      // Force exit if close hangs
      setTimeout(() => {
        console.log("⚠️ Forcing shutdown...");
        process.exit(1);
      }, 10000);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("SIGQUIT", shutdown);
  } catch (error) {
    console.error("❌ Failed to start the server:", error);
    process.exit(1);
  }
}

// Log unexpected errors but do not kill the process outside of scheduled jobs.
// (Scheduled jobs intentionally exit after finishing to free memory.)
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  // Do not process.exit here – let the health-check server stay up
  // until the next scheduled job exits deliberately.
});

startServer();