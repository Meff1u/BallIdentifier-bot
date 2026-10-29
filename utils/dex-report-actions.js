const {
    MessageFlags,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require("discord.js");
const crypto = require("crypto");
const { ADMIN_ID } = require("./constants");
const { downloadBuffer } = require("./helpers");
const dexEditor = require("./dex-editor");

const KEY_TO_DEX = Object.fromEntries(Object.entries(dexEditor.DEX_KEYS).map(([dex, key]) => [key, dex]));
const EXTRA_FIELDS = ["wave", "common_value", "demand", "cc"];
const PENDING_TTL_MS = 15 * 60 * 1000;
const pending = new Map(); // token -> { at, ...save options, messageId, channelId }

/** The two buttons added under a report (dexKey e.g. "BD", bestMatch = ball the report compared to). */
function reportButtons(dexKey, bestMatch) {
    const updateId = `dexedit:update:${dexKey}:${bestMatch || ""}`.slice(0, 100);
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(updateId).setLabel("Update existing").setEmoji("✏️").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`dexedit:add:${dexKey}`).setLabel("Add as new").setEmoji("➕").setStyle(ButtonStyle.Success),
    );
}

function textInput(id, label, { value, required = false, style = TextInputStyle.Short, placeholder, max = 100 } = {}) {
    const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max);
    if (value !== undefined && value !== null && String(value) !== "") input.setValue(String(value).slice(0, max));
    if (placeholder) input.setPlaceholder(placeholder);
    return new ActionRowBuilder().addComponents(input);
}

function buildModal(mode, dexKey, name, client) {
    const dex = KEY_TO_DEX[dexKey];
    const data = client.rarities?.[dexKey] || {};
    const title = `${mode === "update" ? "Update entry" : "Add entry"} · ${dex}`.slice(0, 45);
    const modal = new ModalBuilder().setCustomId(`dexedit:modal:${mode}:${dexKey}`).setTitle(title);

    if (mode === "update") {
        // Empty = keep; the placeholders show the best match's current values
        const entry = data[name] || {};
        const keep = (value) => (value !== undefined ? `Keep: ${value}`.slice(0, 100) : "Keep the current value");
        return modal.addComponents(
            textInput("name", "Ball to update", { value: name, required: true, max: 80 }),
            textInput("rarity", "New rarity (optional)", { placeholder: keep(entry.rarity), max: 10 }),
            textInput("artist", "New artist (optional)", { placeholder: keep(entry.artist) }),
            // Ballsdex keeps old arts in Previous arts: ask for their alt text instead of the (rarely changed) ID
            dex === "Ballsdex"
                ? textInput("alt", "Alt text for the old art (optional)", { placeholder: "e.g. Special art for the birthday event", max: 200 })
                : textInput("id", "New ID (optional)", { placeholder: keep(entry.id), max: 10 }),
            textInput("extra", "More changes (optional, one per line)", {
                style: TextInputStyle.Paragraph,
                placeholder: `wave: 5\ncommon_value: 150\ndemand: A\ncc: 250${dex === "Ballsdex" ? `\nid: ${entry.id ?? 123}` : ""}`,
                max: 400,
            }),
        );
    }

    const nextId = Math.max(0, ...Object.values(data).map((e) => Number(e.id) || 0)) + 1;
    return modal.addComponents(
        textInput("name", "Name", { required: true, max: 80 }),
        textInput("rarity", "Rarity", { required: true, placeholder: "e.g. 13", max: 10 }),
        textInput("artist", "Artist", { required: true }),
        textInput("id", "ID", { value: nextId, required: true, max: 10 }),
        textInput("extra", "More (optional, one per line)", { style: TextInputStyle.Paragraph, placeholder: "wave: 5\ncommon_value: 150\ndemand: A\ncc: 250", max: 400 }),
    );
}

function parseForm(interaction) {
    const get = (id) => {
        try {
            return interaction.fields.getTextInputValue(id)?.trim() || "";
        } catch {
            return ""; // not in this form
        }
    };
    const details = { rarity: get("rarity"), artist: get("artist"), id: get("id") };
    const fields = [...EXTRA_FIELDS, "id"];
    for (const line of get("extra").split("\n").map((l) => l.trim()).filter(Boolean)) {
        const match = /^([\w ]+?)\s*[:=]\s*(.*)$/.exec(line);
        const field = match?.[1].toLowerCase().replace(/\s+/g, "_");
        if (!match || !fields.includes(field)) throw Object.assign(new Error(`Can't read "${line}". Use: ${fields.join(", ")} (e.g. "wave: 5").`), { status: 400 });
        details[field] = match[2];
    }
    return { name: get("name"), details, previousAlt: get("alt") };
}

function reportImageUrl(message) {
    return message?.attachments?.find((a) => a.name === "spawn.png")?.url || null;
}

