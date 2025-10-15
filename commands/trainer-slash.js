const { SlashCommandBuilder } = require('discord.js');
const { trainingSessions, scheduleNextCountryball, updateCatchStats, sendCountryball, endSession } = require('../trainingSession');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('trainer')
        .setDescription("Manage countryball catching trainer.")
        .addSubcommand(sub =>
            sub
                .setName('start')
                .setDescription('Start a new catching trainer session.')
                .addStringOption(opt =>
                    opt
                        .setName('dex')
                        .setDescription('Select the dex to use.')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Ballsdex', value: 'Ballsdex' },
                            { name: 'Dynastydex', value: 'Dynastydex' },
                            { name: 'Empireballs', value: 'Empireballs' },
                            { name: 'HistoryDex', value: 'HistoryDex' }
                        )
                )
                .addIntegerOption(opt =>
                    opt
                        .setName('rounds')
                        .setDescription('Number of rounds (Min of 2)')
                        .setMinValue(2)
                        .setRequired(false)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('stop')
                .setDescription('Stop the current catching trainer session.')     
        ),
    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        if (sub === 'start') {
            if (!interaction.guild) {
                return interaction.reply({ content: '🚫 This command can only be used in a server.', ephemeral: true });
            }
            const guildId = interaction.guild.id;

            if (trainingSessions.has(guildId) && trainingSessions.get(guildId).active) {
                return interaction.reply({ content: '🚫 A training session is already active in this server.', ephemeral: true });
            }

            const dex = interaction.options.getString('dex', true);
            const rounds = interaction.options.getInteger('rounds') ?? null;

            trainingSessions.set(guildId, {
                active: true,
                channelId: interaction.channel.id,
                startTime: Date.now(),
                catches: 0,
                leaderboard: new Map(),
                fastestCatch: null,
                dex,
                roundsTotal: rounds,
                roundsPlayed: 0
            });

            await interaction.reply({ content: `🏁 Starting a new catching trainer session!\n- Dex: **${dex}**\n- Rounds: ${rounds ? `**${rounds}**` : '**Unlimited**'}!\n\nFirst countryball gonna appear in 5 seconds...`});

            setTimeout(async () => {
                const session = trainingSessions.get(guildId);
                if (session && session.active) {
                    await sendCountryball(interaction.channel, guildId);
                }
            }, 5000);
        } else if (sub === 'stop') {
            const guildId = interaction.guild?.id;
            const sessionData = guildId ? trainingSessions.get(guildId) : null;
            if (!guildId || !sessionData || !sessionData.active) {
                return interaction.reply({ content: '🚫 There is no active training session in this server.', ephemeral: true });
            }

            endSession(guildId, interaction.channel, `Session manually stopped by ${interaction.user.tag}.`);
            return interaction.reply({ content: '🛑 The training session has been stopped.', ephemeral: true });
        }
    }
}