const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { version } = require("../package.json");
const { users } = require("../assets/data.json");

module.exports = {
    data: new SlashCommandBuilder().setName("help").setDescription("Useful informations."),
    async execute(interaction) {
        const app = await interaction.client.application.fetch();
        const identifyAmount = Object.values(users).reduce((acc, user) => acc + user.identifyAmount, 0);

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
                    value: `- **Approximate user count:** ${Math.max(app.approximateUserInstallCount, Object.values(users).length)}\n- **Identified balls:** ${identifyAmount}`,
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

        await interaction.reply({ embeds: [embed], ephemeral: true });
    },
};
