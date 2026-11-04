const { getDatabase } = require("./database");
const { BOT_DATA_KEYS, ADMIN_ID, DEX_NAME_BY_KEY } = require("./constants");
const { isLinked, getStoredCollection, verifyFileBall } = require("./ballsdex");
const { getData } = require("./helpers");

const PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MISSING_PROFILE_TTL_MS = 24 * 60 * 60 * 1000;
const PROFILE_FETCH_GAP_MS = 250;
const DAILY_ADD_LIMIT = 20; // adds per user per 24 h
const MAX_SELF_ENTRIES = 300; // entries a user added themselves (not added by the owner), all dexes
const MAX_UNVERIFIED = 5; // unverified entries per user, per dex (checked in addSelf, i.e. on the backend)
// Enabled dexes only (the list can change while the bot runs)
const DEX_KEYS = { has: (key) => Object.values(BOT_DATA_KEYS).includes(key) };

let client = null;
let ready = false;
// Statuses: "verified", "unverified" or "removed" (hides a collector from the dex data). Old records say "self":
// in Ballsdex those were only saved after the sync + half-CC check, so they count as verified; in every other
// dex nothing was ever checked, so they are unverified (see normalizeStatus, applied when the records load).
const selfEntries = new Map(); // "dexKey:ballId" -> Map(userId -> { addedAt, status, addedBy? })
const staticCollectors = new WeakMap(); // ball object -> collectors from the dex JSON
const profiles = new Map(); // userId -> { name, username, avatarUrl, missing, fetchedAt }
const addLog = new Map(); // userId -> [timestamps] of recent adds
const queue = [];
const queued = new Set();
let draining = false;

// Discord renames a deleted account to deleted_user_<id> (deleted_account_<id> in older exports); its entries are dropped
const DELETED_USERNAME = /^deleted_(?:user|account)_[a-z0-9]+$/;
const isDeletedProfile = (profile) => Boolean(profile && !profile.missing && DELETED_USERNAME.test(String(profile.username || "")));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const entryKey = (dexKey, ballId) => `${dexKey}:${ballId}`;

function normalizeStatus(dexKey, status) {
    if (status === "verified" || status === "unverified" || status === "removed") return status;
    return dexKey === "BD" ? "verified" : "unverified"; // legacy "self"
}

// One add at a time per user, so the limits can't be beaten by sending several requests at once
const userLocks = new Map();
function withUserLock(userId, task) {
    const run = (userLocks.get(userId) || Promise.resolve()).then(task, task);
    const tail = run.catch(() => {});
    userLocks.set(userId, tail);
    tail.then(() => userLocks.get(userId) === tail && userLocks.delete(userId));
    return run;
}

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

// "removed" entries hide a collector from the dex data; "verified"/"unverified" ones add a collector
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
    purgeKnownDeleted();
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
                if (isDeletedProfile(profile)) purgeDeletedUser(userId).catch((error) => console.error("[COLLECTORS] ❌ Couldn't remove a deleted account:", error.message));
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

/**
 * Removes a deleted Discord account from every collector list: its website entries are deleted, and the ones
 * that come from the dex JSON (which can't be edited from here) are hidden like an owner removal. Also its
 * Specials entries. Only called for an account whose Discord username is exactly the deleted-account pattern.
 */
async function purgeDeletedUser(userId) {
    if (!ready || !client?.rarities) return 0;
    const db = await getDatabase();
    let count = 0;
    for (const [dexKey, rarities] of Object.entries(client.rarities)) {
        if (!DEX_KEYS.has(dexKey) || !rarities) continue;
        for (const [name, ball] of Object.entries(rarities)) {
            if (!ball || typeof ball !== "object" || ball.id === undefined) continue;
            const key = entryKey(dexKey, ball.id);
            const entry = selfEntries.get(key)?.get(userId);
            if ((staticOf(ball) || []).includes(userId)) {
                if (entry?.status === "removed") continue;
                await saveEntry(dexKey, { name, ball }, userId, { addedAt: new Date().toISOString(), status: "removed" }, { removedBy: "deleted-account" });
                count++;
            } else if (entry) {
                await db.collection("collectorEntries").deleteOne({ dexKey, ballId: ball.id, userId });
                selfEntries.get(key).delete(userId);
                if (!selfEntries.get(key).size) selfEntries.delete(key);
                applyBall(dexKey, ball);
                count++;
            }
        }
    }
    count += await require("./special-collectors").purgeUser(userId);
    if (count) client?.log?.("COLLECTORS", `🗑️ Removed ${count} collector entries of the deleted account ${userId}`);
    return count;
}

