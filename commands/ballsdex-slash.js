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
    getSavedApiKey,
    getStoredCollection,
    startSync,
    computeRaws,
} = require("../utils/ballsdex");

const SUBCOMMAND_COOLDOWNS = {
    link: 20 * 1000,
    unlink: 20 * 1000,
    collection: 5 * 60 * 1000,
    raws: 30 * 1000,
};
const subcommandCooldowns = new Map();

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
        .addSubcommand((subcommand) => subcommand.setName("sync").setDescription("Synchronize your Ballsdex collection to BallIdentifier."))
        .addSubcommand((subcommand) => subcommand.setName("raws").setDescription("Value of your rare (T1-T23) non-special balls.")),

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
            const result = startSync(interaction.user.id);

            if (!result.started) {
                const left = result.retryAfterSec || 0;
                const minutes = Math.ceil(left / 60);
                const wait = `${Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)} h ` : ""}${minutes % 60} min`;
                const messages = {
                    NOT_LINKED: "Link your Ballsdex account first with `/ballsdex link`.",
                    IN_PROGRESS: "Your Ballsdex collection is already being synchronized.",
                    BUSY: "Someone else's collection is being synchronized right now (only one sync can run at a time). I'll notify you as soon as you can start yours.",
                    COOLDOWN: `You can sync again in ${wait}. Syncs are limited to one every 24 hours.`,
                };
                return interaction.reply({ content: messages[result.reason], flags: MessageFlags.Ephemeral });
            }

            const cancelButton = new ButtonBuilder()
                .setCustomId("ballsdex-sync:cancel")
                .setLabel("Cancel sync")
                .setStyle(ButtonStyle.Secondary);
            return interaction.reply({
                content:
                    "Your Ballsdex collection synchronization has started. Big collections take a while (about 1,500 balls a minute). " +
                    "You'll get a notification when it finishes; follow the progress on https://ballidentifier.xyz/#/ballsdex",
                components: [new ActionRowBuilder().addComponents(cancelButton)],
                flags: MessageFlags.Ephemeral,
            });
        }

        if (subcommand === "raws") {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            try {
                const stored = await getStoredCollection(interaction.user.id);
                if (!stored || !Array.isArray(stored.nonSpecial)) {
                    return interaction.editReply({
                        content: stored
                            ? "Your saved collection is from before raws existed. Run `/ballsdex sync` once to count them."
                            : "No saved Ballsdex collection was found. Run `/ballsdex sync` to import it.",
                    });
                }
                const rarityData = interaction.client.rarities?.BD;
                if (!rarityData) return interaction.editReply({ content: "Dex data is still loading, try again in a moment." });

                const raws = computeRaws(stored.nonSpecial, rarityData);
                const fmt = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
                const syncedAt = Math.floor(new Date(stored.lastSyncedAt).getTime() / 1000);
                const displayName = stored.summary?.displayName && stored.summary.displayName !== "Unknown" ? stored.summary.displayName : interaction.user.username;

                let tierText = "";
                for (const tier of raws.tiers) {
                    if (!tier.count) continue;
                    const owned = raws.rows.filter((row) => row.tier === tier.tier && row.count > 0);
                    const line =
                        `**T${tier.tier}** · ×${tier.value} · \`${fmt(tier.count)}\` balls = **${fmt(tier.total)}**\n` +
                        `-# ${owned.map((row) => `${row.name} ×${row.count}`).join(", ")}\n`;
                    if (tierText.length + line.length > 3300) {
                        tierText += "-# …more on the website\n";
                        break;
                    }
                    tierText += line;
                }

                const container = new ContainerBuilder()
                    .setAccentColor(0xa020f0)
                    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${displayName}'s raws`))
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            `**Total raws value: \`${fmt(raws.total)}\`**\n` +
                                `- Rare non-special balls (T1-T23): \`${fmt(raws.rareCount)}\`\n` +
                                `- Different rare balls owned: \`${raws.ownedKinds} / ${raws.kinds}\``,
                        ),
                    )
                    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
                    .addTextDisplayComponents(new TextDisplayBuilder().setContent(tierText || "You don't have any rare non-special balls yet."))
                    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            `-# Values: T1 1 · T4 0.8 · T6 0.75 · T7 0.5 · T10 0.4 · T12 0.25 · T15 0.2 · T18 0.15 · T19-T23 0.1\n` +
                                `-# Last synced <t:${syncedAt}:R> · full list on https://ballidentifier.xyz/#/ballsdex/raws`,
                        ),
                    );
                return interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
            } catch (error) {
                console.error("[BALLSDEX] Raws failed:", error);
                return interaction.editReply({ content: `Could not load your raws: ${error.message}` });
            }
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
                        `- Specials: \`${summary.specialCount.toLocaleString("en-US")}\`` +
                            (Number.isFinite(summary.specialKinds) && summary.specialKinds > 0 ? ` (${summary.specialKinds} different)\n` : "\n") +
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
                        `-# Last updated: <t:${syncedAt}:R> | Run **/ballsdex sync** to update your data.` +
                            (Array.isArray(storedCollection.nonSpecial) ? "" : "\n-# Saved before top 5 rankings existed: sync once to refresh them."),
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