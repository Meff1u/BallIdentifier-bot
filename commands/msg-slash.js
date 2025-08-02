const { SlashCommandBuilder, MessageFlags } = require("discord.js");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("msg")
        .setDescription("DM to a user with a message.")
        .addUserOption((option) =>
            option.setName("user").setDescription("The user to DM").setRequired(true)
        )
        .addStringOption((option) =>
            option.setName("message").setDescription("The message to send").setRequired(true)
        ),
    async execute(interaction) {
        if (
            interaction.guildId !== "379676234566729742" ||
            interaction.user.id !== "334411435633541121"
        ) {
            return interaction.reply({ content: "No permissions.", flags: MessageFlags.Ephemeral });
        }

        const user = interaction.options.getUser("user");
        const message = interaction.options.getString("message");

        if (!user) {
            return interaction.reply({ content: "User not found.", flags: MessageFlags.Ephemeral });
        }

        if (!message) {
            return interaction.reply({ content: "Message cannot be empty.", flags: MessageFlags.Ephemeral });
        }


        try {
            await user.send(message);
        } catch (e) {
            console.error("Error sending DM:", e);
            return interaction.reply({ content: "Failed to send DM.", flags: MessageFlags.Ephemeral });
        }

        return interaction.reply({ content: "DM sent!", flags: MessageFlags.Ephemeral });
    }
};
