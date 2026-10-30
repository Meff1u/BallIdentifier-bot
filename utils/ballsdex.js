const crypto = require("crypto");
const zlib = require("zlib");

const { getData, updateData } = require("./helpers");
const { getDatabase } = require("./database");
const { ADMIN_ID } = require("./constants");

const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

// API v2: every call is made for a player who signed in to BallIdentifier's Ballsdex app (OAuth 2 + PKCE).
// v1 and its personal bdx_live_ keys were switched off on November 1, 2026.
const API_BASE_URL = process.env.BALLSDEX_API_URL || "https://ballsdex.com/api/v2";
const OAUTH_URL = process.env.BALLSDEX_OAUTH_URL || "https://ballsdex.com/api/oauth";
const ACCESS_REFRESH_MARGIN_MS = 2 * 60 * 1000; // refresh an access token this long before it expires
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const PAGE_SIZE = 50; // the most /me/balls, /me/trades and /players/{id}/balls return per page
// Every request from the bot's one IP counts toward a shared per-IP limit (2000 a day and 30 a minute when
// v2 launched; read from the headers, never hardcoded). A sync stops when the shared daily quota gets down to
// this share of it, so the rest of the bot keeps working.
const IP_DAY_RESERVE_SHARE = 0.2;
// A sync stopped by the quota keeps its progress and continues by itself once the quota resets
const PAUSED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Sync pacing (see syncPageDelay): pages go as fast as the per-minute limits allow, but part of the bot's
// shared per-IP minute limit always stays free for everything else, more of it while others are using it.
const MIN_PAGE_DELAY = 100;
const FALLBACK_PAGE_DELAY = 1000; // before the first rate-limit headers are known
const IP_MINUTE_FREE_IDLE_SHARE = 0.1; // of the IP's per-minute limit, kept free when nothing else is calling the API
const IP_MINUTE_FREE_BUSY_SHARE = 0.5; // kept free while other requests are coming in
const IP_MINUTE_BUSY_OTHERS = 4; // that many other requests in the current minute = busy
const SYNC_COOLDOWN_MS = 24 * 60 * 60 * 1000; // after a successful sync
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
const REQUEST_TIMEOUT_MS = 30 * 1000;
// Requests someone is waiting for (website, commands): no long waits on a 429, a short timeout.
// The website's functions give up after about 10 s, so these must answer well before that.
const INTERACTIVE = { maxWaitMs: 3000, retries: 1, timeoutMs: 7000 };

