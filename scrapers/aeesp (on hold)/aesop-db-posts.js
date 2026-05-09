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
    let aSPCollection = await db.collection("aesop-posted-scholarships");
    let aSCollection = db.collection("aesop-scholarships");

    // Create indexes in parallel for better performance
    await Promise.all([
        aSPCollection.createIndex({ post_title: 1 }, { background: true }),
        aSPCollection.createIndex({ application_deadline: 1 }, { background: true }),
        aSPCollection.createIndex({ postLink: 1 }, { unique: true, background: true }),
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



/**
 * Adds a document to the 'Posted-Jobs' collection with optimized insertion.
 * Creates collection and indexes if they don't exist.
 * @param {object} jobDocument - The job document that was posted.
 */
async function addDocumentToPostedDb(postDocument) {

  try {
    const collection = db.collection("aesop-posted-scholarships");

    // Create index if collection is new
    const collections = await db.listCollections({ name: "aesop-posted-scholarships" }).toArray();
    if (collections.length === 0) {
      console.log("📊 Creating new Posted-Jobs collection with indexes...");
      await collection.createIndex(
        { postLink: 1 },
        {
          name: "posted_link_index",
          background: true
        }
      );
    }

    // Use insertOne with writeConcern for better performance
    const result = await collection.insertOne(postDocument, {
      writeConcern: { w: 1, j: false }
    });

    console.log(`📝 Document added to PostedDb with ID: ${result.insertedId}`);
    return {success: true};
  } catch (error) {
    console.error("⛔ Error adding document to Posted-Jobs:", error);
    process.exit(1);
  }
}

/**
 * Efficiently finds a single, random document from the 'Jobs' collection
 * that has not yet been posted using aggregation pipeline optimization.
 * @returns {Promise<object|null>} A random unposted document or null if none are found.
 */
async function findRandomUnpostedDocument() {

  try {
    const collection = db.collection("aesop-scholarships");

    // Optimized pipeline with better memory usage
    const pipeline = [
      // Use $lookup with pipeline for better performance
      {
        $lookup: {
          from: "aesop-posted-scholarships",
          let: { Link: "$postLink" },
          pipeline: [
            { $match: { $expr: { $eq: ["$postLink", "$$Link"] } } },
            { $limit: 1 },
            { $project: { _id: 1 } }
          ],
          as: "posted"
        }
      },
      // Filter unposted documents
      { $match: { posted: { $size: 0 } } },
      // Random sample
      { $sample: { size: 1 } },
      // Remove the lookup field to reduce memory
      { $unset: "posted" }
    ];

    const cursor = collection.aggregate(pipeline, {
      allowDiskUse: true,
      maxTimeMS: 30000
    });

    const result = await cursor.next();
    await cursor.close();

    return result;
  } catch (error) {
    console.error("⛔ Error finding unposted document:", error);
    process.exit(1);
  }
}

/**
 * Deletes all documents from the 'Posted-Jobs' collection if count exceeds threshold.
 * Uses efficient counting and bulk operations.
 */
async function deleteAllPostedAScholarshipsFromDb() {

  try {
    const collection = db.collection("aesop-posted-scholarships");

    // Use estimatedDocumentCount for better performance on large collections
    const count = await collection.estimatedDocumentCount();

    if (count >= 3000) {
      console.log(`🗑️ aesop-posted-scholarships collection has ~${count} documents. Deleting...`);

      const result = await collection.deleteMany({}, {
        writeConcern: { w: 1, j: false }
      });

      console.log(`✅ Deleted ${result.deletedCount} documents from aesop-posted-scholarships.`);
      return;
    } else {
      console.log(`ℹ️ aesop-posted-scholarships has ~${count} documents. No deletion needed.`);
      return;
    }

  } catch (error) {
    console.error("⛔ Error managing Posted-Jobs collection:", error.message);
    process.exit(1);
  }
}

/**
 * Native date parsing function to replace moment.js
 * @param {string} dateString - Date in format "MMMM DD, YYYY" (e.g., "January 15, 2024")
 * @returns {Date|null} Parsed date or null if invalid
 */


/**
 * Removes documents from the 'Jobs' collection older than 14 days using native Date.
 * Memory-optimized with cursor streaming and batch processing.
 */
async function removeOldDocumentsFromDb() {

  try {
    const collection = db.collection("Jobs");
    const currentDate = new Date();
    const batchSize = 1000;
    let totalDeleted = 0;

    // Use aggregation to find expired documents more efficiently
    const pipeline = [
      {
        $match: {
          deadline: { $ne: "Not specified" } // Filter out "Not specified" deadlines
        }
      },
      {
        $addFields: {
          parsedDeadline: {
            $dateFromString: {
              dateString: "$deadline",
              format: "%d %B %Y", // Format: "28 September 2025"
              onError: null
            }
          }
        }
      },
      {
        $match: {
          parsedDeadline: {
            $lt: currentDate, // Only get documents with deadlines before current date
            $ne: null // Exclude documents where date parsing failed
          }
        }
      },
      {
        $project: { _id: 1 }
      }
    ];

    const cursor = collection.aggregate(pipeline, {
      allowDiskUse: true,
      batchSize: batchSize
    });

    let idsToDelete = [];

    for await (const doc of cursor) {
      idsToDelete.push(doc._id);

      if (idsToDelete.length >= batchSize) {
        const result = await collection.deleteMany(
          { _id: { $in: idsToDelete } },
          { writeConcern: { w: 1, j: false } }
        );
        totalDeleted += result.deletedCount;
        idsToDelete = [];
      }
    }

    // Process remaining documents
    if (idsToDelete.length > 0) {
      const result = await collection.deleteMany(
        { _id: { $in: idsToDelete } },
        { writeConcern: { w: 1, j: false } }
      );
      totalDeleted += result.deletedCount;
    }

    if (totalDeleted > 0) {
      console.log(`✅ Successfully deleted ${totalDeleted} expired job documents.`);
    } else {
      console.log("ℹ️ No expired documents found to delete.");
    }

    return;
  } catch (error) {
    console.error("⛔ Error removing expired documents:", error);
    process.exit(1);
  }
}

/**
 * Removes documents with "Not specified" deadline that are older than 30 days
 * based on uploadedDate. Uses aggregation pipeline for efficient processing.
 * @returns {Promise<number>} Number of documents deleted
 */
async function removeUnspecifiedDeadlineJobs() {

  try {
    const collection = db.collection("Jobs");
    const twelveDaysAgo = new Date();
    twelveDaysAgo.setDate(twelveDaysAgo.getDate() - 12);  // Changed from 30 to 12 days
    const batchSize = 1000;
    let totalDeleted = 0;

    // Aggregation pipeline to find old "Not specified" deadline documents
    const pipeline = [
      {
        $match: {
          deadline: "Not specified"
        }
      },
      {
        $addFields: {
          parsedUploadDate: {
            $dateFromString: {
              dateString: "$uploadedDate",
              format: "%d %B %Y",
              onError: null
            }
          }
        }
      },
      {
        $match: {
          parsedUploadDate: {
            $lt: twelveDaysAgo,  // Now checking for documents older than 12 days
            $ne: null
          }
        }
      },
      {
        $project: { _id: 1 }
      }
    ];

    const cursor = collection.aggregate(pipeline, {
      allowDiskUse: true,
      batchSize: batchSize
    });

    let idsToDelete = [];

    for await (const doc of cursor) {
      idsToDelete.push(doc._id);

      if (idsToDelete.length >= batchSize) {
        const result = await collection.deleteMany(
          { _id: { $in: idsToDelete } },
          { writeConcern: { w: 1, j: false } }
        );
        totalDeleted += result.deletedCount;
        idsToDelete = [];
      }
    }

    // Process remaining documents
    if (idsToDelete.length > 0) {
      const result = await collection.deleteMany(
        { _id: { $in: idsToDelete } },
        { writeConcern: { w: 1, j: false } }
      );
      totalDeleted += result.deletedCount;
    }

    if (totalDeleted > 0) {
      console.log(`✅ Deleted ${totalDeleted} documents with "Not specified" deadline older than 30 days`);
    } else {
      console.log("ℹ️ No old unspecified deadline documents found to delete");
    }

    return totalDeleted;
  } catch (error) {
    console.error("⛔ Error removing unspecified deadline documents:", error);
    process.exit(1);
  }
}

// Automatically initialize the database when this module is loaded

/*(async () => {
  await initializeDatabase();
  let post = await findRandomUnpostedDocument();
  console.log(post);
})()*/

module.exports = {
  initializeDatabase,
  closeDatabase,
  storeJob,
  addDocumentToPostedDb,
  findRandomUnpostedDocument,
  removeOldDocumentsFromDb,
  deleteAllPostedJobsFromDb,
  removeUnspecifiedDeadlineJobs
};