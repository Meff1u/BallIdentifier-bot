/**
 * /catchstats — catch times on servers with Catch stats turned on (website: Bot -> Catch stats).
 *   /catchstats me [user]          your last 30 days (from your last Ballsdex sync) and your record (or another user's, if public)
 *   /catchstats global [period]    fastest catchers of everyone (only users with public stats; from Ballsdex syncs)
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
const PERIOD_LABELS = { "30d": "last 30 days", "7d": "last 7 days" };
const day = (date) => (date ? ` · set <t:${Math.floor(new Date(date).getTime() / 1000)}:D>` : "");
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
    const { settings, last30, last7, records, syncedAt } = await catchStats.getUserStats(userId);
    const who = self ? "Your" : `<@${userId}>'s`;
    if (!last30.count && !records.personal) {
        return container(
            `## ${who} catch stats`,
            self
                ? settings.tracking
                    ? "No catches found in your last Ballsdex sync. Run `/ballsdex sync` to update them."
                    : "You're not tracked (you opted out). Turn it back on with `/catchstats settings tracking:True`."
                : "No catches found.",
        );
    }
    const line = (label, value) => `- ${label}: **${value}**`;
    const balls = (list) => list.map((b) => `  - ${b.ball}: avg ${formatMs(b.averageMs)} · best ${formatMs(b.bestMs)} · ${b.count}×`).join("\n");
    return container(
        `## ${who} catch stats`,
        [
            line("Last 30 days", last30.count ? `${last30.count.toLocaleString("en-US")} catches · avg ${formatMs(last30.averageMs)} · best ${formatMs(last30.bestMs)}${last30.bestBall ? ` (${last30.bestBall.ball})` : ""}` : "no catches"),
            line("Last 7 days", last7.count ? `${last7.count} catches · avg ${formatMs(last7.averageMs)} · best ${formatMs(last7.bestMs)}` : "no catches"),
            records.personal ? line("Personal record", `${formatMs(records.personal.ms)} (${records.personal.ball})${day(records.personal.at)}`) : null,
        ]
            .filter(Boolean)
            .join("\n"),
        last30.fastestBalls.length ? `**Fastest balls, last 30 days** (3+ catches)\n${balls(last30.fastestBalls)}` : null,
        syncedAt ? `-# Last 30 / 7 days from the Ballsdex sync <t:${Math.floor(new Date(syncedAt).getTime() / 1000)}:R>. Sync again to refresh them.` : null,
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
                .setName("global")
                .setDescription("Fastest catchers of everyone (users with public stats, from Ballsdex syncs).")
                .addStringOption((option) =>
                    option.setName("period").setDescription("Time range").addChoices({ name: "Last 30 days", value: "30d" }, { name: "Last 7 days", value: "7d" }),
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

            if (sub === "global") {
                const period = interaction.options.getString("period") || "30d";
                await interaction.deferReply();
                const board = await catchStats.leaderboard({ period });
                return interaction.editReply({ components: [boardView(board, `Fastest catchers · ${PERIOD_LABELS[period]}`)], flags: [MessageFlags.IsComponentsV2], allowedMentions: { parse: [] } });
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
            interaction.client.log?.("CATCH_STATS", `🔕 <@${interaction.user.id}> opted out of Catch stats`);
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
