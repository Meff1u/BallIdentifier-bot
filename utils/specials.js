/**
 * Ballsdex specials for the website's Specials page.
 *
 * Three layers, merged per special id:
 * 1. official data from the Ballsdex API (/specials: name, emoji, tradeable, dates; /market/specials: sales),
 *    fetched with the owner's linked API key and cached for a few hours;
 * 2. the starting notes in specials-seed.js (alias, prices, spawn rate, duration, notes);
 * 3. owner edits from the website, stored in MongoDB (specialInfo), which win over the seed.
 */

const { getDatabase } = require("./database");
const { ADMIN_ID } = require("./constants");
const seed = require("./specials-seed");

const OFFICIAL_TTL_MS = 6 * 60 * 60 * 1000;
const EDITABLE = {
    alias: 60,
    emoji: 40,
    priceAverage: 40,
    priceHighest: 40,
    spawnRate: 120,
    duration: 120,
    notes: 500,
};

let official = { at: 0, specials: [], market: [], windowDays: null, error: null };
let refreshing = null;
let edits = null; // Map id -> fields

function ballsdex() {
    return require("./ballsdex"); // lazy: ballsdex.js loads a lot
}

async function fetchOfficial() {
    const { getSavedApiKey, decryptApiKey, ballsdexRequest } = ballsdex();
    const encrypted = getSavedApiKey(ADMIN_ID);
    if (!encrypted) throw new Error("Link the owner's Ballsdex account to load the official specials list.");
    const apiKey = decryptApiKey(encrypted);

    const specials = [];
    let cursor;
    do {
        const page = await ballsdexRequest(apiKey, "/specials", { limit: 100, cursor });
        specials.push(...(page.items || []));
        cursor = page.next_cursor || undefined;
    } while (cursor);

    let market = [];
    let windowDays = null;
    try {
        const result = await ballsdexRequest(apiKey, "/market/specials", { window: 30 });
        market = result.items || [];
        windowDays = result.window_days ?? 30;
    } catch {
        /* market data is optional */
    }
    return { specials, market, windowDays };
}

async function refreshOfficial(force = false) {
    if (!force && Date.now() - official.at < OFFICIAL_TTL_MS) return official;
    refreshing ??= fetchOfficial()
        .then((result) => (official = { at: Date.now(), ...result, error: null }))
        .catch((error) => {
            // keep what we had; try again in 15 minutes
            official = { ...official, at: Date.now() - OFFICIAL_TTL_MS + 15 * 60 * 1000, error: error.message };
            return official;
        })
        .finally(() => (refreshing = null));
    return refreshing;
}

async function loadEdits() {
    if (edits) return edits;
    const database = await getDatabase();
    const docs = await database.collection("specialInfo").find({}).toArray();
    edits = new Map(docs.map(({ _id, ...fields }) => [Number(_id), fields]));
    return edits;
}

/** Every known special, newest first. */
async function getSpecials() {
    await refreshOfficial();
    let edited = new Map();
    try {
        edited = await loadEdits();
    } catch {
        /* without MongoDB the seed still works */
    }

    const byId = new Map();
    for (const entry of seed) byId.set(entry.id, { ...entry });
    for (const special of official.specials) {
        const current = byId.get(special.id) || { id: special.id };
        byId.set(special.id, {
            ...current,
            name: special.name || current.name,
            officialEmoji: special.emoji || null,
            tradeable: special.tradeable,
            credits: special.credits || null,
            startDate: special.start_date || null,
            endDate: special.end_date || null,
            official: true,
        });
    }
    for (const row of official.market) {
        const current = byId.get(row.special_id) || { id: row.special_id, name: row.special_name };
        current.market = { sales: row.count, median: row.median, mean: Math.round(row.mean), distinctBalls: row.distinct_balls };
        byId.set(row.special_id, current);
    }
    for (const [id, fields] of edited) {
        const current = byId.get(id) || { id };
        for (const key of Object.keys(EDITABLE)) {
            if (key in fields) {
                if (fields[key] === "" || fields[key] === null) delete current[key];
                else current[key] = fields[key];
            }
        }
        current.editedAt = fields.updatedAt || null;
        byId.set(id, current);
    }

    return {
        specials: [...byId.values()].sort((a, b) => b.id - a.id),
        officialLoadedAt: official.at && official.specials.length ? new Date(official.at).toISOString() : null,
        officialError: official.specials.length ? null : official.error,
        marketWindowDays: official.windowDays,
    };
}

/** Owner edit of one special's notes. An empty string hides that field (also the seed's value). */
async function updateSpecial(actorId, id, patch) {
    if (actorId !== ADMIN_ID) {
        const error = new Error("Owner only");
        error.status = 403;
        throw error;
    }
    if (!Number.isInteger(id) || id < 1 || id > 100000) {
        const error = new Error("Invalid special id");
        error.status = 400;
        throw error;
    }
    const fields = {};
    for (const [key, max] of Object.entries(EDITABLE)) {
        if (!(key in patch)) continue;
        const value = patch[key];
        if (value !== null && typeof value !== "string") {
            const error = new Error(`${key} must be text`);
            error.status = 400;
            throw error;
        }
        fields[key] = value === null ? "" : value.trim().slice(0, max);
    }
    const database = await getDatabase();
    await database.collection("specialInfo").updateOne(
        { _id: id },
        { $set: { ...fields, updatedAt: new Date().toISOString(), updatedBy: actorId } },
        { upsert: true },
    );
    const map = await loadEdits();
    map.set(id, { ...(map.get(id) || {}), ...fields, updatedAt: new Date().toISOString() });
    return fields;
}

module.exports = { getSpecials, updateSpecial, refreshOfficial, EDITABLE };
