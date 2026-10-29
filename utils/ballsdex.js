const crypto = require("crypto");

const { getData, updateData } = require("./helpers");
const { getDatabase } = require("./database");

const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const API_BASE_URL = process.env.BALLSDEX_API_URL || "https://ballsdex.com/api/v1";
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const PAGE_SIZE = 25;
const PAGE_REQUEST_DELAY = 1000; // ~60 pages/min: the per-key limit, and kind to the shared per-IP limit
const SYNC_COOLDOWN_MS = 12 * 60 * 60 * 1000; // after a successful sync
const SYNC_RETRY_COOLDOWN_MS = 5 * 60 * 1000; // after a failed or cancelled sync
const TOP_ENTRIES = 5;

// Raw value of one non-special ball per rarity tier (t19-t23 share 0.1). Tiers are the dex "rarity" rank.
const RAW_TIER_VALUES = [
    [1, 1],
    [4, 0.8],
    [6, 0.75],
    [7, 0.5],
    [10, 0.4],
    [12, 0.25],
    [15, 0.2],
    [18, 0.15],
    [19, 0.1],
];
const RAW_MAX_TIER = 23;
const LINK_COOLDOWN_MS = 20 * 1000;
const SPECIAL_WRITE_BATCH_SIZE = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getEncryptionKey() {
    const secret = process.env.BALLSDEX_API_ENCRYPTION_KEY;

    if (!secret) {
        throw new Error("BALLSDEX_API_ENCRYPTION_KEY is not configured.");
    }

    return crypto.createHash("sha256").update(secret).digest();
}

function encryptApiKey(apiKey) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, getEncryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);

    return {
        version: 1,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        value: encrypted.toString("base64"),
    };
}

function decryptApiKey(encryptedKey) {
    if (!encryptedKey?.iv || !encryptedKey?.tag || !encryptedKey?.value) {
        throw new Error("Saved Ballsdex API key is invalid.");
    }

    const decipher = crypto.createDecipheriv(
        ENCRYPTION_ALGORITHM,
        getEncryptionKey(),
        Buffer.from(encryptedKey.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(encryptedKey.tag, "base64"));

    return Buffer.concat([
        decipher.update(Buffer.from(encryptedKey.value, "base64")),
        decipher.final(),
    ]).toString("utf8");
}

const MAX_RATE_LIMIT_WAIT_MS = 120 * 1000;
const MAX_429_RETRIES = 5;

async function readError(response) {
    let detail = `HTTP ${response.status}`;
    try {
        const body = await response.json();
        detail = body.detail || body.title || detail;
    } catch (error) {}
    const error = new Error(detail);
    error.status = response.status;
    return error;
}

const RATE_PROBE_MAX_AGE_MS = 30 * 1000;
const RATE_LIMIT_LABELS = {
    minute: "Per minute",
    day: "Per day",
    player_minute: "Player lookups per minute",
    ip_minute: "Per minute",
    ip_day: "Per day",
};
const keyRateLimits = new Map(); // sha256(apiKey) -> { at, limits }
let ipRateLimits = null; // { at, limits }

const hashKey = (apiKey) => crypto.createHash("sha256").update(apiKey).digest("hex");

function parseRateLimitList(value) {
    const out = new Map();
    for (const part of String(value || "").split(",")) {
        const match = /^\s*"([^"]+)"\s*;(.*)$/.exec(part);
        if (!match) continue;
        const params = {};
        for (const pair of match[2].split(";")) {
            const [key, raw] = pair.trim().split("=");
            if (key && raw !== undefined && Number.isFinite(Number(raw))) params[key] = Number(raw);
        }
        out.set(match[1], params);
    }
    return out;
}

