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
                "The notifier configuration has been moved to our **[Dashboard](https://ballidentifier.xyz/dashboard)**!\n\n" +
                "Please visit the dashboard to set up, view, or manage your notifier configuration."
            );

        await interaction.reply({
            embeds: [embed],
            flags: MessageFlags.Ephemeral,
        });
    },
};
