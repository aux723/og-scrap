const { MongoClient } = require("mongodb");

// Use environment variable for the database URI for security
const uri = process.env.MONGODB_URI || "mongodb+srv://info-brown:brown@cluster0.05k2pqu.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
if (!uri) {
  throw new Error("MONGODB_URI environment variable not set.");
}

let client = new MongoClient(uri, {
  maxPoolSize: 10,
  minPoolSize: 2,
  maxIdleTimeMS: 30000,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
});

let db; // This variable will hold the database instance once connected

/**
 * Connects to the MongoDB database. Should be called once at application startup.
 */
async function initializeDatabase() {
  try {
    await client.connect();
    db = client.db("aesop");

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
    let aSCollection = db.collection("aesop-scholarships");

    // Create indexes in parallel for better performance
    await Promise.all([
        aSCollection.createIndex({ post_title: 1 }, { background: true }),
        aSCollection.createIndex({ application_deadline: 1 }, { background: true }),
        aSCollection.createIndex({ postLink: 1 }, { unique: true, background: true }),
    ]);

    console.log("✅ Database indexing configuration completed");
    return;
    // For Posted-Jobs, we'll create the index when the collection is first used
    // This is handled in addDocumentToPostedDb function

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

async function storePosts(postsArr) {
    // Normalize input to array
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
      // Use bulkWrite for efficient batch insert with ordered: false to continue on errors
      const result = await db.collection("aesop-scholarships").bulkWrite(
        posts.map(post => ({
          insertOne: { document: post }
        })),
        { ordered: false } // Continue processing even if some inserts fail
      );

      const inserted = result.insertedCount;
      const duplicateCount = result.writeErrors?.filter(
        error => error.code === 11000
      ).length || 0;
      const otherErrors = (result.writeErrors?.length || 0) - duplicateCount;

      return {
        success: inserted > 0,
        message: `Processed ${posts.length} scholar post(s)`,
        inserted,
        duplicates: duplicateCount,
        errors: otherErrors,
      };

    } catch (error) {
      // Handle unexpected errors
      console.error("Error in bulk operation:", error);
      return {
        success: false,
        message: "Failed to process jobs",
        error: error.message,
        attempted: posts.length
      };
    }
  }



module.exports = {
  initializeDatabase,
  closeDatabase,
  storePosts
};