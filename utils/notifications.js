/**
 * Notifications shared by the bot and the website.
 *
 * Every type can be turned on/off (shown in the website's notification history) and,
 * independently, sent as a Discord DM. Settings live in data.json users[id].notificationSettings;
 * the older /notifications keys (users[id].notifications.thanks / .reminder) stay in sync for the
 * two vote types. The website history (users[id].inbox) is kept only for users who have opened the
 * website at least once (users[id].web), capped at INBOX_LIMIT entries.
 */

const { getData, updateData } = require("./helpers");

const INBOX_LIMIT = 40;

const TYPES = {
    vote_reminder: {
        label: "Vote reminder",
        description: "Your upvote expired and you can vote again.",
        defaults: { enabled: true, dm: false },
    },
    vote_thanks: {
        label: "Thanks for voting",
        description: "A thank-you when you upvote the bot.",
        defaults: { enabled: true, dm: true },
    },
    sync_finished: {
        label: "Ballsdex sync finished",
        description: "Your collection sync completed or failed.",
        defaults: { enabled: true, dm: true },
    },
    sync_available: {
        label: "Ballsdex sync available",
        description: "Your 12-hour sync cooldown ended, or a busy sync slot freed up.",
        defaults: { enabled: true, dm: false },
    },
    ballsdex_account: {
        label: "Ballsdex account changes",
        description: "A Ballsdex API key was linked to or removed from your account.",
        defaults: { enabled: true, dm: true },
    },
    update_dex: {
        label: "Dex updates",
        description: "New spawn arts and dex data, from the changelog.",
        defaults: { enabled: true, dm: false },
    },
    update_site: {
        label: "Website & bot updates",
        description: "New features and fixes, from the changelog.",
        defaults: { enabled: true, dm: false },
    },
};

let client = null;
function setClient(discordClient) {
    client = discordClient;
}

function getSettings(userId, data = getData()) {
    const user = data.users[userId] || {};
    const stored = user.notificationSettings || {};
    const legacy = user.notifications || {};
    const settings = {};
    for (const [type, { defaults }] of Object.entries(TYPES)) {
        const value = { ...defaults, ...(stored[type] || {}) };
        // The old /notifications DM switches keep working until the user changes the new setting
        if (!stored[type]) {
            if (type === "vote_thanks") value.dm = legacy.thanks !== false;
            if (type === "vote_reminder") value.dm = legacy.reminder === true;
        }
        if (!value.enabled) value.dm = false;
        settings[type] = value;
    }
    return settings;
}

function setSetting(userId, type, { enabled, dm }) {
    if (!TYPES[type]) throw new Error("Unknown notification type");
    return updateData((data) => {
        const current = getSettings(userId, data)[type];
        const next = {
            enabled: typeof enabled === "boolean" ? enabled : current.enabled,
            dm: typeof dm === "boolean" ? dm : current.dm,
        };
        if (!next.enabled) next.dm = false;
        data.users[userId] ??= {};
        data.users[userId].notificationSettings ??= {};
        data.users[userId].notificationSettings[type] = next;
        // keep the legacy keys the vote handlers used to read
        if (type === "vote_thanks" || type === "vote_reminder") {
            data.users[userId].notifications ??= {};
            data.users[userId].notifications[type === "vote_thanks" ? "thanks" : "reminder"] = next.dm;
        }
        return getSettings(userId, data);
    });
}

/** Called when the website asks for notifications: from now on, history is kept for this user. */
function markWebUser(userId) {
    const data = getData();
    if (data.users[userId]?.web) return;
    updateData((d) => {
        d.users[userId] ??= {};
        d.users[userId].web ??= { since: new Date().toISOString() };
    });
}

function getInbox(userId) {
    const data = getData();
    const items = data.users[userId]?.inbox || [];
    return { items, unread: items.filter((item) => !item.read).length, settings: getSettings(userId, data) };
}

function markRead(userId, ids) {
    return updateData((data) => {
        const inbox = data.users[userId]?.inbox || [];
        const wanted = Array.isArray(ids) ? new Set(ids.map(String)) : null;
        for (const item of inbox) if (!wanted || wanted.has(item.id)) item.read = true;
        return inbox.filter((item) => !item.read).length;
    });
}

/**
 * Send one notification. `dmText` defaults to "**title**\nbody".
 * @returns {Promise<{stored: boolean, dm: boolean}>}
 */
async function notify(userId, type, { title, body = "", link = null, dmText } = {}) {
    userId = String(userId);
    const settings = getSettings(userId)[type];
    if (!settings?.enabled) return { stored: false, dm: false };

    let stored = false;
    updateData((data) => {
        const user = data.users[userId];
        if (!user?.web) return;
        user.inbox ??= [];
        user.inbox.unshift(inboxItem(type, title, body, link));
        user.inbox.length = Math.min(user.inbox.length, INBOX_LIMIT);
        stored = true;
    });

    let dm = false;
    if (settings.dm && client) {
        try {
            const user = await client.users.fetch(userId);
            await user.send(dmText || `**${title}**${body ? `\n${body}` : ""}`);
            dm = true;
        } catch (error) {
            console.error(`[NOTIFY] DM ${type} to ${userId} failed:`, error.message);
        }
    }
    return { stored, dm };
}

function inboxItem(type, title, body, link) {
    return {
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        type,
        title,
        body,
        link,
        createdAt: new Date().toISOString(),
        read: false,
    };
}

/** Changelog entries -> update notifications for everyone who wants them (one data.json write). */
async function notifyChangelog(entries) {
    if (!entries.length) return;
    const dms = [];
    updateData((data) => {
        for (const entry of entries) {
            const type = entry.type === "dex" ? "update_dex" : "update_site";
            const title = entry.type === "dex" ? "Dex update" : "BallIdentifier update";
            const body = entry.changes.slice(0, 3).join("\n") + (entry.changes.length > 3 ? `\n+${entry.changes.length - 3} more` : "");
            for (const [userId, user] of Object.entries(data.users)) {
                const settings = getSettings(userId, data)[type];
                if (!settings.enabled) continue;
                if (user.web) {
                    user.inbox ??= [];
                    user.inbox.unshift(inboxItem(type, title, body, "#/identify?whatsnew=1"));
                    user.inbox.length = Math.min(user.inbox.length, INBOX_LIMIT);
                }
                if (settings.dm) {
                    dms.push([userId, `**${title}**\n${entry.changes.map((c) => `- ${c}`).join("\n").slice(0, 1800)}\n-# Manage notifications on https://ballidentifier.xyz`]);
                }
            }
        }
    });
    for (const [userId, text] of dms) {
        try {
            const user = await client?.users.fetch(userId);
            await user?.send(text);
        } catch (error) {
            console.error(`[NOTIFY] update DM to ${userId} failed:`, error.message);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
}

function publicTypes() {
    return Object.entries(TYPES).map(([id, { label, description }]) => ({ id, label, description }));
}

module.exports = { TYPES, setClient, getSettings, setSetting, markWebUser, getInbox, markRead, notify, notifyChangelog, publicTypes };