const formatWait = (seconds) => {
    const s = Math.max(1, Math.ceil(seconds));
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.ceil(s / 60)} min`;
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m ? `${h} h ${m} min` : `${h} h`;
};

/** Which limit a 429 came from, from the headers recorded with it: "key", "ip" or null when unknown. */
function exhaustedScope(cred) {
    const key = viewRateLimits(keyRateLimits.get(hashKey(cred)))?.limits.some((limit) => limit.remaining <= 0);
    if (key) return "key";
    return viewRateLimits(ipRateLimits)?.limits.some((limit) => limit.remaining <= 0) ? "ip" : null;
}

/**
 * Every failed Ballsdex API call ends up here, so users always get a readable message.
 * error.status: the HTTP status (503 when Ballsdex couldn't be reached at all), error.code: what went wrong,
 * error.reason: the message without "try again in…", error.retryAfterSec: when it makes sense to retry.
 */
function apiError(status, { detail = null, retryAfterSec = null, cred = null, type = null } = {}) {
    let code;
    let reason;
    if (status === 429) {
        code = "RATE_LIMITED";
        const scope = cred ? exhaustedScope(cred) : null;
        reason =
            scope === "ip"
                ? "BallIdentifier has used up its Ballsdex API requests for now (they're shared by everyone)."
                : scope === "key"
                  ? "Your Ballsdex account has run out of API requests for now."
                  : "The Ballsdex API is rate limiting requests right now.";
    } else if (status === 401) {
        code = "RECONNECT";
        reason = "Your Ballsdex sign-in isn't valid anymore (it expired or access was removed). Sign in with Ballsdex again in the Ballsdex tab.";
    } else if (status === 403 && type === "app_not_approved") {
        code = "APP_NOT_APPROVED";
        reason = "BallIdentifier's Ballsdex app is still waiting for approval by the Ballsdex team. Try again later.";
    } else if (status === 403) {
        code = "FORBIDDEN";
        reason = `Ballsdex refused this request${detail ? ` (${detail})` : ""}. Your API key may be missing a permission.`;
    } else if (status === 404) {
        code = "NOT_FOUND";
        reason = detail || "Not found on Ballsdex.";
    } else if (status >= 500) {
        code = "UNAVAILABLE";
        reason = "The Ballsdex API isn't responding right now.";
    } else {
        code = "API_ERROR";
        reason = detail ? `The Ballsdex API said: ${detail}` : `The Ballsdex API returned an error (HTTP ${status}).`;
    }
    const retry = code === "RATE_LIMITED" ? (retryAfterSec ? ` Try again in ${formatWait(retryAfterSec)}.` : " Try again later.") : code === "UNAVAILABLE" ? " Try again in a few minutes." : "";
    return Object.assign(new Error(reason + retry), {
        status,
        code,
        reason,
        detail,
        type,
        scope: status === 429 && cred ? exhaustedScope(cred) : null,
        retryAfterSec: retryAfterSec ? Math.ceil(retryAfterSec) : null,
        ballsdexApi: true,
    });
}

async function readError(response, cred = null) {
    let detail = null;
    let type = null;
    try {
        const body = await response.json();
        detail = typeof (body.detail || body.title) === "string" ? String(body.detail || body.title).slice(0, 200) : null;
        // problem+json "type" is a stable id, sometimes given as a URL ending in it
        type = typeof body.type === "string" ? body.type.split("/").pop() : null;
    } catch (error) {}
    let retryAfterSec = null;
    if (response.status === 429) {
        retryAfterSec = Number(response.headers.get("retry-after")) || (cred && exhaustedScope(cred) ? Math.max(1, (exhaustedResetTime(cred) - 60 * 1000 - Date.now()) / 1000) : null);
    }
    return apiError(response.status, { detail, retryAfterSec, cred, type });
}

// Checking a user's limits costs a request from them and from the shared IP: at most every 5 minutes
const RATE_PROBE_MAX_AGE_MS = 5 * 60 * 1000;
const RATE_LIMIT_LABELS = {
    minute: "Per minute",
    day: "Per day",
    player_minute: "Player lookups per minute",
    ip_minute: "Per minute",
    ip_day: "Per day",
};
const keyRateLimits = new Map(); // user id -> { at, limits } (each player has their own limits with our app)
let ipRateLimits = null; // { at, limits }

const hashKey = (cred) => `user:${cred.userId}`;

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

function recordRateLimits(cred, headers) {
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
    if (keyLimits.length) keyRateLimits.set(hashKey(cred), { at, limits: keyLimits });
    if (ipLimits.length) ipRateLimits = { at, limits: ipLimits };
}

// A snapshot as it stands now: a window that has reset since is shown as unused
function syncError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

/** What's left today of a limit (by name) in a snapshot, or null when unknown. */
function remainingToday(snapshot, name) {
    const limit = viewRateLimits(snapshot)?.limits.find((entry) => entry.name === name);
    return limit ? limit.remaining : null;
}

/**
 * Stops a sync before the next page when today's quota runs out: the bot's shared IP keeps
 * IP_DAY_RESERVE requests for everyone else, and the user's own key must have a request left.
 */
function assertQuota(cred) {
    const ipDay = viewRateLimits(ipRateLimits)?.limits.find((entry) => entry.name === "ip_day");
    const ipLeft = ipDay ? ipDay.remaining : null;
    if (ipLeft !== null && ipLeft <= Math.ceil(ipDay.limit * IP_DAY_RESERVE_SHARE)) {
        const error = syncError("BallIdentifier has used most of today's Ballsdex API requests.", "QUOTA");
        error.resumeAt = resetTime(ipRateLimits, "ip_day");
        throw error;
    }
    const keySnapshot = keyRateLimits.get(hashKey(cred));
    const keyLeft = remainingToday(keySnapshot, "day");
    if (keyLeft !== null && keyLeft <= 0) {
        const error = syncError("Your Ballsdex account has no API requests left today.", "QUOTA");
        error.resumeAt = resetTime(keySnapshot, "day");
        throw error;
    }
}

/** When a limit resets (ms timestamp, with a minute to spare); an hour from now when unknown. */
function resetTime(snapshot, name) {
    const limit = viewRateLimits(snapshot)?.limits.find((entry) => entry.name === name);
    return Date.now() + ((limit?.resetInSec ?? 3600) + 60) * 1000;
}

/** After a 429: the latest reset among the limits that ran out. */
function exhaustedResetTime(cred) {
    const limits = [viewRateLimits(ipRateLimits), viewRateLimits(keyRateLimits.get(hashKey(cred)))].flatMap((view) => view?.limits || []);
    const waits = limits.filter((limit) => limit.remaining <= 0 && limit.resetInSec).map((limit) => limit.resetInSec);
    return Date.now() + ((waits.length ? Math.max(...waits) : 3600) + 60) * 1000;
}

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
    if (!getGrant(userId)) return null;
    const cred = credentialFor(userId);
    const hash = hashKey(cred);
    const snapshot = keyRateLimits.get(hash);
    if (!snapshot || Date.now() - snapshot.at > RATE_PROBE_MAX_AGE_MS) {
        try {
            await ballsdexFetch(cred, "/me", {}, { ...INTERACTIVE, retry: false });
        } catch (error) {
            if (error.status !== 429) throw error; // a 429 still carries the headers
        }
    }
    return { key: viewRateLimits(keyRateLimits.get(hash)), ip: viewRateLimits(ipRateLimits) };
}

/** The bot's shared per-IP limits as last seen (no request is made; every API call refreshes them). */
function getSharedRateLimits() {
    return {
        ip: viewRateLimits(ipRateLimits),
        reserveShare: IP_DAY_RESERVE_SHARE,
        syncRunning: Boolean(activeSync),
    };
}

/*
 * Lockouts (https://ballsdex.com/api/docs/): going over a limit returns 429 and locks that limit, longer each
 * time (2 s, 4 s, 8 s… up to 1 h), and requests sent during a lockout still count toward the shared IP limit.
 * So nothing is sent while a limit we know of is used up or locked:
 *   "ip"                   the bot's shared IP limits (blocks every user)
 *   "user:<id>"            one player's limits with our app (minute, day)
 *   "user:<id>:player"     their player lookups (player_minute, /players/... only)
 * Locks come from the RateLimit headers of every response (a limit at 0 until it resets: no 429 at all)
 * and from Retry-After on a 429.
 */
const lockouts = new Map(); // scope -> until (ms timestamp)

const lockScopeOf = (cred, limitName) => (limitName.startsWith("ip_") ? "ip" : limitName === "player_minute" ? `${hashKey(cred)}:player` : hashKey(cred));

function lockScope(scope, ms) {
    const until = Date.now() + ms;
    if (until > (lockouts.get(scope) || 0)) lockouts.set(scope, until);
}

/** How long (ms) a request for this path has to wait before it may be sent; 0 when it can go now. */
function lockedFor(cred, path) {
    const now = Date.now();
    const scopes = ["ip", hashKey(cred), ...(path.startsWith("/players") ? [`${hashKey(cred)}:player`] : [])];
    let wait = 0;
    for (const scope of scopes) {
        const until = lockouts.get(scope) || 0;
        if (until <= now) lockouts.delete(scope);
        else wait = Math.max(wait, until - now);
    }
    return wait;
}

/** Locks every limit the response shows as used up, until it resets; on a 429 at least for Retry-After. */
function noteLockouts(cred, response) {
    const states = parseRateLimitList(response.headers.get("ratelimit"));
    let locked = false;
    for (const [name, state] of states) {
        if (state.r === 0 && state.t > 0) {
            lockScope(lockScopeOf(cred, name), state.t * 1000 + 250);
            locked = true;
        }
    }
    const remaining = response.headers.get("x-ratelimit-remaining");
    const resetAfter = Number(response.headers.get("x-ratelimit-reset-after")) || 0;
    if (!locked && remaining === "0" && resetAfter > 0) {
        lockScope(hashKey(cred), resetAfter * 1000 + 250);
        locked = true;
    }
    if (response.status !== 429) return;
    const retryAfterMs = (Number(response.headers.get("retry-after")) || 2) * 1000 + 250;
    const exhausted = [...states].filter(([, state]) => state.r === 0).map(([name]) => lockScopeOf(cred, name));
    for (const scope of exhausted.length ? exhausted : [hashKey(cred)]) lockScope(scope, retryAfterMs);
    console.warn(`[BALLSDEX] 429: ${(exhausted.length ? exhausted : [hashKey(cred)]).join(", ")} locked for ${Math.ceil(retryAfterMs / 1000)} s`);
}

// One API call that follows the documented rate-limit headers (https://ballsdex.com/api/docs/):
// waits out a short 429 using Retry-After, and returns how long to pause before the next call.
// Background work (syncs) waits up to 2 min per 429; INTERACTIVE calls give up after a few seconds.
async function ballsdexFetch(cred, path, query = {}, { retry = true, maxWaitMs = MAX_RATE_LIMIT_WAIT_MS, retries = MAX_429_RETRIES, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const url = new URL(`${API_BASE_URL}${path}`);
    Object.entries(query).forEach(([key, value]) => {
        if (value !== undefined && value !== null) url.searchParams.set(key, value);
    });

    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
        // A used-up or locked limit: wait for it (background work) or give up without asking Ballsdex
        const lockedMs = lockedFor(cred, path);
        if (lockedMs > 0) {
            if (!retry || lockedMs > maxWaitMs || attempt > retries) throw apiError(429, { retryAfterSec: lockedMs / 1000, cred });
            await sleep(lockedMs);
        }
        const token = cred.token || (await accessToken(cred.userId, { force: refreshed }));
        let response;
        try {
            response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
        } catch (error) {
            // Network error or timeout: Ballsdex couldn't be reached at all
            throw apiError(503, { detail: error.name === "TimeoutError" || error.name === "AbortError" ? "timeout" : error.message });
        }
        recordRateLimits(cred, response.headers);
        noteLockouts(cred, response);

        // The access token was revoked or expired early: get a new one once, then give up
        if (response.status === 401 && !cred.token && !refreshed) {
            refreshed = true;
            attempt--;
            continue;
        }
        if (response.status === 429) {
            // noteLockouts() locked the limit: the check at the top of the loop waits it out (or gives up)
            if (retry && attempt < retries && lockedFor(cred, path) <= maxWaitMs) continue;
            throw await readError(response, cred);
        }
        if (!response.ok) throw await readError(response, cred);

        const remaining = response.headers.get("x-ratelimit-remaining");
        const resetAfter = Number(response.headers.get("x-ratelimit-reset-after")) || 0;
        const waitMs = remaining === "0" ? Math.min(resetAfter * 1000 + 250, MAX_RATE_LIMIT_WAIT_MS) : 0;
        let data;
        try {
            data = await response.json();
        } catch {
            throw apiError(502, { detail: "invalid response" });
        }
        return { data, waitMs };
    }
}

// Sync page requests in the last minute (one sync runs at a time), to tell them apart from other traffic
const syncRequestTimes = [];
function noteSyncRequest() {
    const now = Date.now();
    syncRequestTimes.push(now);
    while (syncRequestTimes.length && now - syncRequestTimes[0] > 60 * 1000) syncRequestTimes.shift();
}

/**
 * Pause before the next sync page: what's left of each per-minute limit is spread over the rest of
 * its window. The key's own limit is used up to its last request; the shared IP limit keeps
 * IP_MINUTE_FREE_IDLE free, or IP_MINUTE_FREE_BUSY when other requests are using it this minute
 * (website, commands, other users), so the sync slows down by itself and speeds up again after.
 */
function syncPageDelay(cred, waitMs = 0) {
    const ip = viewRateLimits(ipRateLimits)?.limits.find((limit) => limit.name === "ip_minute");
    const key = viewRateLimits(keyRateLimits.get(hashKey(cred)))?.limits.find((limit) => limit.name === "minute");
    if (!ip && !key) return Math.max(waitMs, FALLBACK_PAGE_DELAY);

    const budgets = [];
    if (key) budgets.push({ left: key.remaining - 1, windowMs: (key.resetInSec ?? 60) * 1000 });
    if (ip) {
        const others = Math.max(0, ip.used - syncRequestTimes.length);
        const keepFree = Math.ceil(ip.limit * (others >= IP_MINUTE_BUSY_OTHERS ? IP_MINUTE_FREE_BUSY_SHARE : IP_MINUTE_FREE_IDLE_SHARE));
        budgets.push({ left: ip.remaining - keepFree, windowMs: (ip.resetInSec ?? 60) * 1000 });
    }
    let delay = MIN_PAGE_DELAY;
    for (const { left, windowMs } of budgets) delay = Math.max(delay, left > 0 ? windowMs / left : windowMs + 250);
    return Math.min(Math.max(delay, waitMs), MAX_RATE_LIMIT_WAIT_MS);
}

async function ballsdexRequest(cred, path, query = {}, options = {}) {
    return (await ballsdexFetch(cred, path, query, options)).data;
}

function getItems(response) {
    if (Array.isArray(response)) return response;
    return response.items || response.results || response.data || [];
}

// /me/balls returns at most PAGE_SIZE per page; walk next_cursor to the end
class SyncCancelled extends Error {
    constructor() {
        super("Sync cancelled.");
        this.code = "CANCELLED";
    }
}

async function getAllMyBalls(cred, onPage, shouldStop = () => false) {
    const balls = [];
    let cursor;

    do {
        if (shouldStop()) throw new SyncCancelled();
        const { data, waitMs } = await ballsdexFetch(cred, "/me/balls", { limit: PAGE_SIZE, cursor });
        noteSyncRequest();
        balls.push(...getItems(data));
        cursor = data.next_cursor;
        onPage?.(balls.length);
        if (cursor) await sleep(syncPageDelay(cred, waitMs));
    } while (cursor);

    return balls;
}

// Ball total as Ballsdex itself counts it. Null when the profile is private.
// special_count is NOT the number of special balls (it's far lower, e.g. 44 vs 2,825 owned),
// so specials are always counted from the synced balls.
async function getPlayerTotals(cred, discordUserId) {
    try {
        const player = await ballsdexRequest(cred, `/players/${discordUserId}`);
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
        // Bronze/Silver/Gold count as the non-specials they stand for
        if (country) countryCounts.set(country, (countryCounts.get(country) || 0) + Math.max(1, nonSpecialWorth(ball)));

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
// Specials that stand for a pile of non-special copies of the same ball ("compressed" non-specials)
const COMPRESSED_SPECIALS = { bronze: 1000, silver: 3000, gold: 5000 };

/** How many non-special copies one instance is worth: 1 for a plain ball, 0 for a normal special. */
function nonSpecialWorth(ball) {
    if (!getSpecialId(ball) && !ball.special) return 1;
    return COMPRESSED_SPECIALS[String(ball.special?.name || "").trim().toLowerCase()] || 0;
}

function countNonSpecial(balls) {
    const counts = new Map();
    for (const ball of balls) {
        const worth = nonSpecialWorth(ball);
        if (!worth) continue;
        const id = ball.ball?.id ?? ball.ball_id;
        const name = ball.ball?.country;
        if (id === undefined && !name) continue;
        const key = String(id ?? name);
        const entry = counts.get(key) || { ballId: id ?? null, name: name || null, count: 0 };
        entry.count += worth;
        counts.set(key, entry);
    }
    return [...counts.values()];
}

/** Instances owned per ball id (specials included), for the Ballsdex collector check. */
function countOwned(balls) {
    const counts = {};
    for (const ball of balls) {
        const id = ball.ball?.id ?? ball.ball_id;
        // Bronze/Silver/Gold count as the non-specials they stand for
        if (id !== undefined && id !== null) counts[id] = (counts[id] || 0) + Math.max(1, nonSpecialWorth(ball));
    }
    return counts;
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

/* ----- Resumable syncs -----
 * A running sync is checkpointed in MongoDB after every page: the job (ballsdexSyncJobs, _id = user id)
 * holds the next cursor, and the pages fetched so far are in ballsdexSyncPages. If the bot restarts
 * mid-sync, resumeInterruptedSyncs() picks the job up from the last cursor.
 */
const RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let syncIndexReady = null;
async function syncStorage() {
    const database = await getDatabase();
    const pages = database.collection("ballsdexSyncPages");
    syncIndexReady ??= pages.createIndex({ userId: 1, page: 1 }, { unique: true }).catch(() => (syncIndexReady = null));
    await syncIndexReady;
    return { jobs: database.collection("ballsdexSyncJobs"), pages };
}

async function createSyncJob(userId) {
    const { jobs, pages } = await syncStorage();
    await pages.deleteMany({ userId });
    await jobs.replaceOne({ _id: userId }, { _id: userId, startedAt: new Date(), cursor: null, pages: 0, fetched: 0, updatedAt: new Date() }, { upsert: true });
}

async function deleteSyncJob(userId) {
    const { jobs, pages } = await syncStorage();
    await Promise.all([jobs.deleteOne({ _id: userId }), pages.deleteMany({ userId })]);
}

// Only what the summary, specials and raws need: keeps big collections small in MongoDB and in memory
function compactBall(ball) {
    return {
        id: ball.id,
        ball: ball.ball ? { id: ball.ball.id, country: ball.ball.country } : undefined,
        ball_id: ball.ball_id,
        special: ball.special ? { id: ball.special.id, name: ball.special.name } : null,
        special_id: ball.special_id,
        self_caught: ball.self_caught,
        favorite: ball.favorite,
        is_frame: ball.is_frame,
        caught_at: ball.caught_at,
        spawned_at: ball.spawned_at,
    };
}

async function fetchBallsResumable(userId, cred, onPage, shouldStop) {
    const { jobs, pages } = await syncStorage();
    const job = (await jobs.findOne({ _id: userId })) || {};
    let cursor = job.cursor || undefined;
    let page = job.pages || 0;
    let fetched = job.fetched || 0;
    let restarted = false;
    let saving = Promise.resolve(); // the previous page's checkpoint, written while the next page loads
    if (page > 0) onPage?.(fetched);

    while (page === 0 || cursor) {
        if (shouldStop()) {
            await saving;
            throw new SyncCancelled();
        }
        assertQuota(cred);
        let response;
        try {
            response = await ballsdexFetch(cred, "/me/balls", { limit: PAGE_SIZE, cursor });
            noteSyncRequest();
        } catch (error) {
            await saving.catch(() => {});
            // A saved cursor the API no longer accepts: start this sync over once
            if (cursor && page > 0 && !restarted && (error.status === 400 || error.status === 422)) {
                restarted = true;
                await pages.deleteMany({ userId });
                cursor = undefined;
                page = 0;
                fetched = 0;
                continue;
            }
            throw error;
        }
        const items = getItems(response.data).map(compactBall);
        const pageIndex = page;
        page += 1;
        fetched += items.length;
        cursor = response.data.next_cursor || undefined;
        // Checkpoints stay in order (page first, then the job), but don't hold up the next request
        await saving;
        const checkpoint = { cursor: cursor || null, pages: page, fetched, updatedAt: new Date() };
        saving = (async () => {
            await pages.updateOne({ userId, page: pageIndex }, { $set: { items } }, { upsert: true });
            await jobs.updateOne({ _id: userId }, { $set: checkpoint });
        })();
        saving.catch(() => {}); // awaited below
        onPage?.(fetched);
        if (cursor) await sleep(syncPageDelay(cred, response.waitMs));
    }
    await saving;

    const saved = await pages.find({ userId }).sort({ page: 1 }).toArray();
    return saved.flatMap((entry) => entry.items || []);
}

async function syncCollection(discordUserId, cred, onProgress, shouldStop) {
    const profile = await ballsdexRequest(cred, "/me");
    const totals = await getPlayerTotals(cred, discordUserId);
    const expected = totals?.ballCount ?? null;


    onProgress?.({ phase: "balls", fetched: 0, total: expected });
    const balls = await fetchBallsResumable(discordUserId, cred, (fetched) => onProgress?.({ phase: "balls", fetched, total: expected }), shouldStop);
    if (shouldStop()) throw new SyncCancelled(); // e.g. unlinked while the last page was loading
    onProgress?.({ phase: "saving", fetched: balls.length, total: expected });
    return saveCollection(discordUserId, profile, balls, totals);
}

/** Saves a fetched (or imported) collection: summary, specials, raws and collector counts. */
async function saveCollection(discordUserId, profile, balls, totals = null, { source = "api" } = {}) {
    const database = await getDatabase();
    const ballsCollection = database.collection("ballsdexBalls");
    const collectionsCollection = database.collection("ballsdexCollections");
    const specialsCollection = database.collection("ballsdexSpecials");

    const summary = buildCollectionSummary(profile, balls, totals);
    await database.collection("ballsdexFileInstances").deleteMany({ userId: String(discordUserId) });
    if (source === "file") {
        // Ballsdex exports have no favorites, frames or spawn times: leave those stats empty instead of 0
        for (const key of ["favoriteCount", "frameCount", "timedCatchCount", "fastestCatchMs", "slowestCatchMs", "fastestCatch", "slowestCatch", "averageCatchMs"]) {
            delete summary[key];
        }
        summary.source = "file";
    }
    const syncedAt = new Date();
    const specialCount = await replaceSpecialCollection(specialsCollection, discordUserId, balls);

    await collectionsCollection.updateOne(
        { discordUserId },
        {
            $set: {
                discordUserId,
                summary,
                nonSpecial: countNonSpecial(balls),
                ownedCounts: countOwned(balls),
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
        database.collection("ballsdexFileInstances").deleteMany({ userId: String(discordUserId) }),
    ]);
}

/* ----- Sign in with Ballsdex (OAuth 2): tokens per user, stored encrypted in data.json ----- */

// users[id].ballsdex = { linkedAt, oauth: { access, refresh (encrypted), expiresAt, scope } }
// needsReconnect: the sign-in stopped working (or it was an old v1 key): stats stay, the API needs a new sign-in.
const ballsdexRecord = (userId) => getData().users[String(userId)]?.ballsdex || null;

/** The sign-in BallIdentifier can call the API with, or null. */
function getGrant(userId) {
    const oauth = ballsdexRecord(userId)?.oauth;
    return oauth?.refresh ? oauth : null;
}

/** Kept for the rest of the bot: truthy when the API can be called for this user. */
function getSavedApiKey(userId) {
    return getGrant(userId);
}

/** A Ballsdex account is connected (maybe needing a new sign-in): its synced stats can be shown. */
function isLinked(userId) {
    const record = ballsdexRecord(userId);
    return Boolean(record?.oauth?.refresh || record?.apiKey || record?.needsReconnect);
}

const needsReconnect = (userId) => isLinked(userId) && !getGrant(userId);

function reconnectError(userId) {
    return needsReconnect(userId)
        ? Object.assign(new Error("Ballsdex now uses Sign in with Ballsdex instead of API keys. Sign in again in the Ballsdex tab to keep syncing."), { status: 401, code: "RECONNECT" })
        : Object.assign(new Error("Connect your Ballsdex account first (Ballsdex tab)."), { status: 400, code: "NOT_LINKED" });
}

/** What API calls for a user are made with (the access token is looked up, and refreshed, per call). */
function credentialFor(userId) {
    if (!getGrant(userId)) throw reconnectError(userId);
    return { userId: String(userId) };
}

const OAUTH_CRED = { userId: "oauth" }; // token/revoke calls: only the IP limits apply to them

function oauthClient() {
    const id = process.env.BALLSDEX_CLIENT_ID;
    if (!id) throw Object.assign(new Error("Sign in with Ballsdex isn't set up on the bot yet."), { status: 503, code: "NOT_CONFIGURED" });
    return { id, secret: process.env.BALLSDEX_CLIENT_SECRET || null };
}

/** POST to the token or revoke endpoint. Errors there follow OAuth 2 ({ error, error_description }). */
async function oauthPost(path, params) {
    const { id, secret } = oauthClient();
    const body = new URLSearchParams(params);
    const headers = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
    if (secret) headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`;
    else body.set("client_id", id);

    let response;
    try {
        response = await fetch(`${OAUTH_URL}${path}`, { method: "POST", headers, body: body.toString(), signal: AbortSignal.timeout(10000) });
    } catch (error) {
        throw apiError(503, { detail: error.message });
    }
    // The shared per-IP limits count here too: keep them up to date
    recordRateLimits(OAUTH_CRED, response.headers);
    const data = await response.json().catch(() => ({}));
    if (response.ok) return data;
    if (response.status === 429) throw await readError(response, OAUTH_CRED);
    if (response.status >= 500) throw apiError(response.status);
    const error = new Error(typeof data.error_description === "string" ? data.error_description.slice(0, 200) : "Ballsdex refused the sign-in.");
    error.status = response.status;
    error.code = "OAUTH";
    error.oauthError = typeof data.error === "string" ? data.error : null;
    throw error;
}

