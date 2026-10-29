const crypto = require("crypto");

const { getData, updateData } = require("./helpers");
const { getDatabase } = require("./database");

const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const API_BASE_URL = process.env.BALLSDEX_API_URL || "https://ballsdex.com/api/v1";
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const PAGE_SIZE = 25;
const PAGE_REQUEST_DELAY = 1000; // ~60 pages/min: the per-key limit, and kind to the shared per-IP limit
const SYNC_COOLDOWN_MS = 5 * 60 * 1000;
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

// One API call that follows the documented rate-limit headers (https://ballsdex.com/api/docs/):
// waits out a 429 using Retry-After, and returns how long to pause before the next call.
async function ballsdexFetch(apiKey, path, query = {}) {
    const url = new URL(`${API_BASE_URL}${path}`);
    Object.entries(query).forEach(([key, value]) => {
        if (value !== undefined && value !== null) url.searchParams.set(key, value);
    });

    for (let attempt = 0; ; attempt++) {
        const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });

        if (response.status === 429 && attempt < MAX_429_RETRIES) {
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
async function getAllMyBalls(apiKey, onPage) {
    const balls = [];
    let cursor;

    do {
        const { data, waitMs } = await ballsdexFetch(apiKey, "/me/balls", { limit: PAGE_SIZE, cursor });
        balls.push(...getItems(data));
        cursor = data.next_cursor;
        onPage?.(balls.length);
        if (cursor) await sleep(Math.max(waitMs, PAGE_REQUEST_DELAY));
    } while (cursor);

    return balls;
}

// Ball/special totals as Ballsdex itself counts them. Null when the profile is private.
async function getPlayerTotals(apiKey, discordUserId) {
    try {
        const player = await ballsdexRequest(apiKey, `/players/${discordUserId}`);
        if (!Number.isFinite(player?.ball_count)) return null;
        return { ballCount: player.ball_count, specialCount: Number.isFinite(player.special_count) ? player.special_count : null };
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
        .slice(0, 3)
        .map(([name, count]) => ({ name, count }));
    const topSpecialBalls = [...specialBallCounts.values()]
        .sort((first, second) => second.count - first.count)
        .slice(0, 3);
    const [mostActiveCatchDay, mostActiveCatchStats] = [...catchesByDay.entries()]
        .sort(([, firstStats], [, secondStats]) => secondStats.count - firstStats.count)[0] || [null, null];

    return {
        displayName: profile.display_name || profile.username || profile.name || profile.user?.username || profile.player?.username || null,
        totalBalls: totals?.ballCount ?? balls.length,
        listedBalls: balls.length,
        uniqueBalls: ballCounts.size,
        duplicateCount,
        specialCount: totals?.specialCount ?? specialCount,
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

async function syncCollection(discordUserId, apiKey, onProgress) {
    const database = await getDatabase();
    const ballsCollection = database.collection("ballsdexBalls");
    const collectionsCollection = database.collection("ballsdexCollections");
    const specialsCollection = database.collection("ballsdexSpecials");
    const profile = await ballsdexRequest(apiKey, "/me");
    const totals = await getPlayerTotals(apiKey, discordUserId);
    const expected = totals?.ballCount ?? null;

    onProgress?.({ phase: "balls", fetched: 0, total: expected });
    const balls = await getAllMyBalls(apiKey, (fetched) => onProgress?.({ phase: "balls", fetched, total: expected }));
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
    return database.collection("ballsdexCollections").findOne({ discordUserId });
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
}

// Remove the stored key and synced data. Returns false when nothing was linked.
async function unlinkAccount(userId) {
    const wasLinked = removeApiKey(userId);
    if (wasLinked) {
        try {
            await deleteStoredCollection(userId);
        } catch (error) {
            console.error("[BALLSDEX] Failed to delete stored collection:", error);
        }
    }
    return wasLinked;
}

// Sync state shared by the bot command and the website (one sync per user at a time)
const syncStates = new Map();

function getSyncState(userId) {
    const state = syncStates.get(String(userId));
    if (!state) return { inProgress: false };
    const nextAllowedAt = (state.finishedAt || state.startedAt || 0) + SYNC_COOLDOWN_MS;
    return {
        inProgress: state.inProgress,
        startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
        finishedAt: state.finishedAt ? new Date(state.finishedAt).toISOString() : null,
        error: state.error || null,
        ballCount: state.ballCount ?? null,
        progress: state.inProgress ? state.progress : null,
        retryAfterSec: state.inProgress ? null : Math.max(0, Math.ceil((nextAllowedAt - Date.now()) / 1000)),
    };
}

function startSync(userId, { onDone } = {}) {
    userId = String(userId);
    const encryptedKey = getSavedApiKey(userId);
    if (!encryptedKey) return { started: false, reason: "NOT_LINKED" };

    const current = syncStates.get(userId);
    if (current?.inProgress) return { started: false, reason: "IN_PROGRESS" };
    const lastRun = current?.finishedAt || current?.startedAt;
    if (lastRun && Date.now() - lastRun < SYNC_COOLDOWN_MS) {
        return {
            started: false,
            reason: "COOLDOWN",
            retryAfterSec: Math.ceil((lastRun + SYNC_COOLDOWN_MS - Date.now()) / 1000),
        };
    }

    const state = { inProgress: true, startedAt: Date.now(), finishedAt: null, error: null, ballCount: null, progress: { phase: "starting", fetched: 0, total: null } };
    syncStates.set(userId, state);

    void (async () => {
        try {
            const result = await syncCollection(userId, decryptApiKey(encryptedKey), (progress) => {
                state.progress = progress;
            });
            state.ballCount = result.ballCount;
            onDone?.(result, null);
        } catch (error) {
            console.error("[BALLSDEX] Failed to sync collection:", error);
            state.error = error.status === 429 ? "The Ballsdex API rate limit was reached. Try again later." : error.message;
            onDone?.(null, error);
        } finally {
            state.inProgress = false;
            state.finishedAt = Date.now();
        }
    })();

    return { started: true };
}

module.exports = {
    SYNC_COOLDOWN_MS,
    decryptFromSite,
    linkApiKey,
    unlinkAccount,
    getSyncState,
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