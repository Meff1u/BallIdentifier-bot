const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    InteractionContextType
} = require("discord.js");

// Import shared utilities
const { COLORS } = require("../utils/constants");
const { updateData } = require("../utils/helpers");


const getStatusEmoji = (value) => (value ? "✅" : "❌");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("notifications")
        .setDescription("Manage your notification preferences.")
        .setContexts(InteractionContextType.BotDM),

    async execute(interaction) {
        if (interaction.guildId || !interaction.channel) {
            return interaction.reply({
                content: "Please use this command in DMs (<@510775326310268930>) to manage your notification preferences.",
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const { user } = interaction;

        // Save one preference atomically and return the user's current preferences
        const setPreference = (key, value) =>
            updateData((data) => {
                data.users[user.id] ??= {};
                data.users[user.id].notifications ??= {};
                data.users[user.id].notifications[key] = value;
                return { ...data.users[user.id].notifications };
            });

        // Initial prompt
        const embed = new EmbedBuilder()
            .setColor(COLORS.INFO)
            .setTitle("Notification Preferences")
            .setDescription('Do you want to receive "Thanks for voting" messages?');

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("thanks_yes").setLabel("Yes").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("thanks_no").setLabel("No").setStyle(ButtonStyle.Danger)
        );

        await interaction.editReply({ embeds: [embed], components: [row] });

        // Set up collector
        const collector = interaction.channel.createMessageComponentCollector({
            filter: (i) => i.user.id === user.id,
            time: 60000,
        });

        collector.on("collect", async (btnInteraction) => {
            await btnInteraction.deferUpdate();
            const { customId } = btnInteraction;

            // Handle thanks preference
            if (customId === "thanks_yes" || customId === "thanks_no") {
                const notifications = setPreference("thanks", customId === "thanks_yes");
                const thanksStatus = getStatusEmoji(notifications.thanks);
                
                const embedUpdate = new EmbedBuilder()
                    .setColor(COLORS.INFO)
                    .setTitle("Notification Preferences")
                    .setDescription(`Thanks messages: ${thanksStatus}\n\nDo you want to receive upvote reminders?`);

                const rowUpdate = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("reminder_yes").setLabel("Yes").setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId("reminder_no").setLabel("No").setStyle(ButtonStyle.Danger)
                );

                await btnInteraction.editReply({ embeds: [embedUpdate], components: [rowUpdate] });
            }
            // Handle reminder preference
            else if (customId === "reminder_yes" || customId === "reminder_no") {
                const notifications = setPreference("reminder", customId === "reminder_yes");
                const thanksStatus = getStatusEmoji(notifications.thanks !== false);
                const reminderStatus = getStatusEmoji(notifications.reminder);

                const finalEmbed = new EmbedBuilder()
                    .setColor(COLORS.INFO)
                    .setTitle("Notification Preferences")
                    .setDescription(`Thanks messages: ${thanksStatus}\nUpvote reminders: ${reminderStatus}`)
                    .setFooter({ text: "Settings saved!" });

                await btnInteraction.editReply({ embeds: [finalEmbed], components: [] });
                collector.stop();
            }
        });

        collector.on("end", async (collected, reason) => {
            if (reason === "time") {
                await interaction.editReply({ components: [] }).catch(() => {});
            }
        });
    },
};
