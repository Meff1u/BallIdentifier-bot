const FormData = require("form-data");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

module.exports = {
    name: "interactionCreate",
    async execute(interaction, client) {
        if (interaction.isChatInputCommand() || interaction.isContextMenuCommand()) {
            const command = client.slashCommands.get(interaction.commandName);
            if (!command) return;
            try {
                await command.execute(interaction);
            } catch (error) {
                console.error(`Error executing command ${interaction.commandName}:`, error);
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp({ content: "Error.", ephemeral: true });
                } else {
                    await interaction.reply({ content: "Error.", ephemeral: true });
                }
            }
        } else if (interaction.isModalSubmit() && interaction.customId.startsWith("rm_")) {
            if (!client.reportCooldowns) client.reportCooldowns = new Map();
            const cooldown = client.reportCooldowns.get(interaction.user.id);
            const now = Date.now();
            if (cooldown && now - cooldown < 10 * 60 * 1000) {
                const left = Math.ceil((10 * 60 * 1000 - (now - cooldown)) / 60000);
                await interaction.reply({
                    content: `You can send another report in ${left} min.`,
                    ephemeral: true,
                });
                return;
            }
            const artLink = interaction.fields.getTextInputValue("art_link");
            const webhookUrl = process.env.REPORT_WEBHOOK_URL;
            let fileBuffer = null;
            let fileName = null;
            let messageUrl = null;
            try {
                const customIdParts = interaction.customId.split("_");
                const messageId = customIdParts[1];
                const channelId = customIdParts[2];
                messageUrl = `https://discord.com/channels/${interaction.guildId}/${channelId}/${messageId}`;
                if (interaction.client[messageId]) {
                    fileBuffer = interaction.client[messageId].buffer;
                    fileName = interaction.client[messageId].name;
                    delete interaction.client[messageId];
                }
            } catch (e) {
                fileBuffer = null;
                fileName = null;
                messageUrl = null;
            }
            const payload = {
                embeds: [
                    {
                        title: "Wrong answer report",
                        fields: [
                            { name: "Current Art Link", value: artLink || "None" },
                            {
                                name: "User",
                                value: `${interaction.user.tag} (${interaction.user.id})`,
                            },
                            { name: "Message link", value: messageUrl || "N/A" },
                        ],
                        timestamp: new Date().toISOString(),
                    },
                ],
            };
            try {
                if (fileBuffer && fileName) {
                    const form = new FormData();
                    form.append("payload_json", JSON.stringify(payload));
                    form.append("file", fileBuffer, fileName);
                    await fetch(webhookUrl, {
                        method: "POST",
                        body: form,
                    });
                } else {
                    await fetch(webhookUrl, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payload),
                    });
                }
                await interaction.reply({ content: "Report sent. Thank you!", ephemeral: true });
                client.reportCooldowns.set(interaction.user.id, now);
            } catch (e) {
                console.error("Error sending report:", e);
                await interaction.reply({ content: "Failed to send report.", ephemeral: true });
            }
            return;
        }
    },
};
