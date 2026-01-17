const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const { trainingSessions, sendCountryball, endSession } = require("../trainingSession");

const SPAWN_DELAY = 5000;

module.exports = {
    data: new SlashCommandBuilder()
        .setName("trainer")
        .setDescription("Manage countryball catching trainer.")
        .addSubcommand((sub) =>
            sub
                .setName("start")
                .setDescription("Start a new catching trainer session.")
                .addStringOption((opt) =>
                    opt
                        .setName("dex")
                        .setDescription("Select the dex to use.")
                        .setRequired(true)
                        .addChoices(
                            { name: "Ballsdex", value: "Ballsdex" },
                            { name: "FoodDex", value: "FoodDex" }
                        )
                )
                .addIntegerOption((opt) =>
                    opt
                        .setName("rounds")
                        .setDescription("Number of rounds (Min of 2)")
                        .setMinValue(2)
                        .setRequired(false)
                )
        )
        .addSubcommand((sub) =>
            sub.setName("stop").setDescription("Stop the current catching trainer session.")
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guild?.id;

        // Guild-only check
        if (!guildId) {
            return interaction.reply({
                content: "🚫 This command can only be used in a server.",
                flags: MessageFlags.Ephemeral,
            });
        }

        if (sub === "start") {
            const session = trainingSessions.get(guildId);
            if (session?.active) {
                return interaction.reply({
                    content: "🚫 A training session is already active in this server.",
                    flags: MessageFlags.Ephemeral,
                });
            }

            const dex = interaction.options.getString("dex", true);
            const rounds = interaction.options.getInteger("rounds");

            trainingSessions.set(guildId, {
                active: true,
                channelId: interaction.channel.id,
                startTime: Date.now(),
                catches: 0,
                leaderboard: new Map(),
                fastestCatch: null,
                dex,
                roundsTotal: rounds,
                roundsPlayed: 0,
            });

            await interaction.reply({
                content: [
                    "🏁 Starting a new catching trainer session!",
                    `- Dex: **${dex}**`,
                    `- Rounds: ${rounds ? `**${rounds}**` : "**Unlimited**"}`,
                    "",
                    "First countryball gonna appear in 5 seconds...",
                ].join("\n"),
            });

            setTimeout(async () => {
                const currentSession = trainingSessions.get(guildId);
                if (currentSession?.active) {
                    await sendCountryball(interaction.channel, guildId);
                }
            }, SPAWN_DELAY);
            
        } else if (sub === "stop") {
            const session = trainingSessions.get(guildId);
            if (!session?.active) {
                return interaction.reply({
                    content: "🚫 There is no active training session in this server.",
                    flags: MessageFlags.Ephemeral,
                });
            }

            endSession(guildId, interaction.channel, `Session manually stopped by ${interaction.user.tag}.`);
            return interaction.reply({
                content: "🛑 The training session has been stopped.",
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};