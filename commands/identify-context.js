const {
    ContextMenuCommandBuilder,
    ApplicationCommandType,
    EmbedBuilder,
    MessageFlags,
    InteractionContextType,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
} = require("discord.js");
const fs = require("fs");

// Import shared utilities
const { SUPPORTED_BOT_IDS, BOT_DATA_KEYS, BOT_NAMES, ASSETS_BASE_URL, COOLDOWN_DURATION, COLORS, SPAWN_BUTTON_LABELS } = require("../utils/constants");
const {
    readJsonFile,
    writeJsonFile,
    compareHashes,
    isUpvoter,
    checkCooldown,
    setCooldown,
    getAssetsPath,
    processImageHash,
    findBestMatch,
    sendThreadReport,
} = require("../utils/helpers");

// Lazy-load node-fetch
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

// Local constants
const DATA_PATH = getAssetsPath("data.json");

const buildImageUrl = (dex, country) => `${ASSETS_BASE_URL}/dexes/${encodeURIComponent(dex)}/${encodeURIComponent(country)}.png`;

// Bot config with dex names
const BOT_CONFIG = Object.fromEntries(SUPPORTED_BOT_IDS.map((id) => [id, { dex: BOT_NAMES[id], dKey: BOT_DATA_KEYS[id] }]));

function getSpawnMessageData(message) {
    const legacyAttachment = message.attachments?.first?.();

    const isLegacySpawn =
        message.attachments?.size === 1 && SPAWN_BUTTON_LABELS.some((text) => message.components?.[0]?.components?.[0]?.label?.includes(text));

    const v2ImageItem = message.components?.[1]?.items?.[0];
    const v2ImageUrl = v2ImageItem?.media?.url;
    const v2ButtonLabel = message.components?.at(-1)?.components?.[0]?.label;
    const isV2Spawn = Boolean(v2ImageUrl && SPAWN_BUTTON_LABELS.some((text) => v2ButtonLabel?.includes(text)));

    if (isLegacySpawn && legacyAttachment?.url) {
        return {
            isSpawn: true,
            imageUrl: legacyAttachment.url,
            imageName: legacyAttachment.name || `${message.id}.png`,
            messageType: "legacy",
        };
    }

    if (isV2Spawn) {
        return {
            isSpawn: true,
            imageUrl: v2ImageUrl,
            imageName: `${message.id}.png`,
            messageType: "components-v2",
        };
    }

    return {
        isSpawn: false,
        imageUrl: null,
        imageName: null,
        messageType: null,
    };
}

