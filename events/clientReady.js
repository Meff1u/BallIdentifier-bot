const { createDjsClient } = require("discordbotlist");

const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

// Import shared utilities
const { ASSETS_BASE_URL, BOT_NAMES, BOT_DATA_KEYS } = require("../utils/constants");
const { getData, updateData, writeJsonFile, readJsonFile, getAssetsPath } = require("../utils/helpers");
const notifications = require("../utils/notifications");
const collectorStore = require("../utils/collector-store");
const { sendDueSyncReminders, resumeInterruptedSyncs } = require("../utils/ballsdex");

// Local constants
const UPVOTES_PATH = getAssetsPath("upvotes.json");
const REFRESH_INTERVAL = 60 * 60 * 1000; // 1 hour
const DBL_POLL_INTERVAL = 180000; // 3 minutes
const REMINDER_INTERVAL = 60 * 1000; // due "sync available" reminders
const CHANGELOG_URL = `${ASSETS_BASE_URL.replace(/\/assets$/, "")}/changelog.json`;

const HASH_URLS = Object.fromEntries(
    Object.entries(BOT_DATA_KEYS).map(([botId, key]) => [
        key,
        `${ASSETS_BASE_URL}/jsons/${BOT_NAMES[botId]}`,
    ])
);

module.exports = {
    name: "clientReady",
    once: true,
    async execute(client) {
        console.log(`[STARTUP] ✅ ${client.user.tag} ready`);
        client.logGeneral(`🤖 Bot started: ${client.user.tag} | Guilds: ${client.guilds.cache.size}`);
        
        notifications.setClient(client);
        collectorStore.init(client);

        // Initialize DBL client
        client.dbl = createDjsClient(process.env.DBL_TOKEN, client);

        // Define fetch methods
        client.hashes = {};
        client.rarities = {};

        // Builds fresh objects and swaps them in at the end, so lookups never see an empty dataset
        // mid-refresh; a dex that fails to download keeps its previous data.
        client.fetchHashes = async () => {
            const hashes = { ...client.hashes };
            const rarities = { ...client.rarities };

            const fetchPromises = Object.entries(HASH_URLS).map(async ([key, url]) => {
                try {
                    const [raritiesRes, hashesRes] = await Promise.all([
                        fetch(`${url}.json`),
                        fetch(`${url}Hashes.json`),
                    ]);
                    
                    if (!raritiesRes.ok || !hashesRes.ok) {
                        throw new Error(`HTTP error`);
                    }
                    
                    const [rarityData, hashData] = await Promise.all([raritiesRes.json(), hashesRes.json()]);
                    rarities[key] = rarityData;
                    hashes[key] = hashData;
                    client.logGeneral(`Fetched ${key} hashes and rarities`);
                } catch (error) {
                    console.error(`[DATAS] ❌ Failed to fetch ${key}:`, error.message);
                }
            });
            
            await Promise.all(fetchPromises);
            client.hashes = hashes;
            client.lastDataRefresh = new Date().toISOString();
            client.rarities = rarities;
            collectorStore.applyOverlay(); // self-added collectors from the website
        };

        client.fetchUpvotes = async () => {
            try {
                const response = await fetch(
                    "https://discordbotlist.com/api/v1/bots/510775326310268930/upvotes",
                    { headers: { Authorization: process.env.DBL_TOKEN } }
                );
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                
                const fetchedUpvotes = await response.json();
                const existingUpvotes = readJsonFile(UPVOTES_PATH, []);
                
                // Find expired upvotes
                const fetchedUserIds = new Set(fetchedUpvotes.upvotes.map((u) => u.user_id));
                const expiredUsers = existingUpvotes.filter((u) => !fetchedUserIds.has(u.user_id));
                
                if (expiredUsers.length > 0) {
                    await client.upvoteReminder(expiredUsers);
                    client.log("VOTES", `Upvotes expired: ${expiredUsers.length}, reminders sent`);
                }
                

                writeJsonFile(UPVOTES_PATH, fetchedUpvotes.upvotes);
                client.upvotes = fetchedUpvotes;
                client.logGeneral(`Fetched ${fetchedUpvotes.upvotes.length} upvotes`);
            } catch (error) {
                // Keep the last known upvoters (or the saved list) so a DBL hiccup doesn't put cooldowns on them
                client.upvotes ??= { upvotes: readJsonFile(UPVOTES_PATH, []) };
                console.error(`[DATAS] ❌ Failed to fetch upvotes:`, error.message);
            }
        };

        client.upvoteReminder = async (users) => {
            for (const { user_id: userId } of users) {
                const result = await notifications.notify(userId, "vote_reminder", {
                    title: "Your upvote expired",
                    body: "You can vote for BallIdentifier again to keep using it without a cooldown.",
                    link: "https://discordbotlist.com/bots/ballidentifier/upvote",
                    dmText: "Your upvote expired! [Upvote](https://discordbotlist.com/bots/ballidentifier/upvote) again!",
                });
                if (result.dm) client.log("VOTES", `Reminder DM sent to <@${userId}>`);
            }
        };

        // New changelog.json entries (committed to the website repo) -> update notifications
        client.checkChangelog = async () => {
            try {
                const response = await fetch(CHANGELOG_URL);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const { changes = [] } = await response.json();
                const entries = changes
                    .map((entry) => ({ ...entry, time: Number(entry.timestamp) }))
                    .filter((entry) => Number.isFinite(entry.time) && Array.isArray(entry.changes));
                if (!entries.length) return;

                const newest = Math.max(...entries.map((entry) => entry.time));
                const seen = getData().meta?.changelogSeenAt;
                updateData((data) => {
                    data.meta ??= {};
                    data.meta.changelogSeenAt = Math.max(newest, seen || 0);
                });
                // First run only records where we are, so old entries never spam anyone
                if (!seen) return;
                const fresh = entries.filter((entry) => entry.time > seen).sort((a, b) => a.time - b.time);
                if (fresh.length) {
                    client.logGeneral(`${fresh.length} new changelog entr${fresh.length === 1 ? "y" : "ies"}, notifications sent`);
                    await notifications.notifyChangelog(fresh);
                }
            } catch (error) {
                console.error("[DATAS] ❌ Changelog check failed:", error.message);
            }
        };

        client.postDBLStats = async () => {
            try {
                const [app] = await Promise.all([
                    client.application.fetch(),
                ]);
                
                const data = getData();
                const userCount = Math.max(
                    app.approximateUserInstallCount || 0,
                    Object.keys(data.users || {}).length
                );
                
                await client.dbl.postBotStats({ guilds: client.guilds.cache.size, users: userCount });
                client.logGeneral("DBL stats posted");
            } catch (error) {
                console.error(`[DATAS] ❌ DBL stats error:`, error.message);
            }
        };

        // Start refresh loop
        const refreshLoop = async () => {
            try {
                await client.fetchHashes();
                await client.fetchUpvotes();
                await client.postDBLStats();
                await client.checkChangelog();
            } catch (error) {
                console.error("[DATAS] ❌ Refresh loop error:", error.message);
            } finally {
                setTimeout(refreshLoop, REFRESH_INTERVAL);
            }
        };
        refreshLoop();

        // "You can sync again" reminders (24 h after a Ballsdex sync)
        // Syncs cut off by a restart continue from their last saved page
        resumeInterruptedSyncs()
            .then((ids) => ids.length && client.log("BALLSDEX", `Resumed ${ids.length} interrupted sync(s) after a restart: ${ids.join(", ")}`))
            .catch((error) => console.error("[BALLSDEX] Couldn't resume interrupted syncs:", error.message));

        setInterval(() => sendDueSyncReminders().catch((error) => console.error("[BALLSDEX] Reminder loop:", error.message)), REMINDER_INTERVAL);

        // Set up DBL polling and vote handler
        client.dbl.startPolling(DBL_POLL_INTERVAL);
        
        client.dbl.on("vote", async (vote) => {
            await client.fetchUpvotes();
            
            try {
                const data = getData();
                
                await notifications.notify(vote.id, "vote_thanks", {
                    title: "Thanks for voting!",
                    body: "Your upvote removes the identify cooldown while it's active.",
                    dmText: "Thanks for voting!\n-# You can turn this message off on https://ballidentifier.xyz (bell icon)",
                });

                client.log("VOTES", `🗳️ New upvote: <@${vote.id}> (${vote.username})`);
            } catch (error) {
                console.error(`[DATAS] ❌ Error handling vote:`, error.message);
            }
        });
    },
};
