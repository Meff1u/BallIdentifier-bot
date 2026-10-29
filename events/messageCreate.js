const { ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, MediaGalleryBuilder, MediaGalleryItemBuilder } = require("discord.js");
const fs = require("fs");
const path = require("path");

// Import shared utilities
const { SUPPORTED_BOT_IDS, BOT_DATA_KEYS, BOT_NAMES, COLORS, ADMIN_ID } = require("../utils/constants");
const {
    getData,
    updateData,
    processImageHash,
    downloadBuffer,
    findBestMatch,
    getMatchThreshold,
    getSpawnMessageData,
    buildBallImageUrl,
    sendThreadReport,
} = require("../utils/helpers");

// Environment variables whose values must never appear in .eval output
const SECRET_ENV_KEYS = [
    "TOKEN",
    "API_KEY",
    "BOT_API_SECRET",
    "DBL_TOKEN",
    "MONGODB_URI",
    "BALLSDEX_API_ENCRYPTION_KEY",
    "ERROR_WEBHOOK_URL",
    "LOG_WEBHOOK_URL",
    "UPVOTE_WEBHOOK_URL",
    "CATCH_WEBHOOK_URL",
];

/**
 * Replace every secret value from the environment with [REDACTED:NAME].
 */
function redactSecrets(text, clientToken) {
    let output = String(text);
    const secrets = SECRET_ENV_KEYS.map((key) => [key, process.env[key]]);
    // Bot token can also be read at runtime via client.token
    secrets.push(["CLIENT_TOKEN", clientToken]);

    for (const [key, value] of secrets) {
        if (value && value.length >= 8) {
            output = output.split(value).join(`[REDACTED:${key}]`);
        }
    }
    return output;
}

module.exports = {
    name: "messageCreate",
    async execute(m, client) {
        // Handle bot spawn messages for notifier
        if (m.author.bot && SUPPORTED_BOT_IDS.includes(m.author.id)) {
            // Cheap checks first: most guilds have no notifier configured
            const guildConfig = getData().guilds[m.guildId]?.notifier;
            if (!guildConfig?.selectedBots?.includes(m.author.id)) return;

            const spawnData = getSpawnMessageData(m);
            if (spawnData.isSpawn) {
                await notify(m, client, guildConfig, {
                    hashes: client.hashes?.[BOT_DATA_KEYS[m.author.id]],
                    imageUrl: spawnData.imageUrl,
                });
            }
            return;
        }

        // Handle eval command for admin
        if (m.content.startsWith(".eval") && m.author.id === ADMIN_ID) {
            await handleEval(m, client);
        }
    },
};

/**
 * Handle eval command
 */
async function handleEval(m, client) {
    try {
        const code = m.content.slice(5).trim();
        if (!code) return m.reply("No code provided!");

        let result = await eval(`(async () => { ${code} })()`);

        // Do not send a reply when the evaluated result is explicitly null.
        if (result === null) return;

        let output = result === undefined ? "undefined" : typeof result === "object" ? JSON.stringify(result, null, 2) : String(result);

        // Redact sensitive info
        output = redactSecrets(output, client.token);

        // Split output into chunks that fit in Discord's 2000 character limit
        const maxChunkLength = 1900; // Account for code block markers
        const chunks = [];

        for (let i = 0; i < output.length; i += maxChunkLength) {
            chunks.push(output.substring(i, i + maxChunkLength));
        }

        // Send each chunk as a separate message
        for (let i = 0; i < chunks.length; i++) {
            const isLastChunk = i === chunks.length - 1;
            const header = chunks.length > 1 ? `[${i + 1}/${chunks.length}]\n` : "";
            await m.reply(`\`\`\`js\n${header}${chunks[i]}\n\`\`\``);
        }
    } catch (error) {
        let errorMessage = error.message || String(error);
        errorMessage = redactSecrets(errorMessage, client.token);

        // Handle long error messages the same way
        const maxChunkLength = 1900;
        const chunks = [];

        for (let i = 0; i < errorMessage.length; i += maxChunkLength) {
            chunks.push(errorMessage.substring(i, i + maxChunkLength));
        }

        for (let i = 0; i < chunks.length; i++) {
            const header = chunks.length > 1 ? `[${i + 1}/${chunks.length}]\n` : "";
            await m.reply(`\`\`\`js\nError: ${header}${chunks[i]}\n\`\`\``);
        }
    }
}