module.exports = {
    data: new ContextMenuCommandBuilder().setName("Identify").setType(ApplicationCommandType.Message).setContexts(InteractionContextType.Guild),

    async execute(interaction) {
        const { client, user, targetMessage: message } = interaction;
        const spawnData = getSpawnMessageData(message);

        // Check upvoter status and cooldown
        if (!isUpvoter(client.upvotes, user.id)) {
            const remainingMinutes = checkCooldown(client.identifyCooldowns, user.id, COOLDOWN_DURATION);

            if (remainingMinutes) {
                return interaction.reply({
                    content: `You can use this function again in ${remainingMinutes} min. ([Upvoters](https://discordbotlist.com/bots/ballidentifier/upvote) have no cooldown)`,
                    flags: MessageFlags.Ephemeral,
                });
            }
            setCooldown(client.identifyCooldowns, user.id);
        }

        // Validate message
        if (!message) {
            return interaction.reply({
                content: "Error while getting message, try again.",
                flags: MessageFlags.Ephemeral,
            });
        }

        if (!SUPPORTED_BOT_IDS.includes(message.author.id)) {
            const supportedBots = SUPPORTED_BOT_IDS.map((id) => BOT_NAMES[id]).join(", ");
            return interaction.reply({
                content: `This command can only be used on messages from: ${supportedBots}.`,
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // Check if message has a catch button
        if (!spawnData.isSpawn || message.content.includes("Caught on")) {
            return interaction.editReply({
                content: "This message doesn't appear to be a spawn message.",
                flags: MessageFlags.Ephemeral,
            });
        }

        try {
            const config = BOT_CONFIG[message.author.id];
            const hashes = client.hashes[config.dKey];
            const data = readJsonFile(DATA_PATH, { users: {} });

            // Process image and get hash
            const { hash } = await processImageHash(spawnData.imageUrl, message.id);

            // Find best match
            let bestMatch = findBestMatch(hash, hashes);

            const minDiff = ["Mali Empire", "Burkina Faso"].includes(bestMatch.country) ? 25 : 20;

            // Determine log color based on confidence
            const logColor = bestMatch.diff <= 10 ? COLORS.SUCCESS : bestMatch.diff <= 15 ? COLORS.WARNING : bestMatch.diff <= 20 ? 0xe69138 : COLORS.ERROR;

            const imageUrl = buildImageUrl(config.dex, bestMatch.country);
            const rarity = client.rarities[config.dKey]?.[bestMatch.country]?.rarity || "Unknown";
            const artist = client.rarities[config.dKey]?.[bestMatch.country]?.artist || "Unknown";

            // Log the identification
            await client.sendLog({
                title: "Identify Log",
                fields: [
                    { name: "User", value: `<@${user.id}> (${user.tag})`, inline: false },
                    {
                        name: "Details",
                        value: `- **Dex:** ${config.dex}\n- **Country:** ${bestMatch.country}\n- **Diff:** ${bestMatch.diff}\n- **Rarity:** ${rarity ? `t${rarity}` : "Not found"}`,
                        inline: false,
                    },
                ],
                thumbnail: imageUrl,
                image: bestMatch.diff >= minDiff ? spawnData.imageUrl : null,
                color: logColor,
            });

            // Create result embed
            const embed = new EmbedBuilder()
                .setColor(logColor)
                .setTitle(bestMatch.country)
                .setDescription(
                    `**Similarity:** \`${100 - bestMatch.diff}%\`\n**Rarity:** \`${rarity ? `t${rarity}` : "Not found"}\`\n**Artist:** \`${artist}\``,
                )
                .setFooter({
                    text: `You have identified ${(data.users[user.id]?.identifyAmount || 0) + (bestMatch.diff >= 20 ? 0 : 1)} balls!`,
                });

            // Add auto-report notice for low confidence results
            if (bestMatch.diff >= minDiff) {
                embed.addFields({
                    name: "⚠️ Auto-Report Status",
                    value: "Low confidence match detected - automatically reported for verification",
                });
            }

            // Reply with result embed
            await interaction.editReply({ embeds: [embed] });

            // Auto-report low confidence results
            if (bestMatch.diff >= minDiff) {
                try {
                    // Fetch both images
                    const [spawnImageRes, matchImageRes] = await Promise.all([fetch(spawnData.imageUrl), fetch(imageUrl)]);

                    const [spawnImageBuffer, matchImageBuffer] = await Promise.all([spawnImageRes.buffer(), matchImageRes.buffer()]);

                    // Build components v2 container
                    const container = new ContainerBuilder().setAccentColor(COLORS.ERROR);

                    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ⚠️ Unknown Spawn Art Report`));
                    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
                    container.addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            `**Report Details:**\n` +
                                `- **User:** ${user.tag} (${user.id})\n` +
                                `- **Bot:** ${config.dex}\n` +
                                `- **Best Match:** ${bestMatch.country}\n` +
                                `- **Difference:** ${bestMatch.diff}\n` +
                                `- **Status:** Low confidence match detected`,
                        ),
                    );
                    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
                    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Detected Spawn Art:**`));
                    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`![spawn](attachment://spawn.png)`));
                    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
                    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Best Matching Entry:**`));
                    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`![match](attachment://match.png)`));

                    // Send report to thread
                    await sendThreadReport(client, config.dex, container, {
                        files: [
                            { attachment: spawnImageBuffer, name: "spawn.png" },
                            { attachment: matchImageBuffer, name: "match.png" },
                        ],
                    });
                } catch (e) {
                    console.error("[IDENTIFY] Error sending auto-report:", e);
                }
            }

            // Update user stats for good matches
            if (bestMatch.diff <= minDiff) {
                if (!data.users) data.users = {};
                if (!data.users[user.id]) data.users[user.id] = { identifyAmount: 0 };
                data.users[user.id].identifyAmount += 1;
                writeJsonFile(DATA_PATH, data);
            }
        } catch (error) {
            // Log error to webhook
            const webhookUrl = process.env.ERROR_WEBHOOK_URL;
            if (webhookUrl) {
                try {
                    await fetch(webhookUrl, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            embeds: [
                                {
                                    title: "Identify Command Error",
                                    description: error.stack || String(error),
                                    color: 0xff0000,
                                    timestamp: new Date().toISOString(),
                                },
                            ],
                        }),
                    });
                } catch (e) {
                    console.error("[IDENTIFY] Error sending error report:", e);
                }
            }

            // Re-throw to let the error handler catch it
            throw error;
        }
    },
};
