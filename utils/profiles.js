/**
 * Public user profiles on the website (/u/<discord id>).
 *
 * Settings live in data.json under users[id].profile. A profile is private until its owner turns it on;
 * Ballsdex stats are a separate opt-in. The owner can hide a profile (it then can't be turned back on).
 */

const { getData, updateData } = require("./helpers");
const { BOT_NAMES, BOT_DATA_KEYS } = require("./constants");
const collectorStore = require("./collector-store");
const { isLinked, getStoredCollection } = require("./ballsdex");

const DEX_TO_KEY = Object.fromEntries(Object.entries(BOT_DATA_KEYS).map(([botId, key]) => [BOT_NAMES[botId], key]));
const KEY_TO_DEX = Object.fromEntries(Object.entries(DEX_TO_KEY).map(([dex, key]) => [key, dex]));
const ACCENTS = ["violet", "blue", "cyan", "green", "yellow", "orange", "red", "pink"];
const LIMITS = { bio: 300, pronouns: 24, showcase: 6, search: 60 };
const DEFAULTS = { public: false, bio: "", pronouns: "", accent: "violet", favoriteDex: null, showcase: [], showBallsdex: false, showCollections: true };

let client = null;
const setClient = (discordClient) => (client = discordClient);

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

function storedProfile(userId) {
    return getData().users[userId]?.profile || null;
}

/** Saved settings with defaults filled in. */
function settingsOf(userId) {
    const stored = storedProfile(userId) || {};
    return { ...DEFAULTS, ...stored, showcase: Array.isArray(stored.showcase) ? stored.showcase : [] };
}

/** Name and avatar: whichever is newer of the bot's cached Discord profile (refreshed weekly) and what the website last sent. */
function discordOf(userId, stored = storedProfile(userId)) {
    let cached = collectorStore.getDiscordProfile(userId);
    const saved = stored?.discord || {};
    if (cached && saved.name && Date.parse(stored.updatedAt || 0) > (cached.fetchedAt || 0)) cached = null;
    return {
        name: cached?.name || saved.name || null,
        username: cached?.username || saved.username || null,
        avatarUrl: cached?.avatarUrl || saved.avatarUrl || collectorStore.defaultAvatar(userId),
    };
}

/* ----- Validation ----- */

const cleanText = (value, max) =>
    String(value ?? "")
        .replace(/\r\n?/g, "\n")
        .replace(/[\u0000-\u0009\u000B-\u001F\u007F​-‏‪-‮⁦-⁩]/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, max);

function findBall(dex, name) {
    const key = DEX_TO_KEY[dex];
    const rarities = key && client?.rarities?.[key];
    if (!rarities) return null;
    const match = Object.keys(rarities).find((ball) => ball !== "hashes" && ball.toLowerCase() === String(name || "").toLowerCase());
    return match ? { dex, name: match, rarity: rarities[match]?.rarity ?? null } : null;
}

