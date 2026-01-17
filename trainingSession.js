const { ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require("discord.js");

// Lazy-load node-fetch
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

// Import shared utilities
const { INACTIVITY_TIMEOUT, NEXT_SPAWN_DELAY, ASSETS_BASE_URL } = require("./utils/constants");

// API configuration
const BALLS_API_URL = "https://ballidentifier.xyz/.netlify/functions/balls";
const CACHE_TTL = 24 * 60 * 60 * 1000; // 1 day in milliseconds

// Cache for balls data (dex -> { data: string[], timestamp: number })
const ballsCache = new Map();

// Active training sessions storage
const trainingSessions = new Map();

/**
 * Fetch balls for a specific dex from the API
 * @param {string} dex - The dex name (e.g., "Ballsdex")
 * @returns {Promise<string[]>} Array of ball names
 */
async function fetchBallsForDex(dex) {
    // Check if cached data exists and is still valid
    const cached = ballsCache.get(dex);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
        return cached.data;
    }

    try {
        const response = await fetch(`${BALLS_API_URL}?source=${encodeURIComponent(dex)}&sort=name`);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const data = await response.json();
        const ballNames = data.results.map(ball => ball.name);
        
        // Cache the results with timestamp
        ballsCache.set(dex, { data: ballNames, timestamp: Date.now() });
        console.log(`✅ Cached ${ballNames.length} balls for ${dex}`);
        
        return ballNames;
    } catch (error) {
        console.error(`❌ Failed to fetch balls for ${dex}:`, error.message);
        // Return stale cache if available, otherwise empty array
        return cached?.data || [];
    }
}

/**
 * Get a random countryball from the specified dex
 * @param {string} dex - The dex name
 * @returns {Promise<string>} Random ball name
 */
async function getRandomCountryball(dex = "Ballsdex") {
    const dexList = await fetchBallsForDex(dex);
    if (dexList.length === 0) {
        // Fallback to Ballsdex if dex has no balls
        const fallbackList = await fetchBallsForDex("Ballsdex");
        return fallbackList[Math.floor(Math.random() * fallbackList.length)] || "Unknown";
    }
    return dexList[Math.floor(Math.random() * dexList.length)];
}

/**
 * Create a disabled catch button row
 */
function createDisabledButtonRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId("disabled")
            .setLabel("Catch me!")
            .setStyle(ButtonStyle.Primary)
            .setDisabled(true)
    );
}

/**
 * Send a countryball to the channel
 */
async function sendCountryball(channel, guildId) {
    const sessionData = trainingSessions.get(guildId) || {};
    const dex = sessionData.dex || "Ballsdex";
    const countryball = await getRandomCountryball(dex);

    const source = `${ASSETS_BASE_URL}/dexes/${encodeURIComponent(dex)}/${encodeURIComponent(countryball)}.png`;
    const attachment = new AttachmentBuilder(source, { name: "countryball.png" });

    const catchButton = new ButtonBuilder()
        .setCustomId(`catch_${guildId}_${Date.now()}`)
        .setLabel("Catch me!")
        .setStyle(ButtonStyle.Primary);

    const message = await channel.send({
        content: "A wild countryball appeared!",
        files: [attachment],
        components: [new ActionRowBuilder().addComponents(catchButton)],
    });

    // Update session data
    Object.assign(sessionData, {
        currentCountryball: {
            name: countryball,
            messageId: message.id,
            spawnTime: Date.now(),
        },
        leaderboard: sessionData.leaderboard || new Map(),
        fastestCatch: sessionData.fastestCatch || null,
    });

    // Reset inactivity timeout
    if (sessionData.inactivityTimeout) {
        clearTimeout(sessionData.inactivityTimeout);
    }

    sessionData.inactivityTimeout = setTimeout(() => {
        endSession(guildId, channel, "Session ended due to inactivity (30 seconds).");
    }, INACTIVITY_TIMEOUT);

    trainingSessions.set(guildId, sessionData);
    return message;
}

/**
 * Schedule the next countryball spawn
 */
