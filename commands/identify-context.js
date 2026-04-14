const {
    ContextMenuCommandBuilder,
    ApplicationCommandType,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
} = require("discord.js");
const fs = require("fs");

// Import shared utilities
const {
    SUPPORTED_BOT_IDS,
    BOT_DATA_KEYS,
    BOT_NAMES,
    ASSETS_BASE_URL,
    COOLDOWN_DURATION,
    COLORS,
} = require("../utils/constants");
const {
    readJsonFile,
    writeJsonFile,
    compareHashes,
    isUpvoter,
    checkCooldown,
    setCooldown,
    getAssetsPath,
    processImageHash,
} = require("../utils/helpers");

// Lazy-load node-fetch
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

// Local constants
const DATA_PATH = getAssetsPath("data.json");

// Bot config with dex names
const BOT_CONFIG = Object.fromEntries(
    SUPPORTED_BOT_IDS.map((id) => [id, { dex: BOT_NAMES[id], dKey: BOT_DATA_KEYS[id] }])
);

const buildImageUrl = (dex, country) =>
    `${ASSETS_BASE_URL}/dexes/${dex}/${encodeURIComponent(country)}.png`;

module.exports = {
    data: new ContextMenuCommandBuilder()
        .setName("Identify")
        .setType(ApplicationCommandType.Message),
        
    async execute(interaction) {
        const { client, user, targetMessage: message } = interaction;
        
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

        // Guild check
        if (!message.guild) {
            return interaction.reply({
                content: "This command can only be used on messages within a server.",
                flags: MessageFlags.Ephemeral,
            });
        }
        
        if (!message.attachments?.size) {
            return interaction.reply({
                content: "No attachments found in the message.",
                flags: MessageFlags.Ephemeral,
            });
        }
        
        if (!SUPPORTED_BOT_IDS.includes(message.author.id)) {
            const supportedBots = SUPPORTED_BOT_IDS.map(id => BOT_NAMES[id]).join(", ");
            return interaction.reply({
                content: `This command can only be used on messages from: ${supportedBots}.`,
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const config = BOT_CONFIG[message.author.id];
            const hashes = client.hashes[config.dKey];
            const data = readJsonFile(DATA_PATH, { users: {} });
            
            // Check if message has a catch button
            if (message.components[0]?.components[0]?.type !== 2) {
                return interaction.editReply({
                    content: "This message doesn't appear to be a spawn message.",
                    flags: MessageFlags.Ephemeral,
                });
            }

            // Process image and get hash
            const { hash, buffer: imageBuffer } = await processImageHash(
                message.attachments.first().url,
                message.id
            );

            // Find best match
            let compareData = { diff: Infinity, country: "" };
            
            for (const [hKey, country] of Object.entries(hashes)) {
                const diff = compareHashes(hash, hKey);
                if (diff < compareData.diff) {
                    compareData = { diff, country };
                }
                if (diff === 0) break;
            }

            // Determine log color based on confidence
            const logColor = compareData.diff <= 10 ? 0x00ff00 
                           : compareData.diff <= 15 ? COLORS.ERROR 
                           : 0xff0000;

            const imageUrl = buildImageUrl(config.dex, compareData.country);
            const rarity = client.rarities[config.dKey]?.[compareData.country]?.rarity || "Unknown";
            const artist = client.rarities[config.dKey]?.[compareData.country]?.artist || "Unknown";
            
            // Log the identification
            await client.sendLog({
                title: "Identify Log",
                fields: [
                    { name: "User", value: `<@${user.id}> (${user.tag})`, inline: false },
                    {
                        name: "Details",
                        value: `- **Dex:** ${config.dex}\n- **Country:** ${compareData.country}\n- **Diff:** ${compareData.diff}\n- **Rarity:** ${rarity ? `t${rarity}` : "Not found"}`,
                        inline: false,
                    },
                    ...(compareData.diff >= 16 ? [{ name: "Target Spawn Art", value: "\u200B" }] : []),
                ],
                thumbnail: imageUrl,
                image: compareData.diff >= 16 ? message.attachments.first().url : null,
                color: logColor,
            });

            // Create result embed
            const embed = new EmbedBuilder()
                .setColor(0xa020f0)
                .setTitle(compareData.country)
                .setDescription(
                    `**Similarity:** \`${100 - compareData.diff}%\`\n**Rarity:** \`${rarity ? `t${rarity}` : "Not found"}\`\n**Artist:** \`${artist}\``
                )
                .setThumbnail(imageUrl)
                .setFooter({
                    text: `You have identified ${(data.users[user.id]?.identifyAmount || 0) + 1} balls!`,
                });

            // Handle low confidence results with report button
            if (compareData.diff >= 16) {
                const reportButton = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId("report_wrong_answer")
                        .setLabel("Wrong answer? - Report")
                        .setStyle(ButtonStyle.Danger)
                );
                
                await interaction.editReply({
                    embeds: [embed],
                    components: [reportButton],
                });

                // Set up report collector
                const collector = interaction.channel.createMessageComponentCollector({
                    filter: (i) => i.customId === "report_wrong_answer" && i.user.id === user.id,
                    time: 60000,
                    max: 1,
                });

                collector.on("collect", async (btnInteraction) => {
                    const cooldown = client.reportCooldowns.get(btnInteraction.user.id);
                    const now = Date.now();
                    
                    if (cooldown && now - cooldown < COOLDOWN_DURATION) {
                        const left = Math.ceil((COOLDOWN_DURATION - (now - cooldown)) / 60000);
                        return btnInteraction.reply({
                            content: `You can send another report in ${left} min.`,
                            flags: MessageFlags.Ephemeral,
                        });
                    }

                    // Send report webhook
                    const webhookUrl = process.env.REPORT_WEBHOOK_URL;
                    if (webhookUrl) {
                        try {
                            const FormData = require("form-data");
                            const form = new FormData();
                            form.append("payload_json", JSON.stringify({
                                embeds: [{
                                    title: "Wrong answer report",
                                    color: COLORS.ERROR,
                                    fields: [
                                        { name: "User", value: `${btnInteraction.user.tag} (${btnInteraction.user.id})` },
                                        { name: "Detected country", value: `${compareData.country} (${compareData.diff} diff)` },
                                        { name: "Bot", value: config.dex },
                                        { name: "Target Spawn URL", value: message.attachments.first().url },
                                    ],
                                    thumbnail: { url: imageUrl },
                                    timestamp: new Date().toISOString(),
                                }],
                            }));
                            form.append("file", imageBuffer, message.attachments.first().name || `${message.id}.png`);
                            await fetch(webhookUrl, { method: "POST", body: form });
                        } catch (e) {
                            console.error("Error sending report:", e);
                        }
                    }
                    
                    client.reportCooldowns.set(btnInteraction.user.id, now);
                    await btnInteraction.reply({
                        content: "Report sent. Thank you!",
                        flags: MessageFlags.Ephemeral,
                    });
                });
            } else {
                await interaction.editReply({ embeds: [embed] });
            }

            // Update user stats for good matches
            if (compareData.diff <= 15) {
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
                            embeds: [{
                                title: "Identify Command Error",
                                description: error.stack || String(error),
                                color: 0xff0000,
                                timestamp: new Date().toISOString(),
                            }],
                        }),
                    });
                } catch (e) {}
            }
            
            // Re-throw to let the error handler catch it
            throw error;
        }
    },
};
