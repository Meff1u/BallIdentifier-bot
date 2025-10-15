const { ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const ballslist = require('./assets/ballslist.json')

const trainingSessions = new Map();

function getRandomCountryball(dex = 'Ballsdex') {
    const dexList = ballslist[dex] || ballslist['Ballsdex'];
    const randomIndex = Math.floor(Math.random() * dexList.length);
    return dexList[randomIndex];
}

async function sendCountryball(channel, guildId) {
    const sessionData = trainingSessions.get(guildId) || {};
    const dex = sessionData.dex || 'Ballsdex';
    const countryball = getRandomCountryball(dex);

    const baseUrl = "https://raw.githubusercontent.com/Meff1u/BallIdentifier/refs/heads/main/assets"
    const source = `${baseUrl}/${encodeURIComponent(dex)}/${encodeURIComponent(countryball)}.png`

    const attachment = new AttachmentBuilder(source, { name: 'countryball.png' });
    
    const catchButton = new ButtonBuilder()
        .setCustomId(`catch_${guildId}_${Date.now()}`)
        .setLabel('Catch me!')
        .setStyle(ButtonStyle.Primary);
    
    const row = new ActionRowBuilder().addComponents(catchButton);
    
    const message = await channel.send({
        content: 'A wild countryball appeared!',
        files: [attachment],
        components: [row]
    });
    
    const sessionData2 = trainingSessions.get(guildId) || {};
    sessionData2.currentCountryball = {
        name: countryball,
        messageId: message.id,
        spawnTime: Date.now()
    };
    
    if (!sessionData2.leaderboard) {
        sessionData2.leaderboard = new Map();
    }
    if (!sessionData2.fastestCatch) {
        sessionData2.fastestCatch = null;
    }
    
    if (sessionData2.inactivityTimeout) {
        clearTimeout(sessionData2.inactivityTimeout);
    }
    
    sessionData2.inactivityTimeout = setTimeout(() => {
        endSession(guildId, channel, 'Session ended due to inactivity (30 seconds).');
    }, 30000);
    
    trainingSessions.set(guildId, sessionData2);
    
    return message;
}

function scheduleNextCountryball(channel, guildId) {
    const sessionData = trainingSessions.get(guildId);
    if (!sessionData || !sessionData.active) return;
    
    sessionData.roundsPlayed = (sessionData.roundsPlayed || 0) + 1;
    if (typeof sessionData.roundsTotal === 'number') {
        if (sessionData.roundsPlayed >= sessionData.roundsTotal) {
            trainingSessions.set(guildId, sessionData);
            endSession(guildId, channel, `Planned rounds finished (${sessionData.roundsTotal}).`);
            return;
        }
    }
    
    sessionData.nextTimeout = setTimeout(async () => {
        if (trainingSessions.has(guildId) && trainingSessions.get(guildId).active) {
            await sendCountryball(channel, guildId);
        }
    }, 3000);
    
    trainingSessions.set(guildId, sessionData);
}

function updateCatchStats(guildId, userId, username, countryball, catchTime) {
    const sessionData = trainingSessions.get(guildId);
    if (!sessionData) return;
    
    if (!sessionData.leaderboard) {
        sessionData.leaderboard = new Map();
    }
    
    const currentUserStats = sessionData.leaderboard.get(userId) || { count: 0, username: username };
    currentUserStats.count += 1;
    currentUserStats.username = username;
    sessionData.leaderboard.set(userId, currentUserStats);
    
    const timeInSeconds = parseFloat(catchTime);
    if (!sessionData.fastestCatch || timeInSeconds < sessionData.fastestCatch.timeNum) {
        sessionData.fastestCatch = {
            userId: userId,
            username: username,
            countryball: countryball,
            time: catchTime,
            timeNum: timeInSeconds
        };
    }
    
    trainingSessions.set(guildId, sessionData);
}

function endSession(guildId, channel, reason = 'Training session ended!') {
    const sessionData = trainingSessions.get(guildId);
    if (!sessionData) return;
    
    if (sessionData.nextTimeout) {
        clearTimeout(sessionData.nextTimeout);
    }
    if (sessionData.inactivityTimeout) {
        clearTimeout(sessionData.inactivityTimeout);
    }
    
    if (sessionData.currentCountryball && sessionData.currentCountryball.messageId && channel) {
        try {
            channel.messages.fetch(sessionData.currentCountryball.messageId).then(message => {
                const disabledButton = new ButtonBuilder()
                    .setCustomId('disabled')
                    .setLabel('Catch me!')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(true);
                
                const disabledRow = new ActionRowBuilder().addComponents(disabledButton);
                
                message.edit({
                    content: `A wild countryball appeared!`,
                    components: [disabledRow]
                }).catch(console.error);
            }).catch(console.error);
        } catch (error) {
            console.error('Error disabling button on session end:', error);
        }
    }
    
    const duration = Math.floor((Date.now() - sessionData.startTime) / 1000);
    const minutes = Math.floor(duration / 60);
    const seconds = duration % 60;
    
    let leaderboardText = '';
    if (sessionData.leaderboard && sessionData.leaderboard.size > 0) {
        const sortedLeaderboard = Array.from(sessionData.leaderboard.entries())
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 10);
        
        leaderboardText = '\n\n🏆 **Leaderboard:**\n';
        sortedLeaderboard.forEach(([userId, data], index) => {
            const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
            leaderboardText += `${medal} <@${userId}>: ${data.count} caught\n`;
        });
    }
    
    let fastestCatchText = '';
    if (sessionData.fastestCatch) {
        const { userId, countryball, time, username } = sessionData.fastestCatch;
        fastestCatchText = `\n⚡ **Fastest catch:** <@${userId}> caught **${countryball}** in ${time}s`;
    }
    
    trainingSessions.delete(guildId);
    
    if (channel) {
        channel.send(`🏁 **${reason}**\n📊 Total countryballs caught: ${sessionData.catches || 0}\n⏱️ Session duration: ${minutes}m ${seconds}s${leaderboardText}${fastestCatchText}`);
    }
    
    return { 
        catches: sessionData.catches || 0, 
        duration: { minutes, seconds },
        leaderboard: sessionData.leaderboard,
        fastestCatch: sessionData.fastestCatch
    };
}

module.exports = {
    trainingSessions,
    getRandomCountryball,
    sendCountryball,
    scheduleNextCountryball,
    endSession,
    updateCatchStats
};
