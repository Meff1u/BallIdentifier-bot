const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const { SlashCommandBuilder } = require("discord.js");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("refresh")
        .setDescription("Refreshes bot's hash data (admin only)."),
    async execute(interaction) {
        if (
            interaction.guildId !== "379676234566729742" ||
            interaction.member.id !== "334411435633541121"
        ) {
            return interaction.reply({ content: "No permissions.", ephemeral: true });
        }

        const urls = {
            BD: "https://raw.githubusercontent.com/Meff1u/BallIdentifier/refs/heads/main/assets/jsons/BallsdexHashes.json",
            DD: "https://raw.githubusercontent.com/Meff1u/BallIdentifier/refs/heads/main/assets/jsons/DynastydexHashes.json",
            EB: "https://raw.githubusercontent.com/Meff1u/BallIdentifier/refs/heads/main/assets/jsons/EmpireballsHashes.json",
            HD: "https://raw.githubusercontent.com/Meff1u/BallIdentifier/refs/heads/main/assets/jsons/HistoryDexHashes.json",
        };
        interaction.client.hashes = {};
        let failed = [];
        for (const [key, url] of Object.entries(urls)) {
            try {
                const response = await fetch(url);
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                const data = await response.json();
                interaction.client.hashes[key] = data;
            } catch (error) {
                failed.push(key);
            }
        }
        if (failed.length > 0) {
            await interaction.reply({
                content: `Hash data refreshed, but failed for: ${failed.join(", ")}`,
                ephemeral: true,
            });
        } else {
            await interaction.reply({ content: "Hash data refreshed!", ephemeral: true });
        }
    },
};
