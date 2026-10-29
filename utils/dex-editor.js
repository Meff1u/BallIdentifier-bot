const sharp = require("sharp");
const { hashImageBuffer } = require("./helpers");
const { BOT_NAMES, BOT_DATA_KEYS } = require("./constants");

const API = "https://api.github.com";
const PREVIEW_WIDTH = 200;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const DEX_KEYS = Object.fromEntries(Object.entries(BOT_NAMES).map(([botId, name]) => [name, BOT_DATA_KEYS[botId]]));
const DEXES = Object.keys(DEX_KEYS);

// Editable fields (collectors are managed on the Collectors tab and kept as they are)
const FIELDS = { rarity: "number", artist: "string", wave: "number", id: "integer", common_value: "string", demand: "string", cc: "string" };
const REQUIRED = ["rarity", "artist", "id"];
const FIELD_ORDER = ["rarity", "artist", "wave", "id", "common_value", "demand", "cc", "collectors"];
const PREVIOUS_DEX = "Ballsdex";
const PREVIOUS_JSON = "assets/jsons/previous-arts.json";
const previousDir = (name) => `assets/dexes/${PREVIOUS_DEX}/previous/${name}`;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "29th October 2026", like the dates already in previous-arts.json */
function untilDate(date = new Date()) {
    const day = date.getUTCDate();
    const suffix = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
    return `${day}${suffix} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

const serializePrevious = (previous, raw) => `${JSON.stringify(previous, null, 4)}${raw.endsWith("\n") ? "\n" : ""}`;

/** Files in a ball's previous arts folder: [{ path, sha }] */
async function previousFiles(name, base) {
    const list = await gh(`/contents/${encodePath(previousDir(name))}?ref=${base.commitSha}`, { allow404: true });
    return Array.isArray(list) ? list.filter((item) => item.type === "file").map((item) => ({ path: item.path, name: item.name, sha: item.sha })) : [];
}

const FIELD_LABELS = { rarity: "rarity", artist: "artist", wave: "wave", id: "ID", common_value: "common value", demand: "demand", cc: "CC" };

let client = null;
function setClient(c) {
    client = c;
}

function userError(message, status = 400) {
    const error = new Error(message);
    error.status = status;
    return error;
}

/* ---------- GitHub ---------- */

function githubConfig() {
    const token = process.env.GITHUB_TOKEN;
    if (!token || token.startsWith("PASTE_")) throw userError("The GitHub token isn't set up: add GITHUB_TOKEN to the bot's .env.", 503);
    return { token, repo: process.env.GITHUB_REPO || "Meff1u/BallIdentifier", branch: process.env.GITHUB_BRANCH || "main" };
}

async function gh(path, { method = "GET", body, raw = false, allow404 = false } = {}) {
    const { token, repo } = githubConfig();
    const response = await fetch(`${API}/repos/${repo}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "BallIdentifier-bot",
            ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (allow404 && response.status === 404) return null;
    if (!response.ok) {
        const text = await response.text().catch(() => "");
        const error = new Error(`GitHub ${method} ${path.split("?")[0]} failed: ${response.status} ${text.slice(0, 200)}`);
        error.githubStatus = response.status;
        if (response.status === 401 || response.status === 403) error.message = "GitHub refused the token (check GITHUB_TOKEN and its Contents permission).";
        throw error;
    }
    return raw ? response.text() : response.json();
}

const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");

async function getBase() {
    const { branch } = githubConfig();
    const ref = await gh(`/git/ref/heads/${encodeURIComponent(branch)}`);
    const commit = await gh(`/git/commits/${ref.object.sha}`);
    return { commitSha: ref.object.sha, treeSha: commit.tree.sha };
}

const readText = (path, base) => gh(`/contents/${encodePath(path)}?ref=${base.commitSha}`, { raw: true });
async function fileSha(path, base) {
    const meta = await gh(`/contents/${encodePath(path)}?ref=${base.commitSha}`, { allow404: true });
    return meta?.sha || null;
}

