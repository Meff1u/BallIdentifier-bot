const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

// Import helpers
const { readJsonFile, getAssetsPath } = require("./utils/helpers");
const { SUPPORTED_BOT_IDS } = require("./utils/constants");

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

// Get server configuration
app.get("/api/guilds/:guildId/config", verifyApiKey, async (req, res) => {
    if (!client) {
        return res.status(503).json({ error: "Discord bot not connected" });
    }

    const { guildId } = req.params;
    const guild = client.guilds.cache.get(guildId);

    if (!guild) {
        return res.status(404).json({ error: "Guild not found" });
    }

    try {
        // Fetch all members to ensure cache is complete
        await guild.members.fetch();

        // 1. Get supported bots present on this server
        const botMembers = guild.members.cache.filter(member => 
            member.user.bot && SUPPORTED_BOT_IDS.includes(member.id)
        );
        const supportedBots = Array.from(botMembers.values()).map(member => ({
            id: member.id,
            name: member.user.username,
        }));

        // 2. Get roles below BallIdentifier bot's highest role
        const botMember = guild.members.cache.get(client.user.id);
        let availableRoles = [];

        if (botMember && botMember.roles.highest) {
            const botHighestRolePosition = botMember.roles.highest.position;
            availableRoles = guild.roles.cache
                .filter(role => 
                    role.position < botHighestRolePosition && 
                    role.id !== guild.id
                )
                .map(role => ({
                    id: role.id,
                    name: role.name,
                    position: role.position,
                }))
                .sort((a, b) => b.position - a.position);
        }

        // 3. Get current configuration from data.json
        const data = readJsonFile(DATA_PATH, { guilds: {} });
        const guildConfig = data.guilds && data.guilds[guildId] ? data.guilds[guildId] : null;

        res.status(200).json({
            guildId: guildId,
            guildName: guild.name,
            supportedBots: supportedBots,
            availableRoles: availableRoles,
            configuration: guildConfig || { message: "No configuration set up yet" },
        });
    } catch (error) {
        console.error("Server config endpoint error:", error);
        res.status(500).json({ error: "Failed to fetch server configuration" });
    }
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
