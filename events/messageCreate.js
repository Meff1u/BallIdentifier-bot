const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const { imageHash } = require("image-hash");

const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

// Import shared utilities
const { SUPPORTED_BOT_IDS, BOT_DATA_KEYS } = require("../utils/constants");
const { readJsonFile, writeJsonFile, compareHashes, getAssetsPath, processImageHash } = require("../utils/helpers");

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
                const botName = m.author.username;
                
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
    client.logImage(`📸 Spawn detected from ${botName} in ${m.guild.name}`);
    const { customMessage, selectedRole } = settings;
    
    // If no ball placeholder, send simple notification
    if (!customMessage.includes("{ball}")) {
        return m.reply({
            content: customMessage.replace("{ball}", "").replace("{role}", `<@&${selectedRole}>`),
        });
    }

    try {
        // Process image to identify ball
        const { hash } = await processImageHash(m.attachments.first().url, m.id);

        // Find best match
        let bestMatch = { diff: Infinity, country: "" };
        
        for (const [hKey, country] of Object.entries(info.hashes)) {
            const diff = compareHashes(hash, hKey);
            if (diff < bestMatch.diff) {
                bestMatch = { diff, country };
            }
            if (diff === 0) break;
        }

        // Determine ball name
        const ballName = bestMatch.diff > 20 
            ? "Unknown (probably new spawn art)" 
            : bestMatch.country;

        m.reply({
            content: customMessage
                .replace("{ball}", ballName)
                .replace("{role}", `<@&${selectedRole}>`),
        });
        
        // Log the identification result
        const status = bestMatch.diff <= 20 ? "✅ Identified" : "⚠️ Unknown";
        client.logImage(`${status}: ${ballName} (diff: ${bestMatch.diff}) | Server: ${m.guild.name}`);
        
        if (bestMatch.diff <= 20) {
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
        }
    } catch (error) {
        console.error("Error processing image:", error);
        client.logImage(`❌ Image processing error: ${error.message}`);
    }
}
