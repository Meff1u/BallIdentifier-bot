/**
 * Ballsdex specials for the website's Specials page.
 *
 * Three layers, merged per special id:
 * 1. official data from the Ballsdex API (/specials: name, emoji, tradeable, dates; /market/specials: sales),
 *    fetched with the owner's linked API key and cached for a few hours (market details per special: 1 hour);
 * 2. the starting notes in specials-seed.js (alias, prices, spawn rate, duration, notes);
 * 3. owner edits from the website, stored in MongoDB (specialInfo), which win over the seed.
 */

const { getDatabase } = require("./database");
const { ADMIN_ID } = require("./constants");
const seed = require("./specials-seed");

const OFFICIAL_TTL_MS = 6 * 60 * 60 * 1000;
const MARKET_TTL_MS = 60 * 60 * 1000;
const ALL_TIME_WINDOW = 3650; // clamped by Ballsdex to the longest history it keeps
const EDITABLE = {
    alias: 60,
    emoji: 40,
    priceAverage: 40,
    priceHighest: 40,
    spawnRate: 120,
    duration: 120,
    notes: 500,
};

let official = { at: 0, specials: [], market: [], windowDays: null, marketAll: [], allWindowDays: null, error: null };
const marketCache = new Map(); // id -> { at, data } or { at, promise }
let refreshing = null;
let edits = null; // Map id -> fields

function ballsdex() {
    return require("./ballsdex"); // lazy: ballsdex.js loads a lot
}

function ownerKey() {
    const { getSavedApiKey, decryptApiKey } = ballsdex();
    const encrypted = getSavedApiKey(ADMIN_ID);
    if (!encrypted) throw new Error("Link the owner's Ballsdex account to load the official specials list.");
    return decryptApiKey(encrypted);
}

async function fetchOfficial() {
    const { ballsdexRequest } = ballsdex();
    const apiKey = ownerKey();

    const specials = [];
    let cursor;
    do {
        const page = await ballsdexRequest(apiKey, "/specials", { limit: 100, cursor });
        specials.push(...(page.items || []));
        cursor = page.next_cursor || undefined;
    } while (cursor);

    // Market data is optional
    const recent = await ballsdexRequest(apiKey, "/market/specials", { window: 30 }).catch(() => null);
    const all = await ballsdexRequest(apiKey, "/market/specials", { window: ALL_TIME_WINDOW }).catch(() => null);
    return {
        specials,
        market: recent?.items || [],
        windowDays: recent?.window_days ?? null,
        marketAll: all?.items || [],
        allWindowDays: all?.window_days ?? null,
    };
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
    const marketRow = (row) => ({ sales: row.count, median: row.median, mean: Math.round(row.mean), distinctBalls: row.distinct_balls });
    for (const [key, rows] of [["recent", official.market], ["all", official.marketAll]]) {
        for (const row of rows) {
            const current = byId.get(row.special_id) || { id: row.special_id, name: row.special_name };
            current.market = { ...current.market, [key]: marketRow(row) };
            byId.set(row.special_id, current);
        }
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
        marketAllWindowDays: official.allWindowDays,
    };
}

/** Sale history of one special (all the history Ballsdex keeps), with a few numbers worked out. */
async function fetchMarket(id) {
    const { ballsdexRequest } = ballsdex();
    let history;
    try {
        history = await ballsdexRequest(ownerKey(), `/market/specials/${id}/history`, { window: ALL_TIME_WINDOW });
    } catch (error) {
        if (error.status === 404) return { id, windowDays: null, totalSales: 0, series: [], balls: [], recentSales: [] };
        throw error;
    }
    const series = (history.series || []).map((b) => ({ start: b.start, end: b.end, count: b.count, median: b.median, mean: b.mean == null ? null : Math.round(b.mean), low: b.low, high: b.high }));
    const withSales = series.filter((b) => b.count > 0);
    const lows = withSales.map((b) => b.low).filter((v) => v != null);
    const highs = withSales.map((b) => b.high).filter((v) => v != null);
    const balls = (history.ball_breakdown || []).map((b) => ({ id: b.ball_id, country: b.country, count: b.count, median: b.median, mean: Math.round(b.mean) }));
    const recentSales = (history.recent_sales || []).slice(0, 10).map((s) => ({ ballId: s.ball_id, country: s.country, price: s.price, endsAt: s.ends_at }));
    const priced = balls.filter((b) => b.count >= 2);
    const byMedian = [...priced].sort((a, b) => a.median - b.median);
    return {
        id,
        windowDays: history.window_days ?? null,
        totalSales: withSales.reduce((sum, b) => sum + b.count, 0),
        lowestSale: lows.length ? Math.min(...lows) : null,
        highestSale: highs.length ? Math.max(...highs) : null,
        lastSaleAt: recentSales[0]?.endsAt || null,
        multiItemLots: history.multi_item_lot_count || 0,
        series,
        topBalls: [...balls].sort((a, b) => b.count - a.count).slice(0, 8),
        cheapestBalls: byMedian.slice(0, 3),
        priciestBalls: byMedian.slice(-3).reverse(),
        ballsSold: balls.length,
        recentSales,
    };
}

async function getSpecialMarket(id) {
    const known = seed.some((s) => s.id === id) || official.specials.some((s) => s.id === id);
    if (!Number.isInteger(id) || !known) {
        const error = new Error("Unknown special");
        error.status = 404;
        throw error;
    }
    const cached = marketCache.get(id);
    if (cached?.data && Date.now() - cached.at < MARKET_TTL_MS) return cached.data;
    if (cached?.promise) return cached.promise;
    const promise = fetchMarket(id)
        .then((data) => {
            marketCache.set(id, { at: Date.now(), data });
            return data;
        })
        .catch((error) => {
            if (cached?.data) marketCache.set(id, cached);
            else marketCache.delete(id);
            throw error;
        });
    marketCache.set(id, { ...cached, promise });
    return promise;
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

module.exports = { getSpecials, getSpecialMarket, updateSpecial, refreshOfficial, EDITABLE };
