const {
    MessageFlags,
    ActionRowBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    RoleSelectMenuBuilder,
    ContainerBuilder,
    EmbedBuilder
} = require("discord.js");
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

        if (interaction.isStringSelectMenu()) {
            if (interaction.customId.startsWith("notifier_bot_select_")) {
                try {
                    const userId = interaction.customId.split("_").pop();
                    if (interaction.user.id !== userId) {
                        return await interaction.reply({
                            content: "❌ You cannot use this menu!",
                            flags: MessageFlags.Ephemeral,
                        });
                    }

                    await interaction.deferUpdate();

                    if (!client.notifierSelections) {
                        client.notifierSelections = new Map();
                    }
                    client.notifierSelections.set(interaction.user.id, interaction.values);
                } catch (error) {
                    console.error("Error handling notifier bot selection:", error);
                }
            }
        } else if (interaction.isRoleSelectMenu()) {
            if (interaction.customId.startsWith("notifier_role_select_")) {
                try {
                    const userId = interaction.customId.split("_").pop();
                    if (interaction.user.id !== userId) {
                        return await interaction.reply({
                            content: "❌ You cannot use this menu!",
                            flags: MessageFlags.Ephemeral,
                        });
                    }

                    await interaction.deferUpdate();

                    if (!client.notifierRoleSelections) {
                        client.notifierRoleSelections = new Map();
                    }
                    client.notifierRoleSelections.set(interaction.user.id, interaction.values[0]);
                } catch (error) {
                    console.error("Error handling notifier role selection:", error);
                }
            }
        }

        if (interaction.isModalSubmit()) {
            if (interaction.customId.startsWith("notifier_message_modal_")) {
                try {
                    const userId = interaction.customId.split("_").pop();
                    if (interaction.user.id !== userId) {
                        return await interaction.reply({
                            content: "❌ You cannot use this modal!",
                            flags: MessageFlags.Ephemeral,
                        });
                    }

                    await interaction.deferUpdate();

                    const messageInput =
                        interaction.fields.getTextInputValue("notifier_message_input");
                    const guild = interaction.guild;

                    if (!guild) {
                        return await interaction.followUp({
                            content: "This command can only be used in a server!",
                            flags: MessageFlags.Ephemeral,
                        });
                    }

                    if (!messageInput.includes("{role}")) {
                        return await interaction.followUp({
                            content:
                                "❌ Your message must contain the `{role}` placeholder! This is required to mention the role in notifications.",
                            flags: MessageFlags.Ephemeral,
                        });
                    }

                    if (!client.notifierMessageSelections) {
                        client.notifierMessageSelections = new Map();
                    }
                    client.notifierMessageSelections.set(interaction.user.id, messageInput);

                    const ContainerBuilder = require("discord.js").ContainerBuilder;
                    const {
                        StringSelectMenuBuilder,
                        ButtonBuilder,
                        ButtonStyle,
                    } = require("discord.js");

                    const targetBotIds = [
                        "999736048596816014", // Ballsdex
                        "1174135035889201173", // DynastyDex
                        "1061145299927695400", // Empireballs
                        "1120942938126553190", // HistoryDex
                    ];

                    const members = await guild.members.fetch();
                    const availableBots = [];

                    for (const botId of targetBotIds) {
                        const member = members.get(botId);
                        if (member && member.user.bot) {
                            availableBots.push({
                                id: botId,
                                name: member.user.username,
                                user: member.user,
                            });
                        }
                    }

                    const notifierContainer = new ContainerBuilder()
                        .setAccentColor(0x0099ff)
                        .addTextDisplayComponents((t) =>
                            t.setContent("**🔔 Notification Setup 🔔**")
                        )
                        .addSeparatorComponents((s) => s)
                        .addTextDisplayComponents((t) =>
                            t.setContent("Select the bots you want to receive notifications from:")
                        )
                        .addActionRowComponents((a) =>
                            a.setComponents(
                                new StringSelectMenuBuilder()
                                    .setCustomId(`notifier_bot_select_${interaction.user.id}`)
                                    .setPlaceholder("Select bots for notifications...")
                                    .setMinValues(1)
                                    .setMaxValues(availableBots.length)
                                    .addOptions(
                                        availableBots.map((bot) => ({
                                            label: bot.name,
                                            description: `Receive notification when ${bot.name} spawns`,
                                            value: bot.id,
                                            emoji: "🤖",
                                        }))
                                    )
                            )
                        )
                        .addSeparatorComponents((s) => s)
                        .addTextDisplayComponents((t) =>
                            t.setContent(
                                "Select the role you want me to mention:\n-# Remember to check if bot has mention permissions and selected role is below the bot's role in the server."
                            )
                        )
                        .addActionRowComponents((s) => {
                            const roleSelectMenu = new RoleSelectMenuBuilder()
                                .setCustomId(`notifier_role_select_${interaction.user.id}`)
                                .setPlaceholder("Select a role...")
                                .setMinValues(1)
                                .setMaxValues(1);

                            const previouslySelectedRole = client.notifierRoleSelections?.get(
                                interaction.user.id
                            );
                            if (previouslySelectedRole) {
                                roleSelectMenu.setDefaultRoles([previouslySelectedRole]);
                            }

                            return s.setComponents(roleSelectMenu);
                        })
                        .addSeparatorComponents((s) => s)
                        .addTextDisplayComponents((t) =>
                            t.setContent(
                                "Notifier message\n - Use `{role}` as placeholder for the mentioned role and `{ball}` for the identified ball name.\n - Simply don't use `{ball}` placeholder if you want to receive notifications without ball name."
                            )
                        )
                        .addSectionComponents((s) =>
                            s
                                .addTextDisplayComponents((t) =>
                                    t.setContent(`\`\`\`\n${messageInput}\n\`\`\``)
                                )
                                .setButtonAccessory((b) =>
                                    b
                                        .setCustomId(`notifier_message_edit_${interaction.user.id}`)
                                        .setLabel("Edit Message")
                                        .setStyle(ButtonStyle.Primary)
                                )
                        )
                        .addSeparatorComponents((s) => s)
                        .addActionRowComponents((s) =>
                            s.setComponents(
                                new ButtonBuilder()
                                    .setCustomId(`notifier_confirm_${interaction.user.id}`)
                                    .setLabel("Confirm Selection")
                                    .setStyle(ButtonStyle.Success)
                                    .setEmoji("✅"),
                                new ButtonBuilder()
                                    .setCustomId(`notifier_cancel_${interaction.user.id}`)
                                    .setLabel("Cancel")
                                    .setStyle(ButtonStyle.Danger)
                                    .setEmoji("🛑")
                            )
                        );

                    await interaction.editReply({
                        components: [notifierContainer],
                        flags: MessageFlags.IsComponentsV2,
                        allowedMentions: { parse: [] },
                    });
                } catch (error) {
                    console.error("Error handling message modal submission:", error);
                    await interaction.followUp({
                        content: "An error occurred while processing your message.",
                        flags: MessageFlags.Ephemeral,
                    });
                }
            }
        }

        if (interaction.isButton()) {
            const checkUserPermission = (customId, userId) => {
                if (customId.includes("_")) {
                    const expectedUserId = customId.split("_").pop();
                    return userId === expectedUserId;
                }
                return true;
            };

            if (interaction.customId.startsWith("notifier_role_select")) {
                const modal = new ModalBuilder()
                    .setCustomId("notifier_role_modal")
                    .setTitle("Select Notifier Role");

                const roleInput = new TextInputBuilder()
                    .setCustomId("notifier_role_input")
                    .setLabel("Enter the role name or ID:")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                modal.addComponents(new ActionRowBuilder().addComponents(roleInput));

                await interaction.showModal(modal);
            } else if (interaction.customId.startsWith("notifier_message_edit_")) {
                if (!checkUserPermission(interaction.customId, interaction.user.id)) {
                    return await interaction.reply({
                        content: "❌ You cannot use this button!",
                        flags: MessageFlags.Ephemeral,
                    });
                }

                const currentMessage =
                    client.notifierMessageSelections?.get(interaction.user.id) ||
                    "{role} Catch that ball! - **{ball}**";

                const modal = new ModalBuilder()
                    .setCustomId(`notifier_message_modal_${interaction.user.id}`)
                    .setTitle("Edit Notifier Message");

                const messageInput = new TextInputBuilder()
                    .setCustomId("notifier_message_input")
                    .setLabel("Enter your custom notifier message:")
                    .setPlaceholder("{role} Catch that ball! - **{ball}**")
                    .setValue(currentMessage)
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
                    .setMaxLength(500);

                modal.addComponents(new ActionRowBuilder().addComponents(messageInput));

                await interaction.showModal(modal);
            } else if (interaction.customId.startsWith("notifier_confirm_")) {
                if (!checkUserPermission(interaction.customId, interaction.user.id)) {
                    return await interaction.reply({
                        content: "❌ You cannot use this button!",
                        flags: MessageFlags.Ephemeral,
                    });
                }
                try {
                    const selectedBots = client.notifierSelections?.get(interaction.user.id);
                    if (!selectedBots || selectedBots.length === 0) {
                        return await interaction.reply({
                            content: "Please select at least one bot first!",
                            flags: MessageFlags.Ephemeral,
                        });
                    }

                    const selectedRole = client.notifierRoleSelections?.get(interaction.user.id);
                    if (!selectedRole) {
                        return await interaction.reply({
                            content: "Please select a role first!",
                            flags: MessageFlags.Ephemeral,
                        });
                    }

                    const botNames = {
                        "999736048596816014": "Ballsdex",
                        "1174135035889201173": "DynastyDex",
                        1061145299927695400: "Empireballs",
                        "1120942938126553190": "HistoryDex",
                    };

                    const selectedBotNames = selectedBots.map((id) => botNames[id]);

                    const customMessage =
                        client.notifierMessageSelections?.get(interaction.user.id) ||
                        "{role} Catch that ball! - **{ball}**";

                    const fs = require("fs");
                    const path = require("path");
                    const dataPath = path.join(__dirname, "../assets/data.json");

                    let data = {};
                    try {
                        data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
                    } catch (error) {
                        console.log("No data.json file found");
                    }

                    if (!data.guilds) {
                        data.guilds = {};
                    }

                    data.guilds[interaction.guild.id] = {
                        notifier: {
                            selectedBots: selectedBots,
                            selectedRole: selectedRole,
                            customMessage: customMessage,
                            setupBy: interaction.user.id,
                            setupAt: new Date(),
                        },
                    };

                    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));

                    const confirmationContainer = new ContainerBuilder()
                        .setAccentColor(0x00ff00)
                        .addTextDisplayComponents((t) =>
                            t.setContent("**✅ Notifier Setup - Completed**")
                        )
                        .addSeparatorComponents((s) => s)
                        .addTextDisplayComponents((t) =>
                            t.setContent(
                                `**Selected Bots:** ${selectedBotNames.join(
                                    ", "
                                )}\n**Selected Role:** <@&${selectedRole}>\n**Custom Message:** \`\`\`\n${customMessage}\n\`\`\`\n\nYour notifier has been configured successfully and saved!`
                            )
                        );

                    await interaction.update({
                        components: [confirmationContainer],
                        flags: MessageFlags.IsComponentsV2,
                    });

                    if (client.notifierSelections) {
                        client.notifierSelections.delete(interaction.user.id);
                    }
                    if (client.notifierRoleSelections) {
                        client.notifierRoleSelections.delete(interaction.user.id);
                    }
                    if (client.notifierMessageSelections) {
                        client.notifierMessageSelections.delete(interaction.user.id);
                    }
                } catch (error) {
                    console.error("Error confirming notifier selection:", error);
                    await interaction.reply({
                        content: "An error occurred while confirming your selection.",
                        flags: MessageFlags.Ephemeral,
                    });
                }
            } else if (interaction.customId.startsWith("notifier_cancel_")) {
                if (!checkUserPermission(interaction.customId, interaction.user.id)) {
                    return await interaction.reply({
                        content: "❌ You cannot use this button!",
                        flags: MessageFlags.Ephemeral,
                    });
                }

                try {
                    const container = new ContainerBuilder()
                        .setAccentColor(0xff0000)
                        .addTextDisplayComponents((t) =>
                            t.setContent("**❌ Notifier Setup - Cancelled**")
                        )
                        .addSeparatorComponents((s) => s)
                        .addTextDisplayComponents((t) =>
                            t.setContent(
                                "The notifier setup has been cancelled.\n\nYou can run </notifier setup:1401243408084762749> again to restart the setup."
                            )
                        );

                    await interaction.update({
                        components: [container],
                        flags: MessageFlags.IsComponentsV2,
                    });

                    if (client.notifierSelections) {
                        client.notifierSelections.delete(interaction.user.id);
                    }
                    if (client.notifierRoleSelections) {
                        client.notifierRoleSelections.delete(interaction.user.id);
                    }
                    if (client.notifierMessageSelections) {
                        client.notifierMessageSelections.delete(interaction.user.id);
                    }
                } catch (error) {
                    console.error("Error cancelling notifier setup:", error);
                }
            } else if (interaction.customId === "changelogs") {
                const embed = new EmbedBuilder()
                    .setColor(0x0099ff)
                    .setTitle("📋 Changelogs")
                    .addFields(
                        {
                            name: "v1.1.0 - Upvote System",
                            value: "In this version, a new upvote system was implemented.\n- Users who upvote the bot in the last 12 hours have no restrictions.\n- Otherwise, identification is limited to one use per 10 minutes.\n- Bot checks for upvotes every 3 minutes.",
                            inline: false
                        },
                        {
                            name: "v2.0.0 - Notifier", 
                            value: "Server notifier feature has been implemented:\n- With /notifier command you can set up a notifier for your server.\n- You can select bots to receive notifications from, choose a role to mention, and customize the notification message.\n- Notifier can be disabled at any time with /notifier disable command.",
                            inline: false
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