function recordRateLimits(apiKey, headers) {
    const policies = parseRateLimitList(headers.get("ratelimit-policy"));
    if (!policies.size) return;
    const states = parseRateLimitList(headers.get("ratelimit"));
    const limits = [];
    for (const [name, policy] of policies) {
        if (!Number.isFinite(policy.q) || policy.q <= 0) continue;
        const state = states.get(name) || {};
        limits.push({
            name,
            limit: policy.q,
            windowSec: policy.w,
            remaining: Number.isFinite(state.r) ? state.r : policy.q,
            resetSec: Number.isFinite(state.t) ? state.t : policy.w,
        });
    }
    const at = Date.now();
    const keyLimits = limits.filter((limit) => !limit.name.startsWith("ip_"));
    const ipLimits = limits.filter((limit) => limit.name.startsWith("ip_"));
    if (keyLimits.length) keyRateLimits.set(hashKey(apiKey), { at, limits: keyLimits });
    if (ipLimits.length) ipRateLimits = { at, limits: ipLimits };
}

// A snapshot as it stands now: a window that has reset since is shown as unused
function viewRateLimits(snapshot) {
    if (!snapshot) return null;
    const elapsedSec = (Date.now() - snapshot.at) / 1000;
    return {
        updatedAt: new Date(snapshot.at).toISOString(),
        limits: snapshot.limits.map((limit) => {
            const reset = elapsedSec >= limit.resetSec;
            const remaining = reset ? limit.limit : limit.remaining;
            return {
                name: limit.name,
                label: RATE_LIMIT_LABELS[limit.name] || limit.name,
                limit: limit.limit,
                remaining,
                used: limit.limit - remaining,
                resetInSec: reset ? null : Math.max(0, Math.ceil(limit.resetSec - elapsedSec)),
            };
        }),
    };
}

/** Rate-limit usage of the user's key and of the bot's shared IP. Probes /me when the snapshot is stale. */
async function getRateLimits(userId) {
    const encryptedKey = getSavedApiKey(userId);
    if (!encryptedKey) return null;
    const apiKey = decryptApiKey(encryptedKey);
    const hash = hashKey(apiKey);
    const snapshot = keyRateLimits.get(hash);
    if (!snapshot || Date.now() - snapshot.at > RATE_PROBE_MAX_AGE_MS) {
        try {
            await ballsdexFetch(apiKey, "/me", {}, { retry: false });
        } catch (error) {
            if (error.status !== 429) throw error; // a 429 still carries the headers
        }
    }
    return { key: viewRateLimits(keyRateLimits.get(hash)), ip: viewRateLimits(ipRateLimits) };
}

// One API call that follows the documented rate-limit headers (https://ballsdex.com/api/docs/):
// waits out a 429 using Retry-After, and returns how long to pause before the next call.
async function ballsdexFetch(apiKey, path, query = {}, { retry = true } = {}) {
    const url = new URL(`${API_BASE_URL}${path}`);
    Object.entries(query).forEach(([key, value]) => {
        if (value !== undefined && value !== null) url.searchParams.set(key, value);
    });

    for (let attempt = 0; ; attempt++) {
        const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
        recordRateLimits(apiKey, response.headers);

        if (response.status === 429 && retry && attempt < MAX_429_RETRIES) {
            const waitMs = (Number(response.headers.get("retry-after")) || 2) * 1000;
            if (waitMs > MAX_RATE_LIMIT_WAIT_MS) throw await readError(response);
            await sleep(waitMs + 250);
            continue;
        }
        if (!response.ok) throw await readError(response);

        const remaining = response.headers.get("x-ratelimit-remaining");
        const resetAfter = Number(response.headers.get("x-ratelimit-reset-after")) || 0;
        const waitMs = remaining === "0" ? Math.min(resetAfter * 1000 + 250, MAX_RATE_LIMIT_WAIT_MS) : 0;
        return { data: await response.json(), waitMs };
    }
}

async function ballsdexRequest(apiKey, path, query = {}) {
    return (await ballsdexFetch(apiKey, path, query)).data;
}

function getItems(response) {
    if (Array.isArray(response)) return response;
    return response.items || response.results || response.data || [];
}

