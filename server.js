const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

// Import helpers
const { getData, updateData } = require("./utils/helpers");
const { SUPPORTED_BOT_IDS } = require("./utils/constants");
const {
    decryptFromSite,
    linkApiKey,
    unlinkAccount,
    getSavedApiKey,
    getStoredCollection,
    getSyncState,
    getRateLimits,
    startSync,
    cancelSync,
    computeRaws,
} = require("./utils/ballsdex");
const notifications = require("./utils/notifications");
const collectorStore = require("./utils/collector-store");

const PORT = process.env.PORT || 3001;

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

// Rate limit middleware (each limiter has its own store, so public and API limits don't share a budget)
const rateLimiterStores = [];

const createRateLimiter = (maxRequests, windowMs) => {
    const store = new Map();
    rateLimiterStores.push({ store, windowMs });

    return (req, res, next) => {
        const ip = req.ip || req.socket.remoteAddress;
        const now = Date.now();
        const recentTimestamps = (store.get(ip) || []).filter((timestamp) => timestamp > now - windowMs);

        if (recentTimestamps.length >= maxRequests) {
            store.set(ip, recentTimestamps);
            return res.status(429).json({
                error: "Too many requests. Please try again later.",
            });
        }

        recentTimestamps.push(now);
        store.set(ip, recentTimestamps);

        // Set rate limit headers
        res.setHeader("X-RateLimit-Limit", maxRequests);
        res.setHeader("X-RateLimit-Remaining", Math.max(0, maxRequests - recentTimestamps.length));
        res.setHeader("X-RateLimit-Reset", new Date(recentTimestamps[0] + windowMs).toISOString());

        next();
    };
};

// Rate limiters - requests come through Netlify functions, which share a few IPs across all users
const generalLimiter = createRateLimiter(60, 60 * 1000); // public endpoints
const apiLimiter = createRateLimiter(30, 60 * 1000); // signed dashboard endpoints

// Cleanup old entries every 30 minutes
setInterval(() => {
    const now = Date.now();
    for (const { store, windowMs } of rateLimiterStores) {
        for (const [ip, timestamps] of store.entries()) {
            const recent = timestamps.filter((timestamp) => timestamp > now - windowMs);
            recent.length ? store.set(ip, recent) : store.delete(ip);
        }
    }
}, 30 * 60 * 1000).unref();

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

// Bot stats endpoint (cached - application.fetch() is a Discord API call)
const STATS_CACHE_MS = 60 * 1000;
let statsCache = { at: 0, value: null };

