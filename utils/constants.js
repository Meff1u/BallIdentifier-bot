/**
 * Shared constants used across the application
 */

// Supported bot IDs for identification
const SUPPORTED_BOT_IDS = [
    "999736048596816014",    // Ballsdex
    "1433922711561699393"   // FoodDex
];

// Bot ID to name mapping
const BOT_NAMES = {
    "999736048596816014": "Ballsdex",
    "1433922711561699393": "FoodDex"
};

// Bot ID to data key mapping
const BOT_DATA_KEYS = {
    "999736048596816014": "BD",
    "1433922711561699393": "FD"
};

// URLs
const ASSETS_BASE_URL = "https://raw.githubusercontent.com/Meff1u/BallIdentifier/refs/heads/main/assets";

// Timeouts (in milliseconds)
const COOLDOWN_DURATION = 10 * 60 * 1000; // 10 minutes
const INACTIVITY_TIMEOUT = 30000; // 30 seconds
const NEXT_SPAWN_DELAY = 3000; // 3 seconds

// Colors
const COLORS = {
    PRIMARY: 0xa020f0,
    SUCCESS: 0x00ff00,
    WARNING: 0xfee75c,
    ERROR: 0xff0000,
    INFO: 0x0099ff,
    LOG: 0x6839a6,
    DISABLED: 0x808080,
};

// File paths
const DATA_FILE = "data.json";
const UPVOTES_FILE = "upvotes.json";
const BALLSLIST_FILE = "ballslist.json";

module.exports = {
    SUPPORTED_BOT_IDS,
    BOT_NAMES,
    BOT_DATA_KEYS,
    ASSETS_BASE_URL,
    COOLDOWN_DURATION,
    INACTIVITY_TIMEOUT,
    NEXT_SPAWN_DELAY,
    COLORS,
    DATA_FILE,
    UPVOTES_FILE,
    BALLSLIST_FILE,
};
