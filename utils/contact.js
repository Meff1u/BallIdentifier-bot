/**
 * Messages from the website's contact form (suggestions, bug reports...). They are DMed to the owner.
 * One message per user every COOLDOWN_MS, remembered in data.json so a restart doesn't reset it.
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } = require("discord.js");
const { getData, updateData } = require("./helpers");
const notifications = require("./notifications");
const { ADMIN_ID } = require("./constants");

const COOLDOWN_MS = 10 * 60 * 1000;
const MAX_LENGTH = 1500;
const MIN_LENGTH = 10;
const REPLY_MAX = 1800;
const REPLY_PREFIX = "contactreply:"; // the owner answers: open|send:<userId>:<type>
const USER_PREFIX = "contactuser:"; // the author replies once: open|send:<type>
const SITE_URL = "https://ballidentifier.xyz";

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

const kindOf = (type) => (TYPES[type] ? type : "other");

/** The message the owner gets (same look for the website form and for a user's reply). */
function messageEmbed(type, text, userId, discord = {}, { reply = false } = {}) {
    const kind = TYPES[kindOf(type)];
    const name = String(discord.displayName || discord.username || userId).slice(0, 64);
    return new EmbedBuilder()
        .setColor(kind.color)
        .setTitle(`${kind.emoji} ${kind.label}${reply ? " · reply" : ""}`)
        .setDescription(text)
        .addFields({ name: "From", value: `${name}${discord.username ? ` (@${String(discord.username).slice(0, 40)})` : ""}\n<@${userId}> · \`${userId}\`` })
        .setTimestamp();
}

const answerRow = (userId, type) =>
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${REPLY_PREFIX}open:${userId}:${kindOf(type)}`).setLabel("Answer").setEmoji("✉️").setStyle(ButtonStyle.Primary));

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
        const embed = messageEmbed(type, text, userId, discord);
        await owner.send({ embeds: [embed], components: [answerRow(userId, type)], allowedMentions: { parse: [] } });
    } catch (error) {
        release(userId, previous);
        if (error instanceof ContactError) throw error;
        client.logError?.("Contact form DM failed", error);
        throw new ContactError(502, "Couldn't deliver your message. Try again later.");
    }
    client.log?.("API", `📨 Contact form (${kind.label}) from <@${userId}>`);
    return { cooldownMs: COOLDOWN_MS };
}

const ephemeral = (interaction, content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
const paragraph = (id, label, max, min = 1) => new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Paragraph).setMinLength(min).setMaxLength(max).setRequired(true));

/**
 * The owner's "Answer" button under a message: a popup with the answer and "Can reply?" (yes / no).
 * The answer is DMed to the author; with "yes" it carries a "Reply" button (one use). If the DM can't be
 * delivered, the answer goes to the website notifications instead (no reply option) and the owner is told.
 */
async function handleOwnerReply(interaction, client) {
    if (interaction.user.id !== ADMIN_ID) return ephemeral(interaction, "Only the owner can answer messages.");
    const [, action, userId, rawType] = interaction.customId.split(":");
    const type = kindOf(rawType);
    if (!/^\d{17,20}$/.test(userId || "")) return ephemeral(interaction, "This message can't be answered.");

    if (interaction.isButton()) {
        const canReply = new TextInputBuilder().setCustomId("canreply").setLabel("Can reply? (yes / no)").setStyle(TextInputStyle.Short).setMinLength(1).setMaxLength(3).setValue("yes").setRequired(true);
        const modal = new ModalBuilder()
            .setCustomId(`${REPLY_PREFIX}send:${userId}:${type}`)
            .setTitle("Answer the message")
            .addComponents(paragraph("text", "Your answer", REPLY_MAX), new ActionRowBuilder().addComponents(canReply));
        return interaction.showModal(modal);
    }
    if (action !== "send") return;

    const text = interaction.fields.getTextInputValue("text").trim();
    const choice = interaction.fields.getTextInputValue("canreply").trim().toLowerCase();
    if (!text) return ephemeral(interaction, "Write an answer first.");
    if (!/^[yn]/.test(choice)) return ephemeral(interaction, `Type yes or no in "Can reply?". Your answer, to copy:\n${text.slice(0, 1800)}`);
    const canReply = choice.startsWith("y");
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const original = interaction.message?.embeds?.[0];
    const quote = original?.description ? original.description.slice(0, 600) + (original.description.length > 600 ? "…" : "") : null;
    let delivered = "dm";
    try {
        const user = await client.users.fetch(userId);
        const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle("💬 Answer from BallIdentifier")
            .setDescription(text)
            .setFooter({ text: canReply ? "You can reply to this answer once, with the button below." : `You can't reply to this message. To write again, use the contact form on ${SITE_URL.replace("https://", "")}.` })
            .setTimestamp();
        if (quote) embed.addFields({ name: "Your message", value: quote });
        const message = { embeds: [embed], allowedMentions: { parse: [] } };
        if (canReply) message.components = [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${USER_PREFIX}open:${type}`).setLabel("Reply").setEmoji("↩️").setStyle(ButtonStyle.Primary))];
        await user.send(message);
    } catch (error) {
        client.log?.("API", `📨 Contact answer to <@${userId}> couldn't be DMed (${error.code || error.message}), sent as a website notification`);
        delivered = "site";
        await notifications.notify(userId, "support_reply", { title: "Answer to your message", body: text.slice(0, 1800) });
    }
    if (original && interaction.message) {
        const note = delivered === "dm" ? (canReply ? " (they can reply)" : " (no reply option)") : " (sent as a website notification)";
        const marked = EmbedBuilder.from(original).addFields({ name: `✅ Your answer${note}`, value: text.slice(0, 1024) });
        await interaction.message.edit({ embeds: [marked] }).catch(() => {});
    }
    client.log?.("API", `📨 Contact answer sent to <@${userId}> (${delivered})`);
    await interaction.editReply(delivered === "dm" ? "✅ Answer sent." : "⚠️ Couldn't DM this user (the bot shares no server with them or their DMs are closed). The answer was sent as a notification on the website instead, without a reply option.");
}

