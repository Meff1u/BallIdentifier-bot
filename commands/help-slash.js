const {
    SlashCommandBuilder,
    EmbedBuilder,
    MessageFlags,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require("discord.js");
const { version, dependencies } = require("../package.json");

// Import shared utilities
const { COLORS, SUPPORTED_BOT_IDS, BOT_NAMES } = require("../utils/constants");
const { readJsonFile, formatDuration, isUpvoter, getAssetsPath } = require("../utils/helpers");

const DATA_PATH = getAssetsPath("data.json");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("help")
        .setDescription("Useful information about the bot."),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const { client, user } = interaction;

        // Fetch data in parallel
        const [app, guilds] = await Promise.all([
            client.application.fetch(),
            client.guilds.fetch(),
        ]);

        // Read user data
        const data = readJsonFile(DATA_PATH, { users: {} });
        const users = data.users || {};
        const guildData = data.guilds || {};
        const usersIdentified = Object.values(users).reduce(
            (acc, u) => acc + (u.identifyAmount || 0),
            0,
        );
        const guildsIdentified = Object.values(guildData).reduce(
            (acc, g) => acc + (g.identifyAmount || 0),
            0,
        );
        const identifiedBalls = usersIdentified + guildsIdentified;

        const isUserUpvoted = isUpvoter(client.upvotes, user.id);
        const supportedBotsList = SUPPORTED_BOT_IDS.map((botId) => BOT_NAMES[botId])
            .filter(Boolean)
            .map((name) => `- ${name}`)
            .join("\n");

        const embed = new EmbedBuilder()
            .setTitle("BallIdentifier")
            .setFooter({
                text: `v${version} by @meffiu | discord.js ${dependencies["discord.js"].replace("^", "")}`,
            })
            .setColor(COLORS.LOG)
            .addFields(
                {
                    name: "Supported Bots",
                    value: supportedBotsList || "- None configured",
                    inline: true,
                },
                {
                    name: "Statistics",
                    value: [
                        `- **Uptime:** ${formatDuration(client.uptime)}`,
                        `- **Approximate user count:** ${Math.max(app.approximateUserInstallCount, Object.keys(users).length)}`,
                        `- **Guilds:** ${guilds.size}`,
                        `- **Identified balls:** ${identifiedBalls}`,
                        `- **Upvoted:** ${isUserUpvoted ? "✅" : "❌"}`,
                    ].join("\n"),
                    inline: true,
                },
                {
                    name: "Links",
                    value: "[GitHub Repository](https://github.com/Meff1u/BallIdentifier-bot)\n[Website](https://ballidentifier.xyz)",
                    inline: false,
                },
                {
                    name: "How to Use",
                    value: 'Right-click on a message with an image from one of the supported bots and select "Identify" (image below)',
                    inline: true,
                },
            )
            .setImage(
                "https://github.com/Meff1u/BallIdentifier-bot/blob/main/assets/tutorial.png?raw=true",
            );

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel("Changelogs")
                .setStyle(ButtonStyle.Secondary)
                .setCustomId("changelogs"),
            new ButtonBuilder()
                .setLabel("Buy me a coffee")
                .setStyle(ButtonStyle.Link)
                .setURL("https://paypal.me/meffiu"),
            new ButtonBuilder()
                .setLabel("Upvote Me")
                .setStyle(ButtonStyle.Link)
                .setURL("https://discordbotlist.com/bots/ballidentifier/upvote"),
        );

        await interaction.editReply({
            embeds: [embed],
            components: [row],
            flags: MessageFlags.Ephemeral,
        });
    },
};