function validate(input) {
    const settings = {};
    if ("public" in input) settings.public = input.public === true;
    if ("showBallsdex" in input) settings.showBallsdex = input.showBallsdex === true;
    if ("showCollections" in input) settings.showCollections = input.showCollections === true;
    if ("bio" in input) settings.bio = cleanText(input.bio, LIMITS.bio);
    if ("pronouns" in input) settings.pronouns = cleanText(input.pronouns, LIMITS.pronouns).replace(/\n/g, " ");
    if ("accent" in input) {
        if (!ACCENTS.includes(input.accent)) throw httpError(400, "Unknown accent color.");
        settings.accent = input.accent;
    }
    if ("favoriteDex" in input) {
        if (input.favoriteDex !== null && !DEX_TO_KEY[input.favoriteDex]) throw httpError(400, "Unknown dex.");
        settings.favoriteDex = input.favoriteDex;
    }
    if ("showcase" in input) {
        if (!Array.isArray(input.showcase) || input.showcase.length > LIMITS.showcase) throw httpError(400, `Pick up to ${LIMITS.showcase} balls for the showcase.`);
        const seen = new Set();
        settings.showcase = [];
        for (const item of input.showcase) {
            const ball = findBall(item?.dex, item?.name);
            if (!ball) throw httpError(400, `"${String(item?.name || "").slice(0, 60)}" isn't a ball in ${String(item?.dex || "that dex").slice(0, 30)}.`);
            const key = `${ball.dex}/${ball.name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            settings.showcase.push({ dex: ball.dex, name: ball.name });
        }
    }
    return settings;
}

/* ----- Reading ----- */

/** What the user collects, grouped by dex (same data as the Collectors page). */
function collectionsOf(userId) {
    const groups = new Map();
    for (const entry of collectorStore.getUserCollections(userId)) {
        const dex = KEY_TO_DEX[entry.dexKey];
        if (!dex) continue;
        if (!groups.has(dex)) groups.set(dex, []);
        groups.get(dex).push({ id: entry.id, name: entry.name, rarity: entry.rarity ?? null, verified: entry.verified });
    }
    return [...groups.entries()].map(([dex, balls]) => ({ dex, balls: balls.sort((a, b) => (a.rarity ?? 1e9) - (b.rarity ?? 1e9) || a.name.localeCompare(b.name)) }));
}

/** Ballsdex numbers that are safe to show publicly (no instance IDs, no account details). */
async function ballsdexOf(userId) {
    if (!isLinked(userId)) return null;
    let stored;
    try {
        stored = await getStoredCollection(userId);
    } catch {
        return { unavailable: true };
    }
    const s = stored?.summary;
    if (!s) return null;
    const dexSize = Object.keys(client?.rarities?.BD || {}).filter((name) => name !== "hashes").length || null;
    const record = (value) => (value ? { ballName: value.ballName, durationMs: value.durationMs } : null);
    return {
        lastSyncedAt: stored.lastSyncedAt || null,
        source: s.source || "api",
        totalBalls: s.totalBalls ?? null,
        uniqueBalls: s.uniqueBalls ?? null,
        dexSize,
        specialCount: s.specialCount ?? null,
        specialKinds: s.specialKinds ?? null,
        selfCaughtCount: s.selfCaughtCount ?? null,
        fastestCatch: record(s.fastestCatch),
        averageCatchMs: s.averageCatchMs ?? null,
        oldestCaughtAt: s.oldestCaughtAt || null,
        mostActiveCatchDay: s.mostActiveCatchDay || null,
        mostActiveCatchCount: s.mostActiveCatchCount || 0,
        topCountries: (s.topCountries || []).slice(0, 5),
        topSpecials: (s.topSpecials || []).slice(0, 5),
    };
}

/** The profile as others see it, or null when it's private, hidden or never set up. `self` also returns private ones. */
async function getPublicProfile(userId, { self = false } = {}) {
    const stored = storedProfile(userId);
    if (!stored) return null;
    const settings = settingsOf(userId);
    if (settings.blocked && !self) return null;
    if (!settings.public && !self) return null;

    const user = getData().users[userId] || {};
    const showcase = settings.showcase.map((item) => findBall(item.dex, item.name)).filter(Boolean);
    const ballsdex = settings.showBallsdex ? await ballsdexOf(userId) : null;
    return {
        id: userId,
        ...discordOf(userId, stored),
        public: settings.public && !settings.blocked,
        blocked: Boolean(settings.blocked),
        bio: settings.bio,
        pronouns: settings.pronouns,
        accent: settings.accent,
        favoriteDex: settings.favoriteDex,
        showcase,
        identifyAmount: user.identifyAmount || 0,
        createdAt: settings.createdAt || null,
        updatedAt: settings.updatedAt || null,
        collections: settings.showCollections ? collectionsOf(userId) : null,
        ballsdex,
    };
}

/** Own settings for the editor. */
function getSettings(userId) {
    const settings = settingsOf(userId);
    return {
        settings: {
            public: settings.public,
            bio: settings.bio,
            pronouns: settings.pronouns,
            accent: settings.accent,
            favoriteDex: settings.favoriteDex,
            showcase: settings.showcase,
            showBallsdex: settings.showBallsdex,
            showCollections: settings.showCollections,
        },
        blocked: Boolean(settings.blocked),
        ballsdexLinked: isLinked(userId),
        limits: LIMITS,
        accents: ACCENTS,
    };
}

/* ----- Writing ----- */

const cleanDiscord = (discord) =>
    discord && typeof discord === "object"
        ? {
              name: cleanText(discord.displayName || discord.name, 64) || null,
              username: cleanText(discord.username, 40) || null,
              avatarUrl: /^https:\/\/cdn\.discordapp\.com\//.test(String(discord.avatarUrl || "")) ? String(discord.avatarUrl).slice(0, 300) : null,
          }
        : null;

function saveSettings(userId, input, discord) {
    const changes = validate(input || {});
    const snapshot = cleanDiscord(discord);
    const now = new Date().toISOString();
    const result = updateData((data) => {
        const user = (data.users[userId] ??= {});
        const current = user.profile || {};
        if (current.blocked && changes.public) throw httpError(403, "This profile was hidden by the BallIdentifier owner.", "PROFILE_BLOCKED");
        user.profile = { ...DEFAULTS, ...current, ...changes, createdAt: current.createdAt || now, updatedAt: now };
        if (snapshot) user.profile.discord = snapshot;
        return user.profile;
    });
    return { ...getSettings(userId), saved: result.updatedAt };
}

/** Owner only: hide a profile (can't be made public again) or let it be public again. */
function moderate(targetId, action) {
    if (!["hide", "unhide", "clear-bio"].includes(action)) throw httpError(400, "Unknown action.");
    return updateData((data) => {
        const profile = data.users[targetId]?.profile;
        if (!profile) throw httpError(404, "This user has no profile.");
        if (action === "hide") Object.assign(profile, { blocked: true, public: false });
        if (action === "unhide") delete profile.blocked;
        if (action === "clear-bio") Object.assign(profile, { bio: "", pronouns: "" });
        profile.updatedAt = new Date().toISOString();
        return { blocked: Boolean(profile.blocked), public: Boolean(profile.public) };
    });
}

/* ----- Search ----- */

function searchProfiles(query = "") {
    const q = cleanText(query, 40).toLowerCase().replace(/^@/, "");
    const counts = collectorStore.collectionCounts();
    const results = [];
    for (const [userId, user] of Object.entries(getData().users)) {
        const profile = user?.profile;
        if (!profile?.public || profile.blocked) continue;
        const discord = discordOf(userId, profile);
        if (q && !(discord.name || "").toLowerCase().includes(q) && !(discord.username || "").toLowerCase().includes(q) && userId !== q) continue;
        results.push({
            id: userId,
            ...discord,
            pronouns: profile.pronouns || "",
            bio: (profile.bio || "").split("\n")[0].slice(0, 140),
            accent: profile.accent || "violet",
            favoriteDex: profile.favoriteDex || null,
            collections: counts.get(userId) || 0,
            updatedAt: profile.updatedAt || null,
        });
    }
    results.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return { total: results.length, users: results.slice(0, LIMITS.search) };
}

const isPublic = (userId) => {
    const profile = storedProfile(userId);
    return Boolean(profile?.public && !profile.blocked);
};

module.exports = { setClient, getPublicProfile, getSettings, saveSettings, moderate, searchProfiles, isPublic, ACCENTS };
