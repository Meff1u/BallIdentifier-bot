const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Import helpers
const { readJsonFile, getAssetsPath } = require("./utils/helpers");
const { SUPPORTED_BOT_IDS } = require("./utils/constants");

const PORT = process.env.PORT || 3001;
const DATA_PATH = getAssetsPath("data.json");

const app = express();

// CORS configuration - restrict to ballidentifier.xyz
app.use(
    cors({
        origin: process.env.CORS_ORIGIN || "https://ballidentifier.xyz",
        credentials: true,
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
    })
);

// Request size limit - 1KB to prevent DoS attacks
// rawBody is kept so request signatures can be verified
app.use(
    express.json({
        limit: "1kb",
        verify: (req, res, buf) => {
            req.rawBody = buf.toString("utf8");
        },
    })
);

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
            return res.status(429).json({ 
                error: "Too many requests. Please try again later."
            });
        }

        // Add current request timestamp
        recentTimestamps.push(now);
        requestLimiter.set(ip, recentTimestamps);

        // Set rate limit headers
        res.setHeader("X-RateLimit-Limit", maxRequests);
        res.setHeader("X-RateLimit-Remaining", Math.max(0, maxRequests - recentTimestamps.length));
        res.setHeader("X-RateLimit-Reset", new Date(Math.min(...recentTimestamps) + windowMs).toISOString());

        next();
    };
};

// Rate limiters
const generalLimiter = createRateLimiter(10, 60 * 1000); // 10 requests per minute
const apiLimiter = createRateLimiter(5, 60 * 1000); // 5 requests per minute for API endpoints

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

// Max allowed difference between request timestamp and server time
const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

const verifySignature = (req, res, next) => {
    const secret = process.env.BOT_API_SECRET;

    if (!secret) {
        return res.status(500).json({ error: "API secret not configured" });
    }

    const timestamp = req.get("X-Timestamp");
    const signature = req.get("X-Signature") || "";

    if (!timestamp || !/^\d+$/.test(timestamp) || !/^[a-f0-9]{64}$/i.test(signature)) {
        return res.status(401).json({ error: "Missing or invalid signature headers" });
    }

    if (Math.abs(Date.now() - Number(timestamp)) > SIGNATURE_MAX_AGE_MS) {
        return res.status(401).json({ error: "Request expired" });
    }

    const expected = crypto
        .createHmac("sha256", secret)
        .update(`${timestamp}.${req.method}.${req.originalUrl}.${req.rawBody || ""}`)
        .digest("hex");

    if (!crypto.timingSafeEqual(Buffer.from(signature.toLowerCase(), "hex"), Buffer.from(expected, "hex"))) {
        client?.logAPI?.(`${req.method} ${req.originalUrl} | Status: Rejected - invalid signature`);
        return res.status(403).json({ error: "Invalid signature" });
    }

    next();
};

// Middleware to validate guild config request body
const validateGuildConfigInput = (req, res, next) => {
    const { selectedBots, selectedRole, customMessage, setupBy, setupAt, isDelete } = req.body;

    // Skip validation for delete operations (minimal data needed)
    if (isDelete) {
        return next();
    }

    // Validate customMessage (same rules as the dashboard, enforced server-side)
    if (customMessage !== undefined && typeof customMessage !== "string") {
        return res.status(400).json({ error: "customMessage must be a string" });
    }

    if (customMessage) {
        if (customMessage.length > 200) {
            return res.status(400).json({
                error: "customMessage exceeds maximum length of 200 characters",
            });
        }

        if (!customMessage.includes("{role}")) {
            return res.status(400).json({ error: "customMessage must contain the {role} placeholder" });
        }

        if (/(https?:\/\/|www\.|\[.*?\]\(.*?\))/i.test(customMessage)) {
            return res.status(400).json({ error: "Links are not allowed in customMessage" });
        }

        if (/@(everyone|here)/i.test(customMessage) || /<@[!&]?\d+>/.test(customMessage)) {
            return res.status(400).json({ error: "Mentions are not allowed in customMessage (use {role})" });
        }
    }

    // Validate selectedRole is a valid Discord snowflake ID (18-20 digits)
    if (selectedRole && typeof selectedRole === "string") {
        if (!/^\d{17,20}$/.test(selectedRole)) {
            return res.status(400).json({
                error: "selectedRole must be a valid Discord role ID (17-20 digits)",
            });
        }
    }

    // Validate setupBy is a valid Discord username (2-32 chars, alphanumeric + . _ -)
    if (setupBy && typeof setupBy === "string") {
        if (!/^[a-zA-Z0-9._-]{2,32}$/.test(setupBy)) {
            return res.status(400).json({
                error: "setupBy must be a valid Discord username (2-32 characters, alphanumeric with . _ -)",
            });
        }
    }

    // Validate setupAt is a valid timestamp
    if (setupAt) {
        if (typeof setupAt !== "number" || setupAt <= 0) {
            return res.status(400).json({
                error: "setupAt must be a valid positive timestamp",
            });
        }
    }

    next();
};

