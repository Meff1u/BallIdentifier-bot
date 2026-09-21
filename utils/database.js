const { MongoClient } = require("mongodb");

let mongoClient;
let database;
let connectPromise;

async function initializeDatabase() {
    if (database) return database;
    if (connectPromise) return connectPromise;

    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI is not configured.");

    connectPromise = (async () => {
        mongoClient = new MongoClient(uri);
        await mongoClient.connect();
        database = mongoClient.db(process.env.MONGODB_DB_NAME || "ballidentifier");

        await database.collection("ballsdexCollections").createIndex(
            { discordUserId: 1 },
            { unique: true },
        );
        await database.collection("ballsdexSpecials").createIndex(
            { user_id: 1, id: 1 },
            { unique: true },
        );

        console.log("[DATABASE] Connected to MongoDB.");
        return database;
    })();

    try {
        return await connectPromise;
    } catch (error) {
        connectPromise = null;
        database = null;
        mongoClient = null;
        throw error;
    }
}

async function getDatabase() {
    return database || initializeDatabase();
}

async function closeDatabase() {
    if (!mongoClient) return;
    await mongoClient.close();
    mongoClient = null;
    database = null;
    connectPromise = null;
}

module.exports = {
    closeDatabase,
    getDatabase,
    initializeDatabase,
};