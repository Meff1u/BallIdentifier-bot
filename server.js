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

// Middleware to verify API key for protected endpoints
const verifyApiKey = (req, res, next) => {
    const apiKey = process.env.API_KEY;
    
    if (!apiKey) {
        return res.status(500).json({ error: "API key not configured" });
    }
    
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Missing or invalid authorization header" });
    }
    
    const token = authHeader.substring(7);
    
    if (token !== apiKey) {
        return res.status(403).json({ error: "Invalid API key" });
    }
    
    next();
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

// Get list of guilds where bot is present
app.get("/api/guilds", verifyApiKey, (req, res) => {
    if (!client) {
        return res.status(503).json({ error: "Discord bot not connected" });
    }

    const guilds = client.guilds.cache.map(guild => ({
        id: guild.id,
        name: guild.name,
        icon: guild.icon,
        memberCount: guild.memberCount,
    }));

    res.status(200).json({
        guilds: guilds,
        total: guilds.length,
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
