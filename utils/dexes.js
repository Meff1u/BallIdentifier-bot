/**
 * Supported dexes: the list in the website repo (assets/jsons/dexes.json), managed on the website
 * (Moderation -> Dexes). Loaded at start and every hour; changes from the website apply right away.
 *
 * dexes.json:
 *   dexes                    names of the enabled dexes (what the website shows)
 *   incompleteAbbreviations  dexes whose trainer abbreviations are incomplete
 *   registry                 [{ name, botId, key, enabled, launched?, waves?, previousArts?, catchPhrases?, catchIgnore? }]
 *
 * The rest of the bot reads utils/constants.js (SUPPORTED_BOT_IDS, BOT_NAMES, BOT_DATA_KEYS, DEX_REGISTRY);
 * this module updates those objects in place and tells listeners (data reload, slash commands) about changes.
 */

const { EventEmitter } = require("events");
const { DEX_REGISTRY, SUPPORTED_BOT_IDS, BOT_NAMES, BOT_DATA_KEYS, ASSETS_BASE_URL } = require("./constants");

const DEX_FILE = "assets/jsons/dexes.json";
const RAW_CACHE_MS = 10 * 60 * 1000; // raw.githubusercontent.com may serve the old file for a few minutes after a commit
const ICON_SIZE = 128;
const MAX_ICON_BYTES = 2 * 1024 * 1024;
const MAX_PHRASES = 20;

const events = new EventEmitter();
let incomplete = [];
let loading = null;
let ownWriteAt = 0;

const editor = () => require("./dex-editor"); // GitHub helpers (required lazily: dex-editor reads constants too)
const userError = (message, status = 400) => Object.assign(new Error(message), { status });

/* ---------- Reading ---------- */

const cleanList = (list) =>
    Array.isArray(list)
        ? [...new Set(list.map((item) => String(item ?? "").trim()).filter(Boolean))].slice(0, MAX_PHRASES).map((item) => item.slice(0, 100))
        : undefined;

function normalize(entry) {
    const dex = {
        name: String(entry.name),
        botId: String(entry.botId),
        key: String(entry.key),
        enabled: entry.enabled !== false,
    };
    if (entry.waves) dex.waves = true;
    if (entry.previousArts) dex.previousArts = true;
    if (entry.launched || dex.enabled) dex.launched = true; // was on at least once ("supported again" vs "now supported")
    const phrases = cleanList(entry.catchPhrases);
    const ignore = cleanList(entry.catchIgnore);
    if (phrases?.length) dex.catchPhrases = phrases;
    if (ignore) dex.catchIgnore = ignore;
    return dex;
}

const signature = () =>
    DEX_REGISTRY.filter((dex) => dex.enabled)
        .map((dex) => `${dex.botId}:${dex.name}:${dex.key}`)
        .join("|");

/** Puts a dex list in place (constants are updated in place, so every module sees it). */
function apply(file) {
    if (!Array.isArray(file?.registry) || !file.registry.length) return false;
    const before = signature();
    const list = file.registry.filter((entry) => entry?.name && /^\d{17,20}$/.test(String(entry.botId)) && entry.key).map(normalize);
    DEX_REGISTRY.splice(0, DEX_REGISTRY.length, ...list);
    incomplete = Array.isArray(file.incompleteAbbreviations) ? file.incompleteAbbreviations.filter((name) => typeof name === "string") : [];

    const enabled = list.filter((dex) => dex.enabled);
    SUPPORTED_BOT_IDS.splice(0, SUPPORTED_BOT_IDS.length, ...enabled.map((dex) => dex.botId));
    for (const map of [BOT_NAMES, BOT_DATA_KEYS]) for (const id of Object.keys(map)) delete map[id];
    for (const dex of enabled) {
        BOT_NAMES[dex.botId] = dex.name;
        BOT_DATA_KEYS[dex.botId] = dex.key;
    }
    if (before !== signature()) events.emit("change");
    return true;
}

