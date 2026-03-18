const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3001;

const app = express();

app.use(cors());
app.use(express.json());

let discordClient;

const initializeServer = (client) => {
    discordClient = client;
};

// API Routes

// Health check endpoint
app.get("/api/health", (req, res) => {
    res.status(200).json({
        status: "online",
        timestamp: new Date().toISOString(),
        botReady: discordClient ? discordClient.isReady() : false,
    });
});

// Bot stats endpoint
app.get("/api/stats", (req, res) => {
    if (!discordClient) {
        return res.status(503).json({ error: "Discord bot not connected" });
    }

    res.status(200).json({
        uptime: discordClient.uptime,
        guilds: discordClient.guilds.cache.size,
        users: discordClient.users.cache.size,
        readyAt: discordClient.readyAt,
        latency: discordClient.ws.ping,
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
