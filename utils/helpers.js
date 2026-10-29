const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { imageHash } = require("image-hash");
const {
    SPAWN_BUTTON_LABELS,
    ASSETS_BASE_URL,
    DEFAULT_MATCH_THRESHOLD,
    MATCH_THRESHOLD_OVERRIDES,
} = require("./constants");

// Lazy-load node-fetch
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const DATA_PATH = path.join(__dirname, "../assets/data.json");

/**
 * Find the best matching country based on perceptual hash
 * @param {string} hash - The hash to compare
 * @param {Object} hashList - Object mapping countries to hashes
 * @returns {Object} Best match with diff and country
 */
function findBestMatch(hash, hashList) {
    let bestMatch = { diff: Infinity, country: null };
    for (const [country, referenceHash] of Object.entries(hashList)) {
        const diff = compareHashes(hash, referenceHash);
        if (diff < bestMatch.diff) {
            bestMatch = { diff, country };
        }
        if (diff === 0) break;
    }
    return bestMatch;
}

/**
 * Download a URL into a Buffer (throws on HTTP errors)
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
async function downloadBuffer(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
}

/**
 * Compute the perceptual hash of an image buffer (same pipeline as the website and asset tools:
 * resize 100x100, flatten on black, PNG, imageHash 20 bits precise)
 * @param {Buffer} imageBuffer
 * @returns {Promise<string>}
 */
async function hashImageBuffer(imageBuffer) {
    const png = await sharp(imageBuffer)
        .resize(100, 100)
        .flatten({ background: { r: 0, g: 0, b: 0 } })
        .png()
        .toBuffer();

    return new Promise((resolve, reject) => {
        imageHash({ ext: "image/png", data: png }, 20, true, (error, data) => {
            error ? reject(error) : resolve(data);
        });
    });
}

/**
 * Process image from URL and compute perceptual hash
 * @param {string} imageUrl - URL of the image to process
 * @returns {Promise<{hash: string, buffer: Buffer}>} Hash string and original image buffer
 */
async function processImageHash(imageUrl) {
    const buffer = await downloadBuffer(imageUrl);
    const hash = await hashImageBuffer(buffer);
    return { hash, buffer };
}

/**
 * Max allowed hash difference for a confident match of the given entry
 * @param {string} name - Best matching entry name
 * @returns {number}
 */
function getMatchThreshold(name) {
    return MATCH_THRESHOLD_OVERRIDES[name] ?? DEFAULT_MATCH_THRESHOLD;
}

/**
 * Extract spawn image data from a dex bot message (legacy attachments and components v2)
 * @param {import("discord.js").Message} message
 * @returns {{isSpawn: boolean, imageUrl: string|null, imageName: string|null, messageType: string|null}}
 */
function getSpawnMessageData(message) {
    const legacyAttachment = message.attachments?.first?.();
    const isLegacySpawn =
        message.attachments?.size === 1 &&
        SPAWN_BUTTON_LABELS.some((text) => message.components?.[0]?.components?.[0]?.label?.includes(text));

    const v2ImageUrl = message.components?.[1]?.items?.[0]?.media?.url;
    const v2ButtonLabel = message.components?.at(-1)?.components?.[0]?.label;
    const isV2Spawn = Boolean(v2ImageUrl && SPAWN_BUTTON_LABELS.some((text) => v2ButtonLabel?.includes(text)));

    if (isLegacySpawn && legacyAttachment?.url) {
        return {
            isSpawn: true,
            imageUrl: legacyAttachment.url,
            imageName: legacyAttachment.name || `${message.id}.png`,
            messageType: "legacy",
        };
    }

    if (isV2Spawn) {
        return { isSpawn: true, imageUrl: v2ImageUrl, imageName: `${message.id}.png`, messageType: "components-v2" };
    }

    return { isSpawn: false, imageUrl: null, imageName: null, messageType: null };
}

