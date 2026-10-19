/**
 * academy-db.js  (updated)
 * ------------------------
 * Adds a `academy-proxy-cache` collection with TTL index so working proxies
 * survive Render hard-restarts. Original scholarship methods unchanged.
 *
 * PROXY CACHE SCHEMA
 *   {
 *     _id:        "ip:port",         // primary key = proxy string
 *     ok:         Number,            // success count
 *     fail:       Number,            // failure count
 *     lastOk:     ISODate,           // last successful use
 *   }
 * TTL index on lastOk: 6h — stale entries auto-expire.
 */

const { MongoClient } = require("mongodb");
require("dotenv").config();

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error("MONGODB_URI environment variable not set.");

let client = new MongoClient(uri, {
  maxPoolSize: 10,
  minPoolSize: 2,
  maxIdleTimeMS: 30000,
  serverSelectionTimeoutMS: 45000,
  socketTimeoutMS: 45000,
});

let db;

async function initializeDatabase() {
  try {
    await client.connect();
    db = client.db("academy-db");
    await createIndexes();
    console.log("✅ Connected to MongoDB Atlas");
  } catch (error) {
    console.error("⛔ MongoDB connect error:", error);
    process.exit(1);
  }
}

async function createIndexes() {
  try {
    const scholarships = db.collection("academy-db-scholarships");
    const proxyCache   = db.collection("academy-proxy-cache");

    await Promise.all([
      scholarships.createIndex({ post_title: 1 }, { background: true }),
      scholarships.createIndex({ application_deadline: 1 }, { background: true }),
      scholarships.createIndex({ application_link: 1 }, { unique: true, background: true }),

      // Proxy cache: TTL expires entries 6h after their lastOk timestamp.
      // This keeps the cache self-cleaning — dead proxies age out automatically.
      proxyCache.createIndex(
        { lastOk: 1 },
        { expireAfterSeconds: 6 * 60 * 60, background: true }
      ),
    ]);

    console.log("✅ Indexes configured (scholarships + proxy-cache TTL)");
  } catch (error) {
    console.error("⚠️ Index setup error:", error.message);
  }
}

async function closeDatabase() {
  try {
    await client.close();
    console.log("🔌 MongoDB closed");
  } catch (error) {
    console.error("⛔ Close error:", error);
  }
}

/* ============================================================ */
/* SCHOLARSHIP COLLECTION (unchanged behavior)                  */
/* ============================================================ */

async function storePosts(postsArr) {
  const posts = Array.isArray(postsArr) ? postsArr : [postsArr];
  if (posts.length === 0) {
    return { success: true, message: "No posts to process", inserted: 0, duplicates: 0, errors: 0 };
  }
  try {
    const result = await db.collection("academy-db-scholarships")
      .insertMany(posts, { ordered: false });
    return {
      success: true,
      message: `Processed ${posts.length} post(s)`,
      inserted: result.insertedCount,
      duplicates: 0,
      errors: 0,
    };
  } catch (error) {
    if (error.name === "MongoBulkWriteError" || error.result) {
      const inserted = error.result.insertedCount;
      const duplicates = error.writeErrors?.filter((e) => e.code === 11000).length || 0;
      const otherErrors = (error.writeErrors?.length || 0) - duplicates;
      return {
        success: true,
        message: `Processed ${posts.length} post(s) with partial successes`,
        inserted, duplicates, errors: otherErrors,
      };
    }
    console.error("Critical store error:", error.message);
    return { success: false, message: "Failed", error: error.message, attempted: posts.length };
  }
}

async function checkPostsCount() {
  try {
    const col = db.collection("academy-db-scholarships");
    const count = await col.estimatedDocumentCount();
    if (count > 10000) {
      console.log(`🗑️  Scholarships at ~${count}, deleting...`);
      await col.deleteMany({}, { writeConcern: { w: 1, j: false } });
      console.log("✅ Cleared");
    } else {
      console.log(`📊 Scholarships count: ${count} (within threshold)`);
    }
  } catch (error) {
    console.error("⛔ checkPostsCount error:", error.message);
  }
}

/* ============================================================ */
/* PROXY CACHE COLLECTION (new)                                 */
/* ============================================================ */

/**
 * Returns all cached proxies, sorted by score (ok - 2*fail), freshest first.
 * The TTL index already handles expiry, so no age filter needed here.
 */
async function getProxyCache() {
  try {
    return await db.collection("academy-proxy-cache")
      .find({})
      .sort({ cloudflareFail: 1, ok: -1, transportFail: 1, lastOk: -1 })
      .limit(50)
      .toArray();
  } catch (err) {
    console.error("getProxyCache error:", err.message);
    return [];
  }
}

/**
 * Upsert a proxy entry with atomic $inc / $set operations.
 *
 * Schema fields:
 *   _id             "ip:port"
 *   ok              success count (cumulative)
 *   transportFail   consecutive transport failures (resets on success)
 *   cloudflareFail  cumulative Cloudflare blocks (does NOT reset)
 *   lastOk          ISODate of last success (TTL indexed)
 *
 * opts: {
 *   okInc,                // increment ok by N
 *   transportFailInc,     // increment transportFail by N
 *   transportFailReset,   // set transportFail = 0
 *   cloudflareFailInc,    // increment cloudflareFail by N
 *   cloudflareFailInit,   // set cloudflareFail to N on insert only (use 0)
 *   lastOk,               // set lastOk to this date
 * }
 */
async function upsertProxyCache(proxy, opts = {}) {
  try {
    const update = {};
    if (opts.okInc)               update.$inc  = { ...(update.$inc  || {}), ok: opts.okInc };
    if (opts.transportFailInc)   update.$inc  = { ...(update.$inc  || {}), transportFail: opts.transportFailInc };
    if (opts.cloudflareFailInc)  update.$inc  = { ...(update.$inc  || {}), cloudflareFail: opts.cloudflareFailInc };
    if (opts.transportFailReset) update.$set  = { ...(update.$set  || {}), transportFail: 0 };
    if (opts.lastOk)              update.$set  = { ...(update.$set  || {}), lastOk: opts.lastOk };
    // $setOnInsert only applies when the document doesn't exist yet — so this
    // is the safe place to initialize both failure counters to 0.
    update.$setOnInsert = {
      ok: 0,
      transportFail: 0,
      cloudflareFail: opts.cloudflareFailInit ?? 0,
      lastOk: opts.lastOk || new Date(),
    };

    await db.collection("academy-proxy-cache").updateOne(
      { _id: proxy },
      update,
      { upsert: true }
    );
  } catch (err) {
    console.error("upsertProxyCache error:", err.message);
  }
}

async function removeProxyCache(proxy) {
  try {
    await db.collection("academy-proxy-cache").deleteOne({ _id: proxy });
  } catch (err) {
    console.error("removeProxyCache error:", err.message);
  }
}

module.exports = {
  initializeDatabase,
  closeDatabase,
  storePosts,
  checkPostsCount,
  // new
  getProxyCache,
  upsertProxyCache,
  removeProxyCache,
};
