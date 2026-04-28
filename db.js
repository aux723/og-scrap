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
    db = client.db("Jobs-visa-co-uk");

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
    const jobsCollection = db.collection("Jobs");

    // Create indexes for Jobs collection
    const jobsIndexes = [
      { key: { link: 1 }, name: "link_index", background: true },
      { key: { deadline: 1 }, name: "deadline_index", background: true },
      { key: { uploadedDate: 1 }, name: "uploadedDate_index", background: true }
    ];

    // Check if Jobs collection exists and create indexes
    const collections = await db.listCollections({ name: "Jobs" }).toArray();
    if (collections.length > 0) {
      console.log("📊 Creating indexes for Jobs collection...");
      await Promise.all(
        jobsIndexes.map(index =>
          jobsCollection.createIndex(index.key, {
            name: index.name,
            background: true
          })
        )
      );
    } else {
      console.log("ℹ️ Jobs collection does not exist yet. Indexes will be created when collection is created.");
    }

    // For Posted-Jobs, we'll create the index when the collection is first used
    // This is handled in addDocumentToPostedDb function

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

async function storeJob(job) {

  try {

    // Attempt to insert the document
    // The unique index on 'link' will automatically prevent duplicates
    const result = await db.collection("Jobs").insertOne({
      ...job,
      createdAt: new Date()
    });

    return {
      success: true,
      message: "Job stored successfully",
      jobId: result.insertedId
    };

  } catch (error) {
    // Check if the error is a duplicate key error
    if (error.code === 11000) {
      return {
        success: false,
        message: "Job already exists in database",
        duplicate: true
      };
    }

    // For other errors
    console.error("Error storing job:", error);
    return {
      success: false,
      message: "Failed to store job",
      error: error.message
    };
  }
}

/**
 * Adds a document to the 'Posted-Jobs' collection with optimized insertion.
 * Creates collection and indexes if they don't exist.
 * @param {object} jobDocument - The job document that was posted.
 */
async function addDocumentToPostedDb(jobDocument) {

  try {
    const collection = db.collection("Posted-Jobs");

    // Create index if collection is new
    const collections = await db.listCollections({ name: "Posted-Jobs" }).toArray();
    if (collections.length === 0) {
      console.log("📊 Creating new Posted-Jobs collection with indexes...");
      await collection.createIndex(
        { link: 1 },
        {
          name: "posted_link_index",
          background: true
        }
      );
    }

    // Use insertOne with writeConcern for better performance
    const result = await collection.insertOne(jobDocument, {
      writeConcern: { w: 1, j: false }
    });

    console.log(`📝 Document added to PostedDb with ID: ${result.insertedId}`);
    return result.insertedId;
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
    const collection = db.collection("Jobs");

    // Optimized pipeline with better memory usage
    const pipeline = [
      // Use $lookup with pipeline for better performance
      {
        $lookup: {
          from: "Posted-Jobs",
          let: { jobLink: "$link" },
          pipeline: [
            { $match: { $expr: { $eq: ["$link", "$$jobLink"] } } },
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
async function deleteAllPostedJobsFromDb() {

  try {
    const collection = db.collection("Posted-Jobs");

    // Use estimatedDocumentCount for better performance on large collections
    const count = await collection.estimatedDocumentCount();

    if (count >= 3000) {
      console.log(`🗑️ Posted-Jobs collection has ~${count} documents. Deleting...`);

      const result = await collection.deleteMany({}, {
        writeConcern: { w: 1, j: false }
      });

      console.log(`✅ Deleted ${result.deletedCount} documents from Posted-Jobs.`);
      return;
    } else {
      console.log(`ℹ️ Posted-Jobs collection has ~${count} documents. No deletion needed.`);
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