// /me/balls returns at most 25 per page; walk next_cursor to the end
class SyncCancelled extends Error {
    constructor() {
        super("Sync cancelled.");
        this.code = "CANCELLED";
    }
}

async function getAllMyBalls(apiKey, onPage, shouldStop = () => false) {
    const balls = [];
    let cursor;

    do {
        if (shouldStop()) throw new SyncCancelled();
        const { data, waitMs } = await ballsdexFetch(apiKey, "/me/balls", { limit: PAGE_SIZE, cursor });
        balls.push(...getItems(data));
        cursor = data.next_cursor;
        onPage?.(balls.length);
        if (cursor) await sleep(Math.max(waitMs, PAGE_REQUEST_DELAY));
    } while (cursor);

    return balls;
}

// Ball total as Ballsdex itself counts it. Null when the profile is private.
// special_count is NOT the number of special balls (it's far lower, e.g. 44 vs 2,825 owned),
// so specials are always counted from the synced balls.
async function getPlayerTotals(apiKey, discordUserId) {
    try {
        const player = await ballsdexRequest(apiKey, `/players/${discordUserId}`);
        if (!Number.isFinite(player?.ball_count)) return null;
        return { ballCount: player.ball_count };
    } catch (error) {
        if (error.status === 404 || error.status === 403) return null;
        throw error;
    }
}

function getBallId(ball) {
    return ball.ball?.id || ball.ball_id || ball.id;
}

function getSpecialId(ball) {
    return ball.special?.id || ball.special_id || null;
}

