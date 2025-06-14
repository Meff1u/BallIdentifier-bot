const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { version } = require('../package.json');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Useful informations.'),
    async execute(interaction) {
        const embed = new EmbedBuilder()
        .setTitle('BallIdentifier')
        .setFooter({ text: `v${version}` })
        .setColor('#6839A6')
        .addFields(
            { name: 'Supported Bots', value: '- Ballsdex\n- DynastyDex\n- Empireballs\n- HistoryDex' },
            { name: 'How to Use', value: 'Right-click on a message with an image from one of the supported bots and select "Identify" (image below)' },
            { name: 'More Information', value: '[GitHub Repository]()\n[Website](https://ballidentifier.xyz)' },
        )

        await interaction.reply({ embeds: [embed], ephemeral: true });
    },
};
