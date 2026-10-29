const { getDatabase } = require("./database");
const { BOT_DATA_KEYS, ADMIN_ID } = require("./constants");
const { getSavedApiKey, getStoredCollection } = require("./ballsdex");

const PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MISSING_PROFILE_TTL_MS = 24 * 60 * 60 * 1000;
const PROFILE_FETCH_GAP_MS = 250;
const DAILY_ADD_LIMIT = 20; // adds per user per 24 h
const MAX_SELF_ENTRIES = 300; // self entries per user, all dexes
const DEX_KEYS = new Set(Object.values(BOT_DATA_KEYS));

let client = null;
let ready = false;
const selfEntries = new Map(); // "dexKey:ballId" -> Map(userId -> addedAt ISO)
const staticCollectors = new WeakMap(); // ball object -> collectors from the dex JSON
const profiles = new Map(); // userId -> { name, username, avatarUrl, missing, fetchedAt }
const addLog = new Map(); // userId -> [timestamps] of recent adds
const queue = [];
const queued = new Set();
let draining = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const entryKey = (dexKey, ballId) => `${dexKey}:${ballId}`;

function defaultAvatar(userId) {
    try {
        return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(userId) >> 22n) % 6n)}.png`;
    } catch {
        return "https://cdn.discordapp.com/embed/avatars/0.png";
    }
}

/* ----- Overlay on client.rarities ----- */

function staticOf(ball) {
    if (!staticCollectors.has(ball)) {
        staticCollectors.set(ball, Array.isArray(ball.collectors) ? ball.collectors.map(String) : null);
    }
    return staticCollectors.get(ball);
}

function applyBall(dexKey, ball) {
    const statics = staticOf(ball);
    const self = selfEntries.get(entryKey(dexKey, ball.id));
    const merged = [...new Set([...(statics || []), ...(self ? self.keys() : [])])];
    if (merged.length) ball.collectors = merged;
    else if (statics) ball.collectors = [];
    else delete ball.collectors;
}

/** Re-merge self entries into the freshly loaded rarities (call after every client.fetchHashes). */
function applyOverlay() {
    if (!client?.rarities) return;
    for (const [dexKey, rarities] of Object.entries(client.rarities)) {
        if (!DEX_KEYS.has(dexKey) || !rarities) continue;
        for (const ball of Object.values(rarities)) {
            if (ball && typeof ball === "object" && ball.id !== undefined) applyBall(dexKey, ball);
        }
    }
    warmProfiles();
}

function findBall(dexKey, ballId) {
    const rarities = client?.rarities?.[dexKey];
    if (!rarities) return null;
    for (const [name, ball] of Object.entries(rarities)) {
        if (Number(ball?.id) === Number(ballId)) return { name, ball };
    }
    return null;
}

/* ----- Discord profiles ----- */

function enqueueProfile(userId) {
    const profile = profiles.get(userId);
    const ttl = profile?.missing ? MISSING_PROFILE_TTL_MS : PROFILE_TTL_MS;
    if (profile && Date.now() - profile.fetchedAt < ttl) return;
    if (queued.has(userId)) return;
    queued.add(userId);
    queue.push(userId);
    drainProfiles();
}

async function drainProfiles() {
    if (draining || !client) return;
    draining = true;
    try {
        while (queue.length) {
            const userId = queue.shift();
            queued.delete(userId);
            let profile = null;
            try {
                const user = await client.users.fetch(userId);
                profile = {
                    name: user.globalName || user.username,
                    username: user.username,
                    avatarUrl: user.displayAvatarURL({ extension: "png", size: 64 }),
                    missing: false,
                    fetchedAt: Date.now(),
                };
            } catch (error) {
                // 10013 Unknown User: deleted account or wrong ID. Anything else: try again later.
                if (error.code === 10013) profile = { name: null, username: null, avatarUrl: null, missing: true, fetchedAt: Date.now() };
            }
            if (profile) {
                profiles.set(userId, profile);
                getDatabase()
                    .then((db) => db.collection("discordProfiles").updateOne({ _id: userId }, { $set: profile }, { upsert: true }))
                    .catch(() => {});
            }
            await sleep(PROFILE_FETCH_GAP_MS);
        }
    } finally {
        draining = false;
    }
}

function warmProfiles() {
    if (!client?.rarities) return;
    for (const [dexKey, rarities] of Object.entries(client.rarities)) {
        if (!DEX_KEYS.has(dexKey) || !rarities) continue;
        for (const ball of Object.values(rarities)) {
            if (Array.isArray(ball?.collectors)) ball.collectors.forEach((id) => enqueueProfile(String(id)));
        }
    }
}

function collectorView(userId, source, addedAt) {
    const profile = profiles.get(userId);
    if (!profile) enqueueProfile(userId);
    return {
        id: userId,
        name: profile?.name || null,
        username: profile?.username || null,
        avatarUrl: profile?.avatarUrl || defaultAvatar(userId),
        missing: Boolean(profile?.missing),
        source,
        addedAt: addedAt || null,
    };
}

/* ----- Public API ----- */

async function init(discordClient) {
    client = discordClient;
    try {
        const db = await getDatabase();
        await db.collection("collectorEntries").createIndex({ dexKey: 1, ballId: 1, userId: 1 }, { unique: true });
        const [entries, cachedProfiles] = await Promise.all([
            db.collection("collectorEntries").find({}).toArray(),
            db.collection("discordProfiles").find({}).toArray(),
        ]);
        for (const entry of entries) {
            const key = entryKey(entry.dexKey, entry.ballId);
            if (!selfEntries.has(key)) selfEntries.set(key, new Map());
            selfEntries.get(key).set(entry.userId, entry.addedAt);
        }
        for (const { _id, ...profile } of cachedProfiles) profiles.set(_id, profile);
        ready = true;
        console.log(`[COLLECTORS] ✅ Loaded ${entries.length} self entries, ${cachedProfiles.length} profiles`);
    } catch (error) {
        console.error("[COLLECTORS] ❌ Storage unavailable:", error.message);
    }
    applyOverlay();
}

/** { [ballId]: [collector, ...] } for one dex, verified first. Null while the dex isn't loaded. */
function getDexCollectors(dexKey) {
    if (!DEX_KEYS.has(dexKey)) return null;
    const rarities = client?.rarities?.[dexKey];
    if (!rarities) return null;
    const entries = {};
    for (const ball of Object.values(rarities)) {
        if (!ball || ball.id === undefined) continue;
        const statics = staticOf(ball) || [];
        const self = selfEntries.get(entryKey(dexKey, ball.id));
        if (!statics.length && !self?.size) continue;
        const list = statics.map((id) => collectorView(id, "verified"));
        for (const [userId, addedAt] of self || []) {
            if (!statics.includes(userId)) list.push(collectorView(userId, "self", addedAt));
        }
        entries[ball.id] = list;
    }
    return { entries, pendingProfiles: queue.length };
}

function fail(status, message, code) {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
}

async function addSelf(userId, dexKey, ballId) {
    if (!ready) throw fail(503, "Collector storage is unavailable right now. Try again later.", "UNAVAILABLE");
    if (!DEX_KEYS.has(dexKey)) throw fail(400, "Unknown dex.", "BAD_DEX");
    const found = findBall(dexKey, ballId);
    if (!found) throw fail(404, "That ball doesn't exist in this dex.", "BAD_BALL");

    const key = entryKey(dexKey, found.ball.id);
    if ((staticOf(found.ball) || []).includes(userId) || selfEntries.get(key)?.has(userId)) {
        throw fail(409, `You're already a collector of ${found.name}.`, "ALREADY");
    }

    if (dexKey === "BD") await checkBallsdexOwnership(userId, found);

    const now = Date.now();
    const recent = (addLog.get(userId) || []).filter((time) => now - time < 24 * 60 * 60 * 1000);
    if (recent.length >= DAILY_ADD_LIMIT) throw fail(429, `You can add yourself to ${DAILY_ADD_LIMIT} balls a day. Try again tomorrow.`, "DAILY_LIMIT");
    let total = 0;
    for (const users of selfEntries.values()) if (users.has(userId)) total++;
    if (total >= MAX_SELF_ENTRIES) throw fail(429, `You've reached the limit of ${MAX_SELF_ENTRIES} self-added collectors.`, "MAX_ENTRIES");

    const addedAt = new Date(now).toISOString();
    const db = await getDatabase();
    try {
        await db.collection("collectorEntries").insertOne({ dexKey, ballId: found.ball.id, ballName: found.name, userId, addedAt });
    } catch (error) {
        if (error.code === 11000) throw fail(409, `You're already a collector of ${found.name}.`, "ALREADY");
        throw error;
    }
    if (!selfEntries.has(key)) selfEntries.set(key, new Map());
    selfEntries.get(key).set(userId, addedAt);
    recent.push(now);
    addLog.set(userId, recent);
    applyBall(dexKey, found.ball);
    enqueueProfile(userId);
    client?.logAPI?.(`Collectors: <@${userId}> added themselves to **${found.name}** (${dexKey})`);
    return { ballId: found.ball.id, ballName: found.name };
}