function buildCollectionSummary(profile, balls, totals = null) {
    const ballCounts = new Map();
    const countryCounts = new Map();
    const specialCounts = new Map();
    const specialBallCounts = new Map();
    let specialCount = 0;
    let selfCaughtCount = 0;
    let favoriteCount = 0;
    let frameCount = 0;
    let catchTimeTotal = 0;
    let fastestCatchMs = null;
    let slowestCatchMs = null;
    let fastestCatch = null;
    let slowestCatch = null;
    let timedCatchCount = 0;
    let oldestCaughtAt = null;
    let newestCaughtAt = null;
    const catchesByDay = new Map();

    for (const ball of balls) {
        const ballId = getBallId(ball);
        if (ballId !== undefined) ballCounts.set(ballId, (ballCounts.get(ballId) || 0) + 1);
        if (getSpecialId(ball)) specialCount += 1;
        if (ball.self_caught) selfCaughtCount += 1;
        if (ball.favorite) favoriteCount += 1;
        if (ball.is_frame) frameCount += 1;

        const country = ball.ball?.country;
        if (country) countryCounts.set(country, (countryCounts.get(country) || 0) + 1);

        const special = ball.special?.name;
        if (special) specialCounts.set(special, (specialCounts.get(special) || 0) + 1);
        if (special && ball.ball?.id && country) {
            const specialBallKey = String(ball.ball.id);
            const current = specialBallCounts.get(specialBallKey) || {
                ballId: ball.ball.id,
                name: country,
                count: 0,
            };
            current.count += 1;
            specialBallCounts.set(specialBallKey, current);
        }

        if (ball.caught_at) {
            if (!oldestCaughtAt || ball.caught_at < oldestCaughtAt) oldestCaughtAt = ball.caught_at;
            if (!newestCaughtAt || ball.caught_at > newestCaughtAt) newestCaughtAt = ball.caught_at;

            const caughtAt = new Date(ball.caught_at);
            if (Number.isFinite(caughtAt.getTime())) {
                const date = caughtAt.toISOString().slice(0, 10);
                const dayStats = catchesByDay.get(date) || {
                    count: 0,
                    firstCaughtAt: caughtAt.getTime(),
                    lastCaughtAt: caughtAt.getTime(),
                };
                dayStats.count += 1;
                dayStats.firstCaughtAt = Math.min(dayStats.firstCaughtAt, caughtAt.getTime());
                dayStats.lastCaughtAt = Math.max(dayStats.lastCaughtAt, caughtAt.getTime());
                catchesByDay.set(date, dayStats);
            }
        }

        if (ball.self_caught && ball.caught_at && ball.spawned_at) {
            const catchTimeMs = new Date(ball.caught_at).getTime() - new Date(ball.spawned_at).getTime();
            if (Number.isFinite(catchTimeMs) && catchTimeMs >= 0) {
                catchTimeTotal += catchTimeMs;
                const catchRecord = {
                    instanceId: ball.id || null,
                    ballName: ball.ball?.country || "Unknown",
                    durationMs: catchTimeMs,
                };

                if (catchTimeMs > 0 && (fastestCatchMs === null || catchTimeMs < fastestCatchMs)) {
                    fastestCatchMs = catchTimeMs;
                    fastestCatch = catchRecord;
                }
                if (slowestCatchMs === null || catchTimeMs > slowestCatchMs) {
                    slowestCatchMs = catchTimeMs;
                    slowestCatch = catchRecord;
                }
                timedCatchCount += 1;
            }
        }
    }

    const duplicateCount = [...ballCounts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
    const getTopEntries = (counts) => [...counts.entries()]
        .sort(([, firstCount], [, secondCount]) => secondCount - firstCount)
        .slice(0, TOP_ENTRIES)
        .map(([name, count]) => ({ name, count }));
    const topSpecialBalls = [...specialBallCounts.values()]
        .sort((first, second) => second.count - first.count)
        .slice(0, TOP_ENTRIES);
    const [mostActiveCatchDay, mostActiveCatchStats] = [...catchesByDay.entries()]
        .sort(([, firstStats], [, secondStats]) => secondStats.count - firstStats.count)[0] || [null, null];

    return {
        displayName: profile.display_name || profile.username || profile.name || profile.user?.username || profile.player?.username || null,
        totalBalls: totals?.ballCount ?? balls.length,
        listedBalls: balls.length,
        uniqueBalls: ballCounts.size,
        duplicateCount,
        specialCount,
        specialKinds: specialCounts.size,
        selfCaughtCount,
        favoriteCount,
        frameCount,
        timedCatchCount,
        fastestCatchMs,
        slowestCatchMs,
        fastestCatch,
        slowestCatch,
        averageCatchMs: timedCatchCount ? Math.round(catchTimeTotal / timedCatchCount) : null,
        oldestCaughtAt,
        newestCaughtAt,
        mostActiveCatchDay,
        mostActiveCatchCount: mostActiveCatchStats?.count || 0,
        averageCatchIntervalMs: mostActiveCatchStats?.count > 1
            ? Math.round((mostActiveCatchStats.lastCaughtAt - mostActiveCatchStats.firstCaughtAt) / (mostActiveCatchStats.count - 1))
            : null,
        topCountries: getTopEntries(countryCounts),
        topSpecials: getTopEntries(specialCounts),
        topSpecialBalls,
    };
}

function toSpecialRecord(ball, userId) {
    if (!ball.special || !ball.id || !ball.ball?.country) return null;

    return {
        id: BigInt(String(ball.id)).toString(16).toUpperCase(),
        user_id: String(userId),
        name: ball.ball.country,
        special: ball.special.name || "Unknown",
    };
}

async function replaceSpecialCollection(collection, userId, balls) {
    const specialRecords = balls
        .map((ball) => toSpecialRecord(ball, userId))
        .filter(Boolean);

    await collection.deleteMany({ user_id: String(userId) });

    for (let index = 0; index < specialRecords.length; index += SPECIAL_WRITE_BATCH_SIZE) {
        await collection.insertMany(specialRecords.slice(index, index + SPECIAL_WRITE_BATCH_SIZE), { ordered: false });
    }

    return specialRecords.length;
}

/** Non-special instance counts per ball, for the raws list. */
function countNonSpecial(balls) {
    const counts = new Map();
    for (const ball of balls) {
        if (getSpecialId(ball) || ball.special) continue;
        const id = ball.ball?.id ?? ball.ball_id;
        const name = ball.ball?.country;
        if (id === undefined && !name) continue;
        const key = String(id ?? name);
        const entry = counts.get(key) || { ballId: id ?? null, name: name || null, count: 0 };
        entry.count += 1;
        counts.set(key, entry);
    }
    return [...counts.values()];
}

function rawValueForTier(tier) {
    if (!Number.isFinite(tier) || tier < 1 || tier > RAW_MAX_TIER) return 0;
    let value = 0;
    for (const [from, v] of RAW_TIER_VALUES) if (tier >= from) value = v;
    return value;
}

/**
 * Raws: every rare (t1-t23) Ballsdex ball, how many non-special copies the player has,
 * and count x tier value. `rarityData` is Ballsdex.json ({ name: { rarity, id, ... } }).
 */
function computeRaws(nonSpecial = [], rarityData = {}) {
    const byId = new Map();
    const byName = new Map();
    for (const entry of nonSpecial) {
        if (entry.ballId !== null && entry.ballId !== undefined) byId.set(String(entry.ballId), entry);
        if (entry.name) byName.set(entry.name.toLowerCase(), entry);
    }

    const rows = [];
    for (const [name, info] of Object.entries(rarityData)) {
        const tier = Number(info?.rarity);
        const value = rawValueForTier(tier);
        if (!value) continue;
        const owned = byId.get(String(info.id)) || byName.get(name.toLowerCase());
        const count = owned?.count || 0;
        rows.push({ name, tier, value, count, total: Math.round(count * value * 100) / 100 });
    }
    rows.sort((a, b) => a.tier - b.tier || b.count - a.count || a.name.localeCompare(b.name));

    const tiers = [];
    for (const row of rows) {
        let group = tiers[tiers.length - 1];
        if (!group || group.tier !== row.tier) {
            group = { tier: row.tier, value: row.value, count: 0, total: 0, balls: 0 };
            tiers.push(group);
        }
        group.count += row.count;
        group.total = Math.round((group.total + row.total) * 100) / 100;
        group.balls += 1;
    }

    const total = Math.round(rows.reduce((sum, row) => sum + row.total, 0) * 100) / 100;
    return {
        total,
        rareCount: rows.reduce((sum, row) => sum + row.count, 0),
        ownedKinds: rows.filter((row) => row.count > 0).length,
        kinds: rows.length,
        tiers,
        rows,
    };
}

async function syncCollection(discordUserId, apiKey, onProgress, shouldStop) {
    const database = await getDatabase();
    const ballsCollection = database.collection("ballsdexBalls");
    const collectionsCollection = database.collection("ballsdexCollections");
    const specialsCollection = database.collection("ballsdexSpecials");
    const profile = await ballsdexRequest(apiKey, "/me");
    const totals = await getPlayerTotals(apiKey, discordUserId);
    const expected = totals?.ballCount ?? null;

    onProgress?.({ phase: "balls", fetched: 0, total: expected });
    const balls = await getAllMyBalls(apiKey, (fetched) => onProgress?.({ phase: "balls", fetched, total: expected }), shouldStop);
    onProgress?.({ phase: "saving", fetched: balls.length, total: expected });

    const summary = buildCollectionSummary(profile, balls, totals);
    const syncedAt = new Date();
    const specialCount = await replaceSpecialCollection(specialsCollection, discordUserId, balls);

    await collectionsCollection.updateOne(
        { discordUserId },
        {
            $set: {
                discordUserId,
                summary,
                nonSpecial: countNonSpecial(balls),
                ballCount: summary.totalBalls,
                lastSyncedAt: syncedAt,
            },
            $unset: { profile: "", schemaVersion: "" },
        },
        { upsert: true },
    );
    await ballsCollection.deleteMany({ discordUserId });

    return { ballCount: summary.totalBalls, listedBalls: balls.length, specialCount, syncedAt };
}

async function getStoredCollection(discordUserId) {
    const database = await getDatabase();
    const stored = await database.collection("ballsdexCollections").findOne({ discordUserId });
    // Summaries saved before specialKinds existed took specialCount from the API's special_count,
    // which isn't the number of special balls; recount from the saved specials instead.
    if (stored?.summary && stored.summary.specialKinds === undefined) {
        const specialCount = await database.collection("ballsdexSpecials").countDocuments({ user_id: String(discordUserId) });
        stored.summary = { ...stored.summary, specialCount };
    }
    return stored;
}

async function deleteStoredCollection(discordUserId) {
    const database = await getDatabase();
    await Promise.all([
        database.collection("ballsdexCollections").deleteOne({ discordUserId }),
        database.collection("ballsdexBalls").deleteMany({ discordUserId }),
        database.collection("ballsdexSpecials").deleteMany({ user_id: String(discordUserId) }),
    ]);
}

function getSavedApiKey(userId) {
    return getData().users[userId]?.ballsdex?.apiKey || null;
}

function saveApiKey(userId, apiKey) {
    const encryptedKey = encryptApiKey(apiKey);
    updateData((data) => {
        data.users[userId] ??= {};
        data.users[userId].ballsdex = {
            apiKey: encryptedKey,
            linkedAt: new Date().toISOString(),
        };
    });
}

function removeApiKey(userId) {
    if (!getSavedApiKey(userId)) return false;

    return updateData((data) => {
        if (!data.users[userId]?.ballsdex) return false;
        delete data.users[userId].ballsdex;
        return true;
    });
}

function decryptFromSite(payload, purpose = "ballsdex-api-key") {
    const secret = process.env.BOT_API_SECRET;
    if (!secret) throw new Error("BOT_API_SECRET is not configured.");
    if (!payload?.iv || !payload?.tag || !payload?.value) throw new Error("Invalid encrypted payload.");

    const key = Buffer.from(crypto.hkdfSync("sha256", secret, "ballidentifier", purpose, 32));
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, Buffer.from(payload.iv, "base64"));
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(payload.value, "base64")), decipher.final()]).toString("utf8");
}

