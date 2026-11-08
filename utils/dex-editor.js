const sharp = require("sharp");
const { hashImageBuffer } = require("./helpers");
const { DEX_KEY_BY_NAME_ALL } = require("./constants");
const deploy = require("./deploy");

const API = "https://api.github.com";
const PREVIEW_WIDTH = 200;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// Every dex on the list, turned-off ones too, so a new dex can be filled before it goes live (utils/dexes.js)
const DEX_KEYS = DEX_KEY_BY_NAME_ALL;

// Editable fields (collectors are managed on the Collectors tab and kept as they are)
const FIELDS = { rarity: "number", artist: "string", wave: "number", id: "integer", common_value: "string", demand: "string", cc: "string" };
const REQUIRED = ["rarity", "artist", "id"];
const FIELD_ORDER = ["rarity", "artist", "wave", "id", "common_value", "demand", "cc", "collectors"];
const PREVIOUS_DEX = "Ballsdex";
const PREVIOUS_JSON = "assets/jsons/previous-arts.json";
const previousDir = (name) => `assets/dexes/${PREVIOUS_DEX}/previous/${name}`;
// Ballsdex "Frame art": a temporary spawn art. The original (art, preview, artist, hash) waits here until it is restored.
const FRAME_JSON = "assets/jsons/frame-arts.json";
const frameArt = (name) => `assets/dexes/${PREVIOUS_DEX}/frame-original/${name}.png`;
const framePreview = (name) => `assets/dexes/${PREVIOUS_DEX}/frame-original/${name}.webp`;
const ART_TYPES = ["new", "fixed", "frame"]; // New spawn art | Fixed spawn art | Frame art (Ballsdex only)
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "October 2026": default "until" of a replaced art (the owner can type something else) */
function untilDate(date = new Date()) {
    return `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

const serializePrevious = (previous, raw) => `${JSON.stringify(previous, null, 4)}${raw.endsWith("\n") ? "\n" : ""}`;

/** Files in a ball's previous arts folder: [{ path, sha }] */
async function previousFiles(name, base) {
    const list = await gh(`/contents/${encodePath(previousDir(name))}?ref=${base.commitSha}`, { allow404: true });
    return Array.isArray(list) ? list.filter((item) => item.type === "file").map((item) => ({ path: item.path, name: item.name, sha: item.sha })) : [];
}

/** The collectibles of Ballsdex that have a frame art now: { [name]: { artist, hash } } (read from the repo, so it is always current). */
async function readFrames(base) {
    const raw = await gh(`/contents/${encodePath(FRAME_JSON)}?ref=${base.commitSha}`, { raw: true, allow404: true });
    return { data: raw ? JSON.parse(raw) : {} };
}
const serializeFrames = (data) => `${JSON.stringify(data, null, 4)}\n`;

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

/**
 * files: [{ path, content } | { path, buffer } | { path, sha } | { path, remove: true }]
 * The website picks the commit up on Deploy; until then it is listed as waiting (utils/deploy.js).
 * details: human-readable changes shown in that list.
 * changelog: { type, dex?, changes, items? } note for changelog.json. While deploys are deferred it waits with the commit and is
 *   written once per deploy (utils/deploy.js); otherwise it goes into this commit.
 * track: false for commits that must not appear in the deploy list (the changelog commit itself).
 */
async function commitFiles(base, files, message, details = [], { changelog = null, track = true } = {}) {
    const { branch } = githubConfig();
    const deferred = Boolean(changelog) && deploy.enabled();
    if (changelog && !deferred) {
        const { items, ...note } = changelog; // items only help deploys merge edits of the same collectible
        const entry = { timestamp: String(Math.floor(Date.now() / 1000)), ...note };
        files = [...files, { path: "changelog.json", content: withChangelog(await readText("changelog.json", base), [entry]) }];
    }
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
    const commit = await gh("/git/commits", { method: "POST", body: { message: deploy.commitMessage(message), tree: newTree.sha, parents: [base.commitSha] } });
    await gh(`/git/refs/heads/${encodeURIComponent(branch)}`, { method: "PATCH", body: { sha: commit.sha, force: false } });
    try {
        if (track) deploy.record({ title: message, changes: details, sha: commit.sha, url: commit.html_url || null, ...(deferred ? { changelog } : {}) });
    } catch (error) {
        client?.logError?.("Couldn't note the change for the next deploy", error);
    }
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
    if (!(typeof dex === "string" && dex in DEX_KEYS)) throw userError("Unknown dex.");
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

/** The changed fields ({ label, from, to }, shown as "rarity T3 → T4"), part of the one changelog line of an edit. */
function describeEdit(before, after) {
    return Object.keys(FIELDS)
        .filter((field) => before[field] !== after[field])
        .map((field) => ({ type: "diff", label: FIELD_LABELS[field], from: show(field, before[field]), to: show(field, after[field]) }));
}

/** changelog.json with the entries (newest first) added on top. */
function withChangelog(raw, entries) {
    const changelog = JSON.parse(raw);
    changelog.changes ??= [];
    changelog.changes.unshift(...entries);
    return `${JSON.stringify(changelog, null, 4)}\n`;
}

/** One commit with the merged changelog entries of a deploy (utils/deploy.js). */
function commitChangelog(entries) {
    if (!entries.length) return Promise.resolve(null);
    return runExclusive(async () => {
        const base = await getBase();
        const raw = await readText("changelog.json", base);
        return commitFiles(base, [{ path: "changelog.json", content: withChangelog(raw, entries) }], "Changelog: deployed changes", [], { track: false });
    });
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
 * Add (no originalName) or update a collectible.
 * @param {object} options
 * @param {string} options.dex           dex name, e.g. "Ballsdex"
 * @param {string} [options.originalName] current name when editing (rename by passing a different name)
 * @param {string} options.name
 * @param {object} options.details       { rarity, artist, id, wave?, common_value?, demand?, cc? }
 * @param {Buffer} [options.image]       new spawn art (required when adding)
 * @param {string} [options.shift]       adding only: "higher" = every collectible rarer than the new one moves 1 down,
 *                                       "same" = the same rarity or rarer moves 1 down, anything else = no change
 * @param {boolean} [options.merge]      editing only: empty details keep their current values
 * @param {string} [options.artType]     with an image when editing: "new" (default) | "fixed" | "frame" (Ballsdex: temporary art, the original is kept)
 * @param {string} [options.previousAlt] Ballsdex, new art: optional alt text for the old art in Previous arts
 * @param {string} [options.previousUntil] Ballsdex, new art: "used until" of the old art (default: this month and year)
 * @param {string} [options.actor]       who did it, for the commit message
 * @param {string} [options.actorMention] the same person as a Discord mention (<@id>) for the Discord log
 */
function saveEntry({ dex, originalName = null, name, details, image = null, shift = false, merge = false, previousAlt = "", previousUntil = "", artType = "new", actor = "owner", actorMention = null }) {
    checkDex(dex);
    const type = ART_TYPES.includes(artType) ? artType : "new";
    if (image && type === "frame" && dex !== PREVIOUS_DEX) throw userError("Frame art is only for Ballsdex.");
    const newName = cleanName(name);
    const oldName = originalName ? cleanName(originalName) : null;
    const isNew = !oldName;
    if (isNew && !image) throw userError("A new collectible needs a spawn art.");
    const processing = image ? processImage(image) : Promise.resolve(null);
    processing.catch(() => {}); // handled when the queued task awaits it

    return runExclusive(async () => {
        const art = await processing;
        const base = await getBase();
        const dataPath = `assets/jsons/${dex}.json`;
        const hashPath = `assets/jsons/${dex}Hashes.json`;
        const [rawData, rawHashes] = await Promise.all([readText(dataPath, base), readText(hashPath, base)]);
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

        const frames = !isNew && dex === PREVIOUS_DEX ? await readFrames(base) : null;
        const frameActive = Boolean(frames && oldName in frames.data);
        if (art && frameActive) throw userError(`${oldName} has a frame art. Restore the original art first.`, 409);
        const changes = [];
        const parts = []; // everything changed on this one collectible (update) -> one changelog line (deploy.editLine)
        let next;
        let shifted = 0;
        const shiftMode = shift === true ? "same" : shift === "same" || shift === "higher" ? shift : null;
        const moves = (rarity) => (shiftMode === "same" ? rarity >= entry.rarity : shiftMode === "higher" ? rarity > entry.rarity : false);
        if (isNew) {
            next = {};
            for (const [other, e] of Object.entries(data)) {
                if (moves(Number(e.rarity))) {
                    next[other] = { ...e, rarity: roundRarity(Number(e.rarity) + 1) };
                    shifted += 1;
                } else next[other] = e;
            }
            next[newName] = entry;
            changes.push(`New collectible: ${newName} (T${entry.rarity})`);
            if (shifted) {
                const which = shiftMode === "same" ? `from T${entry.rarity} on` : `rarer than T${entry.rarity}`;
                changes.push(`${shifted} ball${shifted === 1 ? "" : "s"} ${which} moved one rarity down`);
            }
        } else {
            next = Object.fromEntries(Object.entries(data).map(([other, e]) => (other === oldName ? [newName, entry] : [other, e])));
            if (newName !== oldName) parts.push({ type: "rename", from: oldName });
            if (art) parts.push({ type: "art", kind: type });
            parts.push(...describeEdit(before, entry));
            if (!parts.length) throw userError("Nothing changed.");
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
        // Frame art: the current art waits as the original; renaming a collectible with a frame art takes it along
        if (art && type === "frame") {
            if (!oldArt || !oldPreview) throw userError(`${oldName} has no current art to keep as the original.`, 409);
            files.push({ path: frameArt(newName), sha: oldArt }, { path: framePreview(newName), sha: oldPreview });
            frames.data[newName] = { artist: before.artist ?? null, hash: hashes[oldName] ?? null };
            files.push({ path: FRAME_JSON, content: serializeFrames(frames.data) });
        } else if (renamed && frameActive) {
            const [backupArt, backupPreview] = await Promise.all([fileSha(frameArt(oldName), base), fileSha(framePreview(oldName), base)]);
            if (backupArt) files.push({ path: frameArt(oldName), remove: true }, { path: frameArt(newName), sha: backupArt });
            if (backupPreview) files.push({ path: framePreview(oldName), remove: true }, { path: framePreview(newName), sha: backupPreview });
            frames.data[newName] = frames.data[oldName];
            delete frames.data[oldName];
            files.push({ path: FRAME_JSON, content: serializeFrames(frames.data) });
        }

        // Ballsdex Previous arts: the replaced art goes there, and a rename moves the ball's previous arts along
        const archive = Boolean(art) && type === "new"; // fixed and frame arts don't go to Previous arts
        if (dex === PREVIOUS_DEX && !isNew && ((archive && oldPreview) || renamed)) {
            const rawPrevious = await readText(PREVIOUS_JSON, base);
            const previous = JSON.parse(rawPrevious);
            const list = [...(previous[oldName] || [])];
            if (renamed && list.length) {
                for (const file of await previousFiles(oldName, base)) {
                    files.push({ path: file.path, remove: true }, { path: `${previousDir(newName)}/${file.name}`, sha: file.sha });
                }
            }
            if (archive && oldPreview) {
                const alt = String(previousAlt || "").trim().slice(0, 200);
                const until = String(previousUntil || "").trim().slice(0, 60) || untilDate();
                list.push({ artist: before.artist || "Unknown", until, ...(alt ? { alt } : {}) });
                files.push({ path: `${previousDir(newName)}/${list.length}.webp`, sha: oldPreview });
                parts.push({ type: "previous" });
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
        );

        const editItems = parts.length ? [{ name: newName, line: deploy.editLine(newName, parts), parts }] : [];
        if (editItems.length) changes.unshift(editItems[0].line);
        const commit = await commitFiles(base, files, `${dex}: ${isNew ? "add" : "update"} ${newName} (${actor})`, changes, { changelog: { type: "dex", dex, changes, ...(editItems.length ? { items: editItems } : {}) } });
        applyLocally(dex, next, nextHashes);
        client?.logGeneral?.(`Dex editor (${actorMention || actor}): ${dex} · ${changes.join(" · ")}`);
        return { dex, name: newName, entry: next[newName], shifted, shiftedFrom: shifted ? entry.rarity : null, shiftMode: shifted ? shiftMode : null, changes, commitUrl: commit.html_url || null };
    });
}

/** Names of the Ballsdex collectibles that have a frame art now. */
async function listFrames({ dex }) {
    checkDex(dex);
    if (dex !== PREVIOUS_DEX) return { names: [] };
    const frames = await readFrames(await getBase());
    return { names: Object.keys(frames.data) };
}

/**
 * Ballsdex: puts the original art back. The frame art goes to Previous arts (with an optional alt text and "used until"),
 * the artist and hash of the original come back too.
 */
function restoreFrameArt({ dex, name, previousAlt = "", previousUntil = "", actor = "owner", actorMention = null }) {
    checkDex(dex);
    if (dex !== PREVIOUS_DEX) throw userError("Frame art is only for Ballsdex.");
    const target = cleanName(name);
    return runExclusive(async () => {
        const base = await getBase();
        const dataPath = `assets/jsons/${dex}.json`;
        const hashPath = `assets/jsons/${dex}Hashes.json`;
        const [rawData, rawHashes, frames] = await Promise.all([readText(dataPath, base), readText(hashPath, base), readFrames(base)]);
        const saved = frames.data[target];
        if (!saved) throw userError(`${target} has no frame art to restore.`, 404);
        const data = JSON.parse(rawData);
        const hashes = JSON.parse(rawHashes);
        if (!(target in data)) throw userError(`${target} isn't in ${dex}.`, 404);
        const before = data[target];
        const [backupArt, backupPreview, currentPreview] = await Promise.all([fileSha(frameArt(target), base), fileSha(framePreview(target), base), fileSha(`assets/dexes/${dex}/compressed/${target}.webp`, base)]);
        if (!backupArt || !backupPreview) throw userError("The saved original art is missing from the repo.", 409);

        const entry = saved.artist ? { ...before, artist: saved.artist } : { ...before };
        const next = { ...data, [target]: entry };
        const nextHashes = { ...hashes };
        if (saved.hash) nextHashes[target] = saved.hash;

        const files = [
            { path: `assets/dexes/${dex}/${target}.png`, sha: backupArt },
            { path: `assets/dexes/${dex}/compressed/${target}.webp`, sha: backupPreview },
            { path: frameArt(target), remove: true },
            { path: framePreview(target), remove: true },
        ];
        const parts = [{ type: "restore" }];
        // The frame art that was live moves to Previous arts
        const rawPrevious = await readText(PREVIOUS_JSON, base);
        const previous = JSON.parse(rawPrevious);
        const list = [...(previous[target] || [])];
        if (currentPreview) {
            const alt = String(previousAlt || "").trim().slice(0, 200);
            const until = String(previousUntil || "").trim().slice(0, 60) || untilDate();
            list.push({ artist: before.artist || "Unknown", until, ...(alt ? { alt } : {}) });
            files.push({ path: `${previousDir(target)}/${list.length}.webp`, sha: currentPreview });
            previous[target] = list;
            files.push({ path: PREVIOUS_JSON, content: serializePrevious(sortKeys(previous), rawPrevious) });
            parts.push({ type: "previous" });
        }
        parts.push(...describeEdit(before, entry));
        delete frames.data[target];
        files.push({ path: FRAME_JSON, content: serializeFrames(frames.data) });
        files.push({ path: dataPath, content: serializeDex(next, detectFormat(rawData)) }, { path: hashPath, content: serializeHashes(nextHashes) });

        const changes = [deploy.editLine(target, parts)];
        const editItems = [{ name: target, line: changes[0], parts }];
        const commit = await commitFiles(base, files, `${dex}: restore art of ${target} (${actor})`, changes, { changelog: { type: "dex", dex, changes, items: editItems } });
        applyLocally(dex, next, nextHashes);
        client?.logGeneral?.(`Dex editor (${actorMention || actor}): ${dex} · ${changes.join(" · ")}`);
        return { dex, name: target, entry, changes, commitUrl: commit.html_url || null };
    });
}