/** files: [{ path, content } | { path, buffer } | { path, sha } | { path, remove: true }] */
async function commitFiles(base, files, message) {
    const { branch } = githubConfig();
    const tree = await Promise.all(
        files.map(async (file) => {
            const item = { path: file.path, mode: "100644", type: "blob" };
            if (file.remove) item.sha = null;
            else if (file.buffer) item.sha = (await gh("/git/blobs", { method: "POST", body: { content: file.buffer.toString("base64"), encoding: "base64" } })).sha;
            else if (file.sha) item.sha = file.sha;
            else item.content = file.content;
            return item;
        }),
    );
    const newTree = await gh("/git/trees", { method: "POST", body: { base_tree: base.treeSha, tree } });
    const commit = await gh("/git/commits", { method: "POST", body: { message, tree: newTree.sha, parents: [base.commitSha] } });
    await gh(`/git/refs/heads/${encodeURIComponent(branch)}`, { method: "PATCH", body: { sha: commit.sha, force: false } });
    return commit;
}

// One change at a time; if the branch moved in the meantime (422 on the ref update), start over once
let queue = Promise.resolve();
function runExclusive(task) {
    const run = queue.then(async () => {
        try {
            return await task();
        } catch (error) {
            if (error.githubStatus !== 422) throw error;
            return task();
        }
    });
    queue = run.catch(() => {});
    return run;
}

/* ---------- File formats (kept as they are in each file) ---------- */

function detectFormat(raw) {
    return {
        indent: raw.match(/\n([ \t]+)"/)?.[1] || "    ",
        multilineArrays: /: \[[ \t]*\r?\n/.test(raw),
        finalNewline: raw.endsWith("\n"),
        crlf: raw.includes("\r\n"),
    };
}

function serializeDex(data, format) {
    const { indent: i, multilineArrays, finalNewline, crlf } = format;
    const value = (x) => {
        if (!Array.isArray(x)) return JSON.stringify(x);
        if (!x.length) return "[]";
        return multilineArrays
            ? `[\n${x.map((item) => `${i}${i}${i}${JSON.stringify(item)}`).join(",\n")}\n${i}${i}]`
            : `[${x.map((item) => JSON.stringify(item)).join(", ")}]`;
    };
    const entries = Object.entries(data).map(
        ([name, entry]) => `${i}${JSON.stringify(name)}: {\n${Object.entries(entry).map(([k, x]) => `${i}${i}${JSON.stringify(k)}: ${value(x)}`).join(",\n")}\n${i}}`,
    );
    const text = `{\n${entries.join(",\n")}\n}${finalNewline ? "\n" : ""}`;
    return crlf ? text.replace(/\n/g, "\r\n") : text;
}

const sortKeys = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b, "en")));
const serializeHashes = (hashes) => `${JSON.stringify(sortKeys(hashes), null, 2)}\n`;
const isSortedByRarity = (data) => Object.values(data).every((entry, index, all) => !index || Number(all[index - 1].rarity) <= Number(entry.rarity));
const sortByRarity = (data) => Object.fromEntries(Object.entries(data).sort(([, a], [, b]) => Number(a.rarity) - Number(b.rarity))); // stable
const roundRarity = (value) => Math.round(value * 1000) / 1000;

/* ---------- Validation ---------- */

