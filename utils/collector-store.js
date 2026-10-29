const { getDatabase } = require("./database");
const { BOT_DATA_KEYS, ADMIN_ID } = require("./constants");
const { getSavedApiKey, getStoredCollection, verifyFileBall } = require("./ballsdex");

const PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MISSING_PROFILE_TTL_MS = 24 * 60 * 60 * 1000;
const PROFILE_FETCH_GAP_MS = 250;
const DAILY_ADD_LIMIT = 20; // adds per user per 24 h
const MAX_SELF_ENTRIES = 300; // self entries per user, all dexes
const DEX_KEYS = new Set(Object.values(BOT_DATA_KEYS));

let client = null;
let ready = false;
const selfEntries = new Map(); // "dexKey:ballId" -> Map(userId -> { addedAt, status: "self" | "verified" | "removed" })
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

// "removed" entries hide a collector from the dex data; "self"/"verified" ones add a collector
function activeIds(dexKey, ball) {
    const statics = staticOf(ball) || [];
    const entries = selfEntries.get(entryKey(dexKey, ball.id));
    const ids = statics.filter((id) => entries?.get(id)?.status !== "removed");
    for (const [userId, entry] of entries || []) if (entry.status !== "removed") ids.push(userId);
    return [...new Set(ids)];
}

function applyBall(dexKey, ball) {
    const statics = staticOf(ball);
    const merged = activeIds(dexKey, ball);
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

function collectorView(userId, source, addedAt, origin = "site") {
    const profile = profiles.get(userId);
    if (!profile) enqueueProfile(userId);
    return {
        id: userId,
        name: profile?.name || null,
        username: profile?.username || null,
        avatarUrl: profile?.avatarUrl || defaultAvatar(userId),
        missing: Boolean(profile?.missing),
        source,
        origin, // "data": from the dex JSON (only the owner can remove it), "site": added on the website
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
            selfEntries.get(key).set(entry.userId, { addedAt: entry.addedAt, status: entry.status || "self" });
        }
        for (const { _id, ...profile } of cachedProfiles) profiles.set(_id, profile);
        ready = true;
        client?.logGeneral?.(`Collectors: loaded ${entries.length} website entries, ${cachedProfiles.length} cached profiles`);
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
        const list = [];
        for (const id of statics) {
            const entry = self?.get(id);
            if (entry?.status === "removed") continue;
            list.push(entry ? collectorView(id, entry.status, entry.addedAt) : collectorView(id, "verified", null, "data"));
        }
        for (const [userId, entry] of self || []) {
            if (entry.status === "verified" && !statics.includes(userId)) list.push(collectorView(userId, "verified", entry.addedAt));
        }
        for (const [userId, entry] of self || []) {
            if (entry.status === "self" && !statics.includes(userId)) list.push(collectorView(userId, "self", entry.addedAt));
        }
        if (list.length) entries[ball.id] = list;
    }
    return { entries, pendingProfiles: queue.length };
}

// Log label for a user: "@name (id)" when the profile is known
function who(userId) {
    const profile = profiles.get(userId);
    return profile?.username ? `@${profile.username} (${userId})` : userId;
}

function fail(status, message, code) {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
}

async function addSelf(userId, dexKey, ballId) {
    const found = resolveBall(dexKey, ballId);
    if (activeIds(dexKey, found.ball).includes(userId)) {
        throw fail(409, `You're already a collector of ${found.name}.`, "ALREADY");
    }

    if (dexKey === "BD") {
        try {
            await checkBallsdexOwnership(userId, found);
        } catch (error) {
            client?.log?.("COLLECTORS", `⛔ ${who(userId)} couldn't add themselves to ${found.name} (${dexKey}): ${error.message}`);
            throw error;
        }
    }

    const now = Date.now();
    const recent = (addLog.get(userId) || []).filter((time) => now - time < 24 * 60 * 60 * 1000);
    if (recent.length >= DAILY_ADD_LIMIT) throw fail(429, `You can add yourself to ${DAILY_ADD_LIMIT} balls a day. Try again tomorrow.`, "DAILY_LIMIT");
    let total = 0;
    for (const users of selfEntries.values()) if (users.get(userId)?.status === "self") total++;
    if (total >= MAX_SELF_ENTRIES) throw fail(429, `You've reached the limit of ${MAX_SELF_ENTRIES} self-added collectors.`, "MAX_ENTRIES");

    const addedAt = new Date(now).toISOString();
    await saveEntry(dexKey, found, userId, { addedAt, status: "self" });
    recent.push(now);
    addLog.set(userId, recent);
    applyBall(dexKey, found.ball);
    enqueueProfile(userId);
    client?.log?.("COLLECTORS", `➕ ${who(userId)} added themselves to ${found.name} (${dexKey})`);
    return { ballId: found.ball.id, ballName: found.name };
}

