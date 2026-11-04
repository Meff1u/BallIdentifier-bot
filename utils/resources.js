/**
 * Server resources for the owner's Moderation page (website -> admin function -> GET /api/users/:id/admin/resources).
 * Only real numbers: what MongoDB reports (dbStats) and what the operating system reports (statfs, folder size).
 * Where a total can't be known the field is null and the website says so; nothing is estimated.
 * No paths, hostnames or connection strings leave this file.
 *
 * Database capacity: dbStats only knows the disk of the cluster on some plans, and a shared (free) Atlas cluster
 * has a fixed quota that the driver can't read. Set DB_STORAGE_LIMIT_MB in .env to the plan's quota (e.g. 512 for
 * the free M0) to show it; without it the capacity is reported as unknown.
 */

const fs = require("fs");
const path = require("path");
const { getDatabase } = require("./database");
const { DATA_PATH } = require("./helpers");

const FOLDER_CACHE_MS = 60 * 1000;
const MAX_FILES = 20000;
let folderCache = null;

const positive = (value) => (Number.isFinite(value) && value >= 0 ? value : null);

async function database() {
    try {
        const stats = await getDatabase().command({ dbStats: 1, scale: 1 });
        const limitMb = Number(process.env.DB_STORAGE_LIMIT_MB);
        const fsTotal = positive(stats.fsTotalSize) || null;
        return {
            available: true,
            dataBytes: positive(stats.dataSize),
            storageBytes: positive(stats.storageSize),
            indexBytes: positive(stats.indexSize),
            collections: positive(stats.collections),
            objects: positive(stats.objects),
            // Capacity: the quota from .env, else the filesystem total the server reports (shared by the whole cluster), else unknown
            capacityBytes: limitMb > 0 ? limitMb * 1024 * 1024 : null,
            capacitySource: limitMb > 0 ? "configured" : null,
            clusterDiskBytes: fsTotal,
            clusterDiskUsedBytes: fsTotal ? positive(stats.fsUsedSize) : null,
        };
    } catch {
        return { available: false };
    }
}

/** Size of the folder the bot keeps its files in (data.json, uploads...), counted file by file (cached, capped). */
function folderSize(dir) {
    if (folderCache && Date.now() - folderCache.at < FOLDER_CACHE_MS) return folderCache.value;
    let bytes = 0;
    let files = 0;
    let complete = true;
    const stack = [dir];
    while (stack.length) {
        let entries;
        try {
            entries = fs.readdirSync(stack.pop(), { withFileTypes: true });
        } catch {
            complete = false;
            continue;
        }
        for (const entry of entries) {
            const full = path.join(entry.parentPath || entry.path || dir, entry.name);
            if (entry.isDirectory()) stack.push(full);
            else if (entry.isFile()) {
                if (++files > MAX_FILES) {
                    complete = false;
                    break;
                }
                try {
                    bytes += fs.statSync(full).size;
                } catch {
                    complete = false;
                }
            }
        }
        if (files > MAX_FILES) break;
    }
    const value = { bytes, files, complete };
    folderCache = { at: Date.now(), value };
    return value;
}

async function disk() {
    const dir = path.dirname(DATA_PATH);
    const out = { available: false, totalBytes: null, usedBytes: null, freeBytes: null, botDataBytes: null, botDataComplete: null };
    try {
        const stat = await fs.promises.statfs(dir);
        out.totalBytes = stat.blocks * stat.bsize;
        out.freeBytes = stat.bavail * stat.bsize;
        out.usedBytes = (stat.blocks - stat.bfree) * stat.bsize;
        out.available = true;
    } catch {
        // statfs missing (old Node) or not allowed: the totals stay unknown
    }
    try {
        const size = folderSize(dir);
        out.botDataBytes = size.bytes;
        out.botDataComplete = size.complete;
        out.available = true;
    } catch {}
    return out;
}

async function getResources() {
    const [db, disks] = await Promise.all([database(), disk()]);
    return { checkedAt: Date.now(), database: db, disk: disks };
}

module.exports = { getResources };
