const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { imageHash } = require("image-hash");

// Lazy-load node-fetch
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

// Temp images path
const TEMP_PATH = path.join(__dirname, "../tempImages");

/**
 * Find the best matching country based on perceptual hash
 * @param {string} hash - The hash to compare
 * @param {Object} hashList - Object mapping hashes to countries
 * @returns {Object} Best match with diff and country
 */
function findBestMatch(hash, hashList) {
    let bestMatch = { diff: Infinity, country: null };
    for (const [hKey, country] of Object.entries(hashList)) {
        const diff = compareHashes(hash, hKey);
        if (diff < bestMatch.diff) {
            bestMatch = { diff, country };
        }
        if (diff === 0) break;
    }
    return bestMatch;
}

/**
 * Process image from URL and compute perceptual hash
 * @param {string} imageUrl - URL of the image to process
 * @param {string} uniqueId - Unique identifier for temp file naming
 * @returns {Promise<{hash: string, buffer: Buffer}>} Hash string and original image buffer
 */
async function processImageHash(imageUrl, uniqueId) {
    const response = await fetch(imageUrl);
    const arrayBuffer = await response.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer);
    const tempFile = path.join(TEMP_PATH, `${uniqueId}.png`);

    await sharp(imageBuffer)
        .resize(100, 100)
        .flatten({ background: { r: 0, g: 0, b: 0 } })
        .png()
        .toFile(tempFile);

    const hash = await new Promise((resolve, reject) => {
        imageHash(tempFile, 20, true, (error, data) => {
            error ? reject(error) : resolve(data);
        });
    });

    fs.unlinkSync(tempFile);

    return { hash, buffer: imageBuffer };
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
    fs.writeFileSync(filePath, JSON.stringify(data, null, indent));
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
    const baseUrl =
        "https://raw.githubusercontent.com/Meff1u/BallIdentifier/refs/heads/main/assets";
    return `${baseUrl}/dexes/${encodeURIComponent(dex)}/${encodeURIComponent(ballName)}.png`;
}

/**
 * Get data file path relative to assets
 * @param {string} filename - File name
 * @returns {string} Full path
 */
function getAssetsPath(filename) {
    return path.join(__dirname, "../assets", filename);
}

module.exports = {
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
};