/**
 * Ballsdex only: the user must have synced their Ballsdex account, and own at least half
 * of the balls the collector needs (cc in Ballsdex.json), counted from their last sync.
 */
async function checkBallsdexOwnership(userId, found) {
    const required = Number(String(found.ball.cc ?? "").replace(/\D/g, "")); // "2,800" -> 2800
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
    // Imported with Fast Sync: a file can be edited, so check some of these balls in the Ballsdex account itself
    if (stored.summary?.source === "file") {
        const confirmed = await verifyFileBall(userId, found.ball.id).catch(() => false);
        if (!confirmed) {
            throw fail(
                403,
                `Your ${found.name} from the Fast Sync file couldn't be confirmed in your Ballsdex account. Use "Sync now" (it reads your collection from Ballsdex directly) and try again.`,
                "FILE_UNVERIFIED",
            );
        }
    }
}

async function saveEntry(dexKey, found, userId, entry, extra = {}) {
    const db = await getDatabase();
    await db.collection("collectorEntries").updateOne(
        { dexKey, ballId: found.ball.id, userId },
        { $set: { ballName: found.name, ...entry, ...extra } },
        { upsert: true },
    );
    const key = entryKey(dexKey, found.ball.id);
    if (!selfEntries.has(key)) selfEntries.set(key, new Map());
    selfEntries.get(key).set(userId, entry);
    applyBall(dexKey, found.ball);
}

function resolveBall(dexKey, ballId) {
    if (!ready) throw fail(503, "Collector storage is unavailable right now. Try again later.", "UNAVAILABLE");
    if (!DEX_KEYS.has(dexKey)) throw fail(400, "Unknown dex.", "BAD_DEX");
    const found = findBall(dexKey, ballId);
    if (!found) throw fail(404, "That ball doesn't exist in this dex.", "BAD_BALL");
    return found;
}

/** Owner only: add any Discord user as a verified collector (no ownership checks). */
async function addVerified(actorId, targetId, dexKey, ballId) {
    if (actorId !== ADMIN_ID) throw fail(403, "Only the owner can add other collectors.", "FORBIDDEN");
    const found = resolveBall(dexKey, ballId);
    const current = selfEntries.get(entryKey(dexKey, found.ball.id))?.get(targetId);
    const fromData = (staticOf(found.ball) || []).includes(targetId);
    if ((fromData && current?.status !== "removed") || current?.status === "verified") {
        throw fail(409, `That user is already a verified collector of ${found.name}.`, "ALREADY");
    }
    await saveEntry(dexKey, found, targetId, { addedAt: new Date().toISOString(), status: "verified" }, { addedBy: actorId });
    enqueueProfile(targetId);
    client?.log?.("COLLECTORS", `✅ ${who(actorId)} added ${who(targetId)} to ${found.name} (${dexKey}) as verified`);
    return { ballId: found.ball.id, ballName: found.name };
}

/** Users remove their own website entries; the owner can remove anyone, including dex-data collectors. */
async function removeSelf(actorId, targetId, dexKey, ballId) {
    if (actorId !== targetId && actorId !== ADMIN_ID) throw fail(403, "You can only remove yourself.", "FORBIDDEN");
    const found = resolveBall(dexKey, ballId);
    const key = entryKey(dexKey, found.ball.id);
    const current = selfEntries.get(key)?.get(targetId);
    const fromData = (staticOf(found.ball) || []).includes(targetId);
    if (!activeIds(dexKey, found.ball).includes(targetId)) throw fail(404, "No such collector entry.", "NOT_FOUND");
    if (fromData && actorId !== ADMIN_ID && !current) {
        throw fail(400, "This entry comes from the dex data. Ask @meffiu to change it.", "STATIC");
    }

    const db = await getDatabase();
    if (fromData) {
        // Collectors from the dex JSON can't be deleted from the file: hide them instead
        await saveEntry(dexKey, found, targetId, { addedAt: new Date().toISOString(), status: "removed" }, { removedBy: actorId });
    } else {
        await db.collection("collectorEntries").deleteOne({ dexKey, ballId: found.ball.id, userId: targetId });
        selfEntries.get(key)?.delete(targetId);
        if (selfEntries.get(key)?.size === 0) selfEntries.delete(key);
        applyBall(dexKey, found.ball);
    }
    client?.log?.("COLLECTORS", `➖ ${who(actorId)} removed ${actorId === targetId ? "themselves" : who(targetId)} from ${found.name} (${dexKey})`);
    return { ballId: found.ball.id, ballName: found.name };
}

module.exports = { init, applyOverlay, getDexCollectors, addSelf, addVerified, removeSelf };
