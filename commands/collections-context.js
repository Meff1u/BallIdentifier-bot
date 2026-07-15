const {
    ContextMenuCommandBuilder,
    ApplicationCommandType,
    MessageFlags,
    InteractionContextType,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
} = require("discord.js");

const { SUPPORTED_BOT_IDS, BOT_NAMES, BOT_DATA_KEYS, COLORS } = require("../utils/constants");

module.exports = {
    data: new ContextMenuCommandBuilder()
        .setName("Check collections")
        .setType(ApplicationCommandType.User)
        .setContexts(InteractionContextType.Guild),

    async execute(interaction) {
        const { client, targetUser: user } = interaction;

        if (!user) {
            return interaction.reply({
                content: "Error while getting user, try again.",
                flags: MessageFlags.Ephemeral,
            });
        }

        const results = SUPPORTED_BOT_IDS.map((botId) => {
            const botName = BOT_NAMES[botId];
            const dataKey = BOT_DATA_KEYS[botId];
            const rarities = client.rarities?.[dataKey];

            if (!rarities) return null;

            const collectedNames = Object.entries(rarities)
                .filter(
                    ([, ballData]) =>
                        Array.isArray(ballData.collectors) && ballData.collectors.includes(user.id),
                )
                .map(([name]) => name)
                .sort((a, b) => a.localeCompare(b));

            if (collectedNames.length === 0) return null;

            return {
                botName,
                collectedNames,
            };
        }).filter(Boolean);

        if (results.length === 0) {
            return interaction.reply({
                content: `No collections found for <@${user.id}>.`,
                flags: MessageFlags.Ephemeral,
            });
        }

        const container = new ContainerBuilder().setAccentColor(COLORS.PRIMARY);

        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`# Collections for <@${user.id}>`),
        );

        container.addSeparatorComponents(
            new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
        );

        results.forEach((result, index) => {
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `**${result.botName}**\n${result.collectedNames.map((name) => `- ${name}`).join("\n")}`,
                ),
            );

            if (index < results.length - 1) {
                container.addSeparatorComponents(
                    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
                );
            }
        });

        container.addSeparatorComponents(
            new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true),
        );

        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "-# That list may be outdated or not updated with new collectors. If you know something i don't, let me know! (<@334411435633541121> | @meffiu)",
            ),
        );

        return interaction.reply({
            components: [container],
            flags: [MessageFlags.Ephemeral, MessageFlags.IsComponentsV2],
        });
    },
};
