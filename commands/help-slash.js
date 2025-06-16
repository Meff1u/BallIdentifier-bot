const { SlashCommandBuilder, EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { version } = require("../package.json");
const fs = require("fs");
const path = require("path");

module.exports = {
    data: new SlashCommandBuilder().setName("help").setDescription("Useful informations."),
    async execute(interaction) {
        const app = await interaction.client.application.fetch();
        const dataPath = path.join(__dirname, "../assets/data.json");
        const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
        const users = data.users || {};
        const identifyAmount = Object.values(users).reduce(
            (acc, user) => acc + user.identifyAmount,
            0
        );
        const uptimeMs = interaction.client.uptime;

        function formatUptime(ms) {
            const sec = Math.floor((ms / 1000) % 60);
            const min = Math.floor((ms / (1000 * 60)) % 60);
            const hr = Math.floor((ms / (1000 * 60 * 60)) % 24);
            const d = Math.floor(ms / (1000 * 60 * 60 * 24));
            return `${d > 0 ? d + "d " : ""}${hr > 0 ? hr + "h " : ""}${
                min > 0 ? min + "m " : ""
            }${sec}s`;
        }

        const embed = new EmbedBuilder()
            .setTitle("BallIdentifier")
            .setFooter({ text: `v${version} by @meffiu` })
            .setColor("#6839A6")
            .addFields(
                {
                    name: "Supported Bots",
                    value: "- Ballsdex\n- DynastyDex\n- Empireballs\n- HistoryDex",
                    inline: true,
                },
                {
                    name: "Statistics",
                    value: `- **Uptime:** ${formatUptime(
                        uptimeMs
                    )}\n- **Approximate user count:** ${Math.max(
                        app.approximateUserInstallCount,
                        Object.values(users).length
                    )}\n- **Identified balls:** ${identifyAmount}`,
                    inline: true,
                },
                {
                    name: "More Information",
                    value: "[GitHub Repository](https://github.com/Meff1u/BallIdentifier-bot)\n[Website](https://ballidentifier.xyz)",
                    inline: false,
                },
                {
                    name: "How to Use",
                    value: 'Right-click on a message with an image from one of the supported bots and select "Identify" (image below)',
                    inline: true,
                }
            )
            .setImage(
                "https://github.com/Meff1u/BallIdentifier-bot/blob/main/assets/tutorial.png?raw=true"
            );

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel("Buy me a coffee")
                .setStyle(ButtonStyle.Link)
                .setURL("https://buycoffee.to/meffiu"),
            new ButtonBuilder()
                .setLabel("Upvote Me")
                .setStyle(ButtonStyle.Link)
                .setURL("https://discordbotlist.com/bots/ballidentifier/upvote")
        );

        await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
    },
};
