const { MongoClient } = require("mongodb");
require("dotenv").config();

const uri = process.env.MONGODB_URI;
if (!uri) {
  throw new Error("MONGODB_URI environment variable not set.");
}

let client = new MongoClient(uri, {
  maxPoolSize: 8,
  minPoolSize: 1,
  maxIdleTimeMS: 30000,
  serverSelectionTimeoutMS: 20000,
  socketTimeoutMS: 30000,
});

let db;

/**
 * Connects to the MongoDB database. Should be called once at application startup.
 */
async function initializeDatabase() {
  try {
    await client.connect();
    db = client.db("academy-db");
    await createIndexes();
    console.log("✅ Successfully connected to MongoDB Atlas!");
  } catch (error) {
    console.error("⛔ Error connecting to MongoDB Atlas:", error);
    process.exit(1);
  }
}

/**
 * Creates necessary indexes
 */
async function createIndexes() {
  try {
    const scholarships = db.collection("academy-db-scholarships");
    const proxyCache = db.collection("proxy-cache");

    await Promise.all([
      scholarships.createIndex({ post_title: 1 }, { background: true }),
      scholarships.createIndex({ application_deadline: 1 }, { background: true }),
      scholarships.createIndex({ application_link: 1 }, { unique: true, background: true }),

      // Proxy cache indexes
      proxyCache.createIndex({ proxy: 1 }, { unique: true, background: true }),
      proxyCache.createIndex({ score: -1, lastSuccess: -1 }, { background: true }),
      proxyCache.createIndex({ lastTested: 1 }, { background: true }),
    ]);

    console.log("✅ Database indexing configuration completed");
  } catch (error) {
    console.error("⛔ Error configuring indexes:", error);
    console.log("ℹ️ Application will continue without optimal indexes");
  }
}

async function closeDatabase() {
  try {
    await client.close();
    console.log("🔌 MongoDB connection closed.");
  } catch (error) {
    console.error("⛔ Error closing MongoDB connection:", error);
  }
}

/* ------------------------------------------------------------------ */
/*  Scholarship storage (unchanged logic, slightly cleaned)           */
/* ------------------------------------------------------------------ */

async function storePosts(postsArr) {
  const posts = Array.isArray(postsArr) ? postsArr : [postsArr];

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
    const result = await db
      .collection("academy-db-scholarships")
      .insertMany(posts, { ordered: false });

    return {
      success: true,
      message: `Processed ${posts.length} scholar post(s)`,
      inserted: result.insertedCount,
      duplicates: 0,
      errors: 0,
    };
  } catch (error) {
    if (error.name === "MongoBulkWriteError" || error.result) {
      const inserted = error.result?.insertedCount || 0;
      const duplicateCount =
        error.writeErrors?.filter((err) => err.code === 11000).length || 0;
      const otherErrors = (error.writeErrors?.length || 0) - duplicateCount;

      return {
        success: true,
        message: `Processed ${posts.length} scholar post(s) with partial successes`,
        inserted,
        duplicates: duplicateCount,
        errors: otherErrors,
      };
    }

    console.error("Critical error in storage operation:", error.message);
    return {
      success: false,
      message: "Failed to process jobs",
      error: error.message,
      attempted: posts.length,
    };
  }
}

async function checkPostsCount() {
  try {
    const sa_Collection = db.collection("academy-db-scholarships");
    const count = await sa_Collection.estimatedDocumentCount();

    if (count > 10000) {
      console.log(`🗑️ Collection has ~${count} documents. Deleting...`);
      const result = await sa_Collection.deleteMany(
        {},
        { writeConcern: { w: 1, j: false } }
      );
      console.log(`✅ Deleted ${result.deletedCount} documents.`);
    } else {
      console.log(
        `Documents within threshold (10,000). Current count: ${count}`
      );
    }
  } catch (error) {
    console.error("⛔ Error managing collection size:", error.message);
  }
}

/* ------------------------------------------------------------------ */
/*  Proxy cache – the key optimisation                                */
/* ------------------------------------------------------------------ */

/**
 * Returns the best known proxies ordered by score (success rate + recency).
 * score = (successCount / (successCount + failCount + 1)) * recencyBoost
 */
async function getTopProxies(limit = 30) {
  try {
    const coll = db.collection("proxy-cache");
    const now = Date.now();

    // Only consider proxies that succeeded at least once in the last 7 days
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const docs = await coll
      .find({
        lastSuccess: { $gte: sevenDaysAgo },
        successCount: { $gt: 0 },
      })
      .sort({ score: -1, lastSuccess: -1 })
      .limit(limit)
      .toArray();

    return docs.map((d) => d.proxy);
  } catch (err) {
    console.error("getTopProxies error:", err.message);
    return [];
  }
}

/**
 * Record a successful use of a proxy. Updates score.
 */
async function recordProxySuccess(proxy) {
  if (!proxy) return;
  try {
    const coll = db.collection("proxy-cache");
    const now = new Date();

    await coll.updateOne(
      { proxy },
      {
        $inc: { successCount: 1 },
        $set: {
          lastSuccess: now,
          lastTested: now,
        },
        $setOnInsert: {
          failCount: 0,
          createdAt: now,
        },
      },
      { upsert: true }
    );

    // Recalculate score
    const doc = await coll.findOne({ proxy });
    if (doc) {
      const total = doc.successCount + doc.failCount;
      const successRate = total === 0 ? 0 : doc.successCount / total;
      // Recency boost: more recent = higher score
      const ageHours = (Date.now() - new Date(doc.lastSuccess).getTime()) / 3600000;
      const recency = Math.max(0.2, 1 - ageHours / (7 * 24)); // decays over 7 days
      const score = successRate * 0.7 + recency * 0.3;

      await coll.updateOne({ proxy }, { $set: { score } });
    }
  } catch (err) {
    console.error("recordProxySuccess error:", err.message);
  }
}

/**
 * Record a failed attempt.
 */
async function recordProxyFail(proxy) {
  if (!proxy) return;
  try {
    const coll = db.collection("proxy-cache");
    const now = new Date();

    await coll.updateOne(
      { proxy },
      {
        $inc: { failCount: 1 },
        $set: { lastTested: now },
        $setOnInsert: {
          successCount: 0,
          createdAt: now,
          lastSuccess: null,
          score: 0,
        },
      },
      { upsert: true }
    );
  } catch (err) {
    console.error("recordProxyFail error:", err.message);
  }
}

/**
 * Optional: prune very old / never-successful proxies to keep collection small.
 */
async function pruneProxyCache() {
  try {
    const coll = db.collection("proxy-cache");
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const result = await coll.deleteMany({
      $or: [
        { lastSuccess: null, createdAt: { $lt: thirtyDaysAgo } },
        { lastSuccess: { $lt: thirtyDaysAgo }, successCount: { $lt: 2 } },
      ],
    });

    if (result.deletedCount > 0) {
      console.log(`🧹 Pruned ${result.deletedCount} stale proxies from cache`);
    }
  } catch (err) {
    // non-critical
  }
}

module.exports = {
  initializeDatabase,
  closeDatabase,
  storePosts,
  checkPostsCount,
  getTopProxies,
  recordProxySuccess,
  recordProxyFail,
  pruneProxyCache,
};