const { MongoClient } = require("mongodb");
require("dotenv").config();

// Use environment variable for the database URI for security
const uri = process.env.MONGODB_URI;
if (!uri) {
  throw new Error("MONGODB_URI environment variable not set.");
}

const DB_NAME = "academy-db";
const SCHOLARSHIPS_COLLECTION = "academy-db-scholarships";
const PROXY_COLLECTION = "academy-db-proxy";      // holds one doc: the batch that last produced a working proxy
const PROXY_CURSOR_ID = "proxy-cursor";

let client = null; // MongoClient (created per initializeDatabase call)
let db = null;     // database instance once connected

function buildClient() {
  return new MongoClient(uri, {
    maxPoolSize: 5,            // free tier: keep the footprint small
    minPoolSize: 1,
    maxIdleTimeMS: 30000,
    connectTimeoutMS: 20000,
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 45000,
  });
}

function getDb() {
  if (!db) throw new Error("Database not initialised. Call initializeDatabase() first.");
  return db;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Connects to MongoDB. Safe to call more than once (no-op if already connected).
 * THROWS on failure instead of calling process.exit(), so the caller decides what to do.
 */
async function initializeDatabase() {
  if (db) return;

  const MAX_ATTEMPTS = 3;
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const candidate = buildClient();
    try {
      await candidate.connect();
      client = candidate;
      db = client.db(DB_NAME);
      await createIndexes();
      console.log("✅ Successfully connected to MongoDB Atlas!");
      return;
    } catch (error) {
      lastError = error;
      console.error(`⛔ MongoDB connect attempt ${attempt}/${MAX_ATTEMPTS} failed:`, error.message);
      await candidate.close().catch(() => {});
      client = null;
      db = null;
      if (attempt < MAX_ATTEMPTS) await sleep(2000 * attempt);
    }
  }

  throw new Error(`Could not connect to MongoDB Atlas: ${lastError && lastError.message}`);
}

/**
 * Creates necessary indexes. Each one is independent: one failing never blocks the others.
 */
async function createIndexes() {
  const scholarships = db.collection(SCHOLARSHIPS_COLLECTION);

  const results = await Promise.allSettled([
    scholarships.createIndex({ post_title: 1 }, { background: true }),
    scholarships.createIndex({ application_deadline: 1 }, { background: true }),
    scholarships.createIndex({ application_link: 1 }, { unique: true, background: true }),
  ]);

  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length) {
    failed.forEach((f) => console.error("⛔ Index error:", f.reason && f.reason.message));
    console.log("ℹ️ Application will continue without some indexes");
  } else {
    console.log("✅ Database indexing configuration completed");
  }
}

/**
 * Closes the MongoDB connection. Never throws and never exits the process.
 */
async function closeDatabase() {
  const current = client;
  client = null;
  db = null;
  if (!current) return;
  try {
    await current.close();
    console.log("🔌 MongoDB connection closed.");
  } catch (error) {
    console.error("⛔ Error closing MongoDB connection:", error.message);
  }
}

// ---------------------------------------------------------------------------
// Scholarship posts
// ---------------------------------------------------------------------------

async function storePosts(postsArr) {
  const posts = (Array.isArray(postsArr) ? postsArr : [postsArr]).filter(Boolean);

  if (posts.length === 0) {
    return {
      success: true,
      message: "No posts to process",
      inserted: 0,
      duplicates: 0,
      errors: 0,
    };
  }

  try {
    const result = await getDb()
      .collection(SCHOLARSHIPS_COLLECTION)
      .insertMany(posts, { ordered: false });

    return {
      success: true,
      message: `Processed ${posts.length} scholar post(s)`,
      inserted: result.insertedCount,
      duplicates: 0,
      errors: 0,
    };
  } catch (error) {
    // Some succeeded, some failed (typically duplicates)
    if (error && (error.name === "MongoBulkWriteError" || error.result)) {
      const inserted =
        (error.result && error.result.insertedCount) ?? error.insertedCount ?? 0;
      const writeErrors = [].concat(error.writeErrors || []); // can be a single object or array
      const duplicateCount = writeErrors.filter((e) => e.code === 11000).length;
      const otherErrors = writeErrors.length - duplicateCount;

      return {
        success: true,
        message: `Processed ${posts.length} scholar post(s) with partial successes`,
        inserted,
        duplicates: duplicateCount,
        errors: otherErrors,
      };
    }

    // Complete system / connection failure
    console.error("Critical error in storage operation:", error.message);
    return {
      success: false,
      message: "Failed to process posts",
      error: error.message,
      attempted: posts.length,
    };
  }
}

async function checkPostsCount() {
  try {
    const collection = getDb().collection(SCHOLARSHIPS_COLLECTION);

    // estimatedDocumentCount is cheap on large collections
    const count = await collection.estimatedDocumentCount();

    if (count > 10000) {
      console.log(`🗑️ Scholarships collection has ~${count} documents. Deleting...`);
      const result = await collection.deleteMany({}, { writeConcern: { w: 1, j: false } });
      console.log(`✅ Deleted ${result.deletedCount} documents.`);
    } else {
      console.log(`Documents are within the target count threshold (10,000 docs)\ncurrent count: ${count}`);
    }
  } catch (error) {
    // Housekeeping only – must never take the scraper down
    console.error("⛔ Error managing scholarships collection:", error.message);
  }
}

// ---------------------------------------------------------------------------
// Persistent proxy search position
// Only the BATCH INDEX that produced the last working proxy is stored (not the proxy
// itself). Both functions swallow their own errors so a DB hiccup never crashes a run.
// ---------------------------------------------------------------------------

/**
 * Returns the batch index that last produced a working proxy, or null if none is stored.
 */
async function getProxyBatchIndex() {
  try {
    const doc = await getDb().collection(PROXY_COLLECTION).findOne({ _id: PROXY_CURSOR_ID });
    return doc && Number.isInteger(doc.batchIndex) ? doc.batchIndex : null;
  } catch (error) {
    console.error("⚠️ Could not read proxy batch index:", error.message);
    return null;
  }
}

/**
 * Stores the batch index that produced a working proxy.
 */
async function saveProxyBatchIndex(batchIndex, { batchSize = null } = {}) {
  if (!Number.isInteger(batchIndex)) return false;
  try {
    await getDb().collection(PROXY_COLLECTION).updateOne(
      { _id: PROXY_CURSOR_ID },
      { $set: { batchIndex, batchSize, updatedAt: new Date() } },
      { upsert: true }
    );
    console.log(`💾 Saved proxy batch index to DB: ${batchIndex}`);
    return true;
  } catch (error) {
    console.error("⚠️ Could not save proxy batch index:", error.message);
    return false;
  }
}

module.exports = {
  initializeDatabase,
  closeDatabase,
  storePosts,
  checkPostsCount,
  getProxyBatchIndex,
  saveProxyBatchIndex,
};