/**
 * Ballsdex only: the user must have synced their Ballsdex account, and own at least half
 * of the balls the collector needs (cc in Ballsdex.json), counted from their last sync.
 */
async function checkBallsdexOwnership(userId, found) {
    const required = Number.parseInt(found.ball.cc, 10);
    const stored = getSavedApiKey(userId) ? await getStoredCollection(userId).catch(() => null) : null;
    if (!stored) {
        throw fail(403, "Link and sync your Ballsdex account first (Ballsdex tab), so your collection can be checked.", "SYNC_REQUIRED");
    }
    if (!stored.ownedCounts) {
        throw fail(403, "Sync your Ballsdex account once more (Ballsdex tab), so your collection can be checked.", "SYNC_REQUIRED");
    }
    if (!Number.isFinite(required) || required <= 0) return;
    const needed = Math.ceil(required / 2);
    const owned = Number(stored.ownedCounts[found.ball.id]) || 0;
    if (owned < needed) {
        throw fail(
            403,
            `You have ${owned} ${found.name} in your last sync. You need at least ${needed} (half of the ${required} the collector requires).`,
            "NOT_ENOUGH",
        );
    }
}

/** Removes a self entry. Users remove their own; the admin can remove anyone's. */
async function removeSelf(actorId, targetId, dexKey, ballId) {
    if (!ready) throw fail(503, "Collector storage is unavailable right now. Try again later.", "UNAVAILABLE");
    if (actorId !== targetId && actorId !== ADMIN_ID) throw fail(403, "You can only remove yourself.", "FORBIDDEN");
    if (!DEX_KEYS.has(dexKey)) throw fail(400, "Unknown dex.", "BAD_DEX");
    const found = findBall(dexKey, ballId);
    if (!found) throw fail(404, "That ball doesn't exist in this dex.", "BAD_BALL");

    const key = entryKey(dexKey, found.ball.id);
    if (!selfEntries.get(key)?.has(targetId)) {
        if ((staticOf(found.ball) || []).includes(targetId)) {
            throw fail(400, "This entry comes from the dex data. Ask @meffiu to change it.", "STATIC");
        }
        throw fail(404, "No such collector entry.", "NOT_FOUND");
    }

    const db = await getDatabase();
    await db.collection("collectorEntries").deleteOne({ dexKey, ballId: found.ball.id, userId: targetId });
    selfEntries.get(key).delete(targetId);
    if (!selfEntries.get(key).size) selfEntries.delete(key);
    applyBall(dexKey, found.ball);
    client?.logAPI?.(`Collectors: <@${actorId}> removed <@${targetId}> from **${found.name}** (${dexKey})`);
    return { ballId: found.ball.id, ballName: found.name };
}

module.exports = { init, applyOverlay, getDexCollectors, addSelf, removeSelf };
