const {
    SlashCommandBuilder,
    StringSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    ContainerBuilder,
    RoleSelectMenuBuilder,
    EmbedBuilder,
} = require("discord.js");
const fs = require("fs");
const path = require("path");
const dataPath = path.join(__dirname, "../assets/data.json");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("notifier")
        .setDescription("Setup, view or disable notifier configuration.")
        .addSubcommand((subcommand) =>
            subcommand.setName("setup").setDescription("Set up the spawn notifier.")
        )
        .addSubcommand((subcommand) =>
            subcommand.setName("view").setDescription("View your current notifier configuration.")
        )
        .addSubcommand((subcommand) =>
            subcommand.setName("disable").setDescription("Disable the notifier for your account.")
        ),
    async execute(interaction) {
        const guild = interaction.guild;
        if (!guild) {
            return await interaction.reply({
                content: "This command can only be used in a server!",
                flags: MessageFlags.Ephemeral,
            });
        }

        if (!interaction.member.permissions.has("Administrator")) {
            return await interaction.reply({
                content: "You need `Administrator` permissions to use this command!",
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ 
            flags: MessageFlags.Ephemeral,
        });

        if (interaction.options.getSubcommand() === "setup") {
            try {
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

                if (availableBots.length === 0) {
                    return await interaction.reply({
                        content: "No supported bots found on this server!",
                        flags: MessageFlags.Ephemeral,
                    });
                }

                if (!interaction.client.notifierMessageSelections) {
                    interaction.client.notifierMessageSelections = new Map();
                }
                interaction.client.notifierMessageSelections.set(
                    interaction.user.id,
                    "{role} Catch that ball! - **{ball}**"
                );

                const userId = interaction.user.id;

                const notifierContainer = new ContainerBuilder()
                    .setAccentColor(0x0099ff)
                    .addTextDisplayComponents((t) => t.setContent("**🔔 Notification Setup 🔔**"))
                    .addSeparatorComponents((s) => s)
                    .addTextDisplayComponents((t) =>
                        t.setContent("Select the bots you want to receive notifications from:")
                    )
                    .addActionRowComponents((a) =>
                        a.setComponents(
                            new StringSelectMenuBuilder()
                                .setCustomId(`notifier_bot_select_${userId}`)
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
                    .addActionRowComponents((s) =>
                        s.setComponents(
                            new RoleSelectMenuBuilder()
                                .setCustomId(`notifier_role_select_${userId}`)
                                .setPlaceholder("Select a role...")
                                .setMinValues(1)
                                .setMaxValues(1)
                        )
                    )
                    .addSeparatorComponents((s) => s)
                    .addTextDisplayComponents((t) =>
                        t.setContent(
                            "Notifier message\n - Use `{role}` as placeholder for the mentioned role and `{ball}` for the identified ball name.\n - Simply don't use `{ball}` placeholder if you want to receive notifications without ball name."
                        )
                    )
                    .addSectionComponents((s) =>
                        s
                            .addTextDisplayComponents((t) =>
                                t.setContent("```\n{role} Catch that ball! - **{ball}**\n```")
                            )
                            .setButtonAccessory((b) =>
                                b
                                    .setCustomId(`notifier_message_edit_${userId}`)
                                    .setLabel("Edit Message")
                                    .setStyle(ButtonStyle.Primary)
                            )
                    )
                    .addSeparatorComponents((s) => s)
                    .addActionRowComponents((s) =>
                        s.setComponents(
                            new ButtonBuilder()
                                .setCustomId(`notifier_confirm_${userId}`)
                                .setLabel("Confirm Selection")
                                .setStyle(ButtonStyle.Success)
                                .setEmoji("✅"),
                            new ButtonBuilder()
                                .setCustomId(`notifier_cancel_${userId}`)
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
                console.error("Error in notifier command:", error);
                await interaction.editReply({
                    content: "An error occurred while setting up the notifier.",
                    flags: MessageFlags.Ephemeral,
                });
            }
        } else if (interaction.options.getSubcommand() === "view") {
            let data = {};
            try {
                data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
            } catch (error) {
                console.error("Error reading data.json:", error);
            }

            if (data.guilds[interaction.guild.id] && data.guilds[interaction.guild.id]?.notifier) {
                const notifierConfig = data.guilds[interaction.guild.id].notifier;

                const embed = new EmbedBuilder()
                    .setColor(0x0099ff)
                    .setTitle("Notifier Configuration")
                    .setDescription(
                        `**Bots:** ${notifierConfig.selectedBots
                            .map((id) => `<@${id}>`)
                            .join(", ")}\n**Role:** <@&${
                            notifierConfig.selectedRole
                        }>\n**Message:** \`\`\`\n${notifierConfig.customMessage}\n\`\`\``
                    )
                    .setFooter({ text: "Use /notifier disable to remove this configuration." });

                return await interaction.editReply({
                    embeds: [embed],
                    flags: MessageFlags.Ephemeral,
                });
            } else {
                return await interaction.editReply({
                    content: "You have no notifier configuration set up.",
                    flags: MessageFlags.Ephemeral,
                });
            }
        } else if (interaction.options.getSubcommand() === "disable") {
            try {
                let data = {};
                try {
                    data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
                } catch (error) {
                    console.error("Error reading data.json:", error);
                }

                if (
                    data.guilds &&
                    data.guilds[interaction.guild.id] &&
                    data.guilds[interaction.guild.id].notifier
                ) {
                    delete data.guilds[interaction.guild.id].notifier;

                    if (Object.keys(data.guilds[interaction.guild.id]).length === 0) {
                        delete data.guilds[interaction.guild.id];
                    }

                    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
                }

                const container = new ContainerBuilder()
                    .setAccentColor(0x808080)
                    .addTextDisplayComponents((t) => t.setContent("**🔕 Notifier Disabled**"))
                    .addSeparatorComponents((s) => s)
                    .addTextDisplayComponents((t) =>
                        t.setContent(
                            "The notifier has been disabled and removed from configuration. You will no longer receive notifications."
                        )
                    );

                await interaction.editReply({
                    components: [container],
                    flags: MessageFlags.IsComponentsV2,
                });

                if (interaction.client.notifierSelections) {
                    interaction.client.notifierSelections.delete(interaction.user.id);
                }
                if (interaction.client.notifierRoleSelections) {
                    interaction.client.notifierRoleSelections.delete(interaction.user.id);
                }
                if (interaction.client.notifierMessageSelections) {
                    interaction.client.notifierMessageSelections.delete(interaction.user.id);
                }
            } catch (error) {
                console.error("Error disabling notifier:", error);
            }
        }
    },
};
