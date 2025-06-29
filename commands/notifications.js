const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
} = require("discord.js");
const fs = require("fs");
const path = require("path");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("notifications")
        .setDescription("Manage your notification preferences."),
    async execute(interaction) {
        const dataPath = path.join(__dirname, "../assets/data.json");
        let data;
        try {
            data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
        } catch (e) {
            data = { users: {} };
        }

        const userId = interaction.user.id;
        if (!data.users[userId]) data.users[userId] = { notifications: {} };

        const embed = new EmbedBuilder()
            .setColor(0x00aaff)
            .setTitle("Notification Preferences")
            .setDescription("Do you want to receive \"Thanks for voting\" messages?");

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("thanks_yes")
                .setLabel("Yes")
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId("thanks_no")
                .setLabel("No")
                .setStyle(ButtonStyle.Danger)
        );

        await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });

        const filter = (i) => i.user.id === interaction.user.id;
        const collector = interaction.channel.createMessageComponentCollector({ filter, time: 60000 });

        collector.on("collect", async (buttonInteraction) => {
            if (buttonInteraction.customId === "thanks_yes" || buttonInteraction.customId === "thanks_no") {
                data.users[userId].notifications.thanks = buttonInteraction.customId === "thanks_yes";
                fs.writeFileSync(dataPath, JSON.stringify(data, null, 4));

                const thanksStatus = data.users[userId].notifications.thanks ? "✅" : "❌";
                const embedUpdate = new EmbedBuilder()
                    .setColor(0x00aaff)
                    .setTitle("Notification Preferences")
                    .setDescription(
                        `Thanks messages: ${thanksStatus}\n\nDo you want to receive upvote reminders?`
                    );

                const rowUpdate = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId("reminder_yes")
                        .setLabel("Yes")
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId("reminder_no")
                        .setLabel("No")
                        .setStyle(ButtonStyle.Danger)
                );

                await buttonInteraction.update({ embeds: [embedUpdate], components: [rowUpdate] });
            } else if (
                buttonInteraction.customId === "reminder_yes" ||
                buttonInteraction.customId === "reminder_no"
            ) {
                data.users[userId].notifications.reminder = buttonInteraction.customId === "reminder_yes";
                fs.writeFileSync(dataPath, JSON.stringify(data, null, 4));

                const thanksStatus = data.users[userId].notifications.thanks ? "✅" : "❌";
                const reminderStatus = data.users[userId].notifications.reminder ? "✅" : "❌";
                const finalEmbed = new EmbedBuilder()
                    .setColor(0x00aaff)
                    .setTitle("Notification Preferences")
                    .setDescription(
                        `Thanks messages: ${thanksStatus}\nUpvote reminders: ${reminderStatus}`
                    )
                    .setFooter({ text: "Settings saved!" });

                await buttonInteraction.update({ embeds: [finalEmbed], components: [] });
                collector.stop();
            }
        });

        collector.on("end", async () => {
            if (!collector.ended) {
                await interaction.editReply({ components: [] });
            }
        });
    },
};