// Reject malformed guild IDs before any route handler runs
app.param("guildId", (req, res, next, guildId) => {
    if (!/^\d{17,20}$/.test(guildId)) {
        return res.status(400).json({ error: "Invalid guild ID" });
    }
    next();
});

// API Routes

// Health check endpoint
app.get("/api/health", generalLimiter, (req, res) => {
    client?.logAPI?.(`GET /api/health | Status: OK`);
    res.status(200).json({
        status: "online",
        timestamp: new Date().toISOString(),
        botReady: client ? client.isReady() : false,
    });
});

// Bot stats endpoint
app.get("/api/stats", generalLimiter, (req, res) => {
    if (!client) {
        client?.logAPI?.(`GET /api/stats | Status: Error`);
        return res.status(503).json({ error: "Discord bot not connected" });
    }

    // Fetch app data and read user data in parallel
    Promise.all([
        client.application.fetch(),
        Promise.resolve(readJsonFile(DATA_PATH, { users: {}, guilds: {} })),
    ]).then(([appData, data]) => {
        const users = data.users || {};
        const guilds = data.guilds || {};
        const usersIdentified = Object.values(users).reduce(
            (acc, u) => acc + (u.identifyAmount || 0), 0
        );
        const guildsIdentified = Object.values(guilds).reduce(
            (acc, g) => acc + (g.identifyAmount || 0), 0
        );
        const identifiedBalls = usersIdentified + guildsIdentified;
        const userCount = Math.max(appData.approximateUserInstallCount, Object.keys(users).length);

        client?.logAPI?.(`GET /api/stats | Guilds: ${client.guilds.cache.size} | Users: ${userCount}`);

        res.status(200).json({
            guilds: client.guilds.cache.size,
            users: userCount,
            identifiedBalls: identifiedBalls,
        });
    }).catch((err) => {
        console.error("[API] Stats endpoint error:", err);
        client?.logAPI?.(`GET /api/stats | Status: Error - ${err.message}`);
        res.status(500).json({ error: "Failed to fetch stats" });
    });
});

// Get list of guilds where bot is present
app.get("/api/guilds", apiLimiter, verifySignature, (req, res) => {
    if (!client) {
        client?.logAPI?.(`GET /api/guilds | Status: Error - Bot not connected`);
        return res.status(503).json({ error: "Discord bot not connected" });
    }

    const guilds = client.guilds.cache.map(guild => ({
        id: guild.id,
        name: guild.name,
        icon: guild.icon,
        memberCount: guild.memberCount,
    }));

    client.logAPI(`GET /api/guilds | Retrieved ${guilds.length} guilds`);

    res.status(200).json({
        guilds: guilds,
        total: guilds.length,
    });
});