/**
 * Fill placeholders in the notifier message (every occurrence)
 */
function formatNotifierMessage(template, values) {
    return template
        .replaceAll("{ball}", values.ball)
        .replaceAll("{role}", `<@&${values.role}>`)
        .replaceAll("{rarity}", values.rarity)
        .replaceAll("{artist}", values.artist);
}

/**
 * Send notification for spawn
 */
async function notify(m, client, settings, info) {
    const { customMessage, selectedRole } = settings;
    const { imageUrl, hashes } = info;
    const guildName = m.guild?.name || m.guildId;

    try {
        if (!imageUrl) throw new Error("Missing spawn image URL for catch message");
        if (!hashes) throw new Error(`Hashes for ${BOT_NAMES[m.author.id]} are not loaded yet`);

        // Process image to identify ball
        const { hash, buffer: imageBuffer } = await processImageHash(imageUrl);
        const bestMatch = findBestMatch(hash, hashes);
        const isConfident = bestMatch.diff <= getMatchThreshold(bestMatch.country);

        const ballName = isConfident ? bestMatch.country : "Unknown (probably new spawn art)";
        const foundBall = isConfident ? client.rarities?.[BOT_DATA_KEYS[m.author.id]]?.[bestMatch.country] : null;

        await m
            .reply({
                content: formatNotifierMessage(customMessage, {
                    ball: ballName,
                    role: selectedRole,
                    rarity: foundBall?.rarity ?? "Unknown",
                    artist: foundBall?.artist ?? "Unknown",
                }),
                // Only the configured role may be pinged
                allowedMentions: { parse: [], roles: [selectedRole], repliedUser: false },
            })
            .catch((error) => {
                client.logImage(`[${guildName}] ❌ Could not send notifier message: ${error.message}`);
            });

        // Log the identification result
        client.logImage(`[${guildName}] ${isConfident ? "✅ Identified" : "⚠️ Unknown"}: ${ballName} (diff: ${bestMatch.diff})`);

        if (isConfident) {

            // Increment identifyAmount counter (atomic read-modify-write)
            updateData((data) => {
                data.guilds[m.guildId] ??= {};
                data.guilds[m.guildId].identifyAmount = (data.guilds[m.guildId].identifyAmount || 0) + 1;
            });
            return;
        }

        // Send report for unknown spawn art
        try {
            const botDex = BOT_NAMES[m.author.id] || "Unknown";
            const matchImageBuffer = await downloadBuffer(buildBallImageUrl(botDex, bestMatch.country));

            const container = new ContainerBuilder().setAccentColor(COLORS.ERROR);
            container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ⚠️ Unknown Spawn Art Report`));
            container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `**Report Details:**\n` +
                        `- **Server:** ${guildName}\n` +
                        `- **Bot:** ${botDex}\n` +
                        `- **Best Match:** ${bestMatch.country}\n` +
                        `- **Difference:** ${bestMatch.diff}\n` +
                        `- **Message:** [Link](${m.url})`,
                ),
            );
            container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
            container.addMediaGalleryComponents(
                new MediaGalleryBuilder().addItems(
                    new MediaGalleryItemBuilder().setURL("attachment://spawn.png").setDescription("Detected Spawn Art"),
                    new MediaGalleryItemBuilder().setURL("attachment://match.png").setDescription("Best Matching Entry"),
                ),
            );

            await sendThreadReport(client, botDex, container, {
                files: [
                    { attachment: imageBuffer, name: "spawn.png" },
                    { attachment: matchImageBuffer, name: "match.png" },
                ],
            });
        } catch (e) {
            console.error("[NOTIFIER] Error sending auto-notifier report:", e);
        }
    } catch (error) {
        console.error("[NOTIFIER] Error processing image:", error);
        client.logImage(`[${guildName}] ❌ Image processing error: ${error.message}`);
    }
}