/** The author's one-time "Reply" button under an answer: a popup, and the text goes to the owner in the usual format. */
async function handleUserReply(interaction, client) {
    const [, action, rawType] = interaction.customId.split(":");
    const type = kindOf(rawType);
    if (interaction.isButton()) {
        const modal = new ModalBuilder().setCustomId(`${USER_PREFIX}send:${type}`).setTitle("Reply").addComponents(paragraph("text", "Your reply", MAX_LENGTH, MIN_LENGTH));
        return interaction.showModal(modal);
    }
    if (action !== "send") return;
    const text = interaction.fields.getTextInputValue("text").trim();
    if (text.length < MIN_LENGTH) return ephemeral(interaction, `Write at least ${MIN_LENGTH} characters.`);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
        const owner = await client.users.fetch(ADMIN_ID);
        const user = interaction.user;
        await owner.send({
            embeds: [messageEmbed(type, text, user.id, { username: user.username, displayName: user.globalName || user.username }, { reply: true })],
            components: [answerRow(user.id, type)],
            allowedMentions: { parse: [] },
        });
    } catch (error) {
        client.logError?.("Contact reply DM failed", error);
        return interaction.editReply("❌ Couldn't deliver your reply. Try again later, or use the contact form on the website.");
    }
    // One reply per answer: the button disappears
    const original = interaction.message?.embeds?.[0];
    if (interaction.message) {
        const payload = { components: [] };
        if (original) payload.embeds = [EmbedBuilder.from(original).setFooter({ text: "✅ You replied to this message." })];
        await interaction.message.edit(payload).catch(() => {});
    }
    client.log?.("API", `📨 Contact reply from <@${interaction.user.id}>`);
    await interaction.editReply("✅ Your reply was sent.");
}

const handleInteraction = (interaction, client) => (interaction.customId.startsWith(USER_PREFIX) ? handleUserReply(interaction, client) : handleOwnerReply(interaction, client));

module.exports = { handleInteraction, REPLY_PREFIX, USER_PREFIX, setClient, submit, cooldownLeft, ContactError, TYPES, COOLDOWN_MS, MAX_LENGTH, MIN_LENGTH };