function saveGrant(userId, tokens, { fresh = false } = {}) {
    if (!tokens?.access_token || !tokens?.refresh_token) throw apiError(502, { detail: "no tokens in the answer" });
    const oauth = {
        access: encryptApiKey(tokens.access_token),
        refresh: encryptApiKey(tokens.refresh_token),
        expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
        scope: typeof tokens.scope === "string" ? tokens.scope : null,
    };
    updateData((data) => {
        const user = (data.users[userId] ??= {});
        const current = user.ballsdex || {};
        // A new sign-in replaces an old v1 key and clears "needs reconnect"
        user.ballsdex = { linkedAt: fresh || !current.linkedAt ? new Date().toISOString() : current.linkedAt, oauth };
    });
}

/** The sign-in stopped working (revoked, expired): keep the account and its stats, ask for a new sign-in. */
function dropGrant(userId) {
    updateData((data) => {
        const record = data.users[userId]?.ballsdex;
        if (!record) return;
        delete record.oauth;
        delete record.apiKey;
        record.needsReconnect = true;
    });
    getNotifier()
        .notify(userId, "ballsdex_account", {
            title: "Sign in with Ballsdex again",
            body: "BallIdentifier can't reach your Ballsdex account anymore (the sign-in expired or access was removed). Your stats are still here; sign in again to sync.",
            link: "#/ballsdex",
        })
        .catch(() => {});
}

