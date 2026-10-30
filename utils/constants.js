/**
 * Shared constants used across the application
 */

/*
 * Supported dexes. The list lives in the website repo (assets/jsons/dexes.json, edited on the website:
 * Moderation -> Dexes) and is loaded by utils/dexes.js, which updates these objects in place.
 * The values below are only the fallback until it loads. Only enabled dexes are in the three maps.
 */
const DEX_REGISTRY = [
    { name: "Ballsdex", botId: "999736048596816014", key: "BD", enabled: true, waves: true, previousArts: true },
    { name: "HistoryDex", botId: "1120942938126553190", key: "HD", enabled: true },
    { name: "JoJoDex", botId: "1425109627636285511", key: "JD", enabled: true },
    { name: "Empireballs Reboot", botId: "1500173453880197162", key: "EB", enabled: true },
    { name: "MapsDex", botId: "1406796704807915630", key: "MD", enabled: true },
    { name: "FlagsDex", botId: "1485343094064021625", key: "FD", enabled: true },
];

// Supported bot IDs for identification
const SUPPORTED_BOT_IDS = DEX_REGISTRY.map((dex) => dex.botId);
// Bot ID to name mapping
const BOT_NAMES = Object.fromEntries(DEX_REGISTRY.map((dex) => [dex.botId, dex.name]));
// Bot ID to data key mapping
const BOT_DATA_KEYS = Object.fromEntries(DEX_REGISTRY.map((dex) => [dex.botId, dex.key]));

/** Read-only map that is rebuilt on every access (stays right when the dex list changes). */
const liveMap = (build) =>
    new Proxy(
        {},
        {
            get: (_, key) => (typeof key === "string" ? build()[key] : undefined),
            has: (_, key) => key in build(),
            ownKeys: () => Reflect.ownKeys(build()),
            getOwnPropertyDescriptor: (_, key) => {
                const map = build();
                return key in map ? { value: map[key], enumerable: true, configurable: true, writable: false } : undefined;
            },
        },
    );
// Enabled dexes: name -> data key
const DEX_KEY_BY_NAME = liveMap(() => Object.fromEntries(Object.entries(BOT_DATA_KEYS).map(([botId, key]) => [BOT_NAMES[botId], key])));
// Every dex on the list, turned-off ones too (the owner can fill a dex before turning it on): name -> data key
const DEX_KEY_BY_NAME_ALL = liveMap(() => Object.fromEntries(DEX_REGISTRY.map((dex) => [dex.name, dex.key])));
// Every known dex (disabled ones too, for old data): data key -> name
const DEX_NAME_BY_KEY = liveMap(() => Object.fromEntries(DEX_REGISTRY.map((dex) => [dex.key, dex.name])));

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
    DEX_REGISTRY,
    DEX_KEY_BY_NAME,
    DEX_KEY_BY_NAME_ALL,
    DEX_NAME_BY_KEY,
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
