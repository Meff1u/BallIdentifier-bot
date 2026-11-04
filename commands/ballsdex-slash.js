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
    isLinked,
    needsReconnect,
    getStoredCollection,
    startSync,
    computeRaws,
    getCompletion,
} = require("../utils/ballsdex");
const specialsApi = require("../utils/specials");

const SUBCOMMAND_COOLDOWNS = {
    link: 20 * 1000,
    unlink: 20 * 1000,
    collection: 5 * 60 * 1000,
    raws: 30 * 1000,
    completion: 30 * 1000,
    specials: 10 * 1000,
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

const SITE_URL = "https://ballidentifier.xyz";
const specialLabel = (special) => special.alias || special.name || `Special #${special.id}`;
/** Unicode emoji only: custom Discord emoji can't be shown reliably outside their server */
const specialEmoji = (special) => special.emoji || (special.officialEmoji && !/^<a?:/.test(special.officialEmoji) ? special.officialEmoji : "");
const customEmojiUrl = (special) => {
    const match = /^<a?:\w+:(\d+)>$/.exec(special.officialEmoji || "");
    return match ? `https://cdn.discordapp.com/emojis/${match[1]}.webp?size=128` : null;
};
const priceOf = (special) => {
    const avg = special.priceAverage;
    const high = special.priceHighest;
    if (avg && high && avg !== high) return `${avg} avg · ${high} highest`;
    return avg || high || null;
};

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
        .addSubcommand((subcommand) => subcommand.setName("link").setDescription("Connect your Ballsdex account (Sign in with Ballsdex)."))
        .addSubcommand((subcommand) => subcommand.setName("unlink").setDescription("Disconnect your Ballsdex account."))
        .addSubcommand((subcommand) => subcommand.setName("collection").setDescription("View your saved Ballsdex collection summary."))
        .addSubcommand((subcommand) => subcommand.setName("sync").setDescription("Synchronize your Ballsdex collection to BallIdentifier."))
        .addSubcommand((subcommand) => subcommand.setName("raws").setDescription("Value of your rare (T1-T23) non-special balls."))
        .addSubcommand((subcommand) =>
            subcommand
                .setName("completion")
                .setDescription("Which Ballsdex balls you own and which are missing (straight from Ballsdex, no sync needed).")
                .addStringOption((option) => option.setName("special").setDescription("Only for this special").setAutocomplete(true)),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName("specials")
                .setDescription("Ballsdex specials: prices, event details and market.")
                .addStringOption((option) => option.setName("special").setDescription("A special to look at (leave empty for the list)").setAutocomplete(true)),
        ),

    async autocomplete(interaction) {
        const query = String(interaction.options.getFocused() || "").toLowerCase().replace(/^#/, "");
        try {
            const { specials } = await specialsApi.getSpecials();
            const choices = specials
                .filter((item) => !query || String(item.id) === query || [item.name, item.alias].some((value) => value?.toLowerCase().includes(query)))
                .slice(0, 25)
                .map((item) => ({ name: `${specialLabel(item)} (#${item.id})`.slice(0, 100), value: String(item.id) }));
            await interaction.respond(choices);
        } catch {
            await interaction.respond([]).catch(() => {});
        }
    },

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
            // Sign in with Ballsdex happens on the website (it needs a browser for the Ballsdex consent screen)
            const reconnect = needsReconnect(interaction.user.id);
            const linkButton = new ButtonBuilder()
                .setURL("https://ballidentifier.xyz/ballsdex?connect=1")
                .setLabel(reconnect ? "Sign in again" : "Sign in with Ballsdex")
                .setStyle(ButtonStyle.Link);
            const container = new ContainerBuilder()
                .setAccentColor(0xa020f0)
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(reconnect ? "# Reconnect your Ballsdex account" : "# Link your Ballsdex account"))
                .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        (reconnect ? "Ballsdex replaced API keys with **Sign in with Ballsdex**, so your old key no longer works. Your synced stats are still here.\n\n" : "") +
                            "Open the website, log in with Discord and press **Sign in with Ballsdex**. Ballsdex asks you to allow BallIdentifier to read your collection, and that's it: no key to copy.",
                    ),
                )
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        "-# BallIdentifier only gets read access, and the sign-in is stored encrypted. Remove it any time with **/ballsdex unlink**.",
                    ),
                )
                .addActionRowComponents(new ActionRowBuilder().addComponents(linkButton));

            return interaction.reply({
                components: [container],
                flags: [MessageFlags.Ephemeral, MessageFlags.IsComponentsV2],
            });
        }

        if (subcommand === "unlink") {
            if (!isLinked(interaction.user.id)) {
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
                content: "Disconnect your Ballsdex account? BallIdentifier's access and your saved collection data are removed. This cannot be undone.",
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
                    RECONNECT: "Ballsdex replaced API keys with Sign in with Ballsdex. Reconnect your account with `/ballsdex link` first.",
                    DISABLED: "Syncing is temporarily disabled by the administrators. Try again later.",
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
                    "You'll get a notification when it finishes; follow the progress on https://ballidentifier.xyz/ballsdex",
                components: [new ActionRowBuilder().addComponents(cancelButton)],
                flags: MessageFlags.Ephemeral,
            });
        }

        if (subcommand === "completion") {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const userId = interaction.user.id;
            if (!isLinked(userId)) return interaction.editReply({ content: "Link your Ballsdex account first with `/ballsdex link`." });
            if (needsReconnect(userId)) return interaction.editReply({ content: "Reconnect your Ballsdex account with `/ballsdex link` first." });
            const raw = interaction.options.getString("special");
            const specialId = /^\d{1,6}$/.test(raw || "") ? Number(raw) : null;
            try {
                const [completion, list] = await Promise.all([getCompletion(userId, { specialId }), specialId ? specialsApi.getSpecials().catch(() => null) : null]);
                const special = specialId ? list?.specials?.find((item) => item.id === specialId) : null;
                const percent = Number.isFinite(completion.percent) ? completion.percent : completion.total ? (completion.ownedCount / completion.total) * 100 : 0;
                const percentText = `${percent.toFixed(percent >= 99.95 || percent === 0 ? 0 : 1)}%`;
                const fmt = (n) => n.toLocaleString("en-US");
                let missing = "";
                let shown = 0;
                for (const ball of completion.missing) {
                    const piece = `${shown ? ", " : ""}${ball.name}`;
                    if (missing.length + piece.length > 2600) break;
                    missing += piece;
                    shown++;
                }
                const hidden = completion.missing.length - shown;
                const container = new ContainerBuilder()
                    .setAccentColor(0xa020f0)
                    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# Completion${special ? ` · ${specialEmoji(special)} ${specialLabel(special)}`.replace("  ", " ") : ""}`))
                    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${percentText}** · \`${fmt(completion.ownedCount)}\` of \`${fmt(completion.total)}\` owned · \`${fmt(completion.missingCount)}\` missing`))
                    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(completion.missing.length ? `**Missing**\n${missing}${hidden > 0 ? `\n-# …and ${fmt(hidden)} more on the website` : ""}` : "Nothing missing. Well done!"),
                    )
                    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(`-# Updated <t:${Math.floor(new Date(completion.updatedAt).getTime() / 1000)}:R> · straight from the Ballsdex API · ${SITE_URL}/ballsdex/completion`),
                    );
                return interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
            } catch (error) {
                if (!error.ballsdexApi) console.error("[BALLSDEX] Completion failed:", error.message);
                return interaction.editReply({ content: error.ballsdexApi || error.code === "RECONNECT" ? error.message : "Couldn't reach the Ballsdex API. Try again in a moment." });
            }
        }

        if (subcommand === "specials") {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            try {
                const data = await specialsApi.getSpecials();
                const query = (interaction.options.getString("special") || "").trim().toLowerCase().replace(/^#/, "");
                if (!query) {
                    let text = "";
                    let shown = 0;
                    for (const item of data.specials) {
                        const line = `${specialEmoji(item) ? `${specialEmoji(item)} ` : ""}**${specialLabel(item)}**${priceOf(item) ? ` · ${priceOf(item)}` : ""}\n`;
                        if (text.length + line.length > 3300) break;
                        text += line;
                        shown++;
                    }
                    const container = new ContainerBuilder()
                        .setAccentColor(0xa020f0)
                        .addTextDisplayComponents(new TextDisplayBuilder().setContent("# Ballsdex specials"))
                        .addTextDisplayComponents(new TextDisplayBuilder().setContent(text || "No specials loaded yet."))
                        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
                        .addTextDisplayComponents(
                            new TextDisplayBuilder().setContent(
                                `-# Prices are in commons (average · highest), community estimates. Pick one with the **special** option for details${shown < data.specials.length ? `; ${data.specials.length - shown} more on` : ". All on"} ${SITE_URL}/ballsdex/specials`,
                            ),
                        );
                    return interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
                }
                const special =
                    data.specials.find((item) => String(item.id) === query) ||
                    data.specials.find((item) => [item.name, item.alias].some((value) => value?.toLowerCase() === query)) ||
                    data.specials.find((item) => [item.name, item.alias].some((value) => value?.toLowerCase().includes(query)));
                if (!special) return interaction.editReply({ content: "No special matches that. Start typing in the **special** option to pick one." });

                const facts = [];
                if (special.tradeable === false || special.priceAverage === "Untradable") facts.push("- 🔒 Untradeable");
                const price = priceOf(special);
                if (price && special.priceAverage !== "Untradable") facts.push(`- Common price: **${price}**`);
                if (special.spawnRate) facts.push(`- Spawn rate: ${special.spawnRate}`);
                if (special.duration) facts.push(`- Duration: ${special.duration}`);
                const stamp = (value) => (value && Number.isFinite(Date.parse(value)) ? `<t:${Math.floor(Date.parse(value) / 1000)}:D>` : null);
                if (stamp(special.startDate)) facts.push(`- Event: ${stamp(special.startDate)}${stamp(special.endDate) ? ` to ${stamp(special.endDate)}` : ""}`);
                if (special.availableCount) facts.push(`- Can appear on \`${special.availableCount.toLocaleString("en-US")}\` balls`);
                const market = [];
                if (special.market?.recent) market.push(`- Last ${data.marketWindowDays || 30} days: \`${special.market.recent.sales}\` sales, median \`${special.market.recent.median?.toLocaleString("en-US")}\``);
                if (special.market?.all) market.push(`- All time: \`${special.market.all.sales}\` sales, median \`${special.market.all.median?.toLocaleString("en-US")}\``);

                const emoji = specialEmoji(special);
                const head = new TextDisplayBuilder().setContent(
                    `# ${emoji ? `${emoji} ` : ""}${specialLabel(special)}\n-# ${special.alias && special.name && special.alias !== special.name ? `${special.name} · ` : ""}#${special.id}`,
                );
                const container = new ContainerBuilder().setAccentColor(0xa020f0);
                const thumb = customEmojiUrl(special);
                if (thumb) container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(head).setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb)));
                else container.addTextDisplayComponents(head);
                container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
                container.addTextDisplayComponents(new TextDisplayBuilder().setContent(facts.length ? facts.join("\n") : "-# No details saved for this special yet."));
                if (special.notes) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`> ${String(special.notes).replace(/\n/g, "\n> ").slice(0, 600)}`));
                if (market.length) {
                    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
                    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Market**\n${market.join("\n")}`));
                }
                container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Prices are in commons, community estimates · ${SITE_URL}/ballsdex/specials/${special.id}`));
                return interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
            } catch (error) {
                if (!error.ballsdexApi) console.error("[BALLSDEX] Specials failed:", error.message);
                return interaction.editReply({ content: "Couldn't load the specials right now. Try again in a moment." });
            }
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
                                `-# Last synced <t:${syncedAt}:R> · full list on https://ballidentifier.xyz/ballsdex/raws`,
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