// Each refresh token works once (a reused one signs the player out): one refresh per user at a time,
// and the new pair is saved as soon as it arrives
const refreshes = new Map();

async function accessToken(userId, { force = false } = {}) {
    const grant = getGrant(userId);
    if (!grant) throw reconnectError(userId);
    if (!force && grant.expiresAt - Date.now() > ACCESS_REFRESH_MARGIN_MS) return decryptApiKey(grant.access);
    if (!refreshes.has(userId)) {
        const job = (async () => {
            try {
                const tokens = await oauthPost("/token", { grant_type: "refresh_token", refresh_token: decryptApiKey(grant.refresh) });
                saveGrant(userId, tokens);
                return tokens.access_token;
            } catch (error) {
                if (error.code === "OAUTH" && error.oauthError === "invalid_grant") {
                    dropGrant(userId);
                    throw Object.assign(new Error("Your Ballsdex sign-in expired or access was removed. Sign in with Ballsdex again in the Ballsdex tab."), { status: 401, code: "RECONNECT" });
                }
                if (error.code === "OAUTH") {
                    console.error(`[BALLSDEX] Token refresh refused (${error.oauthError}): ${error.message}`);
                    throw Object.assign(new Error("Ballsdex refused BallIdentifier's sign-in right now. Try again later."), { status: 503, code: "UNAVAILABLE" });
                }
                throw error;
            }
        })().finally(() => refreshes.delete(userId));
        refreshes.set(userId, job);
    }
    return refreshes.get(userId);
}

async function revokeGrant(grant) {
    try {
        if (grant?.refresh) await oauthPost("/revoke", { token: decryptApiKey(grant.refresh), token_type_hint: "refresh_token" });
    } catch (error) {
        console.error("[BALLSDEX] Couldn't revoke a sign-in:", error.message);
    }
}

function removeApiKey(userId) {
    if (!isLinked(userId)) return false;
    const grant = getGrant(userId);
    const removed = updateData((data) => {
        if (!data.users[userId]?.ballsdex) return false;
        delete data.users[userId].ballsdex;
        return true;
    });
    if (removed && grant) revokeGrant(grant);
    return removed;
}

