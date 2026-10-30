/**
 * Catch stats: on servers where an admin turned it on (website: Bot -> Catch stats), every catch of a
 * dex bot's spawn is timed (spawn message -> catch message) and saved for the catcher. The bot answers
 * with the time, averages and records (what it says is set per server).
 *
 * Privacy: everyone on an enabled server is tracked unless they opt out ("Don't track me" button,
 * /catchstats settings or the website). Opting out deletes their catch data. Stats are private by
 * default; only users who make them public appear in rankings or on their profile.
 *
 * Storage (MongoDB): catchEvents (one per catch, kept 35 days, for 7/30-day numbers),
 * catchStats (per-user all-time totals), catchGuilds (server records). Settings live in data.json:
 * users[id].catchStats = { public, tracking }, guilds[id].catchStats = { enabled, mode, lines, ... }.
 * How catch messages are recognized: utils/catch-phrases.js (phrases are set per dex on the website)
 */

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, SnowflakeUtil } = require("discord.js");
const { getData, updateData, getSpawnMessageData } = require("./helpers");
const { getDatabase } = require("./database");
const { BOT_DATA_KEYS, BOT_NAMES, DEX_NAME_BY_KEY } = require("./constants");
const { rulesFor } = require("./catch-phrases");

const MAX_CATCH_MS = 60 * 60 * 1000; // slower than an hour isn't a reaction time (the spawn sat there)
const EVENT_TTL_SEC = 35 * 24 * 60 * 60;
const SPAWN_MEMORY_MS = 2 * 60 * 60 * 1000;
const PERIODS = { all: null, "30d": 30, "7d": 7 };
const MIN_FOR_AVERAGE = { all: 20, "30d": 10, "7d": 5 }; // catches needed to be ranked by average
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
const decodeBallKey = (key) => {
    const [dexKey, ...rest] = key.split(":");
    return { dexKey, ball: decodeURIComponent(rest.join(":")) };
};
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

