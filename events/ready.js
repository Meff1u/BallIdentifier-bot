const { createDjsClient } = require("discordbotlist");

const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

// Import shared utilities
const { ASSETS_BASE_URL, BOT_NAMES, BOT_DATA_KEYS } = require("../utils/constants");
const { readJsonFile, writeJsonFile, getAssetsPath } = require("../utils/helpers");

// Local constants
const DATA_PATH = getAssetsPath("data.json");
const UPVOTES_PATH = getAssetsPath("upvotes.json");
const REFRESH_INTERVAL = 60 * 60 * 1000; // 1 hour
const DBL_POLL_INTERVAL = 180000; // 3 minutes

const HASH_URLS = Object.fromEntries(
    Object.entries(BOT_DATA_KEYS).map(([botId, key]) => [
        key,
        `${ASSETS_BASE_URL}/jsons/${BOT_NAMES[botId]}`,
    ])
);

module.exports = {
    name: "ready",
    once: true,
    async execute(client) {
        console.log(`✅ ${client.user.tag} ready`);
        client.logDiscord(`🤖 Bot started: ${client.user.tag} | Guilds: ${client.guilds.cache.size}`);
        
        // Initialize DBL client
        client.dbl = createDjsClient(process.env.DBL_TOKEN, client);

        // Define fetch methods
        client.fetchHashes = async () => {
            client.hashes = {};
            client.rarities = {};
            
            const fetchPromises = Object.entries(HASH_URLS).map(async ([key, url]) => {
                try {
                    const [raritiesRes, hashesRes] = await Promise.all([
                        fetch(`${url}.json`),
                        fetch(`${url}Hashes.json`),
                    ]);
                    
                    if (!raritiesRes.ok || !hashesRes.ok) {
                        throw new Error(`HTTP error`);
                    }
                    
                    client.rarities[key] = await raritiesRes.json();
                    client.hashes[key] = await hashesRes.json();
                    console.log(`✅ Fetched ${key} hashes and rarities`);
                } catch (error) {
                    console.error(`❌ Failed to fetch ${key}:`, error.message);
                }
            });
            
            await Promise.all(fetchPromises);
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
                    console.log("📤 Sent reminders to expired upvoters:", expiredUsers.length);
                }
                

                writeJsonFile(UPVOTES_PATH, fetchedUpvotes.upvotes);
                client.upvotes = fetchedUpvotes;
                console.log(`✅ Fetched ${fetchedUpvotes.upvotes.length} upvotes`);
            } catch (error) {
                client.upvotes = { upvotes: [] };
                console.error("❌ Failed to fetch upvotes:", error.message);
            }
        };

        client.upvoteReminder = async (users) => {
            const data = readJsonFile(DATA_PATH, { users: {} });
            
            for (const { user_id: userId } of users) {
                if (data.users[userId]?.notifications?.reminder !== true) continue;
                
                try {
                    const user = await client.users.fetch(userId);
                    await user.send(
                        "Your upvote expired! [Upvote](https://discordbotlist.com/bots/ballidentifier/upvote) again!"
                    );
                    console.log(`📨 Reminder sent to ${userId}`);
                } catch (error) {
                    console.error(`❌ Failed to send reminder to ${userId}:`, error.message);
                }
            }
        };

        client.postDBLStats = async () => {
            try {
                const [app, guilds] = await Promise.all([
                    client.application.fetch(),
                    client.guilds.fetch(),
                ]);
                
                const data = readJsonFile(DATA_PATH, { users: {} });
                const userCount = Math.max(
                    app.approximateUserInstallCount || 0,
                    Object.keys(data.users || {}).length
                );
                
                await client.dbl.postBotStats({ guilds: guilds.size, users: userCount });
                console.log("✅ DBL stats posted");
            } catch (error) {
                console.error("❌ DBL stats error:", error.message);
            }
        };

        // Initial fetch
        await client.fetchHashes();
        
        // Start refresh loop
        const refreshLoop = async () => {
            await client.fetchUpvotes();
            await client.postDBLStats();
            setTimeout(refreshLoop, REFRESH_INTERVAL);
        };
        refreshLoop();

        // Set up DBL polling and vote handler
        client.dbl.startPolling(DBL_POLL_INTERVAL);
        
        client.dbl.on("vote", async (vote) => {
            await client.fetchUpvotes();
            
            try {
                const data = readJsonFile(DATA_PATH, { users: {} });
                
                // Send thanks message if enabled
                if (data.users[vote.id]?.notifications?.thanks !== false) {
                    try {
                        const user = await client.users.fetch(vote.id);
                        await user.send(
                            "Thanks for voting!\n-# You can toggle this message in </notifications:1388927499248996473> command"
                        );
                        console.log(`💖 Thanks sent to ${vote.id}`);
                    } catch (error) {
                        console.error(`❌ Failed to send thanks to ${vote.id}:`, error.message);
                    }
                }

                // Send webhook notification
                const webhookUrl = process.env.UPVOTE_WEBHOOK_URL;
                if (webhookUrl) {
                    await fetch(webhookUrl, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            embeds: [{
                                title: "New Upvote!",
                                description: `<@${vote.id}> (${vote.username}) just upvoted!`,
                                color: 0x00ff00,
                                timestamp: vote.time ? new Date(vote.time).toISOString() : new Date().toISOString(),
                            }],
                        }),
                    });
                }
            } catch (error) {
                console.error("❌ Error handling vote:", error.message);
            }
        });
    },
};
