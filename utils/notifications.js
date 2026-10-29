/**
 * Notifications shared by the bot and the website.
 *
 * Every type can be turned on/off (shown in the website's notification history) and,
 * independently, sent as a Discord DM. Settings live in data.json users[id].notificationSettings;
 * the keys of the removed /notifications command (users[id].notifications.thanks / .reminder) stay
 * in sync for the two vote types. The website history (users[id].inbox) is kept only for users who have opened the
 * website at least once (users[id].web), capped at INBOX_LIMIT entries.
 */

const {
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    SectionBuilder,
    ThumbnailBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
} = require("discord.js");
const { getData, updateData } = require("./helpers");

const INBOX_LIMIT = 40;
const SITE_URL = "https://ballidentifier.xyz";
const MAX_DM_TEXT = 3500; // components v2 messages allow 4000 characters of text in total

// Look of the DM card per notification type
const DM_STYLE = {
    vote_reminder: { emoji: "⏰", color: 0xfee75c },
    vote_thanks: { emoji: "💜", color: 0x00c853 },
    sync_finished: { emoji: "📦", color: 0xa020f0 },
    sync_available: { emoji: "🔄", color: 0x3498db },
    ballsdex_account: { emoji: "🔑", color: 0xa020f0 },
    update_dex: { emoji: "🗂️", color: 0x6839a6 },
    update_site: { emoji: "✨", color: 0x7289da },
};

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
        description: "Your 24-hour sync cooldown ended, or a busy sync slot freed up.",
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
        // DM switches saved by the removed /notifications command keep working until the user changes the setting
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
    const user = data.users[userId] || {};
    const items = user.inbox || [];
    // dmBlockedAt: the last DM failed because Discord doesn't let the bot reach this user (see sendDm)
    return { items, unread: items.filter((item) => !item.read).length, settings: getSettings(userId, data), dmReachable: !user.dmBlockedAt };
}

// Discord refuses a bot's DM when the user shares no server with it and hasn't added the app to their
// account (50278), or has DMs closed (50007). Those are expected, so they're remembered, not logged as errors.
const DM_BLOCKED_CODES = new Set([50007, 50278]);

