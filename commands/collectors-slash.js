const { SlashCommandBuilder, MessageFlags } = require("discord.js");

const { SUPPORTED_BOT_IDS, BOT_NAMES, BOT_DATA_KEYS } = require("../utils/constants");
const { getDexChoices, buildCollectorsView } = require("../utils/collectors");

const slashBuilder = new SlashCommandBuilder()
    .setName("collectors")
    .setDescription("Browse collectors for countryballs.")
    .addStringOption((option) =>
        option
            .setName("dex")
            .setDescription("Select a dex to browse.")
            .setRequired(true)
            .setAutocomplete(true),
    );

module.exports = {
    data: slashBuilder,

    async execute(interaction) {
        const { client, options } = interaction;
        const dexInput = options.getString("dex", true).trim();
        const botId = SUPPORTED_BOT_IDS.find((id) => BOT_NAMES[id].toLowerCase() === dexInput.toLowerCase());

        if (!botId) {
            return interaction.reply({
                content: "Invalid dex selected.",
                flags: MessageFlags.Ephemeral,
            });
        }

        const dataKey = BOT_DATA_KEYS[botId];
        const rarities = client.rarities?.[dataKey];

        if (!rarities) {
            return interaction.reply({
                content: `Collectors data for **${BOT_NAMES[botId]}** is not available yet.`,
                flags: MessageFlags.Ephemeral,
            });
        }

        const collectorBalls = Object.entries(rarities)
            .filter(([, ballData]) => Array.isArray(ballData.collectors) && ballData.collectors.length > 0)
            .map(([name]) => name);

        if (collectorBalls.length === 0) {
            return interaction.reply({
                content: `No collectors found for **${BOT_NAMES[botId]}**.`,
                flags: MessageFlags.Ephemeral,
            });
        }

        const view = buildCollectorsView(client, dataKey, collectorBalls[0], 0);

        return interaction.reply({
            ...view,
            flags: [MessageFlags.Ephemeral, MessageFlags.IsComponentsV2],
        });
    },

    async autocomplete(interaction) {
        if (interaction.commandName !== "collectors") return;

        const focusedValue = interaction.options.getFocused() || "";
        await interaction.respond(getDexChoices(focusedValue));
    },
};