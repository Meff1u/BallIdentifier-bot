const {
    MessageFlags,
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    ActionRowBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    WebhookClient,
} = require("discord.js");

// Import shared utilities
const { COLORS, INACTIVITY_TIMEOUT } = require("../utils/constants");
const { readJsonFile, writeJsonFile, getAssetsPath } = require("../utils/helpers");
const { linkApiKey, unlinkAccount, cancelSync } = require("../utils/ballsdex");
const {
    PAGE_SIZE,
    buildCollectorsView,
    findCollectorEntry,
    getCollectorBalls,
    getCollectorsSession,
} = require("../utils/collectors");

const { handleDexEdit } = require("../utils/dex-report-actions");

const DATA_PATH = getAssetsPath("data.json");

module.exports = {
    name: "interactionCreate",
    async execute(interaction, client) {
        // Dex entry editing from spawn art reports (owner only)
        if ((interaction.isButton() || interaction.isModalSubmit()) && interaction.customId.startsWith("dexedit:")) {
            try {
                await handleDexEdit(interaction, client);
            } catch (error) {
                client.logError?.("Dex edit interaction failed", error);
                const reply = { content: `❌ ${error.message}`, flags: MessageFlags.Ephemeral };
                await (interaction.deferred || interaction.replied ? interaction.followUp(reply) : interaction.reply(reply)).catch(() => {});
            }
            return;
        }

        // Autocomplete interactions
        if (interaction.isAutocomplete()) {
            const command = client.slashCommands.get(interaction.commandName);
            if (!command || !command.autocomplete) return;

            try {
                await command.autocomplete(interaction);
            } catch (error) {
                console.error(`[INTERACTION] Error handling autocomplete for ${interaction.commandName}:`, error);
            }
            return;
        }

        // Slash commands and context menus
        if (interaction.isChatInputCommand() || interaction.isContextMenuCommand()) {
            const command = client.slashCommands.get(interaction.commandName);
            if (!command) return;

            // Log command usage
            const commandType = interaction.isChatInputCommand() ? "Slash" : "Context Menu";
            const userTag = `${interaction.user.username}`;
            const guildName = interaction.guild?.name || "DM";
            client.logDiscord(
                `${commandType} Command: \`${interaction.commandName}\` | User: ${userTag} | Guild: ${guildName}`,
            );

            try {
                await command.execute(interaction);
            } catch (error) {
                client.logError(`Command error: ${interaction.commandName} (${userTag}, ${guildName})`, error);
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
            if (interaction.customId.startsWith("collectors:")) {
                const [, sessionId, action] = interaction.customId.split(":");
                if (action !== "select") return;

                const session = getCollectorsSession(sessionId);
                if (!session) {
                    return interaction.reply({
                        content: "Collectors session expired. Please run /collectors again.",
                        flags: MessageFlags.Ephemeral,
                    });
                }

                const dataKey = session.dataKey;
                const selectedBallName = interaction.values[0];
                const view = buildCollectorsView(
                    interaction.client,
                    dataKey,
                    selectedBallName,
                    Number(session.page) || 0,
                    sessionId,
                );

                if (view.error) {
                    return interaction.reply({
                        content: view.error,
                        flags: MessageFlags.Ephemeral,
                    });
                }

                return interaction.update(view);
            }
        }

        // Role Select Menus
        else if (interaction.isRoleSelectMenu()) {
            // No role select menus handling needed
        }

        // Modals
        else if (interaction.isModalSubmit()) {
            if (interaction.customId === "ballsdex-link") {
                const apiKey = interaction.fields.getTextInputValue("api-key").trim();

                await interaction.deferReply({ flags: MessageFlags.Ephemeral });

                try {
                    await linkApiKey(interaction.user.id, apiKey);
                    return interaction.editReply({
                        content: "Your Ballsdex account has been linked securely.",
                    });
                } catch (error) {
                    console.error("[BALLSDEX] Failed to link account:", error);
                    return interaction.editReply({
                        content: `Could not link your Ballsdex account: ${error.message}`,
                    });
                }
            }

            if (interaction.customId.startsWith("collectors-search:")) {
                const [, sessionId] = interaction.customId.split(":");
                const session = getCollectorsSession(sessionId);

                if (!session) {
                    return interaction.reply({
                        content: "Collectors session expired. Please run /collectors again.",
                        flags: MessageFlags.Ephemeral,
                    });
                }

                const dataKey = session.dataKey;
                const rarities = interaction.client.rarities?.[dataKey];

                if (!rarities) {
                    return interaction.reply({
                        content: `Collectors data for this dex is not available yet.`,
                        flags: MessageFlags.Ephemeral,
                    });
                }

                const query = interaction.fields.getTextInputValue("query");
                const foundEntry = findCollectorEntry(rarities, query);

                if (!foundEntry) {
                    return interaction.reply({
                        content: `No entry found for **${query}**.`,
                        flags: MessageFlags.Ephemeral,
                    });
                }

                const collectors = Array.isArray(foundEntry.data.collectors) ? foundEntry.data.collectors : [];
                if (collectors.length === 0) {
                    return interaction.reply({
                        content: `Entry **${foundEntry.name}** has no collectors.`,
                        flags: MessageFlags.Ephemeral,
                    });
                }

                const collectorBalls = getCollectorBalls(rarities);
                const selectedIndex = collectorBalls.findIndex((ball) => ball.name === foundEntry.name);
                const page = selectedIndex >= 0 ? Math.floor(selectedIndex / PAGE_SIZE) : 0;
                const view = buildCollectorsView(
                    interaction.client,
                    dataKey,
                    foundEntry.name,
                    page,
                    sessionId,
                );

                if (view.error) {
                    return interaction.reply({
                        content: view.error,
                        flags: MessageFlags.Ephemeral,
                    });
                }

                await interaction.deferReply({ flags: MessageFlags.Ephemeral });

                try {
                    const webhook = new WebhookClient({
                        id: interaction.applicationId,
                        token: session.token,
                    });

                    await webhook.editMessage("@original", view);
                    await interaction.deleteReply();
                } catch (error) {
                    console.error(`[INTERACTION] Error updating collectors search result:`, error);
                    await interaction.editReply({
                        content: "Failed to update collectors view.",
                    });
                }
            }
        }

        // Buttons
        else if (interaction.isButton()) {
            if (interaction.customId === "ballsdex-link:start") {
                const modal = new ModalBuilder()
                    .setCustomId("ballsdex-link")
                    .setTitle("Link Ballsdex account");
                const apiKeyInput = new TextInputBuilder()
                    .setCustomId("api-key")
                    .setLabel("Ballsdex API key")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMinLength(10)
                    .setMaxLength(200)
                    .setPlaceholder("bdx_live_...");

                modal.addComponents(new ActionRowBuilder().addComponents(apiKeyInput));
                return interaction.showModal(modal);
            }

            if (interaction.customId === "ballsdex-sync:cancel") {
                const cancelled = cancelSync(interaction.user.id);
                return interaction.update({
                    content: cancelled
                        ? "Cancelling your Ballsdex sync. It stops after the current page; you can start a new one in 5 minutes."
                        : "There's no Ballsdex sync running for you.",
                    components: [],
                });
            }

            if (interaction.customId.startsWith("ballsdex-unlink:")) {
                const action = interaction.customId.split(":")[1];

                if (action === "cancel") {
                    return interaction.update({
                        content: "Your Ballsdex account remains linked.",
                        components: [],
                    });
                }

                const wasRemoved = await unlinkAccount(interaction.user.id);
                return interaction.update({
                    content: wasRemoved
                        ? "Your Ballsdex account has been unlinked. The encrypted API key and saved collection data were removed."
                        : "No linked Ballsdex account was found.",
                    components: [],
                });
            }

            if (interaction.customId.startsWith("collectors:")) {
                const [, sessionId, action] = interaction.customId.split(":");
                const session = getCollectorsSession(sessionId);

                if (!session) {
                    return interaction.reply({
                        content: "Collectors session expired. Please run /collectors again.",
                        flags: MessageFlags.Ephemeral,
                    });
                }

                if (action === "search") {
                    const modal = new ModalBuilder()
                        .setCustomId(`collectors-search:${sessionId}`)
                        .setTitle("Search collectors");

                    const input = new TextInputBuilder()
                        .setCustomId("query")
                        .setLabel("Name or ID")
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                        .setPlaceholder("Enter a name or ID");

                    modal.addComponents(new ActionRowBuilder().addComponents(input));
                    return interaction.showModal(modal);
                }

                const currentPage = Number(session.page) || 0;
                const selectedBallName = session.selectedBallName;
                const nextPage = action === "next" ? currentPage + 1 : currentPage - 1;
                const view = buildCollectorsView(
                    interaction.client,
                    session.dataKey,
                    selectedBallName,
                    nextPage,
                    sessionId,
                );

                if (view.error) {
                    return interaction.reply({
                        content: view.error,
                        flags: MessageFlags.Ephemeral,
                    });
                }

                return interaction.update(view);
            }

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
                const collectorsList =
                    collectors.length > 0
                        ? collectors.map((c) => `- <@${c}>\n > ${c}`).join("\n")
                        : "No collectors yet.";

                const container = new ContainerBuilder()
                    .setAccentColor(COLORS.PRIMARY)
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(`Collectors of **${ballName}:**`),
                    )
                    .addSeparatorComponents(
                        new SeparatorBuilder()
                            .setSpacing(SeparatorSpacingSize.Small)
                            .setDivider(true),
                    )
                    .addTextDisplayComponents(new TextDisplayBuilder().setContent(collectorsList))
                    .addSeparatorComponents(
                        new SeparatorBuilder()
                            .setSpacing(SeparatorSpacingSize.Small)
                            .setDivider(true),
                    )
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            "-# Collect one of these? Add yourself on https://ballidentifier.xyz/#/collectors",
                        ),
                    );

                return interaction.reply({
                    components: [container],
                    flags: [MessageFlags.Ephemeral, MessageFlags.IsComponentsV2],
                });
            }
        }
    },
};
