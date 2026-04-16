const { SlashCommandBuilder, MessageFlags } = require("discord.js");

const ADMIN_USER_ID = "334411435633541121";
const ADMIN_GUILD_ID = "379676234566729742";

module.exports = {
    data: new SlashCommandBuilder()
        .setName("msg")
        .setDescription("DM to a user with a message.")
        .addUserOption((opt) => opt.setName("user").setDescription("The user to DM").setRequired(true))
        .addStringOption((opt) => opt.setName("message").setDescription("The message to send").setRequired(true)),
        
    async execute(interaction) {
        // Permission check
        if (interaction.guildId !== ADMIN_GUILD_ID || interaction.user.id !== ADMIN_USER_ID) {
            return interaction.reply({ content: "No permissions.", flags: MessageFlags.Ephemeral });
        }

        const user = interaction.options.getUser("user");
        const message = interaction.options.getString("message");

        if (!user || !message) {
            return interaction.reply({ 
                content: !user ? "User not found." : "Message cannot be empty.", 
                flags: MessageFlags.Ephemeral 
            });
        }

        try {
            await user.send(message);
            return interaction.reply({ content: "DM sent!", flags: MessageFlags.Ephemeral });
        } catch (e) {
            console.error("[MSG] Error sending DM:", e);
            return interaction.reply({ content: "Failed to send DM.", flags: MessageFlags.Ephemeral });
        }
    },
};