const linkCooldowns = new Map();
async function linkApiKey(userId, apiKey) {
    const cooldownUntil = linkCooldowns.get(userId) || 0;
    if (cooldownUntil > Date.now()) {
        const error = new Error("Please wait a moment before trying again.");
        error.code = "COOLDOWN";
        error.retryAfterSec = Math.ceil((cooldownUntil - Date.now()) / 1000);
        throw error;
    }
    linkCooldowns.set(userId, Date.now() + LINK_COOLDOWN_MS);

    const profile = await ballsdexRequest(apiKey, "/me");
    const linkedAccountId = String(profile.discord_id || profile.id || "");
    if (linkedAccountId !== String(userId)) {
        const error = new Error("That API key belongs to a different Discord account.");
        error.code = "WRONG_ACCOUNT";
        throw error;
    }

    saveApiKey(userId, apiKey);
    getNotifier()
        .notify(userId, "ballsdex_account", {
            title: "Ballsdex account linked",
            body: "A Ballsdex API key was linked to your BallIdentifier account. Not you? Unlink it in the Ballsdex tab.",
            link: "#/ballsdex",
        })
        .catch(() => {});
}

// Remove the stored key and synced data. Returns false when nothing was linked.
async function unlinkAccount(userId) {
    const wasLinked = removeApiKey(userId);
    cancelSync(userId);
    if (wasLinked) {
        getNotifier()
            .notify(userId, "ballsdex_account", {
                title: "Ballsdex account unlinked",
                body: "Your Ballsdex API key and synced collection data were removed.",
                link: "#/ballsdex",
            })
            .catch(() => {});
        try {
            await deleteStoredCollection(userId);
        } catch (error) {
            console.error("[BALLSDEX] Failed to delete stored collection:", error);
        }
    }
    return wasLinked;
}

