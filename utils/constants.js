/**
 * Shared constants used across the application
 */

// Supported bot IDs for identification
const SUPPORTED_BOT_IDS = [
    "999736048596816014",    // Ballsdex
    "1433922711561699393",   // FoodDex
    "1120942938126553190",   // HistoryDex
    "1425109627636285511",   // JoJoDex
    "1500173453880197162",   // Empireballs Reboot
    "1406796704807915630",   // MapsDex
    "1485343094064021625"    // FlagsDex
];

// Bot ID to name mapping
const BOT_NAMES = {
    "999736048596816014": "Ballsdex",
    "1433922711561699393": "FoodDex",
    "1120942938126553190": "HistoryDex",
    "1425109627636285511": "JoJoDex",
    "1500173453880197162": "Empireballs Reboot",
    "1406796704807915630": "MapsDex",
    "1485343094064021625": "FlagsDex"
};

// Bot ID to data key mapping
const BOT_DATA_KEYS = {
    "999736048596816014": "BD",
    "1433922711561699393": "FOD",
    "1120942938126553190": "HD",
    "1425109627636285511": "JD",
    "1500173453880197162": "EB",
    "1406796704807915630": "MD",
    "1485343094064021625": "FD"
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

// Log channel
const LOG_CHANNEL_ID = "1565286048471326791";

// File paths
const DATA_FILE = "data.json";
const UPVOTES_FILE = "upvotes.json";

const SPAWN_BUTTON_LABELS = ['Annex!', 'Catch'];

// Admin / private guild (admin-only commands and .eval)
const ADMIN_ID = "334411435633541121";
const PRIVATE_GUILD_ID = "379676234566729742";

// Max hash difference for a confident match (some entries need a looser threshold)
const DEFAULT_MATCH_THRESHOLD = 20;
const MATCH_THRESHOLD_OVERRIDES = {
    "Mali Empire": 25,
    "Burkina Faso": 25,
};

module.exports = {
    SUPPORTED_BOT_IDS,
    BOT_NAMES,
    BOT_DATA_KEYS,
    ASSETS_BASE_URL,
    COOLDOWN_DURATION,
    INACTIVITY_TIMEOUT,
    NEXT_SPAWN_DELAY,
    COLORS,
    LOG_CHANNEL_ID,
    DATA_FILE,
    UPVOTES_FILE,
    SPAWN_BUTTON_LABELS,
    ADMIN_ID,
    PRIVATE_GUILD_ID,
    DEFAULT_MATCH_THRESHOLD,
    MATCH_THRESHOLD_OVERRIDES,
};
