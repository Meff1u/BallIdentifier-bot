/**
 * Discord logging. Every log goes to a thread of the log channel (LOG_CHANNEL_ID), one thread per
 * category, created by the bot when missing. Text logs are batched (every 2 min or 20 lines);
 * errors and embeds (identify logs) are sent right away. The console only gets errors and
 * a few important lines (startup, shutdown, logging failures).
 */

const { EmbedBuilder, ChannelType } = require("discord.js");
const { LOG_CHANNEL_ID } = require("./constants");

const CATEGORIES = {
    COMMANDS: { name: "Commands", color: 0x7289da }, // slash / context command usage
    IDENTIFY: { name: "Identify", color: 0x6839a6 }, // Identify results (embeds)
    NOTIFIER: { name: "Notifier", color: 0x9966ff }, // spawn notifier results
    API: { name: "API", color: 0x2ecc71 }, // website <-> bot API
    BALLSDEX: { name: "Ballsdex", color: 0xa020f0 }, // linking, syncs
    COLLECTORS: { name: "Collectors", color: 0xe67e22 }, // collector entries added/removed
    VOTES: { name: "Votes", color: 0x00c853 }, // upvotes and reminders
    CATCHES: { name: "Catches", color: 0x3498db }, // Ballsdex catch messages
    SYSTEM: { name: "System", color: 0xf39c12 }, // startup, data refresh, database, reports
    ERRORS: { name: "Errors", color: 0xff0000 }, // errors and crashes
};
// Old category names still used in a few places
const ALIASES = { DISCORD: "COMMANDS", IMAGE: "NOTIFIER", GENERAL: "SYSTEM" };

const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 2 * 60 * 1000;

const logBatches = new Map(Object.keys(CATEGORIES).map((category) => [category, []]));
const batchTimers = new Map();
const threadIds = new Map(); // category -> thread id
const threadLookups = new Map(); // category -> pending Promise<thread>
let warnedChannel = false;
// Last lines of every category, kept in memory for the owner's Moderation page on the website
const RECENT_LIMIT = 50;
const recentLogs = new Map(Object.keys(CATEGORIES).map((category) => [category, []]));

function remember(category, text) {
    const list = recentLogs.get(category);
    list.unshift({ at: new Date().toISOString(), text: String(text).slice(0, 600) });
    list.length = Math.min(list.length, RECENT_LIMIT);
}

/** { category: [{ at, text }] } newest first, for the given categories (all by default). */
function getRecentLogs(categories = Object.keys(CATEGORIES)) {
    return Object.fromEntries(categories.filter((category) => recentLogs.has(category)).map((category) => [category, recentLogs.get(category)]));
}

