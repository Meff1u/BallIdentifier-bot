const { 
    SlashCommandBuilder, 
    MessageFlags, 
    ContainerBuilder, 
    TextDisplayBuilder, 
    MediaGalleryBuilder, 
    MediaGalleryItemBuilder, 
    SeparatorBuilder, 
    SeparatorSpacingSize, 
    ButtonBuilder, 
    ButtonStyle, 
    SectionBuilder 
} = require("discord.js");

// Import shared utilities
const { SUPPORTED_BOT_IDS, BOT_NAMES, BOT_DATA_KEYS, COLORS } = require("../utils/constants");

const buildImageUrl = (dex, ballName) => {
    return `https://ballidentifier.xyz/assets/dexes/${encodeURIComponent(dex)}/compressed/${encodeURIComponent(ballName)}.webp`;
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
        let ballName = options.getString("name");
        const rarities = client.rarities?.[dataKey];

        if (!rarities) {
            return interaction.reply({
                content: `Entry **${ballName}** not found in ${dexName}.`,
                flags: MessageFlags.Ephemeral,
            });
        }

        let ballData = rarities[ballName];

        if (!ballData) {
            const inputAsNumber = parseInt(ballName, 10);
            if (!isNaN(inputAsNumber)) {
                const foundEntry = Object.entries(rarities).find(([_, data]) => data.id === inputAsNumber);
                if (foundEntry) {
                    ballData = foundEntry[1];
                    ballName = foundEntry[0];
                }
            }
        }

        if (!ballData) {
            return interaction.reply({
                content: `Entry **${ballName}** not found in ${dexName}.`,
                flags: MessageFlags.Ephemeral,
            });
        }

        const detailsParts = [];

        if (ballData.rarity !== undefined) {
            detailsParts.push(`- Rarity: \`t${ballData.rarity}\``);
        }

        if (ballData.wave !== undefined) {
            detailsParts.push(`- Wave: \`${ballData.wave}\``);
        }

        if (ballData.common_value !== undefined) {
            detailsParts.push(`- Common value: \`${ballData.common_value}\``);
        }

        if (ballData.cc !== undefined) {
            detailsParts.push(`- Collector requirement: \`${ballData.cc}\``);
        }

        if (ballData.demand !== undefined) {
            detailsParts.push(`- Demand tier: \`${ballData.demand}\``);
        }

        const detailsText = detailsParts.length > 0 ? detailsParts.join("\n") : "No additional information available.";

        const container = new ContainerBuilder()
            .setAccentColor(COLORS.PRIMARY);

        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`# **${ballName}**`),
        );

        const galleryItem = new MediaGalleryItemBuilder()
            .setURL(buildImageUrl(dexName, ballName))
            .setDescription(`spawn art made by ${ballData.artist}`);

        container.addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(galleryItem),
        );

        container.addSeparatorComponents(
            new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
        );

        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`**Details**:\n${detailsText}`),
        );
        container.addSeparatorComponents(
            new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
        );

        if (ballData.collectors) {
            const section = new SectionBuilder()
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(`-# ID: \`${ballData.id}\``),
                );

            const button = new ButtonBuilder()
                .setStyle(ButtonStyle.Primary)
                .setLabel("Collectors")
                .setEmoji("🏆")
                .setCustomId(`collectors_${dataKey}_${ballData.id}`);
            
            section.setButtonAccessory(button);
            container.addSectionComponents(section);
        } else {
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`-# ID: \`${ballData.id}\``),
            );
        }

        await interaction.reply({
            components: [container],
            flags: [MessageFlags.Ephemeral, MessageFlags.IsComponentsV2],
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
