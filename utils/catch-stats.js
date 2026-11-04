/**
 * Catch stats (Ballsdex only): on servers where an admin turned it on (website: Bot -> Catch stats), every catch of a
 * Ballsdex spawn is timed (spawn message -> catch message) and saved for the catcher. The bot answers
 * with the time, averages and records (what it says is set per server).
 *
 * Privacy: everyone on an enabled server is tracked unless they opt out ("Don't track me" button,
 * /catchstats settings or the website). Opting out deletes their catch data. Stats are private by
 * default; only users who make them public appear in rankings or on their profile.
 *
 * Storage (MongoDB), three separate things:
 *   history  catchEvents: one per catch, deleted after 35 days (TTL). Every number shown (averages, counts,
 *            rankings, the profile's "Recent Catch Stats") is computed from the last 30 days of it; nothing
 *            is totalled over a longer time.
 *   records  catchStats (per user: best / bestMs with the date it was set, balls.<key>.bestMs + bestAt) and
 *            catchGuilds (best = the server record with its date). Kept until the user opts out; the 35-day
 *            cleanup of the history never touches them. Old documents still hold unused all-time counters
 *            (count, totalMs, balls.<key>.count/totalMs, guilds): they are no longer read or updated.
 * Settings live in data.json:
 * users[id].catchStats = { public, tracking }, guilds[id].catchStats = { enabled, mode, lines, ... }.
 * How catch messages are recognized: utils/catch-phrases.js (phrases are set per dex on the website)
 */

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, SnowflakeUtil } = require("discord.js");
const { getData, updateData, getSpawnMessageData } = require("./helpers");
const { getDatabase } = require("./database");
const { BOT_DATA_KEYS, BOT_NAMES, DEX_NAME_BY_KEY, SUPPORTED_BOT_IDS } = require("./constants");
const { rulesFor, CATCH_STATS_BOTS } = require("./catch-phrases");

const MAX_CATCH_MS = 60 * 60 * 1000; // slower than an hour isn't a reaction time (the spawn sat there)
const EVENT_TTL_SEC = 35 * 24 * 60 * 60;
const SPAWN_MEMORY_MS = 2 * 60 * 60 * 1000;
const PERIODS = { "30d": 30, "7d": 7 };
const STATS_DAYS = 30; // the window every shown number covers
const MIN_FOR_AVERAGE = { "30d": 10, "7d": 5 }; // catches needed to be ranked by average
const LINES = ["average", "ballAverage", "best", "serverRank"];
const DEFAULT_GUILD = { enabled: false, mode: "every", lines: { average: true, ballAverage: true, best: true, serverRank: false } };
const DEFAULT_USER = { public: false, tracking: true };

let client = null;
const spawns = new Map(); // spawn message id -> { at, botId } (spawns seen on enabled servers)
const handled = new Set(); // catch message ids already counted (create + edit events)
const replyErrors = new Set(); // channel:error already reported (one log per channel and error)

/* ----- Settings ----- */

function guildConfig(guildId) {
    const stored = getData().guilds[guildId]?.catchStats || {};
    return { ...DEFAULT_GUILD, ...stored, lines: { ...DEFAULT_GUILD.lines, ...(stored.lines || {}) } };
}

function userSettings(userId) {
    return { ...DEFAULT_USER, ...(getData().users[userId]?.catchStats || {}) };
}

function setGuildConfig(guildId, input, setupBy) {
    const config = guildConfig(guildId);
    if (typeof input.enabled === "boolean") config.enabled = input.enabled;
    if (input.mode !== undefined) {
        if (!["every", "records"].includes(input.mode)) throw Object.assign(new Error("Unknown mode"), { status: 400 });
        config.mode = input.mode;
    }
    if (input.lines && typeof input.lines === "object") {
        for (const key of LINES) if (typeof input.lines[key] === "boolean") config.lines[key] = input.lines[key];
    }
    updateData((data) => {
        data.guilds[guildId] ??= {};
        data.guilds[guildId].catchStats = { ...config, setupBy: setupBy || null, updatedAt: Date.now() };
    });
    return guildConfig(guildId);
}