// Get server configuration
app.get("/api/guilds/:guildId/config", apiLimiter, verifySignature, async (req, res) => {
    if (!client) {
        return res.status(503).json({ error: "Discord bot not connected" });
    }

    const { guildId } = req.params;
    const guild = client.guilds.cache.get(guildId);

    if (!guild) {
        client.logAPI(`GET /api/guilds/${guildId}/config | Status: Error - Guild not found`);
        return res.status(404).json({ error: "Guild not found" });
    }

    try {
        // Fetch all members with timeout to avoid hanging on large servers
        try {
            await Promise.race([
                guild.members.fetch(),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error("Members fetch timeout")), 5000)
                )
            ]);
        } catch (fetchError) {
            console.warn(`[API] Members fetch failed for guild ${guildId}: ${fetchError.message}. Using cached members.`);
            client.logAPI(`GET /api/guilds/${guildId}/config | Members fetch timeout, using cache`);
        }

        // 1. Get supported bots present on this server (uses cache, which may be partial if fetch timed out)
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

        client.logAPI(`GET /api/guilds/${guildId}/config | Guild: ${guild.name} | Bots: ${supportedBots.length} | Roles: ${availableRoles.length}`);

        res.status(200).json({
            guildId: guildId,
            guildName: guild.name,
            supportedBots: supportedBots,
            availableRoles: availableRoles,
            configuration: guildConfig || { message: "No configuration set up yet" },
        });
    } catch (error) {
        console.error("[API] Server config endpoint error:", error);
        client.logAPI(`GET /api/guilds/${guildId}/config | Status: Error - ${error.message}`);
        res.status(500).json({ error: "Failed to fetch server configuration" });
    }
});

// Update server configuration
app.post("/api/guilds/:guildId/config", apiLimiter, verifySignature, validateGuildConfigInput, (req, res) => {
    if (!client) {
        return res.status(503).json({ error: "Discord bot not connected" });
    }

    const { guildId } = req.params;
    const { selectedBots, selectedRole, customMessage, setupBy, setupAt, isDelete } = req.body;

    // Validate guild exists
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
        client.logAPI(`POST /api/guilds/${guildId}/config | Status: Error - Guild not found`);
        return res.status(404).json({ error: "Guild not found" });
    }

    try {
        // Read current data
        const data = readJsonFile(DATA_PATH, { guilds: {} });
        
        // Ensure guilds object exists
        if (!data.guilds) {
            data.guilds = {};
        }

        // Handle delete operation
        if (isDelete) {
            // Delete notifier configuration for this guild
            if (data.guilds[guildId]) {
                delete data.guilds[guildId].notifier;
            }

            // Write updated data back to file
            fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), "utf8");

            client.logAPI(`POST /api/guilds/${guildId}/config | Configuration deleted for guild: ${guild.name} (${guildId}) by ${setupBy}`);

            return res.status(200).json({
                success: true,
                message: "Configuration deleted successfully",
                guildId: guildId,
            });
        }

        // Handle save/update operation
        // Validate required fields
        if (!selectedBots || !selectedRole || !customMessage || !setupBy || !setupAt) {
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

        // Validate role: must exist, not @everyone, not a managed (bot/integration) role,
        // and be below the bot's highest role (same list the dashboard shows)
        const role = guild.roles.cache.get(selectedRole);
        const botHighestPosition = guild.members.me?.roles.highest.position ?? 0;
        if (!role || role.id === guild.id || role.managed || role.position >= botHighestPosition) {
            return res.status(400).json({ error: "Invalid role selected" });
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

        client.logAPI(`POST /api/guilds/${guildId}/config | Configuration updated for guild: ${guild.name} (${guildId}) by ${setupBy} | Bots: ${selectedBots.length}`);

        res.status(200).json({
            success: true,
            message: "Configuration updated successfully",
            guildId: guildId,
            configuration: data.guilds[guildId].notifier,
        });
    } catch (error) {
        console.error("[API] Update config endpoint error:", error);
        client.logAPI(`POST /api/guilds/${guildId}/config | Status: Error - ${error.message}`);
        res.status(500).json({ 
            error: "Failed to update server configuration",
            details: error.message 
        });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error("[API] Server error:", err);
    res.status(500).json({ error: "Internal server error" });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: "Not found" });
});

// Start server
const startServer = () => {
    app.listen(PORT, () => {
        console.log(`[API] Server running on http://localhost:${PORT}`);
        console.log(`[API] Dashboard API ready at http://localhost:${PORT}/api`);
    });
};

module.exports = { app, startServer, initializeServer };