const linkCooldowns = new Map();

/**
 * Finish "Sign in with Ballsdex": exchange the code from the website's callback for tokens,
 * check that the Ballsdex account is the logged-in Discord user, and save the sign-in.
 */
async function connectOAuth(userId, { code, codeVerifier, redirectUri }) {
    userId = String(userId);
    const cooldownUntil = linkCooldowns.get(userId) || 0;
    if (cooldownUntil > Date.now()) {
        throw Object.assign(new Error("Please wait a moment before trying again."), { code: "COOLDOWN", retryAfterSec: Math.ceil((cooldownUntil - Date.now()) / 1000) });
    }
    linkCooldowns.set(userId, Date.now() + LINK_COOLDOWN_MS);

    let tokens;
    try {
        tokens = await oauthPost("/token", { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: codeVerifier });
    } catch (error) {
        linkCooldowns.delete(userId);
        if (error.code === "OAUTH") {
            throw Object.assign(new Error(error.oauthError === "invalid_grant" ? "This sign-in expired or was already used. Try again." : `Ballsdex refused the sign-in: ${error.message}`), { status: 400, code: "OAUTH_FAILED" });
        }
        throw error;
    }

    const refreshOnly = { refresh: encryptApiKey(tokens.refresh_token || "") };
    let profile;
    try {
        profile = await ballsdexRequest({ userId, token: tokens.access_token }, "/me", {}, INTERACTIVE);
    } catch (error) {
        linkCooldowns.delete(userId);
        await revokeGrant(refreshOnly);
        throw error;
    }
    if (String(profile.discord_id || "") !== userId) {
        linkCooldowns.delete(userId); // a mix-up, not abuse: let them sign in with the right account right away
        await revokeGrant(refreshOnly);
        throw Object.assign(new Error("You signed in to Ballsdex with a different Discord account than the one logged in here. Use the same account."), { status: 403, code: "WRONG_ACCOUNT" });
    }

    const wasLinked = isLinked(userId);
    saveGrant(userId, tokens, { fresh: !wasLinked });
    getNotifier()
        .notify(userId, "ballsdex_account", {
            title: wasLinked ? "Ballsdex account reconnected" : "Ballsdex account linked",
            body: "Your Ballsdex account was connected to BallIdentifier with Sign in with Ballsdex. Not you? Unlink it in the Ballsdex tab.",
            link: "#/ballsdex",
        })
        .catch(() => {});
    return { reconnected: wasLinked, scope: tokens.scope || null };
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
// Per-user cooldown: 24 h after a successful sync, 5 min after a failed or cancelled one; persisted in
// data.json users[id].ballsdexSync so restarts and unlink/relink don't reset it.
// ---------------------------------------------------------------------------

const syncStates = new Map(); // userId -> live state of the user's current/last sync this run
let activeSync = null; // { userId, state }
const slotWaiters = new Set(); // users to notify when the running sync ends

function getNotifier() {
    return require("./notifications");
}

/* ----- Owner switches (website Moderation): syncing on/off for everyone but the owner ----- */

function getSyncSwitches() {
    const settings = getData().settings || {};
    return { syncDisabled: Boolean(settings.syncDisabled), fastSyncDisabled: Boolean(settings.fastSyncDisabled) };
}

function setSyncSwitches({ syncDisabled, fastSyncDisabled } = {}) {
    updateData((data) => {
        data.settings ??= {};
        if (typeof syncDisabled === "boolean") data.settings.syncDisabled = syncDisabled;
        if (typeof fastSyncDisabled === "boolean") data.settings.fastSyncDisabled = fastSyncDisabled;
    });
    const switches = getSyncSwitches();
    // Turned back on: paused and interrupted syncs continue, and whoever waited can sync again
    if (!switches.syncDisabled) resumeInterruptedSyncs().catch(() => {});
    return switches;
}

const syncBlocked = (userId) => String(userId) !== ADMIN_ID && getSyncSwitches().syncDisabled;
const fastSyncBlocked = (userId) => String(userId) !== ADMIN_ID && getSyncSwitches().fastSyncDisabled;

function getSyncRecord(userId) {
    return getData().users[userId]?.ballsdexSync || {};
}

function cooldownLeftMs(userId) {
    if (userId === ADMIN_ID) return 0; // the owner has no sync cooldown
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
        // stopped by today's quota: progress kept, continues by itself at resumeAt
        paused: Boolean(record.pausedUntil && !state?.inProgress),
        resumeAt: record.pausedUntil && !state?.inProgress ? record.pausedUntil : null,
        pausedFetched: record.pausedUntil ? record.pausedFetched ?? null : null,
        busy,
        waiting: busy && slotWaiters.has(userId),
        source: state?.source || "api",
        fastRetryAfterSec: Math.ceil(fastCooldownLeftMs(userId) / 1000),
        // turned off by the owner in Moderation
        disabled: syncBlocked(userId),
        fastDisabled: fastSyncBlocked(userId),
    };
}

function finishSync(userId, state, outcome) {
    const cooldown = userId === ADMIN_ID || outcome === "paused" ? 0 : outcome === "success" ? SYNC_COOLDOWN_MS : SYNC_RETRY_COOLDOWN_MS;
    const nextSyncAt = new Date(Date.now() + cooldown).toISOString();
    updateData((data) => {
        data.users[userId] ??= {};
        const previous = data.users[userId].ballsdexSync || {};
        data.users[userId].ballsdexSync = {
            // Fast Sync keeps its own cooldown
            fastNextAt: previous.fastNextAt,
            lastFastAt: previous.lastFastAt,
            lastFastOutcome: previous.lastFastOutcome,
            lastFinishedAt: new Date().toISOString(),
            lastOutcome: outcome,
            nextSyncAt,
            // remind only after a real sync; a quick retry window needs no notification
            notifyAvailableAt: outcome === "success" && userId !== ADMIN_ID ? nextSyncAt : null,
            ...(outcome === "paused" ? { pausedUntil: new Date(state.resumeAt).toISOString(), pausedFetched: state.progress?.fetched ?? null } : {}),
        };
    });
    state.inProgress = false;
    state.finishedAt = Date.now();
    if (activeSync?.userId === userId) activeSync = null;

    // The slot is free: tell everyone who was turned away
    const waiters = [...slotWaiters].filter((id) => id !== userId);
    slotWaiters.clear();
    for (const waiterId of waiters) {
        if (!getSavedApiKey(waiterId) || cooldownLeftMs(waiterId) > 0 || syncBlocked(waiterId)) continue;
        getNotifier()
            .notify(waiterId, "sync_available", {
                title: "You can sync your Ballsdex collection now",
                body: "The sync that was running has finished.",
                link: "#/ballsdex",
                dmText: "The Ballsdex sync slot is free: sync your collection now with `/ballsdex sync` or on the website.",
                linkLabel: "Open the Ballsdex tab",
            })
            .catch(() => {});
    }
}

/**
 * Start a background collection sync.
 * @returns {{started: true} | {started: false, reason: "NOT_LINKED"|"RECONNECT"|"DISABLED"|"IN_PROGRESS"|"BUSY"|"COOLDOWN", retryAfterSec?: number}}
 */
function startSync(userId) {
    userId = String(userId);
    if (!getGrant(userId)) return { started: false, reason: needsReconnect(userId) ? "RECONNECT" : "NOT_LINKED" };
    if (syncBlocked(userId)) return { started: false, reason: "DISABLED" };

    if (syncStates.get(userId)?.inProgress) return { started: false, reason: "IN_PROGRESS" };

    const left = cooldownLeftMs(userId);
    if (left > 0) return { started: false, reason: "COOLDOWN", retryAfterSec: Math.ceil(left / 1000) };

    if (activeSync) {
        slotWaiters.add(userId);
        return { started: false, reason: "BUSY" };
    }

    runSync(userId);
    return { started: true };
}

