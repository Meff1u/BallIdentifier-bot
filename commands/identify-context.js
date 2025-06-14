const {
    ContextMenuCommandBuilder,
    ApplicationCommandType,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    InteractionType,
} = require("discord.js");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const { imageHash } = require("image-hash");
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

module.exports = {
    data: new ContextMenuCommandBuilder()
        .setName("Identify")
        .setType(ApplicationCommandType.Message),
    async execute(interaction) {
        const message = interaction.targetMessage;
        if (!message) {
            return interaction.reply({
                content: "Error while getting message, try again.",
                ephemeral: true,
            });
        }
        if (!message.attachments || message.attachments.size === 0) {
            return interaction.reply({
                content: "No attachments found in the message.",
                ephemeral: true,
            });
        }
        if (
            ![
                "999736048596816014",
                "1174135035889201173",
                "1061145299927695400",
                "1120942938126553190",
            ].includes(message.author.id)
        ) {
            return interaction.reply({
                content:
                    "This command can only be used on messages from these bots: Ballsdex, DynastyDex, Empireballs, HistoryDex",
                ephemeral: true,
            });
        }
        await interaction.deferReply({ ephemeral: true });
        let compareData = {
            diff: Infinity,
            country: "",
        };
        const idMap = {
            "999736048596816014": { hashes: interaction.client.hashes.BD, dex: "Ballsdex" },
            "1174135035889201173": { hashes: interaction.client.hashes.DD, dex: "DynastyDex" },
            1061145299927695400: { hashes: interaction.client.hashes.EB, dex: "Empireballs" },
            "1120942938126553190": { hashes: interaction.client.hashes.HD, dex: "HistoryDex" },
        };

        const { hashes, dex } = idMap[message.author.id] || {};

        if (message.components[0]?.components[0]?.type == 2) {
            const response = await fetch(message.attachments.first().url);
            const arrayBuffer = await response.arrayBuffer();
            const imageBuffer = Buffer.from(arrayBuffer);
            const tempFile = path.join(__dirname, "../tempImages", `${message.id}.png`);
            await sharp(imageBuffer)
                .resize(100, 100)
                .flatten({ background: { r: 0, g: 0, b: 0 } })
                .png()
                .toFile(tempFile);

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

            console.log(
                `${interaction.user.tag} | ${interaction.guild.name} | ${dex} | ${compareData.country} | ${compareData.diff} diff`
            );

            const embed = new EmbedBuilder()
                .setColor("#6839A6")
                .setTitle(compareData.country)
                .setDescription(`**Similarity:** ${100 - compareData.diff}%`)
                .setImage(
                    `https://raw.githubusercontent.com/Meff1u/BallIdentifier/refs/heads/main/assets/${dex}/${compareData.country.replace(
                        / /g,
                        "%20"
                    )}.png`
                )
                .setFooter({ text: "BallIdentifier tool made by @meffiu" });

            if (compareData.diff >= 16) {
                const reportButton = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`report_wrong_answer`)
                        .setLabel("Wrong answer? - Report")
                        .setStyle(ButtonStyle.Danger)
                );
                await interaction.editReply({
                    embeds: [embed],
                    components: [reportButton],
                    ephemeral: true,
                });

                const filter = (i) =>
                    i.customId === "report_wrong_answer" && i.user.id === interaction.user.id;
                const collector = interaction.channel.createMessageComponentCollector({
                    filter,
                    time: 60000,
                    max: 1,
                });

                collector.on("collect", async (btnInteraction) => {
                    interaction.client[message.id] = {
                        buffer: imageBuffer,
                        name: message.attachments.first().name || `${message.id}.png`,
                    };
                    const modal = new ModalBuilder()
                        .setCustomId(`rm_${message.id}_${message.channel.id}`)
                        .setTitle("Report Wrong Answer");
                    const artLinkInput = new TextInputBuilder()
                        .setCustomId("art_link")
                        .setLabel("Link to current spawn art (optional):")
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false);
                    modal.addComponents(new ActionRowBuilder().addComponents(artLinkInput));
                    await btnInteraction.showModal(modal);
                });
            } else {
                await interaction.editReply({ embeds: [embed], ephemeral: true });
            }

            const dataPath = path.join(__dirname, "../assets/data.json");
            let data;
            try {
                data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
            } catch (e) {
                data = { users: {} };
            }
            const userId = interaction.user.id;
            if (!data.users) data.users = {};
            if (!data.users[userId]) data.users[userId] = { identifyAmount: 0 };
            data.users[userId].identifyAmount += 1;
            fs.writeFileSync(dataPath, JSON.stringify(data, null, 4));

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