/** Deleted accounts already known from the cached profiles (also catches entries left by an earlier run). */
function purgeKnownDeleted() {
    for (const [userId, profile] of profiles) {
        if (isDeletedProfile(profile)) purgeDeletedUser(userId).catch((error) => console.error("[COLLECTORS] ❌ Couldn't remove a deleted account:", error.message));
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

// Users with a public website profile (their names link to /u/<id>)
function publicProfileIds() {
    const ids = new Set();
    for (const [userId, user] of Object.entries(getData().users || {})) {
        if (user?.profile?.public && !user.profile.blocked) ids.add(userId);
    }
    return ids;
}

function collectorView(userId, source, addedAt, origin = "site", publicIds = null) {
    const profile = profiles.get(userId);
    if (!profile) enqueueProfile(userId);
    return {
        hasProfile: Boolean(publicIds?.has(userId)),
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
            selfEntries.get(key).set(entry.userId, { addedAt: entry.addedAt, status: normalizeStatus(entry.dexKey, entry.status), addedBy: entry.addedBy });
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
    const publicIds = publicProfileIds();
    for (const ball of Object.values(rarities)) {
        if (!ball || ball.id === undefined) continue;
        const statics = staticOf(ball) || [];
        const self = selfEntries.get(entryKey(dexKey, ball.id));
        const list = [];
        for (const id of statics) {
            const entry = self?.get(id);
            if (entry?.status === "removed") continue;
            list.push(entry ? collectorView(id, entry.status, entry.addedAt, "data", publicIds) : collectorView(id, "verified", null, "data", publicIds));
        }
        for (const [userId, entry] of self || []) {
            if (entry.status === "verified" && !statics.includes(userId)) list.push(collectorView(userId, "verified", entry.addedAt, "site", publicIds));
        }
        for (const [userId, entry] of self || []) {
            if (entry.status === "unverified" && !statics.includes(userId)) list.push(collectorView(userId, "unverified", entry.addedAt, "site", publicIds));
        }
        list.sort((a, b) => (b.source === "verified") - (a.source === "verified")); // verified first (stable)
        if (list.length) entries[ball.id] = list;
    }
    return { entries, pendingProfiles: queue.length };
}

// Log label for a user: a Discord mention (the website log shows it as "username (id)")
const who = (userId) => `<@${userId}>`;

function fail(status, message, code) {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
}

/**
 * Adds the user as a collector of a ball. Never refused for lack of a sync: the entry is "verified" only when the
 * Ballsdex check passes (synced account owning at least half of the CC requirement), otherwise "unverified".
 * Every other dex is always "unverified" (nothing to confirm it with); the owner can verify entries by hand.
 * A user can have at most MAX_UNVERIFIED unverified entries per dex.
 */
async function addSelf(userId, dexKey, ballId) {
    const found = resolveBall(dexKey, ballId);
    if (activeIds(dexKey, found.ball).includes(userId)) {
        throw fail(409, `You're already a collector of ${found.name}.`, "ALREADY");
    }

    let status = "unverified";
    let reason = null;
    if (dexKey === "BD") {
        try {
            await checkBallsdexOwnership(userId, found);
            status = "verified";
        } catch (error) {
            reason = error.message;
        }
    }

    return withUserLock(userId, async () => {
        if (activeIds(dexKey, found.ball).includes(userId)) throw fail(409, `You're already a collector of ${found.name}.`, "ALREADY");

        const now = Date.now();
        const recent = (addLog.get(userId) || []).filter((time) => now - time < 24 * 60 * 60 * 1000);
        if (recent.length >= DAILY_ADD_LIMIT) throw fail(429, `You can add yourself to ${DAILY_ADD_LIMIT} balls a day. Try again tomorrow.`, "DAILY_LIMIT");
        let total = 0;
        let unverified = 0;
        for (const [key, users] of selfEntries) {
            const entry = users.get(userId);
            if (!entry || entry.status === "removed") continue;
            if (!entry.addedBy) total++;
            if (entry.status === "unverified" && key.startsWith(`${dexKey}:`) && !entry.addedBy) unverified++;
        }
        if (total >= MAX_SELF_ENTRIES) throw fail(429, `You've reached the limit of ${MAX_SELF_ENTRIES} self-added collectors.`, "MAX_ENTRIES");
        if (status === "unverified" && unverified >= MAX_UNVERIFIED) {
            throw fail(429, `You already have ${MAX_UNVERIFIED} unverified collections in ${DEX_NAME_BY_KEY[dexKey] || "this dex"}. Remove one first, or ask the owner to verify one.`, "UNVERIFIED_LIMIT");
        }

        await saveEntry(dexKey, found, userId, { addedAt: new Date(now).toISOString(), status });
        recent.push(now);
        addLog.set(userId, recent);
        enqueueProfile(userId);
        client?.log?.("COLLECTORS", `➕ ${who(userId)} added themselves to ${found.name} (${dexKey}) as ${status}${reason ? ` (${reason})` : ""}`);
        return { ballId: found.ball.id, ballName: found.name, status, reason: status === "unverified" ? reason : null };
    });
}

/**
 * Ballsdex only: the user must have synced their Ballsdex account, and own at least half
 * of the balls the collector needs (cc in Ballsdex.json), counted from their last sync.
 */
async function checkBallsdexOwnership(userId, found) {
    const required = Number(String(found.ball.cc ?? "").replace(/\D/g, "")); // "2,800" -> 2800
    const stored = isLinked(userId) ? await getStoredCollection(userId).catch(() => null) : null;
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
        let confirmed;
        try {
            confirmed = await verifyFileBall(userId, found.ball.id);
        } catch (error) {
            // Ballsdex couldn't answer (rate limit, outage): that's not "these balls aren't yours"
            if (error.code === "RECONNECT" || error.code === "NOT_LINKED") throw fail(403, error.message, "RECONNECT");
            if (error.ballsdexApi) {
                throw fail(error.status === 429 ? 429 : 503, `Your Fast Sync balls couldn't be checked in Ballsdex right now. ${error.message}`, "BALLSDEX_UNAVAILABLE");
            }
            confirmed = false;
        }
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
    selfEntries.get(key).set(userId, { ...entry, addedBy: extra.addedBy ?? entry.addedBy });
    applyBall(dexKey, found.ball);
}

function resolveBall(dexKey, ballId) {
    if (!ready) throw fail(503, "Collector storage is unavailable right now. Try again later.", "UNAVAILABLE");
    if (!DEX_KEYS.has(dexKey)) throw fail(400, "Unknown dex.", "BAD_DEX");
    const found = findBall(dexKey, ballId);
    if (!found) throw fail(404, "That ball doesn't exist in this dex.", "BAD_BALL");
    return found;
}

/** Tells a collector the owner changed one of their entries (entries within an hour become one notification). */
function tellCollector(targetId, found, dexKey, what) {
    try {
        require("./notifications")
            .notify(targetId, "collector_status", {
                title: `Collector ${what}`,
                body: `${found.name} (${DEX_NAME_BY_KEY[dexKey] || dexKey}): ${what}`,
                link: "/collectors",
                linkLabel: "Open Collectors",
                merge: true,
            })
            .catch(() => {});
    } catch {
        // notifications are optional
    }
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
    tellCollector(targetId, found, dexKey, "added as verified");
    client?.log?.("COLLECTORS", `✅ ${who(actorId)} added ${who(targetId)} to ${found.name} (${dexKey}) as verified`);
    return { ballId: found.ball.id, ballName: found.name };
}

/**
 * Owner only: verify / unverify any collector. For collectors from the dex data (always verified in the JSON, which
 * can't be edited from here) "unverified" is saved as an override entry (addedBy = owner, so it isn't counted in the
 * user's limits); making them verified again deletes the override.
 */
async function setStatus(actorId, targetId, dexKey, ballId, status) {
    if (actorId !== ADMIN_ID) throw fail(403, "Only the owner can change a collector's status.", "FORBIDDEN");
    if (status !== "verified" && status !== "unverified") throw fail(400, "Invalid status.", "BAD_STATUS");
    const found = resolveBall(dexKey, ballId);
    const key = entryKey(dexKey, found.ball.id);
    const current = selfEntries.get(key)?.get(targetId);
    const fromData = (staticOf(found.ball) || []).includes(targetId);
    if (current?.status === "removed" || (!current && !fromData)) throw fail(404, "No such collector entry.", "NOT_FOUND");
    const currentStatus = current ? current.status : "verified";
    if (currentStatus === status) throw fail(409, `That collector is already ${status}.`, "ALREADY");

    if (fromData && status === "verified") {
        const db = await getDatabase();
        await db.collection("collectorEntries").deleteOne({ dexKey, ballId: found.ball.id, userId: targetId });
        selfEntries.get(key)?.delete(targetId);
        if (selfEntries.get(key)?.size === 0) selfEntries.delete(key);
        applyBall(dexKey, found.ball);
    } else {
        await saveEntry(
            dexKey,
            found,
            targetId,
            { addedAt: current?.addedAt || new Date().toISOString(), status, addedBy: current?.addedBy ?? (fromData ? actorId : undefined) },
            { statusBy: actorId, statusAt: new Date().toISOString() },
        );
    }
    tellCollector(targetId, found, dexKey, status === "verified" ? "verified" : "set to unverified");
    client?.log?.("COLLECTORS", `🛡️ ${who(actorId)} set ${who(targetId)} to ${status} for ${found.name} (${dexKey})`);
    return { ballId: found.ball.id, ballName: found.name, status };
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
    if (actorId !== targetId) tellCollector(targetId, found, dexKey, "removed by the owner");
    client?.log?.("COLLECTORS", `➖ ${who(actorId)} removed ${actorId === targetId ? "themselves" : who(targetId)} from ${found.name} (${dexKey})`);
    return { ballId: found.ball.id, ballName: found.name };
}

/* ----- Profiles (website /u/<id>) ----- */

/** Every ball a user collects: [{ dexKey, id, name, rarity, verified }]. */
function getUserCollections(userId) {
    const result = [];
    for (const [dexKey, rarities] of Object.entries(client?.rarities || {})) {
        if (!DEX_KEYS.has(dexKey) || !rarities) continue;
        for (const [name, ball] of Object.entries(rarities)) {
            if (!ball || typeof ball !== "object" || ball.id === undefined) continue;
            const entry = selfEntries.get(entryKey(dexKey, ball.id))?.get(userId);
            if (entry?.status === "removed") continue;
            const fromData = (staticOf(ball) || []).includes(userId);
            if (!fromData && !entry) continue;
            result.push({ dexKey, id: Number(ball.id), name, rarity: ball.rarity, verified: entry ? entry.status === "verified" : fromData });
        }
    }
    return result;
}

/** userId -> number of balls collected, over every dex. */
function collectionCounts() {
    const counts = new Map();
    for (const [dexKey, rarities] of Object.entries(client?.rarities || {})) {
        if (!DEX_KEYS.has(dexKey) || !rarities) continue;
        for (const ball of Object.values(rarities)) {
            if (!ball || typeof ball !== "object" || ball.id === undefined) continue;
            for (const userId of activeIds(dexKey, ball)) counts.set(userId, (counts.get(userId) || 0) + 1);
        }
    }
    return counts;
}

/** Cached Discord name and avatar (fetched in the background when missing or old). */
function getDiscordProfile(userId) {
    enqueueProfile(userId);
    const profile = profiles.get(userId);
    return profile && !profile.missing ? profile : null;
}

const pendingProfiles = () => queue.length;

module.exports = { init, applyOverlay, getDexCollectors, addSelf, addVerified, setStatus, removeSelf, getUserCollections, collectionCounts, getDiscordProfile, defaultAvatar, publicProfileIds, collectorView, pendingProfiles };
