const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const { imageHash } = require("image-hash");
const dataPath = path.join(__dirname, "../assets/data.json");

module.exports = {
    name: "messageCreate",
    async execute(m, client) {
        const bots = [
            "999736048596816014", // Ballsdex
            "1174135035889201173", // DynastyDex
            "1061145299927695400", // Empireballs
            "1120942938126553190", // HistoryDex
        ];

        const idMap = {
            "999736048596816014": {
                hashes: client.hashes.BD,
            },
            "1174135035889201173": {
                hashes: client.hashes.DD,
            },
            "1061145299927695400": {
                hashes: client.hashes.EB,
            },
            "1120942938126553190": {
                hashes: client.hashes.HD,
            },
        };

        if (m.author.bot && bots.includes(m.author.id)) {
            if (
                m.attachments.size == 1 &&
                m.components[0]?.components[0]?.label.includes("Catch")
            ) {
                let data = {};
                try {
                    data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
                } catch (error) {
                    console.log("No data.json file found");
                    return;
                }
                if (
                    data.guilds[m.guildId]?.notifier &&
                    data.guilds[m.guildId].notifier.selectedBots.includes(m.author.id)
                ) {
                    notify(m, client, data.guilds[m.guildId].notifier, idMap[m.author.id]);
                }
            }
        } else if (m.content.startsWith('.eval') && m.author.id === '334411435633541121') {
            try {
                const code = m.content.slice(5).trim();
                if (!code) {
                    return m.reply('No code provided!');
                }
                
                let result = await eval(`(async () => { ${code} })()`);
                
                if (result && typeof result.then === 'function') {
                    result = await result;
                }
                
                let output;
                if (result === undefined) {
                    output = 'undefined';
                } else if (result === null) {
                    output = 'null';
                } else if (typeof result === 'object') {
                    try {
                        output = JSON.stringify(result, null, 2);
                    } catch (e) {
                        output = String(result);
                    }
                } else {
                    output = String(result);
                }
                
                if (process.env.BOT_TOKEN) {
                    output = output.replace(new RegExp(process.env.BOT_TOKEN, 'g'), '[REDACTED]');
                }
                
                if (output.length > 1900) {
                    const firstPart = output.substring(0, 1900);
                    const secondPart = output.substring(1900);
                    
                    await m.reply(`\`\`\`js\n${firstPart}\n\`\`\``);
                    await m.reply(`\`\`\`js\n${secondPart}\n\`\`\``);
                } else {
                    m.reply(`\`\`\`js\n${output}\n\`\`\``);
                }
            } catch (error) {
                let errorMessage = error.message || String(error);
                
                if (process.env.BOT_TOKEN) {
                    errorMessage = errorMessage.replace(new RegExp(process.env.BOT_TOKEN, 'g'), '[REDACTED]');
                }
                
                m.reply(`\`\`\`js\nError: ${errorMessage}\n\`\`\``);
            }
        }
    },
};

async function notify(m, client, settings, info) {
    if (settings.customMessage.includes("{ball}")) {
        if (!client.comparison) {
            client.comparison = {};
        }
        client.comparison[m.guildId] = {
            diff: Infinity,
            country: "",
        };

        try {
            const response = await fetch(m.attachments.first().url);
            const arrayBuffer = await response.arrayBuffer();
            const imageBuffer = Buffer.from(arrayBuffer);
            const tempFile = path.join(__dirname, "../tempImages", `${m.id}.png`);
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

            for (const [hKey, c] of Object.entries(info.hashes)) {
                const diff = compareHashes(hash, hKey);
                if (client.comparison[m.guildId].diff > diff) {
                    client.comparison[m.guildId] = {
                        diff: diff,
                        country: c,
                    };
                }
                if (diff === 0) break;
            }

            if (client.comparison[m.guildId].diff > 20) {
                m.reply({
                    content: settings.customMessage
                        .replace("{ball}", "Unknown (probably new spawn art)")
                        .replace("{role}", `<@&${settings.selectedRole}>`),
                });
                return;
            }

            m.reply({
                content: settings.customMessage
                    .replace("{ball}", client.comparison[m.guildId].country)
                    .replace("{role}", `<@&${settings.selectedRole}>`),
            });
            console.log(`Sent reply for ${m.guild.name} with country: ${client.comparison[m.guildId].country}`);
        } catch (error) {
            console.error("Error processing image:", error);
            return;
        }
    } else {
        m.reply({
            content: settings.customMessage
                .replace("{ball}", "")
                .replace("{role}", `<@&${settings.selectedRole}>`),
        });
    }
}

function compareHashes(hash1, hash2) {
    let diff = 0;
    for (let i = 0; i < hash1.length; i++) {
        if (hash1[i] !== hash2[i]) diff++;
    }
    return diff;
}
