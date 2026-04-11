const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require("discord.js");

// Import shared utilities
const { SUPPORTED_BOT_IDS, BOT_NAMES, BOT_DATA_KEYS, COLORS } = require("../utils/constants");

const buildImageUrl = (dex, ballName) => {
    return `https://raw.githubusercontent.com/Meff1u/BallIdentifier/refs/heads/main/assets/dexes/${encodeURIComponent(dex)}/${encodeURIComponent(ballName)}.png`;
};

const slashBuilder = new SlashCommandBuilder()
    .setName("info")
    .setDescription("Get information about a countryball.");

SUPPORTED_BOT_IDS.forEach((botId) => {
    const botName = BOT_NAMES[botId];

    slashBuilder.addSubcommand((subcommand) =>
        subcommand
            .setName(botName.toLowerCase())
            .setDescription(`Get information about a ${botName} entry.`)
            .addStringOption((option) =>
                option
                    .setName("name")
                    .setDescription("The entry to get info about.")
                    .setRequired(true)
                    .setAutocomplete(true),
            ),
    );
});

module.exports = {
    data: slashBuilder,
    async execute(interaction) {
        const { client, options } = interaction;
        const subcommand = options.getSubcommand();
        const botId = SUPPORTED_BOT_IDS.find((id) => BOT_NAMES[id].toLowerCase() === subcommand);

        if (!botId) {
            return interaction.reply({
                content: "Invalid bot selection.",
                flags: MessageFlags.Ephemeral,
            });
        }

        const dexName = BOT_NAMES[botId];
        const dataKey = BOT_DATA_KEYS[botId];
        const ballName = options.getString("name");
        const rarities = client.rarities?.[dataKey];

        if (!rarities || !rarities[ballName]) {
            return interaction.reply({
                content: `Entry **${ballName}** not found in ${dexName}.`,
                flags: MessageFlags.Ephemeral,
            });
        }

        const ballData = rarities[ballName];
        const descriptionParts = [];

        if (ballData.rarity !== undefined) {
            descriptionParts.push(`**Rarity:** \`t${ballData.rarity}\``);
        }

        if (ballData.artist) {
            descriptionParts.push(`**Artist:** \`${ballData.artist}\``);
        }

        if (ballData.id !== undefined) {
            descriptionParts.push(`**ID:** \`${ballData.id}\``);
        }

        if (ballData.wave !== undefined) {
            descriptionParts.push(`**Wave:** \`${ballData.wave}\``);
        }

        const description =
            descriptionParts.length > 0 ? descriptionParts.join("\n") : "No information available.";

        const embed = new EmbedBuilder()
            .setTitle(ballName)
            .setDescription(description)
            .setColor(COLORS.PRIMARY)
            .setThumbnail(buildImageUrl(dexName, ballName))
            .setFooter({
                text: dexName,
                iconURL: `https://raw.githubusercontent.com/Meff1u/BallIdentifier/refs/heads/main/assets/icons/${encodeURIComponent(dexName)}.png`,
            });

        await interaction.reply({
            embeds: [embed],
            flags: MessageFlags.Ephemeral,
        });
    },

    // Handle autocomplete
    async autocomplete(interaction) {
        const { client, options, commandName } = interaction;

        if (commandName !== "info") return;

        const subcommand = options.getSubcommand();
        const botId = SUPPORTED_BOT_IDS.find((id) => BOT_NAMES[id].toLowerCase() === subcommand);

        if (!botId) return;

        const dataKey = BOT_DATA_KEYS[botId];
        const rarities = client.rarities?.[dataKey];

        if (!rarities) {
            await interaction.respond([]);
            return;
        }
        const focusedValue = options.getFocused().toLowerCase();

        const ballNames = Object.keys(rarities);
        const filtered = ballNames
            .filter((name) => name.toLowerCase().includes(focusedValue))
            .slice(0, 25);

        await interaction.respond(
            filtered.map((name) => ({
                name,
                value: name,
            })),
        );
    },
};
