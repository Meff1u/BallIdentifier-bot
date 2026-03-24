/**
 * Batched logging system for Discord channels
 * Groups logs by category and sends them in batches
 * Sends every 10 minutes or when batch exceeds 20 items
 */

const { EmbedBuilder } = require("discord.js");
const { LOG_IDS } = require("./constants");

// Store for batched logs by category
const logBatches = new Map([
    ["DISCORD", []],
    ["IMAGE", []],
    ["API", []],
    ["GENERAL", []],
]);

// Batch timers
const batchTimers = new Map();

// Category to thread ID mapping
const categoryToThreadId = {
    DISCORD: LOG_IDS.DISCORD,
    IMAGE: LOG_IDS.IMAGE,
    API: LOG_IDS.API,
    GENERAL: LOG_IDS.GENERAL,
};

/**
 * Format timestamp with full date and time
 * @returns {string} Formatted timestamp
 */
function getTimestamp() {
    const now = new Date();
    return now.toLocaleString("pl-PL", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

/**
 * Add a log entry to a category batch
 * @param {string} category - Log category (DISCORD, IMAGE, API, GENERAL)
 * @param {string} message - Log message
 * @param {object} client - Discord client
 */
function addLog(category, message, client) {
    const validCategories = ["DISCORD", "IMAGE", "API", "GENERAL"];
    
    if (!validCategories.includes(category)) {
        console.warn(`[Logger] Invalid category: ${category}`);
        return;
    }

    const timestamp = getTimestamp();
    const formattedLog = `[${timestamp}] ${message}`;

    // Add to batch
    logBatches.get(category).push(formattedLog);

    // Check if batch should be sent
    if (logBatches.get(category).length >= 20) {
        sendBatch(category, client);
    } else {
        // Set up timer if not already scheduled
        if (!batchTimers.has(category)) {
            const timer = setTimeout(() => {
                sendBatch(category, client);
            }, 2 * 60 * 1000); // 2 minutes

            batchTimers.set(category, timer);
        }
    }
}

/**
 * Send a batch of logs to Discord thread
 * @param {string} category - Log category
 * @param {object} client - Discord client
 */
async function sendBatch(category, client) {
    const batch = logBatches.get(category);
    
    if (batch.length === 0) return;

    const threadId = categoryToThreadId[category];
    
    try {
        const channel = await client.channels.fetch(threadId);
        
        if (!channel) {
            console.error(`[Logger] Thread not found: ${threadId}`);
            logBatches.set(category, []);
            return;
        }

        // Split logs into chunks of ~1900 chars to avoid message length limits
        const chunks = [];
        let currentChunk = "";

        for (const log of batch) {
            if ((currentChunk + log + "\n").length > 1900) {
                if (currentChunk) chunks.push(currentChunk.trim());
                currentChunk = log + "\n";
            } else {
                currentChunk += log + "\n";
            }
        }
        
        if (currentChunk) chunks.push(currentChunk.trim());

        // Send chunks
        for (const chunk of chunks) {
            const embed = new EmbedBuilder()
                .setTitle(`📋 ${category} Logs`)
                .setDescription(`\`\`\`\n${chunk}\n\`\`\``)
                .setColor(getCategoryColor(category))
                .setTimestamp();

            await channel.send({ embeds: [embed] });
        }

        console.log(`[Logger] Sent ${batch.length} ${category} logs`);
    } catch (error) {
        console.error(`[Logger] Error sending batch for ${category}:`, error);
    }

    // Clear batch and timer
    logBatches.set(category, []);
    const timer = batchTimers.get(category);
    if (timer) {
        clearTimeout(timer);
        batchTimers.delete(category);
    }
}

/**
 * Get color for log category
 * @param {string} category - Log category
 * @returns {number} Discord color code
 */
function getCategoryColor(category) {
    const colors = {
        DISCORD: 0x7289da,  // Discord blue
        IMAGE: 0x9966ff,    // Purple
        API: 0x2ecc71,      // Green
        GENERAL: 0xf39c12,  // Orange
    };
    return colors[category] || 0x95a5a6;
}

/**
 * Force send all pending batches
 * @param {object} client - Discord client
 */
async function flushAllBatches(client) {
    for (const [category] of logBatches) {
        await sendBatch(category, client);
    }
}

/**
 * Clear all timers and batches (for cleanup)
 */
function clearAllBatches() {
    for (const [, timer] of batchTimers) {
        clearTimeout(timer);
    }
    logBatches.clear();
    batchTimers.clear();
    logBatches.set("DISCORD", []);
    logBatches.set("IMAGE", []);
    logBatches.set("API", []);
    logBatches.set("GENERAL", []);
}

/**
 * Get current batch sizes (for debugging)
 * @returns {object} Current batch sizes by category
 */
function getBatchSizes() {
    const sizes = {};
    for (const [category, batch] of logBatches) {
        sizes[category] = batch.length;
    }
    return sizes;
}

module.exports = {
    addLog,
    sendBatch,
    flushAllBatches,
    clearAllBatches,
    getBatchSizes,
    getTimestamp,
};
