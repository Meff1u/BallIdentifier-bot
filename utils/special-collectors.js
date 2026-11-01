/**
 * Special collectors: users who collect a Ballsdex special (website Collectors -> Specials).
 *
 * Same idea as collector-store.js, but for specials and without any ownership check, so it's
 * protected against abuse instead: a Discord login, a Discord account of a minimum age, a daily
 * limit, a cap per user, and removal by the owner. Entries live in MongoDB (specialCollectorEntries).
 */

const { getDatabase } = require("./database");
const { ADMIN_ID } = require("./constants");
const specials = require("./specials");
const collectorStore = require("./collector-store");

const DAILY_ADD_LIMIT = 10; // adds per user per 24 h (removing and re-adding still counts)
const MAX_PER_USER = 10;
const MIN_ACCOUNT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DISCORD_EPOCH = 1420070400000n;

let client = null;
let ready = false;
const entries = new Map(); // specialId -> Map(userId -> { addedAt })
const addLog = new Map(); // userId -> [timestamps] of recent adds

const setClient = (c) => {
    client = c;
};

function fail(status, message, code) {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
}

function accountAgeMs(userId) {
    try {
        return Date.now() - Number((BigInt(userId) >> 22n) + DISCORD_EPOCH);
    } catch {
        return 0;
    }
}

async function init(discordClient) {
    client = discordClient;
    try {
        const db = await getDatabase();
        await db.collection("specialCollectorEntries").createIndex({ specialId: 1, userId: 1 }, { unique: true });
        const docs = await db.collection("specialCollectorEntries").find({}).toArray();
        for (const doc of docs) {
            if (!entries.has(doc.specialId)) entries.set(doc.specialId, new Map());
            entries.get(doc.specialId).set(doc.userId, { addedAt: doc.addedAt });
        }
        ready = true;
        client?.logGeneral?.(`Special collectors: loaded ${docs.length} entries`);
    } catch (error) {
        console.error("[COLLECTORS] ❌ Special collector storage unavailable:", error.message);
    }
}

/** { [specialId]: [collector, ...] }, oldest first. */
function getAll() {
    const publicIds = collectorStore.publicProfileIds();
    const result = {};
    for (const [specialId, users] of entries) {
        if (!users.size) continue;
        result[specialId] = [...users]
            .sort((a, b) => String(a[1].addedAt).localeCompare(String(b[1].addedAt)))
            .map(([userId, entry]) => collectorStore.collectorView(userId, "self", entry.addedAt, "site", publicIds));
    }
    return { entries: result, pendingProfiles: collectorStore.pendingProfiles(), limits: { daily: DAILY_ADD_LIMIT, max: MAX_PER_USER } };
}

const countOf = (userId) => {
    let total = 0;
    for (const users of entries.values()) if (users.has(userId)) total++;
    return total;
};

async function findSpecial(specialId) {
    if (!ready) throw fail(503, "Collector storage is unavailable right now. Try again later.", "UNAVAILABLE");
    if (!Number.isInteger(specialId)) throw fail(400, "Invalid special.", "BAD_SPECIAL");
    const { specials: list } = await specials.getSpecials();
    const special = list.find((item) => item.id === specialId);
    if (!special) throw fail(404, "That special doesn't exist.", "BAD_SPECIAL");
    return { id: special.id, name: special.alias || special.name || `Special #${special.id}` };
}

async function add(userId, specialId) {
    const special = await findSpecial(specialId);
    if (entries.get(special.id)?.has(userId)) throw fail(409, `You're already a collector of ${special.name}.`, "ALREADY");

    if (userId !== ADMIN_ID) {
        if (accountAgeMs(userId) < MIN_ACCOUNT_AGE_MS) {
            throw fail(403, "Your Discord account is too new to add itself as a collector. Try again in a few days.", "ACCOUNT_TOO_NEW");
        }
        const now = Date.now();
        const recent = (addLog.get(userId) || []).filter((time) => now - time < DAY_MS);
        addLog.set(userId, recent);
        if (recent.length >= DAILY_ADD_LIMIT) throw fail(429, `You can add yourself to ${DAILY_ADD_LIMIT} specials a day. Try again tomorrow.`, "DAILY_LIMIT");
        if (countOf(userId) >= MAX_PER_USER) throw fail(429, `You can collect up to ${MAX_PER_USER} specials. Remove one first.`, "MAX_ENTRIES");
    }

    const addedAt = new Date().toISOString();
    const db = await getDatabase();
    await db.collection("specialCollectorEntries").updateOne({ specialId: special.id, userId }, { $set: { specialName: special.name, addedAt } }, { upsert: true });
    if (!entries.has(special.id)) entries.set(special.id, new Map());
    entries.get(special.id).set(userId, { addedAt });
    if (addLog.has(userId)) addLog.get(userId).push(Date.now());
    else addLog.set(userId, [Date.now()]);
    collectorStore.getDiscordProfile(userId); // warms the name and avatar
    client?.log?.("COLLECTORS", `➕ ${userId} added themselves to special ${special.name} (#${special.id})`);
    return { specialId: special.id, specialName: special.name };
}

/** Users remove themselves; the owner can remove anyone. */
async function remove(actorId, targetId, specialId) {
    if (actorId !== targetId && actorId !== ADMIN_ID) throw fail(403, "You can only remove yourself.", "FORBIDDEN");
    if (!ready) throw fail(503, "Collector storage is unavailable right now. Try again later.", "UNAVAILABLE");
    if (!entries.get(specialId)?.has(targetId)) throw fail(404, "No such collector entry.", "NOT_FOUND");
    const db = await getDatabase();
    await db.collection("specialCollectorEntries").deleteOne({ specialId, userId: targetId });
    entries.get(specialId).delete(targetId);
    if (!entries.get(specialId).size) entries.delete(specialId);
    client?.log?.("COLLECTORS", `➖ ${actorId === targetId ? `${actorId} removed themselves` : `${actorId} removed ${targetId}`} from special #${specialId}`);
    return { specialId };
}

/** Specials a user collects, newest special first (for the public profile). */
async function getUserSpecials(userId) {
    const ids = [...entries].filter(([, users]) => users.has(userId)).map(([specialId]) => specialId);
    if (!ids.length) return [];
    let known = [];
    try {
        known = (await specials.getSpecials()).specials;
    } catch {
        /* names fall back below */
    }
    const byId = new Map(known.map((item) => [item.id, item]));
    return ids
        .sort((a, b) => b - a)
        .map((id) => {
            const item = byId.get(id);
            return { id, name: item ? item.alias || item.name || `Special #${id}` : `Special #${id}`, emoji: item?.emoji || null, officialEmoji: item?.officialEmoji || null };
        });
}

module.exports = { setClient, init, getAll, add, remove, getUserSpecials };
