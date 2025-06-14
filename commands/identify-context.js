const { ContextMenuCommandBuilder, ApplicationCommandType, EmbedBuilder } = require('discord.js');
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const { imageHash } = require("image-hash");
const sharp = require("sharp");
const path = require('path');
const fs = require('fs');

module.exports = {
    data: new ContextMenuCommandBuilder()
        .setName('Identify')
        .setType(ApplicationCommandType.Message),
    async execute(interaction) {
        const message = interaction.targetMessage;
        if (!message) {
            return interaction.reply({ content: 'Error while getting message, try again.', ephemeral: true });
        }
        if (!message.attachments || message.attachments.size === 0) {
            return interaction.reply({ content: 'No attachments found in the message.', ephemeral: true });
        }
        if (!['999736048596816014', '1174135035889201173', '1061145299927695400', '1120942938126553190'].includes(message.author.id)) {
            return interaction.reply({ content: 'This command can only be used on messages from these bots: Ballsdex, DynastyDex, Empireballs, HistoryDex', ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true });
        let compareData = {
            diff: Infinity,
            country: ""
        };
        const hashes = message.author.id == '999736048596816014' ? interaction.client.hashes.BD :
            message.author.id == '1174135035889201173' ? interaction.client.hashes.DD :
                message.author.id == '1061145299927695400' ? interaction.client.hashes.EB :
                    message.author.id == '1120942938126553190' ? interaction.client.hashes.HD : null;
        if (message.components[0]?.components[0]?.type == 2) {
            const response = await fetch(message.attachments.first().url);
            const arrayBuffer = await response.arrayBuffer();
            const imageBuffer = Buffer.from(arrayBuffer);
            const tempFile = path.join(__dirname, '../tempImages', `${message.id}.png`);
            await sharp(imageBuffer).resize(100, 100).flatten({ background: { r: 0, g: 0, b: 0 } }).png().toFile(tempFile);

            const hash = await new Promise((resolve, reject) => {
                imageHash(tempFile, 20, true, (error, data) => {
                    if (error) return reject(error);
                    resolve(data);
                });
            });
            fs.unlinkSync(tempFile);

            for (const [hKey, c] of Object.entries(hashes)) {
                const diff = compareHashes(hash, hKey);
                if (compareData.diff > diff) {
                    compareData.diff = diff;
                    compareData.country = c;
                }
                if (diff === 0) break;
            }

            const embed = new EmbedBuilder()
                .setColor('#6839A6')
                .setTitle(compareData.country)
                .setDescription(`**Similarity:** ${100 - compareData.diff}%`)
                .setImage(message.attachments.first().url)
                .setFooter({ text: 'BallIdentifier tool made by @meffiu' });

            return await interaction.editReply({ embeds: [embed], ephemeral: true });
        }

        function compareHashes(hash1, hash2) {
            let diff = 0;
            for (let i = 0; i < hash1.length; i++) {
                if (hash1[i] !== hash2[i]) diff++;
            }
            return diff;
        }

    },
};
