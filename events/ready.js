const path = require("path");
const fs = require("fs");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const { createDjsClient } = require("discordbotlist");

module.exports = {
    name: "ready",
    once: true,
    async execute(client) {
        console.log(`${client.user.tag} ready`);
        client.dbl = createDjsClient(process.env.DBL_TOKEN, client);

        client.fetchHashes = async function () {
            const urls = {
                BD: "https://raw.githubusercontent.com/Meff1u/BallIdentifier/refs/heads/main/assets/jsons/Ballsdex",
                DD: "https://raw.githubusercontent.com/Meff1u/BallIdentifier/refs/heads/main/assets/jsons/Dynastydex",
                EB: "https://raw.githubusercontent.com/Meff1u/BallIdentifier/refs/heads/main/assets/jsons/Empireballs",
                HD: "https://raw.githubusercontent.com/Meff1u/BallIdentifier/refs/heads/main/assets/jsons/HistoryDex",
            };
            client.hashes = {};
            client.rarities = {};
            for (const [key, url] of Object.entries(urls)) {
                try {
                    const response1 = await fetch(`${url}.json`);
                    if (!response1.ok) throw new Error(`HTTP error! status: ${response1.status}`);
                    const data1 = await response1.json();
                    const response2 = await fetch(`${url}Hashes.json`);
                    if (!response2.ok) throw new Error(`HTTP error! status: ${response2.status}`);
                    const data2 = await response2.json();
                    client.hashes[key] = data2;
                    client.rarities[key] = data1;
                    console.log(`Fetched ${key} hashes and rarities successfully.`);
                } catch (error) {
                    console.error(`Failed to fetch ${key} hashes/rarities:`, error);
                }
            }
        };
        await client.fetchHashes();

        client.fetchUpvotes = async function () {
            try {
                const upvoteRes = await fetch(
                    "https://discordbotlist.com/api/v1/bots/510775326310268930/upvotes",
                    {
                        headers: { Authorization: process.env.DBL_TOKEN },
                    }
                );
                if (upvoteRes.ok) {
                    const fetchedUpvotes = await upvoteRes.json();

                    const upvotesFilePath = path.join(__dirname, "../assets/upvotes.json");
                    let existingUpvotes = [];
                    try {
                        existingUpvotes = JSON.parse(fs.readFileSync(upvotesFilePath, "utf8"));
                    } catch (e) {
                        console.warn("No existing upvotes file found, starting fresh.");
                    }

                    const fetchedUserIds = new Set(fetchedUpvotes.upvotes.map((u) => u.user_id));
                    const missingUsers = existingUpvotes.filter(
                        (u) => !fetchedUserIds.has(u.user_id)
                    );

                    if (missingUsers.length > 0) {
                        client.upvoteReminder(missingUsers);
                        console.log("Users in file but not in fetched data:", missingUsers);
                    }

                    fs.writeFileSync(
                        upvotesFilePath,
                        JSON.stringify(fetchedUpvotes.upvotes, null, 4)
                    );

                    client.upvotes = fetchedUpvotes;
                    console.log(client.upvotes);
                } else {
                    client.upvotes = [];
                    console.error(`Failed to fetch upvotes from DBL: ${upvoteRes.status}`);
                }
            } catch (e) {
                client.upvotes = [];
                console.error("Error fetching upvotes from DBL:", e);
            }
        };

        client.upvoteReminder = async function (userIds) {
            const dataPath = path.join(__dirname, "../assets/data.json");
            let data;
            try {
                data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
            } catch (e) {
                data = { users: {} };
            }

            for (const user of userIds) {
                const userId = user.user_id;
                if (data.users[userId]?.notifications?.reminder === true) {
                    try {
                        const userObject = await client.users.fetch(userId);
                        await userObject.send(
                            "Your upvote expired! [Upvote](https://discordbotlist.com/bots/ballidentifier/upvote) again!"
                        );
                        console.log(`Reminder sent to user ${userId}`);
                    } catch (e) {
                        console.error(`Failed to send reminder to user ${userId}:`, e);
                    }
                }
            }
        };

        async function refreshLoop() {
            await client.fetchUpvotes();
            await client.postDBLStats();
            setTimeout(refreshLoop, 60 * 60 * 1000);
        }
        refreshLoop();

        client.postDBLStats = async function () {
            try {
                const app = await client.application.fetch();
                const dataPath = path.join(__dirname, "../assets/data.json");
                const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
                const users = data.users || {};
                const userCount = Math.max(
                    app.approximateUserInstallCount,
                    Object.values(users).length
                );
                await client.dbl.postBotStats({ guilds: 0, users: userCount });
                console.log("DBL stats posted.");
            } catch (e) {
                console.error("DBL stats error:", e);
            }
        };

        client.dbl.startPolling(180000);
        client.dbl.on("vote", async (vote) => {
            await client.fetchUpvotes();
            try {
                const dataPath = path.join(__dirname, "../assets/data.json");
                let data;
                try {
                    data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
                } catch (e) {
                    data = { users: {} };
                }

                const userId = vote.id;
                if (data.users[userId]?.notifications?.thanks !== false) {
                    try {
                        const userObject = await client.users.fetch(userId);
                        await userObject.send("Thanks for voting!\n-# You can toggle this message in </notifications:1388927499248996473> command");
                        console.log(`Thanks message sent to user ${userId}`);
                    } catch (e) {
                        console.error(`Failed to send thanks message to user ${userId}:`, e);
                    }
                }

                const webhookUrl = process.env.UPVOTE_WEBHOOK_URL;
                if (!webhookUrl) return;
                await fetch(webhookUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        embeds: [
                            {
                                title: "New Upvote!",
                                description: `<@${vote.id}> (${vote.username}) just upvoted the bot on DiscordBotList!`,
                                color: 0x00ff00,
                                timestamp: vote.time
                                    ? new Date(vote.time).toISOString()
                                    : new Date().toISOString(),
                            },
                        ],
                    }),
                });
            } catch (e) {
                console.error("Error sending upvote notification:", e);
            }
        });
    },
};
