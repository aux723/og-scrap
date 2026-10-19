const { MongoClient } = require("mongodb");
require ("dotenv").config();
// Use environment variable for the database URI for security

const uri = process.env.MONGODB_URI
if (!uri) {
  throw new Error("MONGODB_URI environment variable not set.");
}

let client = new MongoClient(uri, {
  maxPoolSize: 10,
  minPoolSize: 2,
  maxIdleTimeMS: 30000,
  serverSelectionTimeoutMS: 45000,
  socketTimeoutMS: 45000,
});

let db; // This variable will hold the database instance once connected

const PROXY_CACHE_COLLECTION = "proxy-cache";
const PROXY_CACHE_MAX = 10;

/**
 * Connects to the MongoDB database. Should be called once at application startup.
 */
async function initializeDatabase() {
  try {
    await client.connect();
    db = client.db("academy-db");

    // Create indexes for better query performance
    await createIndexes();
    console.log("✅ Successfully connected to MongoDB Atlas!");
  } catch (error) {
    console.error("⛔ Error connecting to MongoDB Atlas:", error);
    process.exit(1);
  }
}

/**
 * Creates necessary indexes for optimal query performance
 */
async function createIndexes() {
  try {
    let academyDB_Collection = db.collection("academy-db-scholarships");

    // Create indexes in parallel for better performance
    await Promise.all([
      academyDB_Collection.createIndex({ post_title: 1 }, { background: true }),
      academyDB_Collection.createIndex({ application_deadline: 1 }, { background: true }),
      academyDB_Collection.createIndex({ application_link: 1 }, { unique: true, background: true }),
    ]);

    // Index for the proxy cache (fast lookup + recency sort + TTL-safe upserts)
    await db.collection(PROXY_CACHE_COLLECTION).createIndex(
      { proxy: 1 },
      { unique: true, background: true }
    );

    console.log("✅ Database indexing configuration completed");

  } catch (error) {
    console.error("⛔ Error configuring indexes:", error);
    // Non-critical error, don't throw
    console.log("ℹ️ Application will continue without optimal indexes");
  }
}

/**
 * Closes the MongoDB connection. Should be called once during application shutdown.
 */
async function closeDatabase() {
  try {
    await client.close();
    console.log("🔌 MongoDB connection closed.");
  } catch (error) {
    console.error("⛔ Error closing MongoDB connection:", error);
    process.exit(1);
  }
}

// =========================================================================
// Proxy cache persistence
// -------------------------------------------------------------------------
// Working proxies are stored here so the expensive proxy-hunting phase is
// paid once and reused across runs, restarts and Render redeploys (the
// free-tier filesystem is ephemeral — MongoDB is not).
// =========================================================================

/**
 * Returns up to PROXY_CACHE_MAX known-good proxies, most recent success first.
 * Returns [] if the DB is not connected yet (callers fall back to hunting).
 */
async function getCachedProxies() {
  if (!db) return [];
  try {
    const docs = await db
      .collection(PROXY_CACHE_COLLECTION)
      .find({})
      .sort({ lastSuccess: -1 })
      .limit(PROXY_CACHE_MAX)
      .toArray();
    return docs.map((d) => ({ proxy: d.proxy, lastSuccess: d.lastSuccess }));
  } catch (error) {
    console.error("⛔ Error reading proxy cache:", error.message);
    return [];
  }
}

/** Record (or refresh) a proxy that just worked. */
async function recordProxySuccess(proxy) {
  if (!db) return;
  try {
    await db.collection(PROXY_CACHE_COLLECTION).updateOne(
      { proxy },
      { $set: { proxy, lastSuccess: Date.now() } },
      { upsert: true }
    );
  } catch (error) {
    console.error("⛔ Error recording proxy success:", error.message);
  }
}

/** Remove a proxy that died (so we never waste a probe on it again). */
async function removeProxyFromCache(proxy) {
  if (!db) return;
  try {
    await db.collection(PROXY_CACHE_COLLECTION).deleteOne({ proxy });
  } catch (error) {
    console.error("⛔ Error removing proxy from cache:", error.message);
  }
}

async function storePosts(postsArr) {
  const posts = Array.isArray(postsArr) ? postsArr : [postsArr];

  if (posts.length === 0) {
    return {
      success: true,
      message: "No posts to process",
      inserted: 0,
      duplicates: 0,
      errors: 0
    };
  }

  try {
    const result = await db.collection("academy-db-scholarships").insertMany(posts, { ordered: false });

    return {
      success: true,
      message: `Processed ${posts.length} scholar post(s)`,
      inserted: result.insertedCount,
      duplicates: 0,
      errors: 0,
    };

  } catch (error) {
    // If the error is a bulk write error (some succeeded, some failed)
    if (error.name === 'MongoBulkWriteError' || error.result) {
      const inserted = error.result.insertedCount;
      const duplicateCount = error.writeErrors?.filter(err => err.code === 11000).length || 0;
      const otherErrors = (error.writeErrors?.length || 0) - duplicateCount;

      return {
        success: true,
        message: `Processed ${posts.length} scholar post(s) with partial successes`,
        inserted: inserted,
        duplicates: duplicateCount,
        errors: otherErrors,
      };
    }

    // Handle complete system/connection failures
    console.error("Critical error in storage operation:", error.message);
    return {
      success: false,
      message: "Failed to process jobs",
      error: error.message,
      attempted: posts.length,
    };
  }
};

async function checkPostsCount() {
  try {
    // Get collection from the shared 'db' instance
    let sa_Collection = db.collection("academy-db-scholarships");

    // Use estimatedDocumentCount for better performance on large collections
    let count = await sa_Collection.estimatedDocumentCount();

    if(count > 10000) {
      console.log(`🗑️ Posted-Jobs collection has ~${count} documents. Deleting...`);

      let result = await sa_Collection.deleteMany({}, {
        writeConcern: { w: 1, j: false }
      });

      console.log(`✅ Deleted ${result.deletedCount} documents from Posted-Jobs.`);
      sa_Collection = null;
    } else {
      console.log (`Documents are within the target count threshold (10,000 docs)\ncurrent count: `, count)
    }

  } catch (error) {
    console.error("⛔ Error managing Posted-Jobs collection:", error.message);
    process.exit(1);
  }
};




module.exports = {
  initializeDatabase,
  closeDatabase,
  storePosts,
  checkPostsCount,
  getCachedProxies,
  recordProxySuccess,
  removeProxyFromCache
};