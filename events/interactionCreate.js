const {
    MessageFlags,
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
} = require("discord.js");
const FormData = require("form-data");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

// Import shared utilities
const { COLORS, INACTIVITY_TIMEOUT } = require("../utils/constants");
const { readJsonFile, writeJsonFile, getAssetsPath } = require("../utils/helpers");

const DATA_PATH = getAssetsPath("data.json");

module.exports = {
    name: "interactionCreate",
    async execute(interaction, client) {
        // Autocomplete interactions
        if (interaction.isAutocomplete()) {
            const command = client.slashCommands.get(interaction.commandName);
            if (!command || !command.autocomplete) return;
            
            try {
                await command.autocomplete(interaction);
            } catch (error) {
                console.error(`Error handling autocomplete for ${interaction.commandName}:`, error);
            }
            return;
        }
        
        // Slash commands and context menus
        if (interaction.isChatInputCommand() || interaction.isContextMenuCommand()) {
            const command = client.slashCommands.get(interaction.commandName);
            if (!command) return;
            
            // Log command usage
            const commandType = interaction.isChatInputCommand() ? "Slash" : "Context Menu";
            const userTag = `${interaction.user.username}#${interaction.user.discriminator || "0"}`;
            const guildName = interaction.guild?.name || "DM";
            client.logDiscord(`${commandType} Command: \`${interaction.commandName}\` | User: ${userTag} | Guild: ${guildName}`);
            
            try {
                await command.execute(interaction);
            } catch (error) {
                console.error(`Error executing command ${interaction.commandName}:`, error);
                client.logDiscord(`⚠️ Command Error in \`${interaction.commandName}\`: ${error.message}`);
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
        // String Select Menus
        else if (interaction.isStringSelectMenu()) {
            // No string select menus handling needed
        }

        // Role Select Menus
        else if (interaction.isRoleSelectMenu()) {
            // No role select menus handling needed
        }

        // Modals
        else if (interaction.isModalSubmit()) {
            // No modal handling needed
        }

        // Buttons
        else if (interaction.isButton()) {
            // Handle collectors button
            if (interaction.customId.startsWith("collectors_")) {
                const parts = interaction.customId.split("_");
                const dataKey = parts[1];
                const ballId = parseInt(parts[2], 10);

                const rarities = client.rarities?.[dataKey];
                if (!rarities) {
                    return interaction.reply({
                        content: "Data not found.",
                        flags: MessageFlags.Ephemeral,
                    });
                }

                // Find ball by ID
                const ballEntry = Object.entries(rarities).find(([_, data]) => data.id === ballId);
                if (!ballEntry || !ballEntry[1].collectors) {
                    return interaction.reply({
                        content: "No collectors data found.",
                        flags: MessageFlags.Ephemeral,
                    });
                }

                const [ballName, ballData] = ballEntry;
                const collectors = ballData.collectors;

                // Format collectors list
                const collectorsList = collectors.length > 0 
                    ? collectors.map(c => `- <@${c}>\n > ${c}`).join("\n")
                    : "No collectors yet.";

                const container = new ContainerBuilder()
                    .setAccentColor(COLORS.PRIMARY)
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(`Collectors of **${ballName}:**`)
                    )
                    .addSeparatorComponents(
                        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
                    )
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(collectorsList)
                    );

                return interaction.reply({
                    components: [container],
                    flags: [MessageFlags.Ephemeral, MessageFlags.IsComponentsV2],
                });
            }

            if (interaction.customId === "changelogs") {
                const embed = new EmbedBuilder()
                    .setColor(COLORS.INFO)
                    .setTitle("📋 Changelogs")
                    .addFields(
                        {
                            name: "v1.1.0 - Upvote System",
                            value: "In this version, a new upvote system was implemented.\n- Users who upvote the bot in the last 12 hours have no restrictions.\n- Otherwise, identification is limited to one use per 10 minutes.\n- Bot checks for upvotes every 3 minutes.",
                            inline: false,
                        },
                        {
                            name: "v2.0.0 - Notifier",
                            value: "Server notifier feature has been implemented:\n- With /notifier command you can set up a notifier for your server.\n- You can select bots to receive notifications from, choose a role to mention, and customize the notification message.\n- Notifier can be disabled at any time with /notifier disable command.",
                            inline: false,
                        },
                        {
                            name: "v2.1.0 - Trainer (Removed)",
                            value: "⚠️ Trainer feature has been removed due to unauthorized use of Ballsdex bot assets.\n\nTry out trainer feature on [website](https://ballidentifier.xyz) instead!",
                            inline: false,
                        },
                        {
                            name: "v2.3.0 - Dashboard",
                            value: "A new dashboard has been implemented for easier management of your bot settings.\n- Access your dashboard at [ballidentifier.xyz/dashboard](https://ballidentifier.xyz/dashboard).",
                            inline: false,
                        },
                        {
                            name: "v2.3.6 - /info command",
                            value: "Added /info command to get information about specific balls.",
                            inline: false,
                        }
                    )
                    .setTimestamp();

                await interaction.reply({
                    embeds: [embed],
                    flags: MessageFlags.Ephemeral,
                });
            }
        }
    },
};