/** Runs a sync in the background; with `resume`, continues a checkpointed job after a restart. */
function runSync(userId, { resume = null } = {}) {
    const state = {
        inProgress: true,
        startedAt: resume?.startedAt ? new Date(resume.startedAt).getTime() : Date.now(),
        finishedAt: null,
        error: null,
        cancelled: false,
        cancelRequested: false,
        ballCount: null,
        progress: { phase: "starting", fetched: resume?.fetched || 0, total: null },
        resumed: Boolean(resume),
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
        let cred = null;
        try {
            const { jobs } = await syncStorage();
            // Starting again after a pause continues the saved progress instead of starting over
            const paused = resume ? null : await jobs.findOne({ _id: userId, pausedUntil: { $exists: true } });
            if (!resume && !paused) await createSyncJob(userId);
            else await jobs.updateOne({ _id: userId }, { $unset: { pausedUntil: "" } });
            if (paused || resume) state.resumed = true;
            cred = credentialFor(userId);
            const result = await syncCollection(
                userId,
                cred,
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
            } else if (error.code === "QUOTA" || error.status === 429) {
                // Out of today's requests: keep the progress and continue when the quota resets
                outcome = "paused";
                state.resumeAt =
                    error.resumeAt ||
                    Math.max(cred ? exhaustedResetTime(cred) : 0, error.retryAfterSec ? Date.now() + (error.retryAfterSec + 60) * 1000 : 0) ||
                    Date.now() + 3600 * 1000;
                const hours = Math.max(1, Math.round((state.resumeAt - Date.now()) / 3600000));
                const fetched = (state.progress?.fetched || 0).toLocaleString("en-US");
                getNotifier()
                    .notify(userId, "sync_finished", {
                        title: "Ballsdex sync paused",
                        body: `${error.reason || error.message} ${fetched} balls are saved; the sync continues by itself in about ${hours} h.`,
                        link: "#/ballsdex",
                        dmText: `Your Ballsdex sync paused after ${fetched} balls: ${error.reason || error.message} It continues by itself in about ${hours} h, nothing is lost.`,
                    })
                    .catch(() => {});
            } else {
                if (!error.ballsdexApi) console.error("[BALLSDEX] Failed to sync collection:", error);
                state.error = error.message;
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
            if (outcome === "paused") {
                await syncStorage()
                    .then(({ jobs }) => jobs.updateOne({ _id: userId }, { $set: { pausedUntil: new Date(state.resumeAt), updatedAt: new Date() } }))
                    .catch((error) => console.error("[BALLSDEX] Couldn't save the paused sync:", error.message));
            } else {
                await deleteSyncJob(userId).catch((error) => console.error("[BALLSDEX] Couldn't clear sync checkpoint:", error.message));
            }
            finishSync(userId, state, outcome);
            resumeNext();
        }
    })();
}

const resumeQueue = []; // interrupted jobs waiting for the sync slot (normally at most one)

function resumeNext() {
    while (!activeSync && resumeQueue.length) {
        const job = resumeQueue.shift();
        if (!getGrant(job._id)) {
            deleteSyncJob(job._id).catch(() => {});
            continue;
        }
        if (syncBlocked(job._id)) continue; // stays saved: picked up again once syncing is back on
        runSync(job._id, { resume: job });
    }
}

function clearPaused(userId) {
    if (!getSyncRecord(userId).pausedUntil) return;
    updateData((data) => {
        const record = data.users[userId]?.ballsdexSync;
        if (record) {
            delete record.pausedUntil;
            delete record.pausedFetched;
        }
    });
}

/**
 * After a restart: continue syncs that were cut off, from their last saved page.
 * Called every minute too, which picks up paused syncs once their quota has reset.
 * Jobs older than a day, or of users who unlinked, are dropped.
 * @returns {Promise<string[]>} user ids whose sync was resumed or queued
 */
async function resumeInterruptedSyncs() {
    const { jobs } = await syncStorage();
    const found = await jobs.find({}).sort({ startedAt: 1 }).toArray();
    const resumed = [];
    for (const job of found) {
        if (syncStates.get(job._id)?.inProgress || resumeQueue.some((queued) => queued._id === job._id)) continue;
        if (job.pausedUntil && new Date(job.pausedUntil).getTime() > Date.now()) continue; // not due yet
        const maxAge = job.pausedUntil ? PAUSED_MAX_AGE_MS : RESUME_MAX_AGE_MS;
        const fresh = Date.now() - new Date(job.updatedAt || job.startedAt).getTime() < maxAge;
        if (!fresh || !getSavedApiKey(job._id)) {
            await deleteSyncJob(job._id);
            clearPaused(job._id);
            continue;
        }
        if (syncBlocked(job._id)) continue; // syncing is off: keep the progress for later
        resumeQueue.push(job);
        resumed.push(job._id);
    }
    resumeNext();
    return resumed;
}

/** Owner view: the running sync, who's waiting for the slot, and interrupted syncs queued to resume. */
function getSyncOverview() {
    const users = getData().users;
    return {
        active: activeSync ? { userId: activeSync.userId, resumed: Boolean(activeSync.state.resumed), ...getSyncState(activeSync.userId) } : null,
        waiting: [...slotWaiters],
        resumeQueue: resumeQueue.map((job) => job._id),
        paused: Object.entries(users)
            .filter(([, user]) => user.ballsdexSync?.pausedUntil)
            .map(([userId, user]) => ({ userId, resumeAt: user.ballsdexSync.pausedUntil, fetched: user.ballsdexSync.pausedFetched ?? null })),
        linkedAccounts: Object.values(users).filter((user) => user.ballsdex?.oauth?.refresh).length,
        switches: getSyncSwitches(),
        syncedLast24h: Object.values(users).filter((user) => user.ballsdexSync?.lastOutcome === "success" && Date.now() - new Date(user.ballsdexSync.lastFinishedAt).getTime() < 86400000).length,
    };
}

/** Owner: stop whichever sync is running. Returns the user id, or null when nothing runs. */
function cancelActiveSync() {
    if (!activeSync) return null;
    const { userId } = activeSync;
    cancelSync(userId);
    return userId;
}

/** Ask the user's running sync to stop after the current page. */
function cancelSync(userId) {
    userId = String(userId);
    const state = syncStates.get(userId);
    if (state?.inProgress) {
        state.cancelRequested = true;
        return true;
    }
    // A paused sync: drop its saved progress
    if (getSyncRecord(userId).pausedUntil) {
        const index = resumeQueue.findIndex((job) => job._id === userId);
        if (index >= 0) resumeQueue.splice(index, 1);
        deleteSyncJob(userId).catch(() => {});
        clearPaused(userId);
        return true;
    }
    return false;
}

/** Sends due "you can sync again" reminders. Called every minute from clientReady. */
async function sendDueSyncReminders() {
    if (getSyncSwitches().syncDisabled) return; // "you can sync again" would be wrong now; sent once syncing is back on
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
                body: "24 hours have passed since your last sync.",
                link: "#/ballsdex",
                dmText: "24 hours have passed: sync your collection again with `/ballsdex sync` or on the website.",
                linkLabel: "Open the Ballsdex tab",
            })
            .catch(() => {});
    }
}

/* ----- Fast Sync: import the export of Ballsdex's /player settings from its Discord link -----
 * Ballsdex sends player_data.zip (with <discord id>_countryball.csv inside) in the user's DMs. The user pastes
 * that file's link and the bot downloads it from Discord's CDN itself, so it reads exactly what Discord stores.
 * Checks, in order: a cdn.discordapp.com / media.discordapp.net attachment link to player_data.zip, uploaded
 * in the last FAST_SYNC_MAX_AGE_MS (the attachment id is a timestamp); the CSV inside is named with the user's
 * Discord id and every row is consistent (id = hex id, dates, stats, no repeats); then the file is checked
 * against the account with the user's own key: /me, the ball total, and FAST_SYNC_SAMPLES random balls looked
 * up by id. The link alone doesn't prove Ballsdex posted the file (a user can upload into the same DM), so
 * collector claims based on it are checked again per ball (verifyFileBall).
 */
