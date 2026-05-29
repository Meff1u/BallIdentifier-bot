const { SlashCommandBuilder, MessageFlags } = require("discord.js");

const ADMIN_USER_ID = "334411435633541121";
const ADMIN_GUILD_ID = "379676234566729742";

const { processImageHash, findBestMatch } = require("../utils/helpers");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("bdcompare")
        .setDescription("Compare an image against Ballsdex hashes.")
        .addStringOption((option) =>
            option
                .setName("url")
                .setDescription("Image URL to compare")
                .setRequired(true),
        ),

    async execute(interaction) {
        const { client } = interaction;

        if (interaction.guildId !== ADMIN_GUILD_ID || interaction.user.id !== ADMIN_USER_ID) {
            return interaction.reply({ content: "No permissions.", flags: MessageFlags.Ephemeral });
        }

        const imageUrl = interaction.options.getString("url", true).trim();
        const hashes = client.hashes?.BD;

        if (!hashes) {
            return interaction.reply({
                content: "[x] Ballsdex hash data is not available yet.",
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const { hash } = await processImageHash(imageUrl, interaction.id);
            const bestMatch = findBestMatch(hash, hashes);

            if (!bestMatch?.country) {
                return interaction.editReply({
                    content: "[x] No matching entry found.",
                });
            }

            if (bestMatch.diff > 20) {
                return interaction.editReply({
                    content: `[x] Too high diff.`,
                });
            }

            return interaction.editReply({
                content: `${bestMatch.country}\n${bestMatch.diff}`,
            });
        } catch (error) {
            console.error("[BDCOMPARE] Error comparing image:", error);
            return interaction.editReply({
                content: `[x] Failed to compare image: ${error.message}`,
            });
        }
    },
};
