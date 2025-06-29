const { SlashCommandBuilder, MessageFlags } = require("discord.js");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("refresh")
        .setDescription("Refreshes bot's hash data, upvotes, and DBL stats (admin only)."),
    async execute(interaction) {
        if (
            interaction.guildId !== "379676234566729742" ||
            interaction.user.id !== "334411435633541121"
        ) {
            return interaction.reply({ content: "No permissions.", flags: MessageFlags.Ephemeral });
        }

        let content = "Starting refresh...";
        await interaction.reply({ content, flags: MessageFlags.Ephemeral });

        // Step 1: Refresh Hashes
        try {
            await interaction.client.fetchHashes();
            content += "\n✅ Hashes and rarities refreshed.";
        } catch (err) {
            content += `\n❌ Failed to refresh hashes: ${err.message}`;
            await interaction.editReply({ content });
            return;
        }
        await interaction.editReply({ content });

        // Step 2: Refresh Upvotes
        try {
            await interaction.client.fetchUpvotes();
            content += "\n✅ Upvotes refreshed.";
        } catch (err) {
            content += `\n❌ Failed to refresh upvotes: ${err.message}`;
            await interaction.editReply({ content });
            return;
        }
        await interaction.editReply({ content });

        // Step 3: Post DBL Stats
        try {
            await interaction.client.postDBLStats();
            content += "\n✅ DBL stats posted.";
        } catch (err) {
            content += `\n❌ Failed to post DBL stats: ${err.message}`;
            await interaction.editReply({ content });
            return;
        }
        await interaction.editReply({ content });
    },
};
