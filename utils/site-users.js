/**
 * Website users: everyone who logged in with Discord at least once, plus a block list.
 * Mongo `siteUsers` (_id = Discord ID): username, displayName, avatar, firstLoginAt, lastLoginAt, loginCount, lastSeenAt,
 * status ("active" | "blocked"), blockedAt, blockedBy, blockReason, profileHiddenByBlock, imported.
 * Ballsdex link/sync, catch stats and collectors stay where they are; the owner panel only reads them.
 * Blocking is enforced by server.js (every /api/users/:id/* call) and interactionCreate.js (bot commands).
 */

const { getDatabase } = require("./database");
const { getData } = require("./helpers");
const { ADMIN_ID } = require("./constants");

const SNOWFLAKE = /^\d{17,20}$/;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_REASON = 300;
const MAX_ROWS = 5000;

let client = null;
let loading = null;
const blocked = new Map(); // id -> reason
const touched = new Map(); // id -> last write (ms)

const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
const log = (message) => client?.log?.("SYSTEM", message);
const clean = (value, max = 80) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const iso = (value) => (value ? new Date(value).toISOString() : null);

function setClient(c) {
    client = c;
}

async function collection() {
    return (await getDatabase()).collection("siteUsers");
}

/** Everyone who has used the website before this registry existed (Ballsdex link or profile need a login), added once. */
async function importLegacy(col) {
    const users = getData().users || {};
    const ids = Object.entries(users)
        .filter(([id, user]) => SNOWFLAKE.test(id) && (user?.ballsdex || user?.ballsdexSync || user?.profile))
        .map(([id]) => id);
    if (!ids.length) return;
    const existing = new Set((await col.find({ _id: { $in: ids } }).project({ _id: 1 }).toArray()).map((doc) => doc._id));
    const fresh = ids.filter((id) => !existing.has(id));
    if (!fresh.length) return;
    await col.insertMany(
        fresh.map((id) => ({ _id: id, status: "active", imported: true, loginCount: 0, firstSeenAt: new Date() })),
        { ordered: false },
    );
    log(`👥 Site users: imported ${fresh.length} existing account${fresh.length === 1 ? "" : "s"}`);
}

/** Loads the block list into memory (once). */
function init() {
    if (!loading) {
        loading = (async () => {
            const col = await collection();
            await col.createIndex({ status: 1 });
            await col.createIndex({ lastSeenAt: -1 });
            for (const doc of await col.find({ status: "blocked" }).project({ blockReason: 1 }).toArray()) blocked.set(doc._id, doc.blockReason || "");
            await importLegacy(col).catch((error) => client?.logError?.("Site users import failed", error));
        })().catch((error) => {
            loading = null;
            throw error;
        });
    }
    return loading;
}

/** null when the account may use the site and the bot, otherwise { reason }. The owner can't be blocked. */
async function checkAccess(userId) {
    if (userId === ADMIN_ID) return null;
    await init();
    return blocked.has(userId) ? { reason: blocked.get(userId) } : null;
}

const blockedMessage = (reason) => `Your account has been blocked.${reason ? ` Reason: ${reason}` : ""}`;

/** Remember that the user is active (at most one write per 5 minutes per user). */
function touch(userId) {
    const now = Date.now();
    if (now - (touched.get(userId) || 0) < TOUCH_INTERVAL_MS) return;
    touched.set(userId, now);
    collection()
        .then((col) => col.updateOne({ _id: userId }, { $set: { lastSeenAt: new Date(now) }, $setOnInsert: { status: "active", loginCount: 0, firstSeenAt: new Date(now) } }, { upsert: true }))
        .catch(() => touched.delete(userId));
}