/** { public, tracking }. Turning tracking off deletes the user's catch data. */
async function setUserSettings(userId, input) {
    const current = userSettings(userId);
    const next = { ...current };
    if (typeof input.public === "boolean") next.public = input.public;
    if (typeof input.tracking === "boolean") next.tracking = input.tracking;
    updateData((data) => {
        data.users[userId] ??= {};
        data.users[userId].catchStats = next;
    });
    if (current.tracking && !next.tracking) await deleteUserData(userId);
    return next;
}

async function deleteUserData(userId) {
    const db = await getDatabase();
    await Promise.all([db.collection("catchEvents").deleteMany({ userId }), db.collection("catchStats").deleteOne({ _id: userId })]);
    // Server records held by this user are cleared too
    await db.collection("catchGuilds").updateMany({ "best.userId": userId }, { $unset: { best: "" } });
}

const publicUserIds = () =>
    Object.entries(getData().users)
        .filter(([, user]) => user?.catchStats?.public && user.catchStats.tracking !== false)
        .map(([id]) => id);

/* ----- Detection ----- */

const ballKey = (dexKey, ball) => `${dexKey}:${encodeURIComponent(ball).replace(/\./g, "%2E")}`;
const DEX_NAMES = DEX_NAME_BY_KEY;

function messageText(message) {
    const parts = [message.content || ""];
    // Components v2 messages keep their text in text displays
    const walk = (components) => {
        for (const component of components || []) {
            if (typeof component.content === "string") parts.push(component.content);
            walk(component.components);
            if (component.accessory) walk([component.accessory]);
        }
    };
    walk(message.components);
    return parts
        .join("\n")
        .split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith(">"))
        .join("\n");
}

/**
 * The spawn a catch answers. A catch is the dex bot's answer to the "Catch me!" button (via its name modal),
 * so Discord links it to the spawn as a reply and/or in its interaction data.
 */
function spawnIdOf(message) {
    const meta = message.interactionMetadata;
    return message.reference?.messageId || meta?.interactedMessageId || meta?.triggeringInteractionMetadata?.interactedMessageId || null;
}

/** null: not a catch message. { skip }: looks like a catch but can't be used. Otherwise the catch. */
function parseCatch(message) {
    const rules = rulesFor(message.author?.id);
    if (!rules) return null;
    const text = messageText(message);
    const lower = text.toLowerCase();
    if (!rules.phrases.some((phrase) => lower.includes(phrase.toLowerCase()))) return null;
    if ((rules.ignore || []).some((phrase) => lower.includes(phrase.toLowerCase()))) return null;
    const userId = rules.user.exec(text)?.[1] || message.interactionMetadata?.user?.id;
    const ball = rules.ball.exec(text)?.[1]?.replace(/[!?.]+$/, "").trim();
    if (!userId || !ball) return { skip: `couldn't read the ${userId ? "ball" : "catcher"} (check utils/catch-phrases.js)` };
    const spawnId = spawnIdOf(message);
    if (!spawnId) return message.interactionMetadata ? { skip: `no link to the spawn message (type ${message.type})` } : null;
    return { userId, ball, spawnId };
}

const noted = new Set();
function noteOnce(key, log) {
    if (noted.has(key)) return;
    noted.add(key);
    log();
}

/** Catch stats activity in the Catches log channel (own log thread, separate from Catches). */
function trace(message, text) {
    client?.log?.("CATCH_STATS", `⏱️ [${message.guild?.name || message.guildId}] ${text}`);
}

function rememberSpawn(message) {
    const now = Date.now();
    spawns.set(message.id, { at: message.createdTimestamp, botId: message.author.id });
    if (spawns.size > 2000) for (const [id, spawn] of spawns) if (now - spawn.at > SPAWN_MEMORY_MS) spawns.delete(id);
}

