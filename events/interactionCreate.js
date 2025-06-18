const { MessageFlags } = require("discord.js");
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
                const webhookUrl = process.env.ERROR_WEBHOOK_URL;
                if (webhookUrl) {
                    try {
                        await fetch(webhookUrl, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                embeds: [
                                    {
                                        title: `Command Error: ${interaction.commandName}`,
                                        description: error.stack || String(error),
                                        color: 0xff0000,
                                        timestamp: new Date().toISOString(),
                                    },
                                ],
                            }),
                        });
                    } catch (e) {}
                }
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp({
                        content: "Error.",
                        flags: MessageFlags.Ephemeral,
                    });
                } else {
                    await interaction.reply({ content: "Error.", flags: MessageFlags.Ephemeral });
                }
            }
        }
    },
};
