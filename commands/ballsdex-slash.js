const {
    SlashCommandBuilder,
    InteractionContextType,
    MessageFlags,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    SectionBuilder,
    ThumbnailBuilder,
} = require("discord.js");

const {
    decryptApiKey,
    getSavedApiKey,
    getStoredCollection,
    syncCollection,
} = require("../utils/ballsdex");

const SUBCOMMAND_COOLDOWNS = {
    link: 20 * 1000,
    unlink: 20 * 1000,
    collection: 5 * 60 * 1000,
};
const subcommandCooldowns = new Map();
const syncsInProgress = new Set();

function getCooldownRemaining(userId, subcommand) {
    const key = `${userId}:${subcommand}`;
    const cooldown = SUBCOMMAND_COOLDOWNS[subcommand];
    if (!cooldown) return 0;
    const expiresAt = subcommandCooldowns.get(key) || 0;
    const remainingMs = expiresAt - Date.now();

    if (remainingMs <= 0) return 0;
    return Math.ceil(remainingMs / 1000);
}

function setSubcommandCooldown(userId, subcommand) {
    const cooldown = SUBCOMMAND_COOLDOWNS[subcommand];
    if (cooldown) subcommandCooldowns.set(`${userId}:${subcommand}`, Date.now() + cooldown);
}

function formatDuration(milliseconds) {
    if (!Number.isFinite(milliseconds)) return "Unavailable";

    const totalSeconds = milliseconds / 1000;
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours || days) parts.push(`${hours}h`);
    if (minutes || hours || days) parts.push(`${minutes}m`);
    parts.push(`${seconds.toFixed(3)}s`);
    return parts.join(" ");
}

function formatRanking(entries) {
    return entries.length
        ? entries.map(({ name, count }) => `  - ${name}: \`${count.toLocaleString("en-US")}\``).join("\n")
        : "  - None";
}

function formatSpecialBallRanking(entries) {
    return entries.length
    ? entries.map(({ name, count }) => `  - ${name}: \`${count.toLocaleString("en-US")}\``).join("\n")
        : "  - None";
}