/** Called by the website after a successful Discord login. */
async function recordLogin(userId, profile = {}) {
    if (!SNOWFLAKE.test(userId)) throw fail(400, "Invalid user.", "BAD_USER");
    const block = await checkAccess(userId);
    if (block) throw fail(403, blockedMessage(block.reason), "ACCOUNT_BLOCKED");
    const now = new Date();
    const col = await collection();
    await col.updateOne(
        { _id: userId },
        {
            $set: { username: clean(profile.username), displayName: clean(profile.displayName), avatar: clean(profile.avatar, 64) || null, lastLoginAt: now, lastSeenAt: now },
            $inc: { loginCount: 1 },
            $min: { firstLoginAt: now },
            $setOnInsert: { status: "active", firstSeenAt: now },
        },
        { upsert: true },
    );
    touched.set(userId, now.getTime());
}

function nameOf(doc) {
    const cached = client?.users?.cache.get(doc._id);
    let fallback = null;
    try {
        fallback = require("./collector-store").getDiscordProfile(doc._id);
    } catch {
        // not ready
    }
    return {
        username: doc.username || cached?.username || fallback?.username || null,
        displayName: doc.displayName || cached?.globalName || fallback?.name || null,
    };
}

function avatarOf(doc) {
    if (!doc.avatar) return null;
    return `https://cdn.discordapp.com/avatars/${doc._id}/${doc.avatar}.${doc.avatar.startsWith("a_") ? "gif" : "png"}?size=64`;
}

function rowOf(doc, ballsdex) {
    const users = getData().users || {};
    const record = users[doc._id] || {};
    const names = nameOf(doc);
    return {
        id: doc._id,
        username: names.username,
        displayName: names.displayName,
        avatarUrl: avatarOf(doc),
        status: doc.status === "blocked" ? "blocked" : "active",
        ballsdexLinked: ballsdex.isLinked(doc._id),
        lastSyncAt: iso(ballsdex.lastSuccessMs(record.ballsdexSync)),
        firstLoginAt: iso(doc.firstLoginAt),
        lastLoginAt: iso(doc.lastLoginAt),
        lastSeenAt: iso(doc.lastSeenAt),
        loginCount: doc.loginCount || 0,
        imported: Boolean(doc.imported) && !doc.lastLoginAt,
    };
}

const SORTS = {
    seen: (row) => row.lastSeenAt || "",
    login: (row) => row.lastLoginAt || "",
    first: (row) => row.firstLoginAt || "",
    sync: (row) => row.lastSyncAt || "",
};

/** Owner list: search by name or ID, filters, sorting and paging. */
async function list({ search = "", status = "all", ballsdex = "all", sort = "seen", page = 1, pageSize = 25 } = {}) {
    await init();
    const ballsdexApi = require("./ballsdex");
    const docs = await (await collection()).find({}).limit(MAX_ROWS).toArray();
    let rows = docs.map((doc) => rowOf(doc, ballsdexApi));
    const summary = {
        total: rows.length,
        blocked: rows.filter((row) => row.status === "blocked").length,
        ballsdexLinked: rows.filter((row) => row.ballsdexLinked).length,
    };

    const query = clean(search, 60).toLowerCase();
    if (query) rows = rows.filter((row) => row.id.includes(query) || row.username?.toLowerCase().includes(query) || row.displayName?.toLowerCase().includes(query));
    if (status === "active" || status === "blocked") rows = rows.filter((row) => row.status === status);
    if (ballsdex === "linked") rows = rows.filter((row) => row.ballsdexLinked);
    if (ballsdex === "unlinked") rows = rows.filter((row) => !row.ballsdexLinked);

    if (sort === "name") rows.sort((a, b) => (a.username || a.id).localeCompare(b.username || b.id));
    else {
        const key = SORTS[sort] || SORTS.seen;
        rows.sort((a, b) => key(b).localeCompare(key(a)));
    }

    const size = Math.min(Math.max(Number(pageSize) || 25, 1), 50);
    const pages = Math.max(1, Math.ceil(rows.length / size));
    const current = Math.min(Math.max(Number(page) || 1, 1), pages);
    return { summary, matching: rows.length, page: current, pages, users: rows.slice((current - 1) * size, current * size) };
}