// ---------------------------------------------------------------------------
// Sync control, shared by /ballsdex and the website.
// Only ONE sync runs at a time (all syncs share the bot's IP rate limit at Ballsdex). Someone who tries
// while another sync runs is told so and gets a "sync available" notification when the slot frees up.
// Per-user cooldown: 12 h after a successful sync, 5 min after a failed or cancelled one; persisted in
// data.json users[id].ballsdexSync so restarts and unlink/relink don't reset it.
// ---------------------------------------------------------------------------

const syncStates = new Map(); // userId -> live state of the user's current/last sync this run
let activeSync = null; // { userId, state }
const slotWaiters = new Set(); // users to notify when the running sync ends

function getNotifier() {
    return require("./notifications");
}

function getSyncRecord(userId) {
    return getData().users[userId]?.ballsdexSync || {};
}

function cooldownLeftMs(userId) {
    const until = getSyncRecord(userId).nextSyncAt ? new Date(getSyncRecord(userId).nextSyncAt).getTime() : 0;
    return Math.max(0, until - Date.now());
}

function getSyncState(userId) {
    userId = String(userId);
    const state = syncStates.get(userId);
    const record = getSyncRecord(userId);
    const busy = Boolean(activeSync && activeSync.userId !== userId);
    return {
        inProgress: Boolean(state?.inProgress),
        startedAt: state?.startedAt ? new Date(state.startedAt).toISOString() : null,
        finishedAt: state?.finishedAt ? new Date(state.finishedAt).toISOString() : record.lastFinishedAt || null,
        error: state?.error || null,
        cancelled: Boolean(state?.cancelled && !state?.inProgress),
        ballCount: state?.ballCount ?? null,
        progress: state?.inProgress ? state.progress : null,
        cancelRequested: Boolean(state?.inProgress && state.cancelRequested),
        retryAfterSec: state?.inProgress ? null : Math.ceil(cooldownLeftMs(userId) / 1000),
        nextSyncAt: record.nextSyncAt || null,
        busy,
        waiting: busy && slotWaiters.has(userId),
    };
}

