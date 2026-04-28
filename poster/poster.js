const { Telegraf } = require("telegraf");

// Import the optimized database and AI functions
const {
  initializeDatabase,
  closeDatabase,
  addDocumentToPostedDb,
  findRandomUnpostedDocument,
  removeOldDocumentsFromDb,
  deleteAllPostedJobsFromDb,
  removeUnspecifiedDeadlineJobs
} = require("../db.js");

const { formatNigerianTime } = require("../utils/dateHelpers.js");


async function makePost() {
    try {
      
      await initializeDatabase();

      const BOT_TOKEN = "6301853750:AAEsCwyhv_gbyavl-JQaXDPrYUSapnth2Z8";
      let TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || "-1001991228615";

      // Initialize the database connection first


      if (!BOT_TOKEN) {
          throw new Error('BOT_TOKEN environment variable not set.');
      }

      // --- Telegraf Bot ---
      let bot = new Telegraf(BOT_TOKEN);

      console.log("🔎 Searching for a new document to post...");

      // Run maintenance tasks first
      await removeOldDocumentsFromDb();
      await removeUnspecifiedDeadlineJobs();
      await deleteAllPostedJobsFromDb();

      let doc = await findRandomUnpostedDocument();

      if (!doc) {
        console.log("ℹ️ No new documents available to post at this time.");
        return;
      }

      console.log(`📄 Found document: ${doc.title}`);

      await bot.telegram.sendMessage(TELEGRAM_CHANNEL_ID, doc.description, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [[{ text: "Apply Now", url: doc.link }]],
        },
      });
      console.log("✅ Post sent successfully to Telegram!");

      await addDocumentToPostedDb(doc);

      console.log(`📈 Post completed today: ${formatNigerianTime()}`);
      doc = null;
      return;
      //bot = null;

    } catch (error) {
        console.error("⚠️ An error occurred in the makePost function:", error);
        return;
    } finally {
      bot = null;
      TELEGRAM_CHANNEL_ID = null;
      closeDatabase();
    }
}

module.exports = { makePost }
//makePost();