/** Owner detail: the row plus a few activity numbers. No tokens, keys or other private data. */
async function detail(userId) {
    if (!SNOWFLAKE.test(userId)) throw fail(400, "Invalid user.", "BAD_USER");
    await init();
    const doc = await (await collection()).findOne({ _id: userId });
    if (!doc) throw fail(404, "This user has never used the website.", "NOT_FOUND");

    const ballsdexApi = require("./ballsdex");
    const row = rowOf(doc, ballsdexApi);
    const blockedBy = doc.blockedBy ? { id: doc.blockedBy, ...nameOf({ _id: doc.blockedBy }) } : null;

    let catches30 = null;
    try {
        catches30 = (await require("./catch-stats").getUserStats(userId))?.last30?.count ?? 0;
    } catch {
        // stats unavailable
    }
    let collectorEntries = null;
    try {
        collectorEntries = require("./collector-store").collectionCounts().get(userId) || 0;
    } catch {
        // storage unavailable
    }
    let profile = null;
    try {
        const stored = require("./profiles").getSettings(userId);
        profile = { public: Boolean(stored.settings?.public), hidden: Boolean(stored.blocked) };
    } catch {
        // no profile
    }

    return {
        ...row,
        catches30,
        collectorEntries,
        profile,
        syncing: Boolean(ballsdexApi.getSyncState(userId)?.inProgress),
        block:
            row.status === "blocked"
                ? { at: iso(doc.blockedAt), by: blockedBy, reason: doc.blockReason || "" }
                : null,
    };
}

async function block(actorId, targetId, reason) {
    if (actorId !== ADMIN_ID) throw fail(403, "Only the owner can block accounts.", "FORBIDDEN");
    if (!SNOWFLAKE.test(targetId)) throw fail(400, "Invalid user.", "BAD_USER");
    if (targetId === ADMIN_ID) throw fail(400, "The owner can't be blocked.", "OWNER");
    const text = clean(reason, MAX_REASON);
    if (text.length < 3) throw fail(400, "Give a reason (at least 3 characters). The user will see it.", "REASON");
    await init();
    if (blocked.has(targetId)) throw fail(409, "This account is already blocked.", "ALREADY");

    const profile = getData().users?.[targetId]?.profile;
    const hideProfile = Boolean(profile && !profile.blocked);
    const now = new Date();
    await (await collection()).updateOne(
        { _id: targetId },
        {
            $set: { status: "blocked", blockedAt: now, blockedBy: actorId, blockReason: text, profileHiddenByBlock: hideProfile },
            $setOnInsert: { firstSeenAt: now, loginCount: 0 },
        },
        { upsert: true },
    );
    blocked.set(targetId, text);

    try {
        require("./ballsdex").cancelSync(targetId);
    } catch {
        // nothing to cancel
    }
    if (hideProfile) await Promise.resolve(require("./profiles").moderate(targetId, "hide")).catch(() => {});
    log(`🔒 Site account blocked: <@${targetId}> by <@${actorId}> | Reason: ${text}`);
    return { status: "blocked" };
}

async function unblock(actorId, targetId) {
    if (actorId !== ADMIN_ID) throw fail(403, "Only the owner can unblock accounts.", "FORBIDDEN");
    if (!SNOWFLAKE.test(targetId)) throw fail(400, "Invalid user.", "BAD_USER");
    await init();
    if (!blocked.has(targetId)) throw fail(409, "This account isn't blocked.", "NOT_BLOCKED");

    const col = await collection();
    const doc = await col.findOne({ _id: targetId });
    await col.updateOne(
        { _id: targetId },
        { $set: { status: "active", unblockedAt: new Date(), unblockedBy: actorId }, $unset: { blockedAt: "", blockedBy: "", blockReason: "", profileHiddenByBlock: "" } },
    );
    blocked.delete(targetId);
    // The profile stays private until the user makes it public again
    if (doc?.profileHiddenByBlock) await Promise.resolve(require("./profiles").moderate(targetId, "unhide")).catch(() => {});
    log(`🔓 Site account unblocked: <@${targetId}> by <@${actorId}>`);
    return { status: "active" };
}

module.exports = { setClient, init, checkAccess, blockedMessage, touch, recordLogin, list, detail, block, unblock };
