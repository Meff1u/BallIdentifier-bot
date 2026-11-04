/**
 * Messages from the website's contact form (suggestions, bug reports...). They are DMed to the owner.
 * One message per user every COOLDOWN_MS, remembered in data.json so a restart doesn't reset it.
 */

const { EmbedBuilder } = require("discord.js");
const { getData, updateData } = require("./helpers");
const { ADMIN_ID } = require("./constants");

const COOLDOWN_MS = 10 * 60 * 1000;
const MAX_LENGTH = 1500;
const MIN_LENGTH = 10;

const TYPES = {
    suggestion: { label: "Suggestion", emoji: "💡", color: 0x5865f2 },
    bug: { label: "Bug report", emoji: "🐛", color: 0xed4245 },
    question: { label: "Question", emoji: "❓", color: 0xfee75c },
    other: { label: "Other", emoji: "💬", color: 0x99aab5 },
};

let client = null;
const setClient = (c) => {
    client = c;
};

class ContactError extends Error {
    constructor(status, message, extra = {}) {
        super(message);
        this.status = status;
        Object.assign(this, extra);
    }
}

/** Reserves the cooldown slot right away (so two quick requests can't both pass), returns the previous value to roll back. */
function reserve(userId) {
    let previous;
    let waitMs = 0;
    updateData((data) => {
        data.users[userId] ??= {};
        const last = Number(data.users[userId].lastContactAt) || 0;
        waitMs = last + COOLDOWN_MS - Date.now();
        if (waitMs > 0) return;
        previous = last;
        data.users[userId].lastContactAt = Date.now();
    });
    if (waitMs > 0) throw new ContactError(429, "You can send another message in a few minutes.", { retryAfterMs: waitMs, code: "COOLDOWN" });
    return previous;
}

function release(userId, previous) {
    updateData((data) => {
        if (!data.users[userId]) return;
        if (previous) data.users[userId].lastContactAt = previous;
        else delete data.users[userId].lastContactAt;
    });
}

function cooldownLeft(userId) {
    return Math.max(0, (Number(getData().users[userId]?.lastContactAt) || 0) + COOLDOWN_MS - Date.now());
}

/** discord: { username, displayName } as seen by the website's login. */
async function submit(userId, { type, message }, discord = {}) {
    const kind = TYPES[type];
    if (!kind) throw new ContactError(400, "Pick a message type.");
    const text = typeof message === "string" ? message.trim() : "";
    if (text.length < MIN_LENGTH) throw new ContactError(400, `Write at least ${MIN_LENGTH} characters.`);
    if (text.length > MAX_LENGTH) throw new ContactError(400, `Keep it under ${MAX_LENGTH} characters.`);
    if (!client) throw new ContactError(503, "The bot is starting up. Try again in a moment.");

    const previous = reserve(userId);
    try {
        const owner = await client.users.fetch(ADMIN_ID);
        const name = String(discord.displayName || discord.username || userId).slice(0, 64);
        const embed = new EmbedBuilder()
            .setColor(kind.color)
            .setTitle(`${kind.emoji} ${kind.label}`)
            .setDescription(text)
            .addFields({ name: "From", value: `${name}${discord.username ? ` (@${String(discord.username).slice(0, 40)})` : ""}\n<@${userId}> · \`${userId}\`` })
            .setTimestamp();
        await owner.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (error) {
        release(userId, previous);
        if (error instanceof ContactError) throw error;
        client.logError?.("Contact form DM failed", error);
        throw new ContactError(502, "Couldn't deliver your message. Try again later.");
    }
    client.log?.("API", `📨 Contact form (${kind.label}) from <@${userId}>`);
    return { cooldownMs: COOLDOWN_MS };
}

module.exports = { setClient, submit, cooldownLeft, ContactError, TYPES, COOLDOWN_MS, MAX_LENGTH, MIN_LENGTH };