/** Remove a collectible, its art, preview and hash. */
function deleteEntry({ dex, name, actor = "owner" }) {
    checkDex(dex);
    const target = cleanName(name);
    return runExclusive(async () => {
        const base = await getBase();
        const dataPath = `assets/jsons/${dex}.json`;
        const hashPath = `assets/jsons/${dex}Hashes.json`;
        const [rawData, rawHashes] = await Promise.all([readText(dataPath, base), readText(hashPath, base)]);
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
        if (dex === PREVIOUS_DEX) {
            const frames = await readFrames(base);
            if (target in frames.data) {
                delete frames.data[target];
                files.push({ path: frameArt(target), remove: true }, { path: framePreview(target), remove: true }, { path: FRAME_JSON, content: serializeFrames(frames.data) });
            }
        }
        const changes = [`Removed ${target}`];
        files.push(
            { path: dataPath, content: serializeDex(data, detectFormat(rawData)) },
            { path: hashPath, content: serializeHashes(hashes) },
        );

        const commit = await commitFiles(base, files, `${dex}: remove ${target} (${actor})`, changes, { changelog: { type: "dex", dex, changes } });
        applyLocally(dex, data, hashes);
        client?.logGeneral?.(`Dex editor (${actorMention || actor}): ${dex} · ${changes.join(" · ")}`);
        return { dex, name: target, changes, commitUrl: commit.html_url || null };
    });
}

module.exports = {
    untilDate,
    DEX_KEYS,
    FIELDS,
    setClient,
    saveEntry,
    deleteEntry,
    restoreFrameArt,
    listFrames,
    cleanDetails,
    // GitHub helpers (also used by utils/dexes.js)
    gh,
    getBase,
    readText,
    commitFiles,
    commitChangelog,
    runExclusive,
    githubConfig,
    userError,
};
