const { SlashCommandBuilder, MessageFlags } = require("discord.js");

const { ADMIN_ID: ADMIN_USER_ID, PRIVATE_GUILD_ID: ADMIN_GUILD_ID } = require("../utils/constants");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("refresh")
        .setDescription("Refreshes bot's hash data, upvotes, and DBL stats (admin only)."),
        
    async execute(interaction) {
        const { client } = interaction;
        
        // Permission check
        if (interaction.guildId !== ADMIN_GUILD_ID || interaction.user.id !== ADMIN_USER_ID) {
            return interaction.reply({ content: "No permissions.", flags: MessageFlags.Ephemeral });
        }

        const steps = [
            { name: "Hashes and rarities", fn: () => client.fetchHashes() },
            { name: "Upvotes", fn: () => client.fetchUpvotes() },
            { name: "DBL stats", fn: () => client.postDBLStats() },
        ];

        let content = "Starting refresh...";
        await interaction.reply({ content, flags: MessageFlags.Ephemeral });

        for (const step of steps) {
            try {
                await step.fn();
                content += `\n✅ ${step.name} refreshed.`;
            } catch (err) {
                content += `\n❌ Failed to refresh ${step.name.toLowerCase()}: ${err.message}`;
                return interaction.editReply({ content });
            }
            await interaction.editReply({ content });
        }
    },
};
