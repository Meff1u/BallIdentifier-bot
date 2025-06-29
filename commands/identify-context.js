const {
    ContextMenuCommandBuilder,
    ApplicationCommandType,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
} = require("discord.js");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const { imageHash } = require("image-hash");
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

const SUPPORTED_BOT_IDS = [
    "999736048596816014",
    "1174135035889201173",
    "1061145299927695400",
    "1120942938126553190",
];
const REPORT_COLOR = 0xfee75c;

module.exports = {
    data: new ContextMenuCommandBuilder()
        .setName("Identify")
        .setType(ApplicationCommandType.Message),
    async execute(interaction) {
        if (!interaction.client.identifyCooldowns) interaction.client.identifyCooldowns = new Map();
        const isUpvoter =
            Array.isArray(interaction.client.upvotes.upvotes) &&
            interaction.client.upvotes.upvotes.some((v) => v.user_id === interaction.user.id);
        if (!isUpvoter) {
            const cooldown = interaction.client.identifyCooldowns.get(interaction.user.id);
            const now = Date.now();
            if (cooldown && now - cooldown < 10 * 60 * 1000) {
                const left = Math.ceil((10 * 60 * 1000 - (now - cooldown)) / 60000);
                return interaction.reply({
                    content: `You can use this function again in ${left} min. ([Upvoters](https://discordbotlist.com/bots/ballidentifier/upvote) have no cooldown)`,
                    flags: MessageFlags.Ephemeral,
                });
            }
            interaction.client.identifyCooldowns.set(interaction.user.id, now);
        }
        try {
            const message = interaction.targetMessage;
            if (!message) {
                return interaction.reply({
                    content: "Error while getting message, try again.",
                    flags: MessageFlags.Ephemeral,
                });
            }
            if (!message.attachments || message.attachments.size === 0) {
                return interaction.reply({
                    content: "No attachments found in the message.",
                    flags: MessageFlags.Ephemeral,
                });
            }
            if (!SUPPORTED_BOT_IDS.includes(message.author.id)) {
                return interaction.reply({
                    content:
                        "This command can only be used on messages from these bots: Ballsdex, DynastyDex, Empireballs, HistoryDex",
                    flags: MessageFlags.Ephemeral,
                });
            }
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            let compareData = {
                diff: Infinity,
                country: "",
            };
            const idMap = {
                "999736048596816014": {
                    hashes: interaction.client.hashes.BD,
                    dex: "Ballsdex",
                    dKey: "BD",
                },
                "1174135035889201173": {
                    hashes: interaction.client.hashes.DD,
                    dex: "Dynastydex",
                    dKey: "DD",
                },
                1061145299927695400: {
                    hashes: interaction.client.hashes.EB,
                    dex: "Empireballs",
                    dKey: "EB",
                },
                "1120942938126553190": {
                    hashes: interaction.client.hashes.HD,
                    dex: "HistoryDex",
                    dKey: "HD",
                },
            };
            const dataPath = path.join(__dirname, "../assets/data.json");
            let data;
            try {
                data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
            } catch (e) {
                data = { users: {} };
            }

            const { hashes, dex, dKey } = idMap[message.author.id] || {};

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

                let logColor =
                    compareData.diff <= 10
                        ? 0x00ff00
                        : compareData.diff <= 15
                        ? 0xfee75c
                        : 0xff0000;

                const imageUrl = `https://raw.githubusercontent.com/Meff1u/BallIdentifier/refs/heads/main/assets/${dex}/${compareData.country.replace(
                    / /g,
                    "%20"
                )}.png`;
                const logFields = [
                    {
                        name: "User",
                        value: `${interaction.user.tag} (${interaction.user.id})`,
                        inline: false,
                    },
                    { name: "Dex", value: dex, inline: true },
                    { name: "Country", value: compareData.country, inline: true },
                    { name: "Diff", value: String(compareData.diff), inline: true },
                    { name: "Rarity", value: `t${interaction.client.rarities[dKey]?.[compareData.country]?.rarity || "Not found"}`, inline: true },
                ];
                if (compareData.diff >= 16) {
                    logFields.push({ name: "Target Spawn Art", value: "\u200B" });
                }
                await interaction.client.sendLog({
                    title: "Identify Log",
                    fields: logFields,
                    thumbnail: imageUrl,
                    image: compareData.diff >= 16 ? message.attachments.first().url : null,
                    color: logColor,
                });

                const embed = new EmbedBuilder()
                    .setColor(0xa020f0)
                    .setTitle(compareData.country)
                    .setDescription(
                        `**Similarity:** ${100 - compareData.diff}%\n**Rarity:** ${
                            interaction.client.rarities[dKey]?.[compareData.country]?.rarity
                                ? `t${
                                      interaction.client.rarities[dKey][compareData.country].rarity
                                  }`
                                : "Not found"
                        }`
                    )
                    .setImage(imageUrl)
                    .setFooter({
                        text: `You have identified ${
                            (data.users[interaction.user.id]?.identifyAmount || 0) + 1
                        } balls!`,
                    });

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
                        flags: MessageFlags.Ephemeral,
                    });

                    const filter = (i) =>
                        i.customId === "report_wrong_answer" && i.user.id === interaction.user.id;
                    const collector = interaction.channel.createMessageComponentCollector({
                        filter,
                        time: 60000,
                        max: 1,
                    });

                    collector.on("collect", async (btnInteraction) => {
                        if (!interaction.client.reportCooldowns)
                            interaction.client.reportCooldowns = new Map();
                        const cooldown = interaction.client.reportCooldowns.get(
                            btnInteraction.user.id
                        );
                        const now = Date.now();
                        if (cooldown && now - cooldown < 10 * 60 * 1000) {
                            const left = Math.ceil((10 * 60 * 1000 - (now - cooldown)) / 60000);
                            await btnInteraction.reply({
                                content: `You can send another report in ${left} min.`,
                                flags: MessageFlags.Ephemeral,
                            });
                            return;
                        }

                        const webhookUrl = process.env.REPORT_WEBHOOK_URL;
                        if (webhookUrl) {
                            try {
                                const form = new (require("form-data"))();
                                form.append(
                                    "payload_json",
                                    JSON.stringify({
                                        embeds: [
                                            {
                                                title: "Wrong answer report",
                                                color: REPORT_COLOR,
                                                fields: [
                                                    {
                                                        name: "User",
                                                        value: `${btnInteraction.user.tag} (${btnInteraction.user.id})`,
                                                    },
                                                    {
                                                        name: "Detected country",
                                                        value: `${compareData.country} (${compareData.diff} diff)`,
                                                    },
                                                    { name: "Bot", value: dex },
                                                    {
                                                        name: "Target Spawn URL",
                                                        value: message.attachments.first().url,
                                                    },
                                                ],
                                                thumbnail: { url: imageUrl },
                                                timestamp: new Date().toISOString(),
                                            },
                                        ],
                                    })
                                );
                                form.append(
                                    "file",
                                    imageBuffer,
                                    message.attachments.first().name || `${message.id}.png`
                                );
                                await fetch(webhookUrl, {
                                    method: "POST",
                                    body: form,
                                });
                            } catch (e) {}
                        }
                        interaction.client.reportCooldowns.set(btnInteraction.user.id, now);
                        await btnInteraction.reply({
                            content: "Report sent. Thank you!",
                            flags: MessageFlags.Ephemeral,
                        });
                    });
                } else {
                    await interaction.editReply({ embeds: [embed], flags: MessageFlags.Ephemeral });
                }

                if (compareData.diff <= 15) {
                    const userId = interaction.user.id;
                    if (!data.users) data.users = {};
                    if (!data.users[userId]) data.users[userId] = { identifyAmount: 0 };
                    data.users[userId].identifyAmount += 1;
                    fs.writeFileSync(dataPath, JSON.stringify(data, null, 4));
                }

                return await interaction.editReply({
                    embeds: [embed],
                    flags: MessageFlags.Ephemeral,
                });
            }
        } catch (error) {
            const webhookUrl = process.env.ERROR_WEBHOOK_URL;
            if (webhookUrl) {
                try {
                    await fetch(webhookUrl, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            embeds: [
                                {
                                    title: `Identify Command Error`,
                                    description: error.stack || String(error),
                                    color: 0xff0000,
                                    timestamp: new Date().toISOString(),
                                },
                            ],
                        }),
                    });
                } catch (e) {}
            }
            throw error;
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
