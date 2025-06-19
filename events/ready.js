const path = require("path");
const fs = require("fs");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

module.exports = {
    name: "ready",
    once: true,
    async execute(client) {
        console.log(`${client.user.tag} ready`);
        const urls = {
            BD: "https://raw.githubusercontent.com/Meff1u/BallIdentifier/refs/heads/main/assets/jsons/BallsdexHashes.json",
            DD: "https://raw.githubusercontent.com/Meff1u/BallIdentifier/refs/heads/main/assets/jsons/DynastydexHashes.json",
            EB: "https://raw.githubusercontent.com/Meff1u/BallIdentifier/refs/heads/main/assets/jsons/EmpireballsHashes.json",
            HD: "https://raw.githubusercontent.com/Meff1u/BallIdentifier/refs/heads/main/assets/jsons/HistoryDexHashes.json",
        };
        client.hashes = {};
        for (const [key, url] of Object.entries(urls)) {
            try {
                const response = await fetch(url);
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                const data = await response.json();
                client.hashes[key] = data;
                console.log(`Fetched ${key} hashes successfully.`);
            } catch (error) {
                console.error(`Failed to fetch ${key} hashes:`, error);
            }
        }

        client.fetchUpvotes = async function() {
            try {
                const upvoteRes = await fetch("https://discordbotlist.com/api/v1/bots/510775326310268930/upvotes", {
                    headers: { Authorization: process.env.DBL_TOKEN }
                });
                if (upvoteRes.ok) {
                    client.upvotes = await upvoteRes.json();
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
        await client.fetchUpvotes();

        try {
            const app = await client.application.fetch();
            const dataPath = path.join(__dirname, "../assets/data.json");
            const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
            const users = data.users || {};
            const userCount = Math.max(
                app.approximateUserInstallCount,
                Object.values(users).length
            );
            const guildCount = client.guilds.cache.size;
            await client.dbl.postBotStats({ guilds: guildCount, users: userCount });
            console.log("DBL stats posted.");
        } catch (e) {
            console.error("DBL stats error:", e);
        }
    },
};
