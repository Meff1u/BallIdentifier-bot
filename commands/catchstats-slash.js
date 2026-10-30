/**
 * /catchstats — catch times on servers with Catch stats turned on (website: Bot -> Catch stats).
 *   /catchstats me [user]          your stats (or another user's, if they made them public)
 *   /catchstats server [period]    fastest catchers of this server (only users with public stats)
 *   /catchstats settings [public] [tracking]   make your stats public / stop being tracked (deletes your data)
 * Also handles the buttons under catch replies: "My stats" and "Don't track me".
 */

const {
    SlashCommandBuilder,
    InteractionContextType,
    MessageFlags,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require("discord.js");
const catchStats = require("../utils/catch-stats");
const { COLORS } = require("../utils/constants");

const { formatMs } = catchStats;
const PERIOD_LABELS = { all: "all time", "30d": "last 30 days", "7d": "last 7 days" };
const SITE = "https://ballidentifier.xyz/bot/catch-stats";

const container = (...blocks) => {
    const box = new ContainerBuilder().setAccentColor(COLORS.PRIMARY);
    blocks.filter(Boolean).forEach((text, index) => {
        if (index) box.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
        box.addTextDisplayComponents(new TextDisplayBuilder().setContent(text.slice(0, 3900)));
    });
    return box;
};

async function statsView(userId, { self }) {
    const { settings, all, last30, last7 } = await catchStats.getUserStats(userId);
    const who = self ? "Your" : `<@${userId}>'s`;
    if (!all) {
        return container(
            `## ${who} catch stats`,
            self
                ? settings.tracking
                    ? "No catches tracked yet. Catch stats only count on servers where an admin turned them on."
                    : "You're not tracked (you opted out). Turn it back on with `/catchstats settings tracking:True`."
                : "No catches tracked yet.",
        );
    }
    const line = (label, value) => `- ${label}: **${value}**`;
    const balls = (list) => list.map((b) => `  - ${b.ball}: avg ${formatMs(b.averageMs)} · best ${formatMs(b.bestMs)} · ${b.count}×`).join("\n");
    return container(
        `## ${who} catch stats`,
        [
            line("Catches", all.count.toLocaleString("en-US")),
            line("Average", formatMs(all.averageMs)),
            line("Fastest", `${formatMs(all.bestMs)}${all.best ? ` (${all.best.ball})` : ""}`),
            line("Last 30 days", last30.count ? `${last30.count} catches · avg ${formatMs(last30.averageMs)} · best ${formatMs(last30.bestMs)}` : "no catches"),
            line("Last 7 days", last7.count ? `${last7.count} catches · avg ${formatMs(last7.averageMs)} · best ${formatMs(last7.bestMs)}` : "no catches"),
        ].join("\n"),
        all.fastestBalls.length ? `**Fastest balls** (3+ catches)\n${balls(all.fastestBalls)}` : null,
        self ? `-# Your stats are **${settings.public ? "public" : "private"}**. Change it with /catchstats settings or on ${SITE}` : null,
    );
}

function boardView(board, title) {
    const row = (entry, index, value) => `${index + 1}. ${entry.name ? `**${entry.name}**` : `<@${entry.userId}>`} · ${value}`;
    return container(
        `## ${title}`,
        `**Fastest catch**\n${board.fastest.length ? board.fastest.map((e, i) => row(e, i, `${formatMs(e.bestMs)}`)).join("\n") : "Nobody yet."}`,
        `**Best average** (${board.minCount}+ catches)\n${board.average.length ? board.average.map((e, i) => row(e, i, `${formatMs(e.averageMs)} over ${e.count}`)).join("\n") : "Nobody yet."}`,
        `-# Only users who made their catch stats public are listed (/catchstats settings public:True). More on ${SITE}`,
    );
}

const v2 = (box, ephemeral = true) => ({ components: [box], flags: ephemeral ? [MessageFlags.Ephemeral, MessageFlags.IsComponentsV2] : [MessageFlags.IsComponentsV2], allowedMentions: { parse: [] } });

module.exports = {
    data: new SlashCommandBuilder()
        .setName("catchstats")
        .setDescription("Your Ballsdex catch times on servers with Catch stats turned on.")
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addSubcommand((sub) =>
            sub
                .setName("me")
                .setDescription("Your catch stats (or another user's, if public).")
                .addUserOption((option) => option.setName("user").setDescription("Someone else (only if their stats are public)")),
        )
        .addSubcommand((sub) =>
            sub
                .setName("server")
                .setDescription("Fastest catchers of this server (users with public stats).")
                .addStringOption((option) =>
                    option.setName("period").setDescription("Time range").addChoices({ name: "All time", value: "all" }, { name: "Last 30 days", value: "30d" }, { name: "Last 7 days", value: "7d" }),
                ),
        )
        .addSubcommand((sub) =>
            sub
                .setName("settings")
                .setDescription("Make your catch stats public, or stop being tracked.")
                .addBooleanOption((option) => option.setName("public").setDescription("Show your stats on your profile and in rankings"))
                .addBooleanOption((option) => option.setName("tracking").setDescription("False: stop tracking you and delete your catch data")),
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        try {
            if (sub === "me") {
                const target = interaction.options.getUser("user") || interaction.user;
                const self = target.id === interaction.user.id;
                if (!self && !catchStats.userSettings(target.id).public) {
                    return interaction.reply({ content: "Their catch stats are private.", flags: MessageFlags.Ephemeral });
                }
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                return interaction.editReply(v2(await statsView(target.id, { self })));
            }

            if (sub === "server") {
                if (!interaction.guildId) return interaction.reply({ content: "Use this on a server.", flags: MessageFlags.Ephemeral });
                const period = interaction.options.getString("period") || "30d";
                await interaction.deferReply();
                const board = await catchStats.leaderboard({ period, guildId: interaction.guildId });
                const enabled = catchStats.guildConfig(interaction.guildId).enabled;
                const box = boardView(board, `Fastest catchers · ${interaction.guild?.name || "this server"} · ${PERIOD_LABELS[period]}`);
                if (!enabled) box.addTextDisplayComponents(new TextDisplayBuilder().setContent("-# Catch stats are turned off on this server. An admin can turn them on on the website."));
                return interaction.editReply({ components: [box], flags: [MessageFlags.IsComponentsV2], allowedMentions: { parse: [] } });
            }

            if (sub === "settings") {
                const changes = {};
                const isPublic = interaction.options.getBoolean("public");
                const tracking = interaction.options.getBoolean("tracking");
                if (isPublic !== null) changes.public = isPublic;
                if (tracking !== null) changes.tracking = tracking;
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const before = catchStats.userSettings(interaction.user.id);
                const after = Object.keys(changes).length ? await catchStats.setUserSettings(interaction.user.id, changes) : before;
                const notes = [];
                if (before.tracking && !after.tracking) notes.push("Your catch data was deleted and new catches aren't tracked.");
                if (!before.tracking && after.tracking) notes.push("Your catches are tracked again from now on.");
                return interaction.editReply({
                    content: [`Tracking: **${after.tracking ? "on" : "off"}** · Visibility: **${after.public ? "public" : "private"}**`, ...notes].join("\n"),
                });
            }
        } catch (error) {
            interaction.client.logError?.("/catchstats failed", error);
            const reply = { content: "Catch stats are unavailable right now. Try again later.", flags: MessageFlags.Ephemeral };
            return interaction.deferred || interaction.replied ? interaction.editReply(reply) : interaction.reply(reply);
        }
    },

    /** Buttons under catch replies. Returns true when handled. */
    async handleButton(interaction) {
        const action = interaction.customId.split(":")[1];
        if (action === "me") {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            await interaction.editReply(v2(await statsView(interaction.user.id, { self: true })));
            return true;
        }
        if (action === "optout") {
            const settings = catchStats.userSettings(interaction.user.id);
            if (!settings.tracking) {
                await interaction.reply({ content: "You're already not tracked. Turn it back on with `/catchstats settings tracking:True`.", flags: MessageFlags.Ephemeral });
                return true;
            }
            await interaction.reply({
                content: "Stop tracking your catches? Your catch data is deleted right away, and the bot won't answer your catches anymore.",
                components: [
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId("catchstats:optout-yes").setLabel("Stop and delete").setStyle(ButtonStyle.Danger),
                        new ButtonBuilder().setCustomId("catchstats:optout-no").setLabel("Keep tracking").setStyle(ButtonStyle.Secondary),
                    ),
                ],
                flags: MessageFlags.Ephemeral,
            });
            return true;
        }
        if (action === "optout-yes") {
            await interaction.deferUpdate();
            await catchStats.setUserSettings(interaction.user.id, { tracking: false });
            interaction.client.log?.("CATCHES", `🔕 <@${interaction.user.id}> opted out of Catch stats`);
            await interaction.editReply({ content: "Done: your catch data was deleted and you're not tracked anymore. Changed your mind? `/catchstats settings tracking:True`", components: [] });
            return true;
        }
        if (action === "optout-no") {
            await interaction.update({ content: "Okay, your catches stay tracked.", components: [] });
            return true;
        }
        return false;
    },
};