app.get("/api/stats", generalLimiter, async (req, res) => {
    if (!client?.isReady()) {
        return res.status(503).json({ error: "Discord bot not connected" });
    }

    if (statsCache.value && Date.now() - statsCache.at < STATS_CACHE_MS) {
        return res.status(200).json(statsCache.value);
    }

    try {
        const appData = await client.application.fetch();
        const { users, guilds } = getData();
        const sumIdentified = (entries) => Object.values(entries).reduce((acc, entry) => acc + (entry.identifyAmount || 0), 0);

        const value = {
            guilds: client.guilds.cache.size,
            users: Math.max(appData.approximateUserInstallCount || 0, Object.keys(users).length),
            identifiedBalls: sumIdentified(users) + sumIdentified(guilds),
        };
        statsCache = { at: Date.now(), value };

        client.logAPI?.(`GET /api/stats | Guilds: ${value.guilds} | Users: ${value.users}`);
        res.status(200).json(value);
    } catch (err) {
        console.error("[API] Stats endpoint error:", err);
        client.logAPI?.(`GET /api/stats | Status: Error - ${err.message}`);
        res.status(500).json({ error: "Failed to fetch stats" });
    }
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
        const guildConfig = getData().guilds[guildId] || null;

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
        // Handle delete operation
        if (isDelete) {
            updateData((data) => {
                if (data.guilds[guildId]) delete data.guilds[guildId].notifier;
            });

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

        // Update notifier configuration (atomic read-modify-write)
        const notifier = { selectedBots, selectedRole, customMessage, setupBy, setupAt };
        updateData((data) => {
            data.guilds[guildId] ??= {};
            data.guilds[guildId].notifier = notifier;
        });

        client.logAPI(`POST /api/guilds/${guildId}/config | Configuration updated for guild: ${guild.name} (${guildId}) by ${setupBy} | Bots: ${selectedBots.length}`);

        res.status(200).json({
            success: true,
            message: "Configuration updated successfully",
            guildId: guildId,
            configuration: notifier,
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

// ---------------------------------------------------------------------------
// Ballsdex account (website). The user id comes from the website's encrypted
// Discord session and the request is HMAC-signed, so it can be trusted here.
// ---------------------------------------------------------------------------

app.param("userId", (req, res, next, userId) => {
    if (!/^\d{17,20}$/.test(userId)) {
        return res.status(400).json({ error: "Invalid user ID" });
    }
    next();
});

// Link status, sync status and saved collection summary
app.get("/api/users/:userId/ballsdex", apiLimiter, verifySignature, async (req, res) => {
    const { userId } = req.params;
    const linkedAt = getData().users[userId]?.ballsdex?.linkedAt || null;
    const linked = Boolean(getSavedApiKey(userId));

    let collection = null;
    let databaseAvailable = true;
    if (linked) {
        try {
            const stored = await getStoredCollection(userId);
            if (stored) {
                collection = {
                    summary: stored.summary,
                    ballCount: stored.ballCount,
                    lastSyncedAt: stored.lastSyncedAt,
                    // saved before top-5 rankings and raws existed: one new sync refreshes it
                    needsResync: !Array.isArray(stored.nonSpecial),
                };
            }
        } catch (error) {
            databaseAvailable = false;
            console.error("[API] Ballsdex collection read failed:", error.message);
        }
    }

    res.status(200).json({ linked, linkedAt, sync: getSyncState(userId), collection, databaseAvailable });
});

// Link a Ballsdex API key (encrypted end-to-end by the website)
app.post("/api/users/:userId/ballsdex/link", apiLimiter, verifySignature, async (req, res) => {
    const { userId } = req.params;

    let apiKey;
    try {
        apiKey = decryptFromSite(req.body?.encryptedKey).trim();
    } catch {
        return res.status(400).json({ error: "Invalid request" });
    }
    if (apiKey.length < 10 || apiKey.length > 200) {
        return res.status(400).json({ error: "That doesn't look like a Ballsdex API key." });
    }

    try {
        await linkApiKey(userId, apiKey);
        client?.logAPI?.(`POST /api/users/${userId}/ballsdex/link | Linked`);
        res.status(200).json({ success: true, linked: true });
    } catch (error) {
        if (error.code === "COOLDOWN") {
            return res.status(429).json({ error: error.message, retryAfterSec: error.retryAfterSec });
        }
        if (error.code === "WRONG_ACCOUNT") {
            return res.status(403).json({ error: error.message, code: "WRONG_ACCOUNT" });
        }
        if (error.status === 401 || error.status === 403) {
            return res.status(400).json({ error: "Ballsdex rejected this API key. Check that it is correct and has all scopes.", code: "INVALID_KEY" });
        }
        if (error.status === 429) {
            return res.status(429).json({ error: "The Ballsdex API is rate limiting requests. Try again later." });
        }
        console.error("[API] Ballsdex link failed:", error);
        res.status(502).json({ error: "Could not reach the Ballsdex API. Try again later." });
    }
});

// Unlink: remove the encrypted key and synced data
app.post("/api/users/:userId/ballsdex/unlink", apiLimiter, verifySignature, async (req, res) => {
    const { userId } = req.params;
    const wasLinked = await unlinkAccount(userId);
    client?.logAPI?.(`POST /api/users/${userId}/ballsdex/unlink | ${wasLinked ? "Unlinked" : "Not linked"}`);
    res.status(200).json({ success: true, linked: false, wasLinked });
});

// Start a background sync (one sync at a time for everyone; 12 h cooldown shared with /ballsdex sync)
app.post("/api/users/:userId/ballsdex/sync", apiLimiter, verifySignature, (req, res) => {
    const { userId } = req.params;
    const result = startSync(userId);

    if (!result.started) {
        const hours = Math.floor((result.retryAfterSec || 0) / 3600);
        const minutes = Math.ceil(((result.retryAfterSec || 0) % 3600) / 60);
        const errors = {
            NOT_LINKED: [400, "Link your Ballsdex account first."],
            IN_PROGRESS: [409, "Your collection is already being synchronized."],
            BUSY: [409, "Another collection sync is running right now. You'll get a notification when you can start yours."],
            COOLDOWN: [429, `You can sync again in ${hours ? `${hours} h ` : ""}${minutes} min.`],
        };
        const [status, message] = errors[result.reason];
        return res.status(status).json({ error: message, code: result.reason, retryAfterSec: result.retryAfterSec ?? null, sync: getSyncState(userId) });
    }

    client?.logAPI?.(`POST /api/users/${userId}/ballsdex/sync | Started`);
    res.status(202).json({ success: true, sync: getSyncState(userId) });
});

// Cancel the user's running sync (stops after the current page)
app.post("/api/users/:userId/ballsdex/cancel", apiLimiter, verifySignature, (req, res) => {
    const { userId } = req.params;
    if (!cancelSync(userId)) return res.status(409).json({ error: "No sync is running.", code: "NOT_RUNNING" });
    client?.logAPI?.(`POST /api/users/${userId}/ballsdex/cancel`);
    res.status(200).json({ success: true, sync: getSyncState(userId) });
});

// Raws: rare (t1-t23) non-special balls x tier value, from the last sync
app.get("/api/users/:userId/ballsdex/raws", apiLimiter, verifySignature, async (req, res) => {
    const { userId } = req.params;
    if (!getSavedApiKey(userId)) return res.status(200).json({ available: false, reason: "NOT_LINKED" });
    try {
        const stored = await getStoredCollection(userId);
        if (!stored) return res.status(200).json({ available: false, reason: "NO_DATA" });
        if (!Array.isArray(stored.nonSpecial)) return res.status(200).json({ available: false, reason: "RESYNC" });
        const rarityData = client?.rarities?.BD;
        if (!rarityData) return res.status(503).json({ error: "Dex data is still loading. Try again in a moment." });
        res.status(200).json({ available: true, lastSyncedAt: stored.lastSyncedAt, raws: computeRaws(stored.nonSpecial, rarityData) });
    } catch (error) {
        console.error("[API] Raws failed:", error.message);
        res.status(503).json({ error: "Collection storage is unavailable right now." });
    }
});

// Ballsdex API rate-limit usage: the user's key and the bot's shared IP
app.get("/api/users/:userId/ballsdex/ratelimit", apiLimiter, verifySignature, async (req, res) => {
    const { userId } = req.params;
    try {
        const limits = await getRateLimits(userId);
        if (!limits) return res.status(200).json({ available: false, reason: "NOT_LINKED" });
        res.status(200).json({ available: true, ...limits });
    } catch (error) {
        console.error("[API] Rate limits failed:", error.message);
        const message = error.status === 401 || error.status === 403 ? "Ballsdex rejected your API key. Link it again." : "Couldn't reach the Ballsdex API.";
        res.status(502).json({ error: message });
    }
});

// Collectors of one dex (verified from the dex data + self-added on the website)
app.get("/api/collectors/:dexKey", generalLimiter, verifySignature, (req, res) => {
    const result = collectorStore.getDexCollectors(req.params.dexKey);
    if (!result) return res.status(503).json({ error: "Dex data is still loading. Try again in a moment." });
    res.status(200).json(result);
});

// Add or remove yourself as a collector (the admin can also remove others' self entries)
app.post("/api/users/:userId/collectors", apiLimiter, verifySignature, async (req, res) => {
    const { userId } = req.params;
    const { action, dexKey, ballId, targetUserId } = req.body || {};
    if (!["add", "remove"].includes(action) || typeof dexKey !== "string" || !Number.isInteger(ballId)) {
        return res.status(400).json({ error: "Invalid request" });
    }
    if (targetUserId !== undefined && (typeof targetUserId !== "string" || !/^\d{17,20}$/.test(targetUserId))) {
        return res.status(400).json({ error: "Invalid user" });
    }
    try {
        const result = action === "add"
            ? await collectorStore.addSelf(userId, dexKey, ballId)
            : await collectorStore.removeSelf(userId, targetUserId || userId, dexKey, ballId);
        res.status(200).json({ success: true, ...result });
    } catch (error) {
        if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
        console.error("[API] Collectors update failed:", error.message);
        res.status(503).json({ error: "Collector storage is unavailable right now. Try again later." });
    }
});

// Notifications (website history + per-type settings)
app.get("/api/users/:userId/notifications", apiLimiter, verifySignature, (req, res) => {
    const { userId } = req.params;
    notifications.markWebUser(userId);
    res.status(200).json({ ...notifications.getInbox(userId), types: notifications.publicTypes() });
});

app.post("/api/users/:userId/notifications/read", apiLimiter, verifySignature, (req, res) => {
    const { userId } = req.params;
    const ids = req.body?.all ? null : Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 100).map(String) : [];
    const unread = notifications.markRead(userId, ids);
    res.status(200).json({ success: true, unread });
});

app.post("/api/users/:userId/notifications/settings", apiLimiter, verifySignature, (req, res) => {
    const { userId } = req.params;
    const { type, enabled, dm } = req.body || {};
    if (!notifications.TYPES[type]) return res.status(400).json({ error: "Unknown notification type" });
    if ((enabled !== undefined && typeof enabled !== "boolean") || (dm !== undefined && typeof dm !== "boolean")) {
        return res.status(400).json({ error: "enabled and dm must be booleans" });
    }
    res.status(200).json({ success: true, settings: notifications.setSetting(userId, type, { enabled, dm }) });
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