function formatCatchRecord(record) {
    if (!record) return "Unavailable";
    const instanceId = record.instanceId ? `${BigInt(String(record.instanceId)).toString(16).toUpperCase()}` : null;
    const ball = instanceId ? `${record.ballName} (#${instanceId})` : record.ballName;
    return `${formatDuration(record.durationMs)} ${ball}`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName("ballsdex")
        .setDescription("Manage your Ballsdex API connection and collection.")
        .setContexts(InteractionContextType.BotDM, InteractionContextType.Guild, InteractionContextType.PrivateChannel)
        .addSubcommand((subcommand) => subcommand.setName("link").setDescription("Link your Ballsdex API key."))
        .addSubcommand((subcommand) => subcommand.setName("unlink").setDescription("Remove your linked Ballsdex API key."))
        .addSubcommand((subcommand) => subcommand.setName("collection").setDescription("View your saved Ballsdex collection summary."))
        .addSubcommand((subcommand) => subcommand.setName("sync").setDescription("Synchronize your Ballsdex collection to BallIdentifier.")),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const cooldownRemaining = getCooldownRemaining(interaction.user.id, subcommand);

        if (cooldownRemaining > 0) {
            return interaction.reply({
                content: `You can use **/ballsdex ${subcommand}** again in ${cooldownRemaining}s.`,
                flags: MessageFlags.Ephemeral,
            });
        }

        setSubcommandCooldown(interaction.user.id, subcommand);

        if (subcommand === "link") {
            const linkButton = new ButtonBuilder()
                .setCustomId("ballsdex-link:start")
                .setLabel("Link my Ballsdex Account")
                .setStyle(ButtonStyle.Primary);
            const container = new ContainerBuilder()
                .setAccentColor(0xa020f0)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent("# Link your Ballsdex Account"),
                )
                .addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
                )
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        "An API key lets BallIdentifier securely access data that Ballsdex only provides to the account owner. " +
                        "It is required for private features such as **/ballsdex collection**.",
                    ),
                )
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        "**Create an API key**\n" +
                        "1. Open [Ballsdex API Keys](https://ballsdex.com/api/keys).\n" +
                        "2. Log in with Discord.\n" +
                        "3. Create a key with **all five scopes** selected.\n" +
                        "4. Generate it and save it somewhere safe, then paste it in the form below.",
                    ),
                )
                .addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
                )
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        "-# Your key is encrypted before BallIdentifier stores it and is only used for Ballsdex API requests on your behalf. " +
                        "You can unlink your account and remove the stored key at any time with **/ballsdex unlink**.",
                    ),
                )
                .addActionRowComponents(new ActionRowBuilder().addComponents(linkButton));

            return interaction.reply({
                components: [container],
                flags: [MessageFlags.Ephemeral, MessageFlags.IsComponentsV2],
            });
        }

        if (subcommand === "unlink") {
            if (!getSavedApiKey(interaction.user.id)) {
                return interaction.reply({
                    content: "No Ballsdex account is currently linked.",
                    flags: MessageFlags.Ephemeral,
                });
            }

            const confirmButton = new ButtonBuilder()
                .setCustomId("ballsdex-unlink:confirm")
                .setLabel("Unlink account")
                .setStyle(ButtonStyle.Danger);
            const cancelButton = new ButtonBuilder()
                .setCustomId("ballsdex-unlink:cancel")
                .setLabel("Cancel")
                .setStyle(ButtonStyle.Secondary);

            return interaction.reply({
                content: "Remove your linked Ballsdex API key? This cannot be undone.",
                components: [new ActionRowBuilder().addComponents(confirmButton, cancelButton)],
                flags: MessageFlags.Ephemeral,
            });
        }

        if (subcommand === "sync") {
            const encryptedKey = getSavedApiKey(interaction.user.id);
            if (!encryptedKey) {
                return interaction.reply({
                    content: "Link your Ballsdex account first with `/ballsdex link`.",
                    flags: MessageFlags.Ephemeral,
                });
            }

            if (syncsInProgress.has(interaction.user.id)) {
                return interaction.reply({
                    content: "Your Ballsdex collection is already being synchronized.",
                    flags: MessageFlags.Ephemeral,
                });
            }

            syncsInProgress.add(interaction.user.id);
            await interaction.reply({
                content: "Your Ballsdex collection synchronization has started. This may take a while for large collections; I will send you a DM when it finishes.",
                flags: MessageFlags.Ephemeral,
            });

            void (async () => {
                try {
                    const apiKey = decryptApiKey(encryptedKey);
                    const result = await syncCollection(interaction.user.id, apiKey);
                    await interaction.user.send(
                        `Your Ballsdex collection sync is complete. ${result.ballCount.toLocaleString("en-US")} balls were updated.`,
                    );
                } catch (error) {
                    console.error("[BALLSDEX] Failed to sync collection:", error);
                    try {
                        await interaction.user.send(
                            `Your Ballsdex collection sync failed: ${error.status === 429 ? "the Ballsdex API rate limit was reached." : error.message}`,
                        );
                    } catch (dmError) {
                        console.error("[BALLSDEX] Failed to send sync failure DM:", dmError);
                    }
                } finally {
                    syncsInProgress.delete(interaction.user.id);
                }
            })();
            return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const storedCollection = await getStoredCollection(interaction.user.id);
            if (!storedCollection) {
                return interaction.editReply({
                    content: "No saved Ballsdex collection data was found. Run `/ballsdex sync` to import it.",
                });
            }

            const { summary } = storedCollection;
            const displayName = summary.displayName && summary.displayName !== "Unknown"
                ? summary.displayName
                : interaction.user.username;
            const topCountries = summary.topCountries || [];
            const topSpecials = summary.topSpecials || [];
            const topSpecialBalls = summary.topSpecialBalls || [];
            const syncedAt = Math.floor(new Date(storedCollection.lastSyncedAt).getTime() / 1000);
            const avatarUrl = interaction.user.displayAvatarURL({ extension: "png", size: 256 });

            const container = new ContainerBuilder()
                .setAccentColor(0xa020f0)
                .addSectionComponents(
                    new SectionBuilder()
                        .addTextDisplayComponents(
                            new TextDisplayBuilder().setContent(`# ${displayName}'s Ballsdex Collection`),
                        )
                        .setThumbnailAccessory(new ThumbnailBuilder().setURL(avatarUrl)),
                )
                .addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
                )
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `**Collection summary**\n` +
                        `- Total balls: \`${summary.totalBalls.toLocaleString("en-US")}\`\n` +
                        `- Unique balls: \`${summary.uniqueBalls.toLocaleString("en-US")}\`\n` +
                        `- Duplicates: \`${summary.duplicateCount.toLocaleString("en-US")}\`\n` +
                        `- Special variants: \`${summary.specialCount.toLocaleString("en-US")}\`\n` +
                        `- Self-caught: \`${summary.selfCaughtCount.toLocaleString("en-US")}\`\n` +
                        `- Favorites: \`${summary.favoriteCount.toLocaleString("en-US")}\`\n` +
                        `- Frames: \`${summary.frameCount.toLocaleString("en-US")}\``,
                    ),
                )
                .addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
                )
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `**Collection history**\n` +
                        `- First catch: ${summary.oldestCaughtAt ? `<t:${Math.floor(new Date(summary.oldestCaughtAt).getTime() / 1000)}:D>` : "Unknown"}\n` +
                        `- Latest catch: ${summary.newestCaughtAt ? `<t:${Math.floor(new Date(summary.newestCaughtAt).getTime() / 1000)}:D>` : "Unknown"}`,
                    ),
                )
                .addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
                )
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `**Rankings**\n` +
                        `- Most owned:\n${formatRanking(topCountries)}\n` +
                        `- Top specials:\n${formatRanking(topSpecials)}\n` +
                        `- Most specials:\n${formatSpecialBallRanking(topSpecialBalls)}`,
                    ),
                )
                .addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
                )
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `**Catch performance**\n` +
                        `- Fastest catch: \`${formatCatchRecord(summary.fastestCatch)}\`\n` +
                        `- Slowest catch: \`${formatCatchRecord(summary.slowestCatch)}\`\n` +
                        `- Average catch time: \`${formatDuration(summary.averageCatchMs)}\`\n` +
                        `- Timed catches: \`${summary.timedCatchCount.toLocaleString("en-US")}\``,
                    ),
                )
                .addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
                )
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `**Catch activity record**\n` +
                        `- Most catches in one day: \`${summary.mostActiveCatchCount.toLocaleString("en-US")}\` (${summary.mostActiveCatchDay ? `<t:${Math.floor(new Date(`${summary.mostActiveCatchDay}T00:00:00.000Z`).getTime() / 1000)}:D>` : "Unknown"})\n` +
                        `- Average interval that day: \`${formatDuration(summary.averageCatchIntervalMs)}\``,
                    ),
                )
                .addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
                )
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `-# Last updated: <t:${syncedAt}:R> | Run **/ballsdex sync** to update your data.`,
                    ),
                );

            return interaction.editReply({
                components: [container],
                flags: MessageFlags.IsComponentsV2,
            });
        } catch (error) {
            console.error("[BALLSDEX] Failed to load stored collection:", error);
            return interaction.editReply({
                content: `Could not load your saved Ballsdex collection: ${error.message}`,
            });
        }
    },
};