function finishSync(userId, state, outcome) {
    const cooldown = outcome === "success" ? SYNC_COOLDOWN_MS : SYNC_RETRY_COOLDOWN_MS;
    const nextSyncAt = new Date(Date.now() + cooldown).toISOString();
    updateData((data) => {
        data.users[userId] ??= {};
        data.users[userId].ballsdexSync = {
            lastFinishedAt: new Date().toISOString(),
            lastOutcome: outcome,
            nextSyncAt,
            // remind only after a real sync; a quick retry window needs no notification
            notifyAvailableAt: outcome === "success" ? nextSyncAt : null,
        };
    });
    state.inProgress = false;
    state.finishedAt = Date.now();
    if (activeSync?.userId === userId) activeSync = null;

    // The slot is free: tell everyone who was turned away
    const waiters = [...slotWaiters].filter((id) => id !== userId);
    slotWaiters.clear();
    for (const waiterId of waiters) {
        if (!getSavedApiKey(waiterId) || cooldownLeftMs(waiterId) > 0) continue;
        getNotifier()
            .notify(waiterId, "sync_available", {
                title: "You can sync your Ballsdex collection now",
                body: "The sync that was running has finished.",
                link: "#/ballsdex",
                dmText: "The Ballsdex sync slot is free, you can sync your collection now with `/ballsdex sync` or on https://ballidentifier.xyz/#/ballsdex",
            })
            .catch(() => {});
    }
}

/**
 * Start a background collection sync.
 * @returns {{started: true} | {started: false, reason: "NOT_LINKED"|"IN_PROGRESS"|"BUSY"|"COOLDOWN", retryAfterSec?: number}}
 */
