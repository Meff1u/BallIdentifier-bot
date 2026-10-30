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
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
} = require("discord.js");

// Import shared utilities
const { SUPPORTED_BOT_IDS, BOT_DATA_KEYS, BOT_NAMES, COOLDOWN_DURATION, COLORS } = require("../utils/constants");
const {
    getData,
    updateData,
    isUpvoter,
    checkCooldown,
    setCooldown,
    processImageHash,
    downloadBuffer,
    findBestMatch,
    getMatchThreshold,
    getSpawnMessageData,
    buildBallImageUrl,
    sendThreadReport,
} = require("../utils/helpers");



module.exports = {
    data: new ContextMenuCommandBuilder().setName("Identify").setType(ApplicationCommandType.Message).setContexts(InteractionContextType.Guild),

    async execute(interaction) {
        const { client, user, targetMessage: message } = interaction;

        // Validate message first, so a wrong target doesn't cost the user their cooldown
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

        const spawnData = getSpawnMessageData(message);
        if (!spawnData.isSpawn || message.content.includes("Caught on")) {
            return interaction.reply({
                content: "This message doesn't appear to be a spawn message.",
                flags: MessageFlags.Ephemeral,
            });
        }

        const config = { dex: BOT_NAMES[message.author.id], dKey: BOT_DATA_KEYS[message.author.id] };
        const hashes = client.hashes?.[config.dKey];
        if (!hashes) {
            return interaction.reply({
                content: `${config.dex} data is still loading, try again in a moment.`,
                flags: MessageFlags.Ephemeral,
            });
        }

        // Check upvoter status and cooldown (only for valid spawn messages)
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

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            // Process image and get hash (the downloaded spawn image is reused for the report)
            const { hash, buffer: spawnImageBuffer } = await processImageHash(spawnData.imageUrl);

            // Find best match
            const bestMatch = findBestMatch(hash, hashes);
            const minDiff = getMatchThreshold(bestMatch.country);
            const isConfident = bestMatch.diff <= minDiff;

            // Determine log color based on confidence
            const logColor = bestMatch.diff <= 10 ? COLORS.SUCCESS : bestMatch.diff <= 15 ? COLORS.WARNING : bestMatch.diff <= 20 ? 0xe69138 : COLORS.ERROR;

            const imageUrl = buildBallImageUrl(config.dex, bestMatch.country);
            const ballData = client.rarities?.[config.dKey]?.[bestMatch.country];
            const rarity = ballData?.rarity;
            const artist = ballData?.artist || "Unknown";
            const rarityText = rarity !== undefined ? `t${rarity}` : "Not found";

            // Update user stats for confident matches (atomic read-modify-write)
            const identifyAmount = isConfident
                ? updateData((data) => {
                      data.users[user.id] ??= {};
                      data.users[user.id].identifyAmount = (data.users[user.id].identifyAmount || 0) + 1;
                      return data.users[user.id].identifyAmount;
                  })
                : getData().users[user.id]?.identifyAmount || 0;

            // Log the identification
            client.sendLog({
                title: "Identify Log",
                fields: [
                    { name: "User", value: `<@${user.id}> (${user.tag})`, inline: false },
                    {
                        name: "Details",
                        value: `- **Dex:** ${config.dex}\n- **Country:** ${bestMatch.country}\n- **Diff:** ${bestMatch.diff}\n- **Rarity:** ${rarityText}`,
                        inline: false,
                    },
                ],
                thumbnail: imageUrl,
                image: isConfident ? null : spawnData.imageUrl,
                color: logColor,
            }).catch((e) => console.error("[IDENTIFY] Failed to send log:", e.message));

            // Create result embed
            const embed = new EmbedBuilder()
                .setColor(logColor)
                .setTitle(bestMatch.country)
                .setDescription(
                    `**Similarity:** \`${100 - bestMatch.diff}%\`\n**Rarity:** \`${rarityText}\`\n**Artist:** \`${artist}\``,
                );

            embed.setFooter({ text: `You have identified ${identifyAmount} balls!` });

            // Add auto-report notice for low confidence results
            if (!isConfident) {
                embed.addFields({
                    name: "⚠️ Auto-Report Status",
                    value: "Low confidence match detected - automatically reported for verification",
                });
            }

            // Reply with result embed
            await interaction.editReply({ embeds: [embed] });

            // Auto-report low confidence results
            if (!isConfident) {
                try {
                    const matchImageBuffer = await downloadBuffer(imageUrl);

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

                    // Build media gallery with both images
                    container.addMediaGalleryComponents(
                        new MediaGalleryBuilder().addItems(
                            new MediaGalleryItemBuilder().setURL("attachment://spawn.png").setDescription("Detected Spawn Art"),
                            new MediaGalleryItemBuilder().setURL("attachment://match.png").setDescription("Best Matching Entry"),
                        ),
                    );

                    // Send report to thread
                    await sendThreadReport(client, config.dex, container, {
                        dexKey: config.dKey,
                        bestMatch: bestMatch.country,
                        files: [
                            { attachment: spawnImageBuffer, name: "spawn.png" },
                            { attachment: matchImageBuffer, name: "match.png" },
                        ],
                    });
                } catch (e) {
                    console.error("[IDENTIFY] Error sending auto-report:", e);
                }
            }
        } catch (error) {
            // interactionCreate logs it to the Errors thread
            throw error;
        }
    },
};