/** Loads dexes.json from the website repo (keeps the current list when it can't). */
async function load() {
    if (Date.now() - ownWriteAt < RAW_CACHE_MS) return DEX_REGISTRY;
    try {
        const response = await fetch(`${ASSETS_BASE_URL}/jsons/dexes.json?t=${Date.now()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (!apply(await response.json())) console.warn("[DEXES] dexes.json has no registry yet, using the built-in list");
    } catch (error) {
        console.error("[DEXES] ❌ Couldn't load the dex list:", error.message);
    }
    return DEX_REGISTRY;
}

/** First load (later calls wait for the same one). */
function ready() {
    loading ??= load();
    return loading;
}

const all = () => DEX_REGISTRY;
const byName = (name) => DEX_REGISTRY.find((dex) => dex.name === name) || null;

/** The list for the website's Moderation page. */
function overview(client) {
    let github = true;
    try {
        editor().githubConfig();
    } catch {
        github = false;
    }
    return {
        github,
        dexes: DEX_REGISTRY.map((dex) => ({
            ...dex,
            incomplete: incomplete.includes(dex.name),
            entries: dex.enabled ? Object.keys(client?.rarities?.[dex.key] || {}).length : null,
        })),
    };
}

/* ---------- Writing (owner, website) ---------- */

function serialize(list, incompleteNames) {
    const file = {
        dexes: list.filter((dex) => dex.enabled).map((dex) => dex.name),
        incompleteAbbreviations: incompleteNames.filter((name) => list.some((dex) => dex.name === name)),
        registry: list,
    };
    return `${JSON.stringify(file, null, 4)}\n`;
}

function changelogWith(raw, entry) {
    const changelog = JSON.parse(raw);
    changelog.changes ??= [];
    changelog.changes.unshift({ timestamp: String(Math.floor(Date.now() / 1000)), ...entry });
    return `${JSON.stringify(changelog, null, 4)}\n`;
}

/**
 * One change to dexes.json (plus other files), committed to the website repo and used right away.
 * change(list, incompleteNames, base) returns { files?, message, changelog? } and edits the list in place.
 */
async function commitChange(change) {
    const { getBase, readText, commitFiles, runExclusive } = editor();
    return runExclusive(async () => {
        const base = await getBase();
        const raw = await readText(DEX_FILE, base);
        const current = JSON.parse(raw);
        const list = (Array.isArray(current.registry) && current.registry.length ? current.registry : DEX_REGISTRY).map(normalize);
        const incompleteNames = Array.isArray(current.incompleteAbbreviations) ? [...current.incompleteAbbreviations] : [...incomplete];

        const result = await change(list, incompleteNames, base);
        const files = [{ path: DEX_FILE, content: serialize(list, incompleteNames) }, ...(result.files || [])];
        if (result.changelog) files.push({ path: "changelog.json", content: changelogWith(await readText("changelog.json", base), result.changelog) });
        const commit = await commitFiles(base, files, result.message);

        ownWriteAt = Date.now();
        apply({ registry: list, incompleteAbbreviations: incompleteNames });
        return { commit: commit.sha, dexes: list };
    });
}

function cleanNewDex(input, list) {
    const name = String(input.name ?? "").trim();
    if (!name || name.length > 40) throw userError("The name must be 1 to 40 characters.");
    if (/[\\/:*?"<>|#%]/.test(name)) throw userError('The name can\'t contain \\ / : * ? " < > | # %');
    const botId = String(input.botId ?? "").trim();
    if (!/^\d{17,20}$/.test(botId)) throw userError("The bot ID must be a Discord ID (17 to 20 digits).");
    const key = String(input.key ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9]{2,5}$/.test(key)) throw userError("The short key must be 2 to 5 letters or digits (e.g. BD).");
    if (list.some((dex) => dex.name.toLowerCase() === name.toLowerCase())) throw userError(`There already is a dex called ${name}.`);
    if (list.some((dex) => dex.botId === botId)) throw userError("That bot is already on the list.");
    if (list.some((dex) => dex.key === key)) throw userError(`The key ${key} is already used.`);
    return { name, botId, key };
}

async function iconPng(buffer) {
    if (buffer.length > MAX_ICON_BYTES) throw userError("The icon is too big (2 MB max).");
    try {
        return await require("sharp")(buffer, { animated: false }).resize(ICON_SIZE, ICON_SIZE, { fit: "cover" }).png().toBuffer();
    } catch {
        throw userError("That file isn't an image the bot can read.");
    }
}

/** New dex: entry in dexes.json, empty data files and its icon. Off by default (add entries first). */
async function addDex({ name, botId, key, waves = false, enabled = false, icon = null, announce = true }) {
    const png = icon ? await iconPng(icon) : null;
    return commitChange(async (list) => {
        const clean = cleanNewDex({ name, botId, key }, list);
        const dex = normalize({ ...clean, enabled: Boolean(enabled), waves: Boolean(waves) });
        list.push(dex);
        const files = [
            { path: `assets/jsons/${dex.name}.json`, content: "{}\n" },
            { path: `assets/jsons/${dex.name}Hashes.json`, content: "{}\n" },
        ];
        if (png) files.push({ path: `assets/icons/${dex.name}.png`, buffer: png });
        return {
            files,
            message: `Add dex ${dex.name}${dex.enabled ? "" : " (off)"} (website)`,
            changelog: dex.enabled && announce ? { type: "dex", dex: dex.name, changes: [`${dex.name} is now supported`] } : null,
        };
    });
}

/** Turn a dex on/off or change its settings (catch phrases, waves, incomplete abbreviations). */
async function updateDex(name, input = {}) {
    return commitChange(async (list, incompleteNames) => {
        const dex = list.find((entry) => entry.name === name);
        if (!dex) throw userError("Unknown dex.", 404);
        const notes = [];
        let changelog = null;
        if (typeof input.enabled === "boolean" && input.enabled !== dex.enabled) {
            dex.enabled = input.enabled;
            notes.push(input.enabled ? "on" : "off");
            if (input.announce !== false) {
                changelog = input.enabled
                    ? { type: "dex", dex: dex.name, changes: [dex.launched ? `${dex.name} is supported again` : `${dex.name} is now supported`] }
                    : { type: "website", changes: [`${dex.name} is no longer supported for now: identification, spawn arts, collectors, the Notifier and Catch stats skip it`] };
            }
        }
        if (dex.enabled) dex.launched = true;
        if (typeof input.waves === "boolean") {
            if (input.waves) dex.waves = true;
            else delete dex.waves;
        }
        if (Array.isArray(input.catchPhrases)) {
            const phrases = cleanList(input.catchPhrases);
            if (phrases.length) dex.catchPhrases = phrases;
            else delete dex.catchPhrases;
            notes.push("catch phrases");
        }
        if (Array.isArray(input.catchIgnore)) dex.catchIgnore = cleanList(input.catchIgnore);
        if (typeof input.incomplete === "boolean") {
            const index = incompleteNames.indexOf(dex.name);
            if (input.incomplete && index < 0) incompleteNames.push(dex.name);
            if (!input.incomplete && index >= 0) incompleteNames.splice(index, 1);
        }
        return { message: `Dex ${dex.name}: ${notes.join(", ") || "settings"} (website)`, changelog };
    });
}

/** Every file of a dex in the repo: its folder of arts, data files and icon. */
async function dexFiles(name, base) {
    const { gh } = editor();
    const files = [`assets/jsons/${name}.json`, `assets/jsons/${name}Hashes.json`, `assets/icons/${name}.png`];
    const folders = await gh(`/contents/assets/dexes?ref=${base.commitSha}`, { allow404: true });
    const folder = Array.isArray(folders) ? folders.find((item) => item.type === "dir" && item.name === name) : null;
    if (folder) {
        const tree = await gh(`/git/trees/${folder.sha}?recursive=1`);
        if (tree.truncated) throw userError("The dex folder is too big to delete from here.", 422);
        for (const item of tree.tree) if (item.type === "blob") files.push(`assets/dexes/${name}/${item.path}`);
    }
    // Only paths that exist (deleting a missing file fails the commit)
    const existing = await Promise.all(
        files.slice(0, 3).map(async (path) => ((await gh(`/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${base.commitSha}`, { allow404: true })) ? path : null)),
    );
    return [...existing.filter(Boolean), ...files.slice(3)];
}

/** Removes a dex completely: its entry, arts, previews, data, hashes and icon. */
async function deleteDex(name, { announce = true } = {}) {
    let removed = 0;
    const result = await commitChange(async (list, incompleteNames, base) => {
        const index = list.findIndex((entry) => entry.name === name);
        if (index < 0) throw userError("Unknown dex.", 404);
        list.splice(index, 1);
        const at = incompleteNames.indexOf(name);
        if (at >= 0) incompleteNames.splice(at, 1);
        const paths = await dexFiles(name, base);
        removed = paths.length;
        return {
            files: paths.map((path) => ({ path, remove: true })),
            message: `Remove dex ${name} (${paths.length} files, website)`,
            changelog: announce ? { type: "website", changes: [`${name} is no longer supported and was removed`] } : null,
        };
    });
    return { ...result, removedFiles: removed };
}

module.exports = {
    ready,
    load,
    all,
    byName,
    overview,
    addDex,
    updateDex,
    deleteDex,
    onChange: (listener) => events.on("change", listener),
};