async function isSpawnOf(message, spawnId) {
    const known = spawns.get(spawnId);
    if (known) return known.botId === message.author.id;
    // Not seen (e.g. after a restart): look at the message itself
    try {
        const spawn = await message.channel.messages.fetch(spawnId);
        return spawn.author?.id === message.author.id && getSpawnMessageData(spawn).isSpawn;
    } catch {
        return false;
    }
}

/*
 * Ballsdex answers a catch after "thinking": the message is created empty (a loading reply) and gets its
 * text by an edit. The edit normally comes as a messageUpdate; in case it doesn't, the message is read
 * again a few seconds later (at most twice).
 */
const RECHECK_DELAYS_MS = [3000, 10000];
const rechecks = new Map(); // message id -> tries so far

function scheduleRecheck(message) {
    const tries = rechecks.get(message.id) || 0;
    if (tries >= RECHECK_DELAYS_MS.length) return rechecks.delete(message.id);
    rechecks.set(message.id, tries + 1);
    if (rechecks.size > 500) rechecks.delete(rechecks.keys().next().value);
    setTimeout(async () => {
        if (handled.has(message.id)) return rechecks.delete(message.id);
        try {
            const fresh = await message.channel.messages.fetch({ message: message.id, force: true });
            observe(fresh);
        } catch {
            rechecks.delete(message.id); // deleted, or no access
        }
    }, RECHECK_DELAYS_MS[tries]);
}

/** Called for every new or edited message of a dex bot. */
async function observe(message) {
    try {
        if (!message.guildId) return;
        if (!rulesFor(message.author?.id)) {
            if (CATCH_STATS_BOTS.includes(message.author?.id)) noteOnce(`rules:${message.author.id}`, () => trace(message, `No catch rules for ${BOT_NAMES[message.author.id]} (dex list)`));
            return;
        }
        if (!guildConfig(message.guildId).enabled) return;
        if (getSpawnMessageData(message).isSpawn) return rememberSpawn(message);

        const found = parseCatch(message);
        if (!found) {
            // An empty answer to a spawn: Ballsdex is still "thinking", its text comes later
            if (!messageText(message).trim() && message.interactionMetadata && spawnIdOf(message) && !handled.has(message.id)) scheduleRecheck(message);
            return;
        }
        rechecks.delete(message.id);
        if (handled.has(message.id)) return;
        handled.add(message.id);
        if (handled.size > 5000) handled.delete(handled.values().next().value);
        if (found.skip) return trace(message, `Catch not counted: ${found.skip}`);

        if (!userSettings(found.userId).tracking) return noteOnce(`user:${found.userId}`, () => trace(message, `Catch of <@${found.userId}> not counted: they turned tracking off`));
        if (!(await isSpawnOf(message, found.spawnId))) return trace(message, `Catch of ${found.ball} not counted: the message it answers isn't a ${BOT_NAMES[message.author.id] || "dex"} spawn`);

        // Both times come from Discord's message IDs: spawn sent -> catch answered
        const ms = Number(SnowflakeUtil.timestampFrom(message.id) - SnowflakeUtil.timestampFrom(found.spawnId));
        if (!(ms > 0 && ms <= MAX_CATCH_MS)) return trace(message, `Catch of ${found.ball} not counted: ${formatMs(ms)} is out of range`);

        const dexKey = BOT_DATA_KEYS[message.author.id];
        const result = await record({ userId: found.userId, guildId: message.guildId, dexKey, ball: found.ball, ms });
        trace(message, `<@${found.userId}> caught ${found.ball} in ${formatMs(ms)} (${result.count} tracked)`);
        await reply(message, found, result);
    } catch (error) {
        client?.logError?.("Catch stats failed", error);
    }
}

/* ----- Storage ----- */

let indexesReady = null;
async function collections() {
    const db = await getDatabase();
    indexesReady ??= Promise.all([
        db.collection("catchEvents").createIndex({ at: 1 }, { expireAfterSeconds: EVENT_TTL_SEC }),
        db.collection("catchEvents").createIndex({ userId: 1, at: -1 }),
        db.collection("catchEvents").createIndex({ guildId: 1, at: -1 }),
    ]).catch((error) => {
        indexesReady = null;
        throw error;
    });
    await indexesReady;
    return { events: db.collection("catchEvents"), stats: db.collection("catchStats"), guilds: db.collection("catchGuilds") };
}

