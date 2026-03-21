const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

// Import helpers
const { readJsonFile, getAssetsPath } = require("./utils/helpers");

const PORT = process.env.PORT || 3001;
const DATA_PATH = getAssetsPath("data.json");

const app = express();

app.use(cors());
app.use(express.json());

let client;

const initializeServer = (c) => {
    client = c;
};

// API Routes

// Health check endpoint
app.get("/api/health", (req, res) => {
    res.status(200).json({
        status: "online",
        timestamp: new Date().toISOString(),
        botReady: client ? client.isReady() : false,
    });
});

// Bot stats endpoint
app.get("/api/stats", (req, res) => {
    if (!client) {
        return res.status(503).json({ error: "Discord bot not connected" });
    }

    // Fetch app data and read user data in parallel
    Promise.all([
        client.application.fetch(),
        Promise.resolve(readJsonFile(DATA_PATH, { users: {} })),
    ]).then(([appData, data]) => {
        const users = data.users || {};
        const identifiedBalls = Object.values(users).reduce(
            (acc, u) => acc + (u.identifyAmount || 0), 0
        );
        const userCount = Math.max(appData.approximateUserInstallCount, Object.keys(users).length);

        res.status(200).json({
            guilds: client.guilds.cache.size,
            users: userCount,
            identifiedBalls: identifiedBalls,
        });
    }).catch((err) => {
        console.error("Stats endpoint error:", err);
        res.status(500).json({ error: "Failed to fetch stats" });
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error("Server error:", err);
    res.status(500).json({ error: "Internal server error" });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: "Not found" });
});

// Start server
const startServer = () => {
    app.listen(PORT, () => {
        console.log(`[Express] Server running on http://localhost:${PORT}`);
        console.log(`[Express] Dashboard API ready at http://localhost:${PORT}/api`);
    });
};

module.exports = { app, startServer, initializeServer };