function summary(result, mode) {
    const lines = [`✅ ${mode === "add" ? "Added" : "Updated"} **${result.name}** in ${result.dex}.`, ...result.changes.map((c) => `- ${c}`)];
    if (result.commitUrl) lines.push(`-# [Commit](<${result.commitUrl}>) · the website updates after its next deploy`);
    return lines.join("\n");
}

async function save(options, mode, interaction, reportMessage) {
    const image = await downloadBuffer(options.imageUrl);
    const result = await dexEditor.saveEntry({ ...options, image, actor: `Discord report, ${interaction.user.username}` });
    await reportMessage?.reply({ content: summary(result, mode), allowedMentions: { parse: [] } }).catch(() => {});
    return summary(result, mode);
}

const errorText = (error) => `❌ ${error.status ? error.message : `Couldn't save: ${error.message}`}`;

/** Returns true when the interaction was one of ours. */
async function handleDexEdit(interaction, client) {
    const id = interaction.customId || "";
    if (!id.startsWith("dexedit:")) return false;
    if (interaction.user.id !== ADMIN_ID) {
        await interaction.reply({ content: "Only the bot owner can edit dex entries.", flags: MessageFlags.Ephemeral });
        return true;
    }
    const [, action, ...rest] = id.split(":");

    // Report buttons -> form
    if (interaction.isButton() && (action === "update" || action === "add")) {
        const dexKey = rest[0];
        if (!KEY_TO_DEX[dexKey]) return interaction.reply({ content: "Unknown dex.", flags: MessageFlags.Ephemeral }).then(() => true);
        if (!reportImageUrl(interaction.message)) {
            await interaction.reply({ content: "This report has no spawn image to use.", flags: MessageFlags.Ephemeral });
            return true;
        }
        await interaction.showModal(buildModal(action, dexKey, rest.slice(1).join(":"), client));
        return true;
    }

    // Form sent
    if (interaction.isModalSubmit() && action === "modal") {
        const [mode, dexKey] = rest;
        const dex = KEY_TO_DEX[dexKey];
        const imageUrl = reportImageUrl(interaction.message);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            if (!dex || !imageUrl) throw Object.assign(new Error("The report or its spawn image is gone."), { status: 400 });
            const { name, details, previousAlt } = parseForm(interaction);
            const options = { dex, name, details, imageUrl, previousAlt };
            if (mode === "update") {
                options.originalName = name;
                options.merge = true;
                return interaction.editReply({ content: await save(options, mode, interaction, interaction.message) }).then(() => true);
            }

            // Adding: ask about the rarities after it
            dexEditor.cleanDetails(details); // validate before asking
            const rarity = Number(String(details.rarity).replace(",", ".").replace(/^t/i, ""));
            const later = Object.values(client.rarities?.[dexKey] || {}).filter((e) => Number(e.rarity) >= rarity).length;
            if (!later) {
                return interaction.editReply({ content: await save({ ...options, shift: false }, mode, interaction, interaction.message) }).then(() => true);
            }
            const token = crypto.randomBytes(6).toString("hex");
            pending.set(token, { at: Date.now(), options, messageId: interaction.message?.id, channelId: interaction.channelId });
            await interaction.editReply({
                content: `**${name}** goes in as T${rarity}. ${later} ball${later === 1 ? "" : "s"} already at T${rarity} or rarer. Move them all one rarity down (T${rarity} → T${rarity + 1} and so on)?`,
                components: [
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`dexedit:shift:${token}:yes`).setLabel("Yes, move them down").setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId(`dexedit:shift:${token}:no`).setLabel("No, keep their rarities").setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder().setCustomId(`dexedit:shift:${token}:cancel`).setLabel("Cancel").setStyle(ButtonStyle.Danger),
                    ),
                ],
            });
        } catch (error) {
            if (!error.status) client.logError?.("Dex editor (report) failed", error);
            await interaction.editReply({ content: errorText(error), components: [] });
        }
        return true;
    }

    // Rarity question answered
    if (interaction.isButton() && action === "shift") {
        const [token, answer] = rest;
        for (const [key, value] of pending) if (Date.now() - value.at > PENDING_TTL_MS) pending.delete(key);
        const job = pending.get(token);
        if (!job) return interaction.update({ content: "This expired. Press the button on the report again.", components: [] }).then(() => true);
        pending.delete(token);
        if (answer === "cancel") return interaction.update({ content: "Cancelled, nothing was saved.", components: [] }).then(() => true);

        await interaction.update({ content: "Saving…", components: [] });
        try {
            const channel = await client.channels.fetch(job.channelId).catch(() => null);
            const reportMessage = job.messageId ? await channel?.messages?.fetch(job.messageId).catch(() => null) : null;
            await interaction.editReply({ content: await save({ ...job.options, shift: answer === "yes" }, "add", interaction, reportMessage) });
        } catch (error) {
            if (!error.status) client.logError?.("Dex editor (report) failed", error);
            await interaction.editReply({ content: errorText(error) });
        }
        return true;
    }

    return false;
}

module.exports = { reportButtons, handleDexEdit };