/**
 * Saves one catch and says what it changed. The catch goes into the history (catchEvents); the permanent
 * records (personal, per ball, server) are only touched when this catch beats them, and keep the date.
 * Averages and counts in the result are the last 30 days, worked out from the history.
 */
async function record({ userId, guildId, dexKey, ball, ms }) {
    const { events, stats, guilds } = await collections();
    const key = ballKey(dexKey, ball);
    const at = new Date();
    const [before, guildBefore] = await Promise.all([stats.findOne({ _id: userId }), guilds.findOne({ _id: guildId })]);
    const hadRecord = Number.isFinite(before?.bestMs);
    const ballBest = before?.balls?.[key]?.bestMs;
    const guildBest = guildBefore?.best?.ms;

    const personalRecord = hadRecord && ms < before.bestMs;
    const ballRecord = Number.isFinite(ballBest) && ms < ballBest;
    const serverRecord = Number.isFinite(guildBest) && ms < guildBest;

    const update = { $set: { updatedAt: at }, $setOnInsert: { firstAt: at } };
    if (!hadRecord || ms < before.bestMs) {
        update.$set.bestMs = ms;
        update.$set.best = { ms, ball, dexKey, guildId, at };
    }
    if (!Number.isFinite(ballBest) || ms < ballBest) {
        update.$set[`balls.${key}.bestMs`] = ms;
        update.$set[`balls.${key}.bestAt`] = at;
    }

    await events.insertOne({ userId, guildId, dexKey, ball, ms, at });
    const [month, ballMonth] = await Promise.all([
        windowRows(userId, STATS_DAYS).then(totalsOf),
        windowRows(userId, STATS_DAYS, { dexKey, ball }).then(totalsOf),
        stats.updateOne({ _id: userId }, update, { upsert: true }),
        !Number.isFinite(guildBest) || ms < guildBest ? guilds.updateOne({ _id: guildId }, { $set: { best: { ms, userId, ball, dexKey, at } } }, { upsert: true }) : null,
    ]);

    return {
        ms,
        count: month.count,
        averageMs: month.averageMs,
        bestMs: Math.min(before?.bestMs ?? ms, ms),
        previousBestMs: hadRecord ? before.bestMs : null,
        best: !hadRecord || ms < before.bestMs ? { ms, ball } : before.best,
        ball: { count: ballMonth.count, averageMs: ballMonth.averageMs, bestMs: Math.min(ballBest ?? ms, ms) },
        personalRecord,
        ballRecord,
        serverRecord,
        firstCatch: !hadRecord,
    };
}

/* ----- Reply in the channel ----- */