function scheduleNextCountryball(channel, guildId) {
    const sessionData = trainingSessions.get(guildId);
    if (!sessionData?.active) return;

    sessionData.roundsPlayed = (sessionData.roundsPlayed || 0) + 1;

    // Check if rounds limit reached
    if (sessionData.roundsTotal && sessionData.roundsPlayed >= sessionData.roundsTotal) {
        trainingSessions.set(guildId, sessionData);
        endSession(guildId, channel, `Planned rounds finished (${sessionData.roundsTotal}).`);
        return;
    }

    sessionData.nextTimeout = setTimeout(async () => {
        const session = trainingSessions.get(guildId);
        if (session?.active) {
            await sendCountryball(channel, guildId);
        }
    }, NEXT_SPAWN_DELAY);

    trainingSessions.set(guildId, sessionData);
}

/**
 * Update catch statistics for a user
 */
function updateCatchStats(guildId, userId, username, countryball, catchTime) {
    const sessionData = trainingSessions.get(guildId);
    if (!sessionData) return;

    // Initialize leaderboard if needed
    if (!sessionData.leaderboard) {
        sessionData.leaderboard = new Map();
    }

    // Update user stats
    const userStats = sessionData.leaderboard.get(userId) || { count: 0, username };
    userStats.count += 1;
    userStats.username = username;
    sessionData.leaderboard.set(userId, userStats);

    // Check for fastest catch
    const timeInSeconds = parseFloat(catchTime);
    if (!sessionData.fastestCatch || timeInSeconds < sessionData.fastestCatch.timeNum) {
        sessionData.fastestCatch = {
            userId,
            username,
            countryball,
            time: catchTime,
            timeNum: timeInSeconds,
        };
    }

    trainingSessions.set(guildId, sessionData);
}

/**
 * End a training session
 */
function endSession(guildId, channel, reason = "Training session ended!") {
    const sessionData = trainingSessions.get(guildId);
    if (!sessionData) return;

    // Clear timeouts
    clearTimeout(sessionData.nextTimeout);
    clearTimeout(sessionData.inactivityTimeout);

    // Disable the catch button on the last message
    if (sessionData.currentCountryball?.messageId && channel) {
        channel.messages.fetch(sessionData.currentCountryball.messageId)
            .then((message) => {
                message.edit({
                    content: "A wild countryball appeared!",
                    components: [createDisabledButtonRow()],
                }).catch(console.error);
            })
            .catch(console.error);
    }

    // Calculate duration
    const duration = Math.floor((Date.now() - sessionData.startTime) / 1000);
    const minutes = Math.floor(duration / 60);
    const seconds = duration % 60;

    // Build leaderboard text
    let leaderboardText = "";
    if (sessionData.leaderboard?.size > 0) {
        const medals = ["🥇", "🥈", "🥉"];
        const sorted = Array.from(sessionData.leaderboard.entries())
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 10);

        leaderboardText = "\n\n🏆 **Leaderboard:**\n" + sorted
            .map(([odUserId, data], idx) => {
                const medal = medals[idx] || `${idx + 1}.`;
                return `${medal} <@${odUserId}>: ${data.count} caught`;
            })
            .join("\n");
    }

    // Build fastest catch text
    let fastestCatchText = "";
    if (sessionData.fastestCatch) {
        const { userId, countryball, time } = sessionData.fastestCatch;
        fastestCatchText = `\n⚡ **Fastest catch:** <@${userId}> caught **${countryball}** in ${time}s`;
    }

    // Clean up and send summary
    trainingSessions.delete(guildId);

    if (channel) {
        channel.send(
            `🏁 **${reason}**\n` +
            `📊 Total countryballs caught: ${sessionData.catches || 0}\n` +
            `⏱️ Session duration: ${minutes}m ${seconds}s` +
            `${leaderboardText}${fastestCatchText}`
        );
    }

    return {
        catches: sessionData.catches || 0,
        duration: { minutes, seconds },
        leaderboard: sessionData.leaderboard,
        fastestCatch: sessionData.fastestCatch,
    };
}

module.exports = {
    trainingSessions,
    getRandomCountryball,
    sendCountryball,
    scheduleNextCountryball,
    updateCatchStats,
    endSession,
    createDisabledButtonRow,
    fetchBallsForDex,
};