/** Catch stats activity in the Catches log channel (helps checking the catch phrases). */
function trace(message, text) {
    client?.log?.("CATCHES", `⏱️ [${message.guild?.name || message.guildId}] ${text}`);
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

/** Called for every new or edited message of a dex bot. */
async function observe(message) {
    try {
        if (!message.guildId || !rulesFor(message.author?.id)) return;
        const enabled = guildConfig(message.guildId).enabled;
        if (getSpawnMessageData(message).isSpawn) return enabled ? rememberSpawn(message) : undefined;

        const found = parseCatch(message);
        if (!found) return;
        // Once per server and run: says why nothing happens there (helps when it "doesn't work")
        if (!enabled) return noteOnce(`off:${message.guildId}`, () => trace(message, "A catch was seen, but Catch stats are off on this server (no data saved)"));
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

/** Saves one catch and says what it changed (records, averages). */
async function record({ userId, guildId, dexKey, ball, ms }) {
    const { events, stats, guilds } = await collections();
    const key = ballKey(dexKey, ball);
    const at = new Date();
    const before = (await stats.findOne({ _id: userId })) || { count: 0, totalMs: 0, balls: {}, guilds: {} };
    const ballBefore = before.balls?.[key] || { count: 0, totalMs: 0 };
    const guildBefore = (await guilds.findOne({ _id: guildId })) || {};

    const personalRecord = before.count > 0 && ms < before.bestMs;
    const ballRecord = ballBefore.count > 0 && ms < ballBefore.bestMs;
    const serverRecord = Boolean(guildBefore.best) && ms < guildBefore.best.ms;

    const update = {
        $inc: { count: 1, totalMs: ms, [`balls.${key}.count`]: 1, [`balls.${key}.totalMs`]: ms, [`guilds.${guildId}.count`]: 1, [`guilds.${guildId}.totalMs`]: ms },
        $min: { bestMs: ms, [`balls.${key}.bestMs`]: ms, [`guilds.${guildId}.bestMs`]: ms },
        $set: { updatedAt: at },
        $setOnInsert: { firstAt: at },
    };
    if (!before.count || ms < before.bestMs) update.$set.best = { ms, ball, dexKey, guildId, at };

    // Worked out before writing, from the numbers as they were
    const result = {
        ms,
        count: before.count + 1,
        averageMs: Math.round((before.totalMs + ms) / (before.count + 1)),
        bestMs: Math.min(before.bestMs ?? ms, ms),
        previousBestMs: before.count ? before.bestMs : null,
        best: !before.count || ms < before.bestMs ? { ms, ball } : before.best,
        ball: { count: ballBefore.count + 1, averageMs: Math.round((ballBefore.totalMs + ms) / (ballBefore.count + 1)), bestMs: Math.min(ballBefore.bestMs ?? ms, ms) },
        personalRecord,
        ballRecord,
        serverRecord,
        firstCatch: before.count === 0,
    };

    await Promise.all([
        events.insertOne({ userId, guildId, dexKey, ball, ms, at }),
        stats.updateOne({ _id: userId }, update, { upsert: true }),
        !guildBefore.best || ms < guildBefore.best.ms ? guilds.updateOne({ _id: guildId }, { $set: { best: { ms, userId, ball, dexKey, at } } }, { upsert: true }) : null,
    ]);
    return result;
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
    if (config.lines.average && result.count > 1) stats.push(`avg ${formatMs(result.averageMs)} (${result.count.toLocaleString("en-US")} catches)`);
    if (config.lines.ballAverage && result.ball.count > 1) stats.push(`${found.ball}: avg ${formatMs(result.ball.averageMs)}, best ${formatMs(result.ball.bestMs)}`);
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

function summarize(doc) {
    if (!doc?.count) return null;
    const balls = Object.entries(doc.balls || {})
        .map(([key, value]) => ({ ...decodeBallKey(key), count: value.count, averageMs: Math.round(value.totalMs / value.count), bestMs: value.bestMs }))
        .map((entry) => ({ ...entry, dex: DEX_NAMES[entry.dexKey] || entry.dexKey }));
    return {
        count: doc.count,
        averageMs: Math.round(doc.totalMs / doc.count),
        bestMs: doc.bestMs,
        best: doc.best ? { ms: doc.best.ms, ball: doc.best.ball, dex: DEX_NAMES[doc.best.dexKey] || doc.best.dexKey, at: doc.best.at } : null,
        firstAt: doc.firstAt || null,
        updatedAt: doc.updatedAt || null,
        fastestBalls: balls.filter((b) => b.count >= 3).sort((a, b) => a.averageMs - b.averageMs).slice(0, 5),
        mostCaught: [...balls].sort((a, b) => b.count - a.count).slice(0, 5),
        uniqueBalls: balls.length,
    };
}

async function windowStats(userId, days) {
    const { events } = await collections();
    const [row] = await events
        .aggregate([
            { $match: { userId, at: { $gte: new Date(Date.now() - days * 86400000) } } },
            { $group: { _id: null, count: { $sum: 1 }, avg: { $avg: "$ms" }, best: { $min: "$ms" } } },
        ])
        .toArray();
    return row ? { count: row.count, averageMs: Math.round(row.avg), bestMs: row.best } : { count: 0, averageMs: null, bestMs: null };
}

/** Everything about one user (their own view; profiles use it only when public). */
async function getUserStats(userId) {
    const { stats } = await collections();
    const all = summarize(await stats.findOne({ _id: userId }));
    if (!all) return { settings: userSettings(userId), all: null };
    const [last30, last7] = await Promise.all([windowStats(userId, 30), windowStats(userId, 7)]);
    return { settings: userSettings(userId), all, last30, last7 };
}

/** Rankings of users with public catch stats: fastest single catch and best average. */
async function leaderboard({ period = "all", guildId = null, limit = 10 } = {}) {
    const days = PERIODS[period] ?? null;
    const ids = publicUserIds();
    const minCount = MIN_FOR_AVERAGE[period] || 5;
    if (!ids.length) return { period, guildId, minCount, fastest: [], average: [] };
    const { events, stats } = await collections();

    let rows;
    if (days || guildId) {
        const match = { userId: { $in: ids } };
        if (days) match.at = { $gte: new Date(Date.now() - days * 86400000) };
        if (guildId) match.guildId = guildId;
        if (!days && guildId) {
            // all time on one server: from the per-server totals
            rows = (await stats.find({ _id: { $in: ids }, [`guilds.${guildId}.count`]: { $gt: 0 } }).toArray()).map((doc) => {
                const g = doc.guilds[guildId];
                return { userId: doc._id, count: g.count, averageMs: Math.round(g.totalMs / g.count), bestMs: g.bestMs };
            });
        } else {
            rows = (
                await events
                    .aggregate([{ $match: match }, { $group: { _id: "$userId", count: { $sum: 1 }, avg: { $avg: "$ms" }, best: { $min: "$ms" } } }])
                    .toArray()
            ).map((row) => ({ userId: row._id, count: row.count, averageMs: Math.round(row.avg), bestMs: row.best }));
        }
    } else {
        rows = (await stats.find({ _id: { $in: ids }, count: { $gt: 0 } }).toArray()).map((doc) => ({ userId: doc._id, count: doc.count, averageMs: Math.round(doc.totalMs / doc.count), bestMs: doc.bestMs, best: doc.best }));
    }

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
            best: row.best ? { ms: row.best.ms, ball: row.best.ball } : undefined,
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
        client?.log?.("CATCHES", `⏱️ Catch stats ready: on in ${on.length} server(s)${on.length ? ` (${on.map(([id]) => client.guilds?.cache.get(id)?.name || id).join(", ")})` : ""}`);
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
    leaderboard,
    PERIODS,
    LINES,
};