/** Website link of a notification ("#/ballsdex" -> https://ballidentifier.xyz/ballsdex). */
function siteUrl(link) {
    if (!link) return null;
    if (/^https?:\/\//.test(link)) return link;
    const path = link.startsWith("#/") ? link.slice(1) : link.startsWith("/") ? link : `/${link}`;
    return `${SITE_URL}${path}`;
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * A DM as a components v2 card: colored container, title, text, optional sections, link buttons
 * and a small footer pointing to the notification settings.
 * sections: [{ title, lines[], thumbnail? }]   buttons: [{ label, url, emoji? }]
 */
function buildDmCard({ type, title, text = "", sections = [], buttons = [] }) {
    const style = DM_STYLE[type] || { emoji: "🔔", color: 0x6839a6 };
    const container = new ContainerBuilder().setAccentColor(style.color);
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(clip(`## ${style.emoji} ${title}${text ? `\n${text}` : ""}`, 1500)));

    let budget = MAX_DM_TEXT - 1500;
    for (const section of sections) {
        if (budget <= 0) break;
        const content = clip(`### ${section.title}\n${section.lines.map((line) => `- ${line}`).join("\n")}`, Math.min(budget, 1500));
        budget -= content.length;
        container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
        if (section.thumbnail) {
            container.addSectionComponents(
                new SectionBuilder()
                    .addTextDisplayComponents(new TextDisplayBuilder().setContent(content))
                    .setThumbnailAccessory(new ThumbnailBuilder().setURL(section.thumbnail)),
            );
        } else {
            container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
        }
    }

    const links = buttons.filter((button) => button?.url).slice(0, 5);
    if (links.length) {
        container.addActionRowComponents(
            new ActionRowBuilder().addComponents(
                links.map((button) => {
                    const built = new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(button.label).setURL(button.url);
                    if (button.emoji) built.setEmoji(button.emoji);
                    return built;
                }),
            ),
        );
    }
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# You can change which notifications you get on [ballidentifier.xyz](${SITE_URL}) (bell icon)`));

    return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

/** Sends a DM (text or a ready message payload); remembers whether the user can be reached so the website can explain how to fix it. */
async function sendDm(userId, message) {
    try {
        const user = await client.users.fetch(userId);
        await user.send(message);
        if (getData().users[userId]?.dmBlockedAt) {
            updateData((data) => {
                if (data.users[userId]) delete data.users[userId].dmBlockedAt;
            });
        }
        return true;
    } catch (error) {
        if (DM_BLOCKED_CODES.has(error.code)) {
            if (!getData().users[userId]?.dmBlockedAt) {
                updateData((data) => {
                    data.users[userId] ??= {};
                    data.users[userId].dmBlockedAt = new Date().toISOString();
                });
            }
        } else {
            console.error(`[NOTIFY] DM to ${userId} failed:`, error.message);
        }
        return false;
    }
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
 * Send one notification. The DM is a card with the title and `dmText` (default: body),
 * a button to `link` on the website (label: `linkLabel`) and any extra `buttons` ([{ label, url }]).
 * @returns {Promise<{stored: boolean, dm: boolean}>}
 */
async function notify(userId, type, { title, body = "", link = null, linkLabel = "Open on the website", dmText, buttons = [] } = {}) {
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
        const url = siteUrl(link);
        dm = await sendDm(userId, buildDmCard({ type, title, text: dmText || body, buttons: [...buttons, url ? { label: linkLabel, url } : null] }));
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
// Changelog entries of the same kind (type + dex) less than this apart become one update
// (the website's What's new panel merges them the same way)
const CHANGELOG_MERGE_GAP_SEC = 60 * 60;

/** entries: { time (seconds), type, dex?, changes[] }, any order -> merged, oldest first */
function mergeChangelogEntries(entries) {
    const merged = [];
    const open = new Map(); // "type|dex" -> group
    for (const entry of [...entries].sort((a, b) => a.time - b.time)) {
        const key = `${entry.type}|${entry.dex || ""}`;
        const group = open.get(key);
        if (group && entry.time - group.time <= CHANGELOG_MERGE_GAP_SEC) {
            // newest changes first, like the changelog
            group.changes = [...entry.changes.filter((change) => !group.changes.includes(change)), ...group.changes];
            group.time = entry.time;
            continue;
        }
        const fresh = { ...entry, changes: [...entry.changes] };
        open.set(key, fresh);
        merged.push(fresh);
    }
    return merged;
}

async function notifyChangelog(entries) {
    entries = mergeChangelogEntries(entries);
    if (!entries.length) return;
    const dms = new Map(); // userId -> { types, sections }, so each user gets one DM however many entries there are
    updateData((data) => {
        for (const entry of entries) {
            const type = entry.type === "dex" ? "update_dex" : "update_site";
            const title = entry.type === "dex" ? `${entry.dex ? `${entry.dex} ` : "Dex "}update` : entry.type === "bot" ? "Bot update" : "Website update";
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
                    if (!dms.has(userId)) dms.set(userId, { types: new Set(), sections: [] });
                    const dm = dms.get(userId);
                    dm.types.add(type);
                    dm.sections.push({ title, lines: entry.changes, thumbnail: entry.dex ? `${SITE_URL}/assets/icons/${encodeURIComponent(entry.dex)}.png` : null });
                }
            }
        }
    });
    for (const [userId, { types, sections }] of dms) {
        const onlyDex = types.size === 1 && types.has("update_dex");
        const card = buildDmCard({
            type: onlyDex ? "update_dex" : "update_site",
            title: "What's new on BallIdentifier",
            sections,
            buttons: [{ label: "Full changelog", url: `${SITE_URL}/?whatsnew=1`, emoji: "📰" }],
        });
        if (client) await sendDm(userId, card);
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
}

function publicTypes() {
    return Object.entries(TYPES).map(([id, { label, description }]) => ({ id, label, description }));
}

module.exports = { TYPES, setClient, getSettings, setSetting, markWebUser, getInbox, markRead, notify, notifyChangelog, mergeChangelogEntries, CHANGELOG_MERGE_GAP_SEC, publicTypes };