const FAST_SYNC_COOLDOWN_MS = 30 * 60 * 1000;
const FAST_SYNC_RETRY_MS = 5 * 60 * 1000; // after a file that didn't pass the checks
const FAST_SYNC_MAX_ROWS = 3000000;
const FAST_SYNC_MAX_BYTES = 200 * 1024 * 1024; // the zip
const FAST_SYNC_MAX_CSV_BYTES = 800 * 1024 * 1024; // the CSV inside it
const FAST_SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FAST_SYNC_SAMPLES = 12;
const FILE_CHECK_SAMPLES = 10; // per ball, when a collector claim rests on Fast Sync data
const FAST_SYNC_FILE = /^(\d{17,20})_countryball(?: ?\(\d+\))?\.csv$/i;
const EXPORT_HEADER = "id,catch_date,health_bonus,attack_bonus,attack,health,hex_id,traded_with,special_card,countryball";
const DISCORD_EPOCH = 1420070400000n;
const catalogCache = { at: 0, balls: null, specials: null };

function fastCooldownLeftMs(userId) {
    if (userId === ADMIN_ID) return 0;
    const until = getSyncRecord(userId).fastNextAt ? new Date(getSyncRecord(userId).fastNextAt).getTime() : 0;
    return Math.max(0, until - Date.now());
}

function fastError(message, status = 400, code = "INVALID_FILE") {
    return Object.assign(new Error(message), { status, code });
}

let fileIndexReady = null;
async function fileInstances() {
    const collection = (await getDatabase()).collection("ballsdexFileInstances");
    fileIndexReady ??= collection.createIndex({ userId: 1, ballId: 1 }).catch(() => (fileIndexReady = null));
    await fileIndexReady;
    return collection;
}

/** Ball and special ids by name (the export only has names), from the Ballsdex API, cached for a day. */
async function getCatalog(cred) {
    if (catalogCache.balls && Date.now() - catalogCache.at < 24 * 60 * 60 * 1000) return catalogCache;
    const balls = new Map();
    const specials = new Map();
    for (const [path, map, nameOf] of [
        ["/balls", balls, (item) => item.country],
        ["/specials", specials, (item) => item.name],
    ]) {
        let cursor;
        do {
            const page = await ballsdexRequest(cred, path, { limit: 100, cursor });
            for (const item of getItems(page)) if (nameOf(item)) map.set(nameOf(item).toLowerCase(), item.id);
            cursor = page.next_cursor || undefined;
        } while (cursor);
    }
    Object.assign(catalogCache, { at: Date.now(), balls, specials });
    return catalogCache;
}

/** A Discord attachment link to player_data.zip -> { url, uploadedAt }. */
function parseExportLink(link) {
    let url;
    try {
        url = new URL(String(link || "").trim());
    } catch {
        throw fastError("Paste the link of player_data.zip from your DMs with Ballsdex.");
    }
    const match = /^\/attachments\/(\d{17,20})\/(\d{17,20})\/player_data\.zip$/i.exec(url.pathname);
    if (url.protocol !== "https:" || !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname) || !match) {
        throw fastError("That isn't a Discord link to player_data.zip. Right-click the file in your DMs with Ballsdex and choose Copy Link.");
    }
    if (!url.searchParams.get("ex") || !url.searchParams.get("hm")) {
        throw fastError("The link is incomplete. Copy it again from Discord: it ends with ?ex=…&is=…&hm=….");
    }
    const uploadedAt = Number((BigInt(match[2]) >> 22n) + DISCORD_EPOCH);
    return { url: `https://cdn.discordapp.com${url.pathname}${url.search}`, uploadedAt };
}

async function downloadExport(url) {
    const response = await fetch(url, { redirect: "error" });
    if ([403, 404, 410].includes(response.status)) throw fastError("Discord says this link has expired. Copy the file's link again.", 400, "LINK_EXPIRED");
    if (!response.ok) throw fastError(`Couldn't download the file from Discord (HTTP ${response.status}). Try again in a moment.`, 502, "DOWNLOAD_FAILED");
    if (Number(response.headers.get("content-length")) > FAST_SYNC_MAX_BYTES) throw fastError("The file is too big.");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > FAST_SYNC_MAX_BYTES) throw fastError("The file is too big.");
    return buffer;
}

/** player_data.zip -> the text of <userId>_countryball.csv inside it. */
function unzipExport(zip, userId) {
    let end = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
        if (zip.readUInt32LE(i) === 0x06054b50) {
            end = i;
            break;
        }
    }
    if (end < 0) throw fastError("player_data.zip is damaged. Export it again.");
    const count = zip.readUInt16LE(end + 10);
    let offset = zip.readUInt32LE(end + 16);
    for (let n = 0; n < count && offset + 46 <= zip.length; n++) {
        if (zip.readUInt32LE(offset) !== 0x02014b50) break;
        const method = zip.readUInt16LE(offset + 10);
        const size = zip.readUInt32LE(offset + 20);
        const unpacked = zip.readUInt32LE(offset + 24);
        const nameLength = zip.readUInt16LE(offset + 28);
        const name = zip.toString("utf8", offset + 46, offset + 46 + nameLength).split("/").pop();
        const local = zip.readUInt32LE(offset + 42);
        offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
        const match = FAST_SYNC_FILE.exec(name);
        if (!match) continue;
        if (match[1] !== userId) throw fastError("This export belongs to another Discord account.", 403, "WRONG_ACCOUNT");
        if (unpacked > FAST_SYNC_MAX_CSV_BYTES) throw fastError("The file is too big.");
        if (zip.readUInt32LE(local) !== 0x04034b50) break;
        const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
        const data = zip.subarray(start, start + size);
        if (method === 0) return data.toString("utf8");
        if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: FAST_SYNC_MAX_CSV_BYTES }).toString("utf8");
        throw fastError("player_data.zip uses a compression the bot can't read.");
    }
    throw fastError(`No ${userId}_countryball.csv in player_data.zip. Is it the export from /player settings?`);
}

function parseCsvLine(line) {
    const out = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quoted) {
            if (c === '"' && line[i + 1] === '"') {
                field += '"';
                i++;
            } else if (c === '"') quoted = false;
            else field += c;
        } else if (c === ",") {
            out.push(field);
            field = "";
        } else if (c === '"' && !field) quoted = true;
        else field += c;
    }
    out.push(field);
    return out;
}

/** "2023-05-18 08:03:12.31984+00" -> unix seconds, or NaN */
function exportDate(value) {
    const iso = value.trim().replace(" ", "T").replace(/(\.\d{3})\d+/, "$1").replace(/([+-]\d{2})$/, "$1:00");
    return Math.floor(Date.parse(iso) / 1000);
}

/** The CSV -> rows [instance id, ball name, special name or "", caught at (unix s), traded 0/1], every row checked. */
function parseExport(text) {
    const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((line) => line.trim());
    if (lines.length < 2) throw fastError("The export has no balls in it.");
    if (lines.length - 1 > FAST_SYNC_MAX_ROWS) throw fastError("The export is too big.");
    if (parseCsvLine(lines[0]).map((name) => name.trim()).join(",") !== EXPORT_HEADER) throw fastError("The file's columns don't match a Ballsdex export.");

    const rows = [];
    const ids = new Set();
    const now = Date.now() / 1000;
    const isInt = (value) => /^-?\d+$/.test(value);
    for (let i = 1; i < lines.length; i++) {
        const fields = parseCsvLine(lines[i]);
        const bad = (what) => fastError(`Row ${i + 1} of the export ${what}.`);
        if (fields.length !== 10) throw bad("has the wrong number of columns");
        const [id, catchDate, healthBonus, attackBonus, attack, health, hexId, tradedWith, special, country] = fields;
        if (!/^\d{1,20}$/.test(id)) throw bad("has an invalid ball id");
        if (BigInt(id).toString(16).toUpperCase() !== hexId.trim().toUpperCase()) throw bad("has an id that doesn't match its hex id");
        if (ids.has(id)) throw bad("repeats a ball");
        const caughtAt = exportDate(catchDate);
        if (!Number.isFinite(caughtAt) || caughtAt < 1500000000 || caughtAt > now + 86400) throw bad("has an invalid catch date");
        if (![healthBonus, attackBonus, attack, health].every(isInt) || Math.abs(Number(healthBonus)) > 100 || Math.abs(Number(attackBonus)) > 100) throw bad("has invalid stats");
        if (tradedWith && !/^\d{17,20}$/.test(tradedWith)) throw bad("has an invalid trade partner");
        if (!country.trim() || country.length > 100 || special.length > 100) throw bad("has an invalid ball name");
        ids.add(id);
        rows.push([id, country, special, caughtAt, tradedWith ? 1 : 0]);
    }
    return rows;
}

