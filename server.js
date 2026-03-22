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

// Rate limiter store
const requestLimiter = new Map();

// Rate limit middleware
const createRateLimiter = (maxRequests, windowMs) => {
    return (req, res, next) => {
        const ip = req.ip || req.connection.remoteAddress;
        const now = Date.now();
        const windowStart = now - windowMs;

        // Initialize or get limiter data for this IP
        if (!requestLimiter.has(ip)) {
            requestLimiter.set(ip, []);
        }

        const timestamps = requestLimiter.get(ip);
        
        // Remove old timestamps outside the window
        const recentTimestamps = timestamps.filter(timestamp => timestamp > windowStart);
        
        if (recentTimestamps.length >= maxRequests) {
            const retryAfter = Math.ceil((Math.min(...recentTimestamps) + windowMs - now) / 1000);
            return res.status(429).json({ 
                error: "Too many requests. Please try again later.",
                retryAfter: retryAfter 
            });
        }

        // Add current request timestamp
        recentTimestamps.push(now);
        requestLimiter.set(ip, recentTimestamps);

        // Set rate limit headers
        res.setHeader("X-RateLimit-Limit", maxRequests);
        res.setHeader("X-RateLimit-Remaining", maxRequests - recentTimestamps.length);
        res.setHeader("X-RateLimit-Reset", new Date(Math.min(...recentTimestamps) + windowMs).toISOString());

        next();
    };
};

// Rate limiters
const generalLimiter = createRateLimiter(100, 15 * 60 * 1000); // 100 requests per 15 minutes
const apiLimiter = createRateLimiter(50, 15 * 60 * 1000); // 50 requests per 15 minutes for API endpoints

// Cleanup old entries every 30 minutes
setInterval(() => {
    const now = Date.now();
    for (const [ip, timestamps] of requestLimiter.entries()) {
        const recentTimestamps = timestamps.filter(timestamp => timestamp > now - 30 * 60 * 1000);
        if (recentTimestamps.length === 0) {
            requestLimiter.delete(ip);
        } else {
            requestLimiter.set(ip, recentTimestamps);
        }
    }
}, 30 * 60 * 1000);

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
app.get("/api/health", generalLimiter, (req, res) => {
    res.status(200).json({
        status: "online",
        timestamp: new Date().toISOString(),
        botReady: client ? client.isReady() : false,
    });
});

// Bot stats endpoint
app.get("/api/stats", generalLimiter, (req, res) => {
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
app.get("/api/guilds", apiLimiter, verifyApiKey, (req, res) => {
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
app.get("/api/guilds/:guildId/config", apiLimiter, verifyApiKey, async (req, res) => {
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

// Update server configuration
app.post("/api/guilds/:guildId/config", apiLimiter, verifyApiKey, (req, res) => {
    if (!client) {
        return res.status(503).json({ error: "Discord bot not connected" });
    }

    const { guildId } = req.params;
    const { selectedBots, selectedRole, customMessage, setupBy, setupAt } = req.body;

    // Validate required fields
    if (!guildId || !selectedBots || !selectedRole || !customMessage || !setupBy || !setupAt) {
        return res.status(400).json({ 
            error: "Missing required fields: selectedBots, selectedRole, customMessage, setupBy, setupAt" 
        });
    }

    // Validate selectedBots is an array
    if (!Array.isArray(selectedBots) || selectedBots.length === 0) {
        return res.status(400).json({ error: "selectedBots must be a non-empty array" });
    }

    // Validate all selectedBots are supported
    const unsupportedBots = selectedBots.filter(botId => !SUPPORTED_BOT_IDS.includes(botId));
    if (unsupportedBots.length > 0) {
        return res.status(400).json({ 
            error: `Unsupported bot IDs: ${unsupportedBots.join(", ")}` 
        });
    }

    // Validate guild exists
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
        return res.status(404).json({ error: "Guild not found" });
    }

    try {
        // Read current data
        const data = readJsonFile(DATA_PATH, { guilds: {} });
        
        // Ensure guilds object exists
        if (!data.guilds) {
            data.guilds = {};
        }

        // Ensure guild entry exists
        if (!data.guilds[guildId]) {
            data.guilds[guildId] = {};
        }

        // Update notifier configuration
        data.guilds[guildId].notifier = {
            selectedBots: selectedBots,
            selectedRole: selectedRole,
            customMessage: customMessage,
            setupBy: setupBy,
            setupAt: setupAt,
        };

        // Write updated data back to file
        fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), "utf8");

        res.status(200).json({
            success: true,
            message: "Configuration updated successfully",
            guildId: guildId,
            configuration: data.guilds[guildId].notifier,
        });
    } catch (error) {
        console.error("Update config endpoint error:", error);
        res.status(500).json({ 
            error: "Failed to update server configuration",
            details: error.message 
        });
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