const formatMs = (ms) => {
    if (!Number.isFinite(ms)) return "—";
    if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 3 : 2)}s`;
    const minutes = Math.floor(ms / 60000);
    return `${minutes}m ${((ms % 60000) / 1000).toFixed(1)}s`;
};

async function serverRank(guildId, userId) {
    const { events } = await collections();
    const rows = await events
        .aggregate([
            { $match: { guildId, at: { $gte: new Date(Date.now() - 30 * 86400000) } } },
            { $group: { _id: "$userId", count: { $sum: 1 }, avg: { $avg: "$ms" } } },
            { $match: { count: { $gte: MIN_FOR_AVERAGE["30d"] } } },
            { $sort: { avg: 1 } },
        ])
        .toArray();
    const index = rows.findIndex((row) => row._id === userId);
    return index >= 0 ? { rank: index + 1, of: rows.length } : null;
}

const buttons = () =>
    new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("catchstats:me").setLabel("My stats").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("catchstats:optout").setLabel("Don't track me").setStyle(ButtonStyle.Secondary),
    );

async function reply(message, found, result) {
    const config = guildConfig(message.guildId);
    const isRecord = result.personalRecord || result.serverRecord || result.ballRecord;
    if (config.mode === "records" && !isRecord) return;

    const lines = [];
    const head = `⏱️ <@${found.userId}> caught **${found.ball}** in **${formatMs(result.ms)}**`;
    if (result.serverRecord) lines.push(`${head}\n🏆 **New server record!**`);
    else if (result.personalRecord) lines.push(`${head}\n🥇 **New personal record!** (was ${formatMs(result.previousBestMs)})`);
    else lines.push(head);
    if (result.ballRecord && !result.personalRecord && !result.serverRecord) lines.push(`🎯 Your fastest ${found.ball} yet`);

    const stats = [];
    if (config.lines.average && result.count > 1) stats.push(`avg ${formatMs(result.averageMs)} (${result.count.toLocaleString("en-US")} catches, 30 days)`);
    if (config.lines.ballAverage && result.ball.count > 1) stats.push(`${found.ball}: avg ${formatMs(result.ball.averageMs)} (30 days), best ${formatMs(result.ball.bestMs)}`);
    if (config.lines.best && !result.personalRecord && !result.firstCatch && result.best) stats.push(`best ${formatMs(result.best.ms)} (${result.best.ball})`);
    if (config.lines.serverRank) {
        const rank = await serverRank(message.guildId, found.userId).catch(() => null);
        if (rank) stats.push(`#${rank.rank} of ${rank.of} on this server (30 days)`);
    }
    if (stats.length) lines.push(`-# ${stats.join(" · ")}`);
    if (result.firstCatch) lines.push("-# First catch tracked here. Stats are private unless you make them public: /catchstats settings");

    // Stats are saved even when the bot can't answer there (missing Send Messages / Read Message History)
    await message.reply({ content: lines.join("\n").slice(0, 1900), components: [buttons()], allowedMentions: { parse: [] } }).catch((error) => {
        const key = `${message.channelId}:${error.code}`;
        if (replyErrors.has(key)) return;
        replyErrors.add(key);
        client?.logError?.("Catch stats reply failed", `${message.guild?.name || message.guildId} <#${message.channelId}>: ${error.message}`);
    });
}

/* ----- Reading ----- */

/** The user's catches of the last `days` days grouped by ball (from the history): [{ _id: { dexKey, ball }, count, totalMs, bestMs }]. */
async function windowRows(userId, days, { dexKey = null, ball = null } = {}) {
    const { events } = await collections();
    const match = { userId, at: { $gte: new Date(Date.now() - days * 86400000) } };
    if (dexKey && ball) Object.assign(match, { dexKey, ball });
    return events.aggregate([{ $match: match }, { $group: { _id: { dexKey: "$dexKey", ball: "$ball" }, count: { $sum: 1 }, totalMs: { $sum: "$ms" }, bestMs: { $min: "$ms" } } }]).toArray();
}

function totalsOf(rows) {
    const count = rows.reduce((sum, row) => sum + row.count, 0);
    if (!count) return { count: 0, averageMs: null, bestMs: null };
    return { count, averageMs: Math.round(rows.reduce((sum, row) => sum + row.totalMs, 0) / count), bestMs: Math.min(...rows.map((row) => row.bestMs)) };
}

/** Last 30 days in detail (profile, website, command): totals, fastest ball and the ball lists. */
function summarizeWindow(rows) {
    const balls = rows.map((row) => ({ dexKey: row._id.dexKey, dex: DEX_NAMES[row._id.dexKey] || row._id.dexKey, ball: row._id.ball, count: row.count, averageMs: Math.round(row.totalMs / row.count), bestMs: row.bestMs }));
    const fastest = [...balls].sort((a, b) => a.bestMs - b.bestMs)[0];
    return {
        ...totalsOf(rows),
        bestBall: fastest ? { ball: fastest.ball, dex: fastest.dex } : null,
        uniqueBalls: balls.length,
        fastestBalls: balls.filter((b) => b.count >= 3).sort((a, b) => a.averageMs - b.averageMs).slice(0, 5),
        mostCaught: [...balls].sort((a, b) => b.count - a.count).slice(0, 5),
    };
}