/** Download, check and save an export from its Discord link (in the background, shown as a sync). */
function startFastSync(userId, { url } = {}) {
    userId = String(userId);
    if (!getGrant(userId)) {
        throw needsReconnect(userId)
            ? fastError("Sign in with Ballsdex again first: Fast Sync checks the file against your account.", 400, "RECONNECT")
            : fastError("Link your Ballsdex account first: Fast Sync checks the file against it.", 400, "NOT_LINKED");
    }
    if (fastSyncBlocked(userId)) throw fastError("Fast Sync is temporarily disabled by the administrators.", 403, "DISABLED");
    if (syncStates.get(userId)?.inProgress) throw fastError("Your collection is already being synchronized.", 409, "IN_PROGRESS");
    const left = fastCooldownLeftMs(userId);
    if (left > 0) throw Object.assign(fastError(`You can use Fast Sync again in ${Math.ceil(left / 60000)} min.`, 429, "COOLDOWN"), { retryAfterSec: Math.ceil(left / 1000) });
    const link = parseExportLink(url);
    if (Date.now() - link.uploadedAt > FAST_SYNC_MAX_AGE_MS) throw fastError("This export is more than a day old. Run /player settings again and use the new file.", 400, "TOO_OLD");

    const state = {
        inProgress: true,
        startedAt: Date.now(),
        finishedAt: null,
        error: null,
        cancelled: false,
        cancelRequested: false,
        ballCount: null,
        source: "file",
        progress: { phase: "downloading", fetched: 0, total: null },
    };
    syncStates.set(userId, state);

    void (async () => {
        let outcome = "failed";
        let retryWaitMs = FAST_SYNC_RETRY_MS;
        try {
            const rows = parseExport(unzipExport(await downloadExport(link.url), userId));
            state.progress = { phase: "verifying", fetched: rows.length, total: rows.length };

            // Does the file belong to this account and match it now?
            const cred = credentialFor(userId);
            const profile = await ballsdexRequest(cred, "/me");
            if (profile?.discord_id && String(profile.discord_id) !== userId) throw fastError("Your linked Ballsdex key belongs to another account.", 403);
            const totals = await getPlayerTotals(cred, userId);
            if (totals) {
                const drift = Math.abs(totals.ballCount - rows.length);
                if (drift > Math.max(25, rows.length * 0.01)) {
                    throw fastError(`The export has ${rows.length.toLocaleString("en-US")} balls but your account has ${totals.ballCount.toLocaleString("en-US")}. Export a fresh one and paste its link right away.`);
                }
            }
            const samples = [...new Set(Array.from({ length: Math.min(FAST_SYNC_SAMPLES, rows.length) }, () => rows[crypto.randomInt(rows.length)]))];
            let matches = 0;
            for (const row of samples) {
                try {
                    const ball = await ballsdexRequest(cred, `/me/balls/${row[0]}`);
                    if (ball?.ball?.country === row[1] && (ball.special?.name || "") === row[2]) matches += 1;
                } catch (error) {
                    if (error.status !== 404 && error.status !== 403) throw error;
                }
            }
            if (matches < samples.length - 1) throw fastError("This export doesn't match the balls in your Ballsdex account. Export a fresh one with /player settings.");

            state.progress = { phase: "saving", fetched: rows.length, total: rows.length };
            const { balls: ballIds, specials: specialIds } = await getCatalog(cred);
            const balls = rows.map(([id, country, special, caughtAt, traded]) => ({
                id,
                ball: { id: ballIds.get(country.toLowerCase()), country },
                special: special ? { id: specialIds.get(special.toLowerCase()) ?? special, name: special } : null,
                self_caught: traded === 0,
                caught_at: new Date(caughtAt * 1000).toISOString(),
            }));
            const result = await saveCollection(userId, profile, balls, null, { source: "file" });
            // instance ids per ball, so collector claims can be checked against the API later
            const idsByBall = new Map();
            for (const ball of balls) {
                if (ball.ball.id === undefined) continue;
                if (!idsByBall.has(ball.ball.id)) idsByBall.set(ball.ball.id, []);
                idsByBall.get(ball.ball.id).push(ball.id);
            }
            const instances = await fileInstances();
            const docs = [...idsByBall].map(([ballId, ids]) => ({ userId, ballId, ids }));
            for (let index = 0; index < docs.length; index += 100) await instances.insertMany(docs.slice(index, index + 100), { ordered: false });
            state.ballCount = result.ballCount;
            outcome = "success";

            // a paused API sync would overwrite this later: drop it
            if (getSyncRecord(userId).pausedUntil) {
                const queued = resumeQueue.findIndex((job) => job._id === userId);
                if (queued >= 0) resumeQueue.splice(queued, 1);
                await deleteSyncJob(userId).catch(() => {});
                clearPaused(userId);
            }
            getNotifier()
                .notify(userId, "sync_finished", {
                    title: "Fast Sync finished",
                    body: `${result.ballCount.toLocaleString("en-US")} balls imported from your Ballsdex export. Your stats and raws are up to date.`,
                    link: "#/ballsdex",
                })
                .catch(() => {});
        } catch (error) {
            if (!error.status) console.error("[BALLSDEX] Fast Sync failed:", error);
            state.error = error.message;
            // Out of API requests: the next try only makes sense once they're back
            if (error.code === "RATE_LIMITED" && error.retryAfterSec) retryWaitMs = Math.min(24 * 3600 * 1000, Math.max(FAST_SYNC_RETRY_MS, error.retryAfterSec * 1000));
        } finally {
            const wait = userId === ADMIN_ID ? 0 : outcome === "success" ? FAST_SYNC_COOLDOWN_MS : retryWaitMs;
            updateData((data) => {
                data.users[userId] ??= {};
                data.users[userId].ballsdexSync ??= {};
                const record = data.users[userId].ballsdexSync;
                record.fastNextAt = new Date(Date.now() + wait).toISOString();
                record.lastFastAt = new Date().toISOString();
                record.lastFastOutcome = outcome;
                if (outcome === "success") record.lastFinishedAt = new Date().toISOString();
            });
            state.inProgress = false;
            state.finishedAt = Date.now();
        }
    })();
    return getSyncState(userId);
}

/**
 * A collection imported from a file: are the user's `ballId` balls really in their Ballsdex account?
 * Looks up FILE_CHECK_SAMPLES random instances of that ball by id (one may be gone since the export).
 */
async function verifyFileBall(userId, ballId) {
    userId = String(userId);
    const cred = credentialFor(userId); // throws when the sign-in is missing
    const doc = await (await fileInstances()).findOne({ userId, ballId: Number(ballId) });
    const ids = doc?.ids || [];
    if (!ids.length) return false;
    const picks = new Set();
    while (picks.size < Math.min(FILE_CHECK_SAMPLES, ids.length)) picks.add(ids[crypto.randomInt(ids.length)]);

    let matches = 0;
    const list = [...picks];
    for (let index = 0; index < list.length; index += 5) {
        const results = await Promise.all(
            list.slice(index, index + 5).map((id) =>
                ballsdexRequest(cred, `/me/balls/${id}`, {}, INTERACTIVE).then(
                    (ball) => Number(ball?.ball?.id) === Number(ballId),
                    (error) => {
                        if (error.status === 404 || error.status === 403) return false;
                        throw error;
                    },
                ),
            ),
        );
        matches += results.filter(Boolean).length;
    }
    return matches >= list.length - (list.length >= 5 ? 1 : 0);
}

module.exports = {
    SYNC_COOLDOWN_MS,
    verifyFileBall,
    startFastSync,
    cancelSync,
    computeRaws,
    sendDueSyncReminders,
    resumeInterruptedSyncs,
    connectOAuth,
    credentialFor,
    isLinked,
    needsReconnect,
    unlinkAccount,
    getSyncState,
    getSyncOverview,
    cancelActiveSync,
    getRateLimits,
    getSharedRateLimits,
    getSyncSwitches,
    setSyncSwitches,
    startSync,
    ballsdexRequest,
    INTERACTIVE,
    buildCollectionSummary,
    decryptApiKey,
    deleteStoredCollection,
    getAllMyBalls,
    getSavedApiKey,
    getStoredCollection,
    removeApiKey,
    syncCollection,
};