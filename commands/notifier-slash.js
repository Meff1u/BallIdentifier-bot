const {
    SlashCommandBuilder,
    MessageFlags,
    EmbedBuilder,
    InteractionContextType
} = require("discord.js");

// Import shared utilities
const { COLORS } = require("../utils/constants");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("notifier")
        .setDescription("Setup notifier configuration.")
        .setContexts(InteractionContextType.Guild),

    async execute(interaction) {
        const embed = new EmbedBuilder()
            .setColor(COLORS.INFO)
            .setTitle("🔔 Notifier Setup Moved")
            .setDescription(
                "The notifier is set up on the website, in the **[Bot tab](https://ballidentifier.xyz/#/bot/notifier)**.\n\n" +
                "Log in with Discord there to set up, view or change the notifier of a server you manage."
            );

        await interaction.reply({
            embeds: [embed],
            flags: MessageFlags.Ephemeral,
        });
    },
};
