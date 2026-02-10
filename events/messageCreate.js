const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const { imageHash } = require("image-hash");

const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

// Import shared utilities
const { SUPPORTED_BOT_IDS, BOT_DATA_KEYS } = require("../utils/constants");
const { readJsonFile, compareHashes, getAssetsPath, processImageHash } = require("../utils/helpers");

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
        
        // Handle long outputs
        if (output.length > 1900) {
            await m.reply(`\`\`\`js\n${output.substring(0, 1900)}\n\`\`\``);
            await m.reply(`\`\`\`js\n${output.substring(1900)}\n\`\`\``);
        } else {
            m.reply(`\`\`\`js\n${output}\n\`\`\``);
        }
    } catch (error) {
        let errorMessage = error.message || String(error);
        if (process.env.BOT_TOKEN) {
            errorMessage = errorMessage.replace(new RegExp(process.env.BOT_TOKEN, "g"), "[REDACTED]");
        }
        m.reply(`\`\`\`js\nError: ${errorMessage}\n\`\`\``);
    }
}

/**
 * Send notification for spawn
 */
async function notify(m, client, settings, info) {
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
        
        if (bestMatch.diff <= 20) {
            console.log(`Sent reply for ${m.guild.name} with country: ${bestMatch.country}`);
        }
    } catch (error) {
        console.error("Error processing image:", error);
    }
}