function cleanName(name) {
    const value = String(name ?? "").trim();
    if (!value) throw userError("The name is required.");
    if (value.length > 80) throw userError("The name is too long (80 characters max).");
    if (/[\\/:*?"<>|]/.test(value)) throw userError('The name can\'t contain \\ / : * ? " < > |');
    return value;
}

function cleanDetails(input = {}, existing = {}) {
    const out = {};
    for (const [field, type] of Object.entries(FIELDS)) {
        let value = input[field];
        if (value === undefined || value === null || (typeof value === "string" && !value.trim())) continue;
        if (type === "number" || type === "integer") {
            value = Number(String(value).replace(",", ".").replace(/^t/i, ""));
            if (!Number.isFinite(value) || (type === "integer" && !Number.isInteger(value))) {
                throw userError(`${FIELD_LABELS[field]} must be ${type === "integer" ? "a whole number" : "a number"}.`);
            }
        } else {
            value = String(value).trim();
            if (value.length > 100) throw userError(`${FIELD_LABELS[field]} is too long.`);
        }
        out[field] = value;
    }
    for (const field of REQUIRED) if (!(field in out)) throw userError(`${FIELD_LABELS[field]} is required.`);
    if (Array.isArray(existing.collectors)) out.collectors = existing.collectors;

    const order = [...Object.keys(existing), ...FIELD_ORDER.filter((key) => !(key in existing))];
    return Object.fromEntries(order.filter((key) => key in out).map((key) => [key, out[key]]));
}

function checkDex(dex) {
    if (!DEXES.includes(dex)) throw userError("Unknown dex.");
    return dex;
}

async function processImage(buffer) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw userError("The spawn art is missing.");
    if (buffer.length > MAX_IMAGE_BYTES) throw userError("The spawn art is too big (8 MB max).");
    let png;
    try {
        png = await sharp(buffer, { animated: false }).png().toBuffer();
    } catch {
        throw userError("That file isn't an image the bot can read.");
    }
    const preview = await sharp(png).resize({ width: PREVIEW_WIDTH }).webp().toBuffer();
    const hash = await hashImageBuffer(png);
    return { png, preview, hash };
}

/* ---------- Changes ---------- */

const show = (field, value) => (value === undefined ? "none" : field === "rarity" ? `T${value}` : String(value));

function describeEdit(name, before, after) {
    const diffs = Object.keys(FIELDS)
        .filter((field) => before[field] !== after[field])
        .map((field) => `${FIELD_LABELS[field]} ${show(field, before[field])} → ${show(field, after[field])}`);
    return diffs.length ? `${name}: ${diffs.join(", ")}` : null;
}

function addChangelog(raw, dex, changes) {
    const changelog = JSON.parse(raw);
    changelog.changes ??= [];
    changelog.changes.unshift({ timestamp: String(Math.floor(Date.now() / 1000)), type: "dex", dex, changes });
    return `${JSON.stringify(changelog, null, 4)}\n`;
}

/** The bot uses the new data right away (raw.githubusercontent.com caches files for a few minutes). */
function applyLocally(dex, data, hashes) {
    if (!client) return;
    const key = DEX_KEYS[dex];
    client.rarities = { ...client.rarities, [key]: data };
    client.hashes = { ...client.hashes, [key]: hashes };
    try {
        require("./collector-store").applyOverlay();
    } catch {
        /* collectors overlay is optional here */
    }
}

/* ---------- Operations ---------- */

/**
 * Add (no originalName) or update an entry.
 * @param {object} options
 * @param {string} options.dex           dex name, e.g. "Ballsdex"
 * @param {string} [options.originalName] current name when editing (rename by passing a different name)
 * @param {string} options.name
 * @param {object} options.details       { rarity, artist, id, wave?, common_value?, demand?, cc? }
 * @param {Buffer} [options.image]       new spawn art (required when adding)
 * @param {boolean} [options.shift]      adding only: every entry with rarity >= the new one moves 1 down
 * @param {boolean} [options.merge]      editing only: empty details keep their current values
 * @param {string} [options.previousAlt] Ballsdex, new art: optional alt text for the old art in Previous arts
 * @param {string} [options.actor]       who did it, for the commit message
 */
function saveEntry({ dex, originalName = null, name, details, image = null, shift = false, merge = false, previousAlt = "", actor = "owner" }) {
    checkDex(dex);
    const newName = cleanName(name);
    const oldName = originalName ? cleanName(originalName) : null;
    const isNew = !oldName;
    if (isNew && !image) throw userError("A new entry needs a spawn art.");
    const processing = image ? processImage(image) : Promise.resolve(null);
    processing.catch(() => {}); // handled when the queued task awaits it

    return runExclusive(async () => {
        const art = await processing;
        const base = await getBase();
        const dataPath = `assets/jsons/${dex}.json`;
        const hashPath = `assets/jsons/${dex}Hashes.json`;
        const [rawData, rawHashes, rawChangelog] = await Promise.all([readText(dataPath, base), readText(hashPath, base), readText("changelog.json", base)]);
        const format = detectFormat(rawData);
        const data = JSON.parse(rawData);
        const hashes = JSON.parse(rawHashes);
        const sorted = isSortedByRarity(data);

        if (!isNew && !(oldName in data)) throw userError(`${oldName} isn't in ${dex}.`, 404);
        if ((isNew || newName !== oldName) && newName in data) throw userError(`${newName} is already in ${dex}.`, 409);
        const before = isNew ? {} : data[oldName];
        const given = merge ? Object.fromEntries(Object.entries(details || {}).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== "")) : details;
        const entry = cleanDetails(merge ? { ...before, ...given } : given, before);
        const sameId = Object.entries(data).find(([other, e]) => other !== oldName && e.id === entry.id);
        if (sameId) throw userError(`ID ${entry.id} is already used by ${sameId[0]}.`, 409);

        const changes = [];
        let next;
        let shifted = 0;
        if (isNew) {
            next = {};
            for (const [other, e] of Object.entries(data)) {
                if (shift && Number(e.rarity) >= entry.rarity) {
                    next[other] = { ...e, rarity: roundRarity(Number(e.rarity) + 1) };
                    shifted += 1;
                } else next[other] = e;
            }
            next[newName] = entry;
            changes.push(`New spawn art: ${newName} (T${entry.rarity})`);
            if (shifted) changes.push(`${shifted} ball${shifted === 1 ? "" : "s"} from T${entry.rarity} on moved one rarity down`);
        } else {
            next = Object.fromEntries(Object.entries(data).map(([other, e]) => (other === oldName ? [newName, entry] : [other, e])));
            if (newName !== oldName) changes.push(`${oldName} is now called ${newName}`);
            if (art) changes.push(`New spawn art for ${newName}`);
            const edit = describeEdit(newName, before, entry);
            if (edit) changes.push(edit);
            if (!changes.length) throw userError("Nothing changed.");
        }
        if (sorted) next = sortByRarity(next);

        // Hashes and files
        const nextHashes = { ...hashes };
        const files = [];
        const artPath = (n) => `assets/dexes/${dex}/${n}.png`;
        const previewPath = (n) => `assets/dexes/${dex}/compressed/${n}.webp`;
        const renamed = !isNew && newName !== oldName;
        const [oldArt, oldPreview] = isNew ? [null, null] : await Promise.all([fileSha(artPath(oldName), base), fileSha(previewPath(oldName), base)]);
        if (renamed) {
            delete nextHashes[oldName];
            if (hashes[oldName]) nextHashes[newName] = hashes[oldName];
            if (oldArt) files.push({ path: artPath(oldName), remove: true });
            if (oldPreview) files.push({ path: previewPath(oldName), remove: true });
            if (!art) {
                if (oldArt) files.push({ path: artPath(newName), sha: oldArt });
                if (oldPreview) files.push({ path: previewPath(newName), sha: oldPreview });
            }
        }
        if (art) {
            nextHashes[newName] = art.hash;
            files.push({ path: artPath(newName), buffer: art.png }, { path: previewPath(newName), buffer: art.preview });
        }

        // Ballsdex Previous arts: the replaced art goes there, and a rename moves the ball's previous arts along
        if (dex === PREVIOUS_DEX && !isNew && ((art && oldPreview) || renamed)) {
            const rawPrevious = await readText(PREVIOUS_JSON, base);
            const previous = JSON.parse(rawPrevious);
            const list = [...(previous[oldName] || [])];
            if (renamed && list.length) {
                for (const file of await previousFiles(oldName, base)) {
                    files.push({ path: file.path, remove: true }, { path: `${previousDir(newName)}/${file.name}`, sha: file.sha });
                }
            }
            if (art && oldPreview) {
                const alt = String(previousAlt || "").trim().slice(0, 200);
                list.push({ artist: before.artist || "Unknown", until: untilDate(), ...(alt ? { alt } : {}) });
                files.push({ path: `${previousDir(newName)}/${list.length}.webp`, sha: oldPreview });
                changes.push(`The old art of ${newName} is now in Previous arts`);
            }
            if (list.length) {
                delete previous[oldName];
                previous[newName] = list;
                files.push({ path: PREVIOUS_JSON, content: serializePrevious(sortKeys(previous), rawPrevious) });
            }
        }

        files.push(
            { path: dataPath, content: serializeDex(next, format) },
            { path: hashPath, content: serializeHashes(nextHashes) },
            { path: "changelog.json", content: addChangelog(rawChangelog, dex, changes) },
        );

        const commit = await commitFiles(base, files, `${dex}: ${isNew ? "add" : "update"} ${newName} (${actor})`);
        applyLocally(dex, next, nextHashes);
        client?.logGeneral?.(`Dex editor (${actor}): ${dex} · ${changes.join(" · ")}`);
        return { dex, name: newName, entry: next[newName], shifted, shiftedFrom: shifted ? entry.rarity : null, changes, commitUrl: commit.html_url || null };
    });
}

