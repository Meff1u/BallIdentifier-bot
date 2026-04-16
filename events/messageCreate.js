const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const { imageHash } = require("image-hash");

const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

// Import shared utilities
const { SUPPORTED_BOT_IDS, BOT_DATA_KEYS, BOT_NAMES, COLORS } = require("../utils/constants");
const { readJsonFile, writeJsonFile, getAssetsPath, processImageHash, findBestMatch } = require("../utils/helpers");

// Local constants
const DATA_PATH = getAssetsPath("data.json");
const ADMIN_ID = "334411435633541121";

module.exports = {
    name: "messageCreate",
    async execute(m, client) {
        // Handle bot spawn messages for notifier
        if (m.author.bot && SUPPORTED_BOT_IDS.includes(m.author.id)) {
            const isCatchMessage = m.attachments.size === 1 && 
                                   m.components[0]?.components[0]?.label?.includes("Catch");
            
            if (isCatchMessage) {
                const data = readJsonFile(DATA_PATH, { guilds: {} });
                
                const guildConfig = data.guilds?.[m.guildId]?.notifier;
                if (guildConfig?.selectedBots.includes(m.author.id)) {
                    const hashKey = BOT_DATA_KEYS[m.author.id];
                    await notify(m, client, guildConfig, { hashes: client.hashes[hashKey] });
                }
            }
            return;
        }
        
        // Handle eval command for admin
        if (m.content.startsWith(".eval") && m.author.id === ADMIN_ID) {
            await handleEval(m, client);
        }
    },
};

/**
 * Handle eval command
 */
async function handleEval(m, client) {
    try {
        const code = m.content.slice(5).trim();
        if (!code) return m.reply("No code provided!");
        
        let result = await eval(`(async () => { ${code} })()`);
        
        let output = result === undefined ? "undefined"
                   : result === null ? "null"
                   : typeof result === "object" ? JSON.stringify(result, null, 2)
                   : String(result);
        
        // Redact sensitive info
        if (process.env.BOT_TOKEN) {
            output = output.replace(new RegExp(process.env.BOT_TOKEN, "g"), "[REDACTED]");
        }
        
        // Split output into chunks that fit in Discord's 2000 character limit
        const maxChunkLength = 1900; // Account for code block markers
        const chunks = [];
        
        for (let i = 0; i < output.length; i += maxChunkLength) {
            chunks.push(output.substring(i, i + maxChunkLength));
        }
        
        // Send each chunk as a separate message
        for (let i = 0; i < chunks.length; i++) {
            const isLastChunk = i === chunks.length - 1;
            const header = chunks.length > 1 ? `[${i + 1}/${chunks.length}]\n` : "";
            await m.reply(`\`\`\`js\n${header}${chunks[i]}\n\`\`\``);
        }
    } catch (error) {
        let errorMessage = error.message || String(error);
        if (process.env.BOT_TOKEN) {
            errorMessage = errorMessage.replace(new RegExp(process.env.BOT_TOKEN, "g"), "[REDACTED]");
        }
        
        // Handle long error messages the same way
        const maxChunkLength = 1900;
        const chunks = [];
        
        for (let i = 0; i < errorMessage.length; i += maxChunkLength) {
            chunks.push(errorMessage.substring(i, i + maxChunkLength));
        }
        
        for (let i = 0; i < chunks.length; i++) {
            const header = chunks.length > 1 ? `[${i + 1}/${chunks.length}]\n` : "";
            await m.reply(`\`\`\`js\nError: ${header}${chunks[i]}\n\`\`\``);
        }
    }
}

/**
 * Send notification for spawn
 */
async function notify(m, client, settings, info) {
    const { customMessage, selectedRole } = settings;

    try {
        // Process image to identify ball
        const { hash, buffer: imageBuffer } = await processImageHash(m.attachments.first().url, m.id);

        // Find best match
        let bestMatch = findBestMatch(hash, info.hashes);

        const minDiff = bestMatch.country == "Mali Empire" ? 25 : 20;

        // Determine ball name
        const ballName = bestMatch.diff > minDiff
            ? "Unknown (probably new spawn art)" 
            : bestMatch.country;

        const foundBall = client.rarities[BOT_DATA_KEYS[m.author.id]]?.[bestMatch.country];
        
        const rarity = (ballName.includes("Unknown") || !foundBall) ? "Unknown" : foundBall.rarity;
        const artist = (ballName.includes("Unknown") || !foundBall) ? "Unknown" : foundBall.artist;

        m.reply({
            content: customMessage
                .replace("{ball}", customMessage.includes("{ball}") ? ballName : "")
                .replace("{role}", `<@&${selectedRole}>`)
                .replace("{rarity}", rarity)
                .replace("{artist}", artist),
        });
        
        // Log the identification result
        const status = bestMatch.diff <= minDiff ? "✅ Identified" : "⚠️ Unknown";
        client.logImage(`[${m.guild.name}] ${status}: ${ballName} (diff: ${bestMatch.diff})`);
        
        if (bestMatch.diff <= minDiff) {
            console.log(`Sent reply for ${m.guild.name} with country: ${bestMatch.country}`);
            
            // Increment identifyAmount counter
            const data = readJsonFile(DATA_PATH, { guilds: {} });
            if (!data.guilds[m.guildId]) {
                data.guilds[m.guildId] = {};
            }
            if (!data.guilds[m.guildId].identifyAmount) {
                data.guilds[m.guildId].identifyAmount = 0;
            }
            data.guilds[m.guildId].identifyAmount++;
            writeJsonFile(DATA_PATH, data);
        } else if (bestMatch.diff > minDiff) {
            // Send report for unknown spawn art
            const webhookUrl = process.env.REPORT_WEBHOOK_URL;
            if (webhookUrl) {
                try {
                    const botDex = BOT_NAMES[m.author.id] || "Unknown";
                    const form = new FormData();
                    form.append("payload_json", JSON.stringify({
                        embeds: [{
                            title: "Unknown spawn art report (AutoNotifier)",
                            color: COLORS.ERROR,
                            fields: [
                                { name: "Server", value: m.guild.name },
                                { name: "Best match", value: `${bestMatch.country} (${bestMatch.diff} diff)` },
                                { name: "Bot", value: botDex },
                                { name: "Message Link", value: `[Link](${m.url})` },
                                { name: "Target Spawn URL", value: m.attachments.first().url },
                            ],
                            thumbnail: { url: m.attachments.first().url },
                            timestamp: new Date().toISOString(),
                        }],
                    }));
                    form.append("file", imageBuffer, m.attachments.first().name || `${m.id}.png`);
                    await fetch(webhookUrl, { method: "POST", body: form });
                } catch (e) {
                    console.error("Error sending auto-notifier report:", e);
                }
            }
        }
    } catch (error) {
        console.error("Error processing image:", error);
        client.logImage(`[${m.guild.name}] ❌ Image processing error: ${error.message}`);
    }
}