/**
 * Safely read and parse JSON file
 * @param {string} filePath - Path to the JSON file
 * @param {object} defaultValue - Default value if file doesn't exist or is invalid
 * @returns {object} Parsed JSON or default value
 */
function readJsonFile(filePath, defaultValue = {}) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) {
        return defaultValue;
    }
}

/**
 * Safely write JSON to file
 * @param {string} filePath - Path to the JSON file
 * @param {object} data - Data to write
 * @param {number} indent - Indentation level
 */
function writeJsonFile(filePath, data, indent = 2) {
    // Write to a temp file and rename, so a crash mid-write can never leave a truncated file
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, indent));
    fs.renameSync(tempPath, filePath);
}

// Read-only cache of data.json, refreshed when the file changes on disk
let dataCache = { mtimeMs: -1, size: -1, data: null };

/**
 * Read data.json (cached).
 * @returns {{users: object, guilds: object}}
 */
function getData() {
    try {
        const stat = fs.statSync(DATA_PATH);
        if (stat.mtimeMs !== dataCache.mtimeMs || stat.size !== dataCache.size) {
            const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
            data.users ??= {};
            data.guilds ??= {};
            dataCache = { mtimeMs: stat.mtimeMs, size: stat.size, data };
        }
        return dataCache.data;
    } catch (error) {
        if (error.code === "ENOENT") return { users: {}, guilds: {} };
        console.error("[DATA] Failed to read data.json:", error.message);
        return dataCache.data || { users: {}, guilds: {} };
    }
}

/**
 * Atomically update data.json: read fresh -> mutate -> write, with no await in between,
 * so concurrent commands can't overwrite each other's changes.
 * Refuses to write if the existing file can't be parsed (prevents wiping all data).
 * @param {(data: {users: object, guilds: object}) => any} mutator
 * @returns {any} Whatever the mutator returns
 */
function updateData(mutator) {
    let data;
    try {
        data = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    } catch (error) {
        if (error.code !== "ENOENT") {
            throw new Error(`data.json is unreadable, refusing to overwrite it: ${error.message}`);
        }
        data = {};
    }
    data.users ??= {};
    data.guilds ??= {};

    const result = mutator(data);
    writeJsonFile(DATA_PATH, data);
    dataCache = { mtimeMs: -1, size: -1, data: null };
    return result;
}

/**
 * Compare two perceptual hashes and return the Hamming distance
 * @param {string} hash1 - First hash
 * @param {string} hash2 - Second hash
 * @returns {number} Number of differing bits
 */
function compareHashes(hash1, hash2) {
    let diff = 0;
    const len = Math.min(hash1.length, hash2.length);
    for (let i = 0; i < len; i++) {
        if (hash1[i] !== hash2[i]) diff++;
    }
    return diff;
}

/**
 * Format milliseconds into human-readable duration
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Formatted duration string
 */
function formatDuration(ms) {
    const sec = Math.floor((ms / 1000) % 60);
    const min = Math.floor((ms / (1000 * 60)) % 60);
    const hr = Math.floor((ms / (1000 * 60 * 60)) % 24);
    const d = Math.floor(ms / (1000 * 60 * 60 * 24));

    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (hr > 0) parts.push(`${hr}h`);
    if (min > 0) parts.push(`${min}m`);
    parts.push(`${sec}s`);

    return parts.join(" ");
}

/**
 * Check if user is on cooldown
 * @param {Map} cooldowns - Cooldown map
 * @param {string} userId - User ID to check
 * @param {number} duration - Cooldown duration in ms
 * @returns {number|null} Minutes remaining or null if not on cooldown
 */
function checkCooldown(cooldowns, userId, duration) {
    const cooldown = cooldowns.get(userId);
    const now = Date.now();

    if (cooldown && now - cooldown < duration) {
        return Math.ceil((duration - (now - cooldown)) / 60000);
    }
    return null;
}

/**
 * Set cooldown for a user
 * @param {Map} cooldowns - Cooldown map
 * @param {string} userId - User ID
 */