function getTimestamp() {
    return new Date().toLocaleString("pl-PL", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

const resolveCategory = (category) => (CATEGORIES[category] ? category : ALIASES[category] || "SYSTEM");

/** The category's thread in the log channel: found by name (active or archived) or created. */
async function getThread(client, category) {
    if (!client?.isReady?.()) return null;
    if (threadLookups.has(category)) return threadLookups.get(category);

    const lookup = (async () => {
        const known = threadIds.get(category);
        if (known) {
            const thread = await client.channels.fetch(known).catch(() => null);
            if (thread) return thread;
            threadIds.delete(category);
        }

        const channel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
        if (!channel?.threads) {
            if (!warnedChannel) console.error(`[LOGGER] Log channel ${LOG_CHANNEL_ID} not found or has no threads. Logs are kept until it's reachable.`);
            warnedChannel = true;
            return null;
        }

        const name = `${CATEGORIES[category].name} logs`;
        const active = await channel.threads.fetchActive().catch(() => null);
        let thread = active?.threads.find((t) => t.parentId === channel.id && t.name === name);
        if (!thread) {
            const archived = await channel.threads.fetchArchived({ limit: 100 }).catch(() => null);
            thread = archived?.threads.find((t) => t.name === name);
        }
        if (!thread) {
            thread = await channel.threads.create({
                name,
                type: ChannelType.PublicThread,
                autoArchiveDuration: 10080, // a week; sending a message reopens it anyway
                reason: "BallIdentifier logs",
            });
        }
        if (thread.archived) await thread.setArchived(false).catch(() => {});
        threadIds.set(category, thread.id);
        return thread;
    })()
        .catch((error) => {
            console.error(`[LOGGER] Couldn't open the ${category} log thread:`, error.message);
            return null;
        })
        .finally(() => threadLookups.delete(category));

    threadLookups.set(category, lookup);
    return lookup;
}

/** Add a text log line; it's sent with the next batch of its category. */
function addLog(category, message, client) {
    category = resolveCategory(category);
    remember(category, message);
    const batch = logBatches.get(category);
    // Discord timestamp: shown in each reader's own time zone
    batch.push(`<t:${Math.floor(Date.now() / 1000)}:T> ${message}`);

    if (batch.length >= BATCH_SIZE) {
        sendBatch(category, client);
    } else if (!batchTimers.has(category)) {
        batchTimers.set(category, setTimeout(() => sendBatch(category, client), BATCH_DELAY_MS));
    }
}

async function sendBatch(category, client) {
    const batch = logBatches.get(category) || [];
    logBatches.set(category, []);
    clearTimeout(batchTimers.get(category));
    batchTimers.delete(category);
    if (!batch.length) return;

    const thread = await getThread(client, category);
    if (!thread) {
        // Not ready yet (startup) or no log channel: keep the lines for the next try, capped
        logBatches.set(category, [...batch, ...logBatches.get(category)].slice(-200));
        if (!batchTimers.has(category)) batchTimers.set(category, setTimeout(() => sendBatch(category, client), BATCH_DELAY_MS));
        return;
    }

    // Plain text (no code block), so mentions, channels and links render; ~3900 characters per embed
    const chunks = [];
    let current = "";
    for (const line of batch) {
        const safe = line.slice(0, 1800);
        if (current && (current + safe + "\n").length > 3900) {
            chunks.push(current);
            current = "";
        }
        current += safe + "\n";
    }
    if (current) chunks.push(current);

    try {
        for (const chunk of chunks) {
            const embed = new EmbedBuilder()
                .setDescription(chunk.trim())
                .setColor(CATEGORIES[category].color)
                .setTimestamp();
            await thread.send({ embeds: [embed], allowedMentions: { parse: [] } });
        }
    } catch (error) {
        console.error(`[LOGGER] Couldn't send ${category} logs:`, error.message);
        threadIds.delete(category);
    }
}

/** Send an embed (or embed data) to a category thread right away. */
async function logEmbed(category, embed, client) {
    category = resolveCategory(category);
    const thread = await getThread(client, category);
    if (!thread) return false;
    try {
        await thread.send({ embeds: [embed], allowedMentions: { parse: [] } });
        return true;
    } catch (error) {
        console.error(`[LOGGER] Couldn't send ${category} embed:`, error.message);
        threadIds.delete(category);
        return false;
    }
}

/** An error: always to the console (short), and to the Errors thread with details. */
async function logError(title, detail, client) {
    const text = detail instanceof Error ? detail.stack || detail.message : String(detail ?? "");
    console.error(`[ERROR] ${title}${text ? `: ${text.split("\n")[0]}` : ""}`);
    remember("ERRORS", `${title}${text ? `: ${text.split("\n")[0]}` : ""}`);
    const embed = new EmbedBuilder()
        .setTitle(String(title).slice(0, 256))
        .setDescription(text ? `\`\`\`\n${text.replace(/```/g, "ˋˋˋ").slice(0, 3900)}\n\`\`\`` : null)
        .setColor(CATEGORIES.ERRORS.color)
        .setTimestamp();
    return logEmbed("ERRORS", embed, client);
}

async function flushAllBatches(client) {
    for (const category of logBatches.keys()) await sendBatch(category, client);
}

function clearAllBatches() {
    for (const timer of batchTimers.values()) clearTimeout(timer);
    batchTimers.clear();
    for (const category of logBatches.keys()) logBatches.set(category, []);
}

function getBatchSizes() {
    return Object.fromEntries([...logBatches].map(([category, batch]) => [category, batch.length]));
}

module.exports = {
    CATEGORIES,
    addLog,
    getRecentLogs,
    logEmbed,
    logError,
    sendBatch,
    flushAllBatches,
    clearAllBatches,
    getBatchSizes,
    getTimestamp,
};