/** The permanent personal record with the date it was set. */
function recordsOf(doc) {
    const best = doc?.best;
    return { personal: best ? { ms: best.ms, ball: best.ball, dex: DEX_NAMES[best.dexKey] || best.dexKey, at: best.at || null } : null };
}

/** The permanent record of a server (fastest catch there) with its date, or null. */
async function getServerRecord(guildId) {
    const { guilds } = await collections();
    const best = (await guilds.findOne({ _id: guildId }))?.best;
    return best ? { ms: best.ms, userId: best.userId, ball: best.ball, dex: DEX_NAMES[best.dexKey] || best.dexKey, at: best.at || null } : null;
}

/** Everything about one user: the last 30 / 7 days (from the history) and the permanent records. */
async function getUserStats(userId) {
    const { stats } = await collections();
    const [doc, rows30, rows7] = await Promise.all([stats.findOne({ _id: userId }), windowRows(userId, STATS_DAYS), windowRows(userId, 7)]);
    return { settings: userSettings(userId), last30: summarizeWindow(rows30), last7: totalsOf(rows7), records: recordsOf(doc) };
}

/** Rankings of users with public catch stats over the last 30 or 7 days: fastest single catch and best average. */
async function leaderboard({ period = "30d", guildId = null, limit = 10 } = {}) {
    if (!Object.hasOwn(PERIODS, period)) period = "30d";
    const ids = publicUserIds();
    const minCount = MIN_FOR_AVERAGE[period];
    if (!ids.length) return { period, guildId, minCount, fastest: [], average: [] };
    const { events } = await collections();

    const match = { userId: { $in: ids }, at: { $gte: new Date(Date.now() - PERIODS[period] * 86400000) } };
    if (guildId) match.guildId = guildId;
    const rows = (await events.aggregate([{ $match: match }, { $sort: { ms: 1 } }, { $group: { _id: "$userId", count: { $sum: 1 }, avg: { $avg: "$ms" }, best: { $first: "$ms" }, bestBall: { $first: "$ball" } } }]).toArray()).map((row) => ({
        userId: row._id,
        count: row.count,
        averageMs: Math.round(row.avg),
        bestMs: row.best,
        best: { ball: row.bestBall },
    }));

    const people = require("./collector-store");
    const withPerson = (row) => {
        const profile = people.getDiscordProfile(row.userId);
        const site = getData().users[row.userId]?.profile;
        return {
            ...row,
            name: profile?.name || profile?.username || site?.discord?.name || null,
            username: profile?.username || site?.discord?.username || null,
            avatarUrl: profile?.avatarUrl || site?.discord?.avatarUrl || people.defaultAvatar(row.userId),
            hasProfile: Boolean(site?.public && !site.blocked),
        };
    };
    return {
        period,
        guildId,
        minCount,
        fastest: [...rows].sort((a, b) => a.bestMs - b.bestMs).slice(0, limit).map(withPerson),
        average: rows.filter((row) => row.count >= minCount).sort((a, b) => a.averageMs - b.averageMs).slice(0, limit).map(withPerson),
    };
}

/** Catch stats config of several servers (website server list). */
function guildConfigs(guildIds) {
    return Object.fromEntries(guildIds.map((id) => [id, guildConfig(id)]));
}

module.exports = {
    setClient: (discordClient) => {
        client = discordClient;
        const on = Object.entries(getData().guilds || {}).filter(([, guild]) => guild?.catchStats?.enabled);
        client?.log?.("CATCH_STATS", `⏱️ Catch stats ready: on in ${on.length} server(s)${on.length ? ` (${on.map(([id]) => client.guilds?.cache.get(id)?.name || id).join(", ")})` : ""}`);
    },
    observe,
    record,
    parseCatch,
    formatMs,
    guildConfig,
    guildConfigs,
    setGuildConfig,
    userSettings,
    setUserSettings,
    getUserStats,
    getServerRecord,
    leaderboard,
    PERIODS,
    LINES,
};