function setCooldown(cooldowns, userId) {
    cooldowns.set(userId, Date.now());
}

/**
 * Check if user has upvoted
 * @param {object} upvotes - Upvotes object from client
 * @param {string} userId - User ID to check
 * @returns {boolean}
 */
function isUpvoter(upvotes, userId) {
    return Array.isArray(upvotes?.upvotes) && upvotes.upvotes.some((v) => v.user_id === userId);
}

/**
 * Build image URL for a ball
 * @param {string} dex - Dex name
 * @param {string} ballName - Ball name
 * @returns {string} Full URL
 */
function buildBallImageUrl(dex, ballName) {
    return `${ASSETS_BASE_URL}/dexes/${encodeURIComponent(dex)}/${encodeURIComponent(ballName)}.png`;
}

/**
 * Get data file path relative to assets
 * @param {string} filename - File name
 * @returns {string} Full path
 */
function getAssetsPath(filename) {
    return path.join(__dirname, "../assets", filename);
}

/**
 * Send a report to a thread in the report channel using components v2
 * @param {object} client - Discord client
 * @param {string} dexName - Name of the dex (e.g., "Ballsdex")
 * @param {object} containerBuilder - ContainerBuilder for message content
 * @param {object} options - Additional options (files array with {attachment, name}; dexKey + bestMatch add the edit buttons)
 * @returns {Promise<boolean>} Success status
 */
async function sendThreadReport(client, dexName, containerBuilder, options = {}) {
    const { MessageFlags } = require("discord.js");
    const REPORT_CHANNEL_ID = process.env.REPORT_CHANNEL_ID;

    if (!REPORT_CHANNEL_ID) {
        console.error("[REPORT] REPORT_CHANNEL_ID not configured");
        return false;
    }

    try {
        const channel = await client.channels.fetch(REPORT_CHANNEL_ID);

        if (!channel || !channel.isTextBased()) {
            console.error("[REPORT] Report channel not found or is not text-based");
            return false;
        }

        let thread = null;

        const archivedThreads = await channel.threads.fetchArchived({ limit: 100 });
        thread = archivedThreads.threads.find((t) => t.name === dexName);

        if (!thread) {
            const activeThreads = await channel.threads.fetch();
            thread = activeThreads.threads.find((t) => t.name === dexName);
        }

        if (!thread) {
            thread = await channel.threads.create({
                name: dexName,
                autoArchiveDuration: 60, // Archive after 1 hour of inactivity
            });
            client.logGeneral?.(`Reports: created thread for ${dexName}`);
        } else if (thread.archived) {
            // Unarchive thread if needed
            await thread.edit({ archived: false });
        }

        const messagePayload = {
            components: [containerBuilder],
            flags: MessageFlags.IsComponentsV2,
        };

        // Add media gallery if provided
        if (options.mediaGallery) {
            messagePayload.components.push(options.mediaGallery);
        }

        // Owner buttons: update the matched entry with this art, or add it as a new one
        if (options.dexKey) {
            messagePayload.components.push(require("./dex-report-actions").reportButtons(options.dexKey, options.bestMatch));
        }

        // Add files if provided
        if (options.files && Array.isArray(options.files)) {
            messagePayload.files = options.files;
        }

        await thread.send(messagePayload);
        client.logGeneral?.(`Reports: unknown spawn art reported in ${dexName}`);
        return true;
    } catch (error) {
        console.error("[REPORT] Error sending thread report:", error);
        return false;
    }
}

module.exports = {
    getData,
    updateData,
    downloadBuffer,
    hashImageBuffer,
    getMatchThreshold,
    getSpawnMessageData,
    readJsonFile,
    writeJsonFile,
    compareHashes,
    formatDuration,
    findBestMatch,
    checkCooldown,
    setCooldown,
    isUpvoter,
    buildBallImageUrl,
    getAssetsPath,
    processImageHash,
    sendThreadReport,
};