/** Remove an entry, its art, preview and hash. */
function deleteEntry({ dex, name, actor = "owner" }) {
    checkDex(dex);
    const target = cleanName(name);
    return runExclusive(async () => {
        const base = await getBase();
        const dataPath = `assets/jsons/${dex}.json`;
        const hashPath = `assets/jsons/${dex}Hashes.json`;
        const [rawData, rawHashes, rawChangelog] = await Promise.all([readText(dataPath, base), readText(hashPath, base), readText("changelog.json", base)]);
        const data = JSON.parse(rawData);
        if (!(target in data)) throw userError(`${target} isn't in ${dex}.`, 404);
        const hashes = JSON.parse(rawHashes);
        delete data[target];
        delete hashes[target];

        const files = [];
        const [artSha, previewSha] = await Promise.all([fileSha(`assets/dexes/${dex}/${target}.png`, base), fileSha(`assets/dexes/${dex}/compressed/${target}.webp`, base)]);
        if (artSha) files.push({ path: `assets/dexes/${dex}/${target}.png`, remove: true });
        if (previewSha) files.push({ path: `assets/dexes/${dex}/compressed/${target}.webp`, remove: true });
        if (dex === PREVIOUS_DEX) {
            const rawPrevious = await readText(PREVIOUS_JSON, base);
            const previous = JSON.parse(rawPrevious);
            if (previous[target]) {
                delete previous[target];
                for (const file of await previousFiles(target, base)) files.push({ path: file.path, remove: true });
                files.push({ path: PREVIOUS_JSON, content: serializePrevious(previous, rawPrevious) });
            }
        }
        const changes = [`Removed ${target}`];
        files.push(
            { path: dataPath, content: serializeDex(data, detectFormat(rawData)) },
            { path: hashPath, content: serializeHashes(hashes) },
            { path: "changelog.json", content: addChangelog(rawChangelog, dex, changes) },
        );

        const commit = await commitFiles(base, files, `${dex}: remove ${target} (${actor})`);
        applyLocally(dex, data, hashes);
        client?.logGeneral?.(`Dex editor (${actor}): ${dex} · ${changes.join(" · ")}`);
        return { dex, name: target, changes, commitUrl: commit.html_url || null };
    });
}

module.exports = { DEXES, DEX_KEYS, FIELDS, setClient, saveEntry, deleteEntry, cleanDetails };