function startSync(userId) {
    userId = String(userId);
    const encryptedKey = getSavedApiKey(userId);
    if (!encryptedKey) return { started: false, reason: "NOT_LINKED" };

    if (syncStates.get(userId)?.inProgress) return { started: false, reason: "IN_PROGRESS" };

    const left = cooldownLeftMs(userId);
    if (left > 0) return { started: false, reason: "COOLDOWN", retryAfterSec: Math.ceil(left / 1000) };

    if (activeSync) {
        slotWaiters.add(userId);
        return { started: false, reason: "BUSY" };
    }

    const state = {
        inProgress: true,
        startedAt: Date.now(),
        finishedAt: null,
        error: null,
        cancelled: false,
        cancelRequested: false,
        ballCount: null,
        progress: { phase: "starting", fetched: 0, total: null },
    };
    syncStates.set(userId, state);
    activeSync = { userId, state };
    slotWaiters.delete(userId);
    // a new sync replaces the pending "available" reminder
    updateData((data) => {
        if (data.users[userId]?.ballsdexSync) data.users[userId].ballsdexSync.notifyAvailableAt = null;
    });

    void (async () => {
        let outcome = "failed";
        try {
            const result = await syncCollection(
                userId,
                decryptApiKey(encryptedKey),
                (progress) => {
                    state.progress = progress;
                },
                () => state.cancelRequested,
            );
            state.ballCount = result.ballCount;
            outcome = "success";
            getNotifier()
                .notify(userId, "sync_finished", {
                    title: "Ballsdex sync finished",
                    body: `${result.ballCount.toLocaleString("en-US")} balls synced. Your stats and raws are up to date.`,
                    link: "#/ballsdex",
                    dmText: `Your Ballsdex collection sync is complete. ${result.ballCount.toLocaleString("en-US")} balls were updated.`,
                })
                .catch(() => {});
        } catch (error) {
            if (error.code === "CANCELLED") {
                outcome = "cancelled";
                state.cancelled = true;
            } else {
                console.error("[BALLSDEX] Failed to sync collection:", error);
                state.error = error.status === 429 ? "The Ballsdex API rate limit was reached. Try again later." : error.message;
                getNotifier()
                    .notify(userId, "sync_finished", {
                        title: "Ballsdex sync failed",
                        body: state.error,
                        link: "#/ballsdex",
                        dmText: `Your Ballsdex collection sync failed: ${state.error}`,
                    })
                    .catch(() => {});
            }
        } finally {
            finishSync(userId, state, outcome);
        }
    })();

    return { started: true };
}

/** Ask the user's running sync to stop after the current page. */
function cancelSync(userId) {
    const state = syncStates.get(String(userId));
    if (!state?.inProgress) return false;
    state.cancelRequested = true;
    return true;
}

/** Sends due "you can sync again" reminders. Called every minute from clientReady. */
async function sendDueSyncReminders() {
    const now = Date.now();
    const due = Object.entries(getData().users)
        .filter(([, user]) => user.ballsdexSync?.notifyAvailableAt && new Date(user.ballsdexSync.notifyAvailableAt).getTime() <= now)
        .map(([userId]) => userId);
    if (!due.length) return;
    updateData((data) => {
        for (const userId of due) if (data.users[userId]?.ballsdexSync) data.users[userId].ballsdexSync.notifyAvailableAt = null;
    });
    for (const userId of due) {
        if (!getSavedApiKey(userId)) continue;
        await getNotifier()
            .notify(userId, "sync_available", {
                title: "Your Ballsdex sync is available again",
                body: "12 hours have passed since your last sync.",
                link: "#/ballsdex",
                dmText: "You can sync your Ballsdex collection again with `/ballsdex sync` or on https://ballidentifier.xyz/#/ballsdex",
            })
            .catch(() => {});
    }
}

module.exports = {
    SYNC_COOLDOWN_MS,
    cancelSync,
    computeRaws,
    sendDueSyncReminders,
    decryptFromSite,
    linkApiKey,
    unlinkAccount,
    getSyncState,
    getRateLimits,
    startSync,
    ballsdexRequest,
    buildCollectionSummary,
    decryptApiKey,
    deleteStoredCollection,
    getAllMyBalls,
    getSavedApiKey,
    getStoredCollection,
    removeApiKey,
    saveApiKey,
    syncCollection,
};