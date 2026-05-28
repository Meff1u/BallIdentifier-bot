const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    SectionBuilder,
    ThumbnailBuilder,
} = require("discord.js");
const { randomUUID } = require("crypto");

const { SUPPORTED_BOT_IDS, BOT_NAMES, BOT_DATA_KEYS, COLORS, ASSETS_BASE_URL } = require("./constants");

const PAGE_SIZE = 25;
const COLLECTOR_SESSION_TTL = 15 * 60 * 1000;
const collectorSessions = new Map();

function createCollectorsSession(data) {
    const sessionId = randomUUID().replace(/-/g, "").slice(0, 12);

    collectorSessions.set(sessionId, {
        ...data,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    });

    return sessionId;
}

function getCollectorsSession(sessionId) {
    const session = collectorSessions.get(sessionId);

    if (!session) return null;

    if (Date.now() - session.updatedAt > COLLECTOR_SESSION_TTL) {
        collectorSessions.delete(sessionId);
        return null;
    }

    return session;
}

function updateCollectorsSession(sessionId, data) {
    const session = getCollectorsSession(sessionId);

    if (!session) return null;

    const nextSession = {
        ...session,
        ...data,
        updatedAt: Date.now(),
    };

    collectorSessions.set(sessionId, nextSession);

    return nextSession;
}

function getCollectorBalls(rarities) {
    return Object.entries(rarities)
        .filter(([, ballData]) => Array.isArray(ballData.collectors) && ballData.collectors.length > 0)
        .map(([name, ballData]) => ({ name, data: ballData }));
}

function findCollectorEntry(rarities, query) {
    const normalizedQuery = String(query || "").trim();

    if (!normalizedQuery) return null;

    const entries = Object.entries(rarities);
    const normalizedName = normalizedQuery.toLowerCase();

    const byName = entries.find(([name]) => name.toLowerCase() === normalizedName);
    if (byName) {
        return { name: byName[0], data: byName[1] };
    }

    const inputAsNumber = Number.parseInt(normalizedQuery, 10);
    if (!Number.isNaN(inputAsNumber)) {
        const byId = entries.find(([, data]) => Number(data.id) === inputAsNumber);
        if (byId) {
            return { name: byId[0], data: byId[1] };
        }
    }

    return null;
}

function getDexChoices(focusedValue = "") {
    const query = focusedValue.toLowerCase();

    return SUPPORTED_BOT_IDS.map((botId) => BOT_NAMES[botId])
        .filter(Boolean)
        .filter((dexName) => dexName.toLowerCase().includes(query))
        .slice(0, 25)
        .map((dexName) => ({ name: dexName, value: dexName }));
}

function buildCollectorsView(client, dataKey, selectedBallName, page = 0, sessionId) {
    const rarities = client.rarities?.[dataKey];

    if (!rarities) return { error: "Data not found." };

    const collectorBalls = getCollectorBalls(rarities);

    if (collectorBalls.length === 0) return { error: "No collectors found for this dex." };

    const selectedIndex = collectorBalls.findIndex((ball) => ball.name === selectedBallName);
    const selectedBall = collectorBalls[selectedIndex >= 0 ? selectedIndex : 0];
    const pageCount = Math.ceil(collectorBalls.length / PAGE_SIZE);
    const currentPage = Math.max(0, Math.min(page, pageCount - 1));
    const pageBalls = collectorBalls.slice(
        currentPage * PAGE_SIZE,
        currentPage * PAGE_SIZE + PAGE_SIZE,
    );

    if (sessionId) {
        updateCollectorsSession(sessionId, {
            dataKey,
            selectedBallName: selectedBall.name,
            page: currentPage,
        });
    }

    const collectors = selectedBall.data.collectors || [];
    const collectorsList = collectors.length
        ? collectors.map((c) => `- <@${c}>\n > ${c}`).join("\n")
        : "No collectors yet.";

    const botIdForKey = Object.keys(BOT_DATA_KEYS).find((id) => BOT_DATA_KEYS[id] === dataKey);
    const dexNameForUrl = botIdForKey ? BOT_NAMES[botIdForKey] : dataKey;

    const container = new ContainerBuilder()
        .setAccentColor(COLORS.PRIMARY)
        .addSectionComponents(
            new SectionBuilder()
                .setThumbnailAccessory(
                    new ThumbnailBuilder().setURL(
                        `${ASSETS_BASE_URL}/dexes/${encodeURIComponent(dexNameForUrl)}/compressed/${encodeURIComponent(selectedBall.name)}.webp`,
                    ),
                )
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(`**Collectors of ${selectedBall.name}**`),
                    new TextDisplayBuilder().setContent(collectorsList),
                ),
        )
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`collectors:${sessionId}:select`)
        .setPlaceholder("Select an entry")
        .addOptions(
            pageBalls.map(({ name, data }) => ({
                label: name,
                value: name,
                description: `Collectors: ${data.collectors.length}`,
                default: name === selectedBall.name,
            })),
        );

    container.addActionRowComponents(new ActionRowBuilder().addComponents(selectMenu));

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# Entries with collectors: ${collectorBalls.length} | Page: ${currentPage + 1}/${pageCount}`),
    );

    const searchButton = new ButtonBuilder()
        .setCustomId(`collectors:${sessionId}:search`)
        .setStyle(ButtonStyle.Secondary)
        .setLabel("🔎");

    if (pageCount > 1) {
        const prevButton = new ButtonBuilder()
            .setCustomId(`collectors:${sessionId}:prev`)
            .setStyle(ButtonStyle.Primary)
            .setLabel("◄")
            .setDisabled(currentPage === 0);

        const nextButton = new ButtonBuilder()
            .setCustomId(`collectors:${sessionId}:next`)
            .setStyle(ButtonStyle.Primary)
            .setLabel("►")
            .setDisabled(currentPage === pageCount - 1);

        container.addActionRowComponents(
            new ActionRowBuilder().addComponents(prevButton, searchButton, nextButton),
        );
    } else {
        container.addActionRowComponents(new ActionRowBuilder().addComponents(searchButton));
    }

    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            "-# That list may be outdated or not updated with new collectors. If you know something i don't, let me know! (<@334411435633541121> | @meffiu)",
        ),
    );

    return { components: [container] };
}

module.exports = {
    PAGE_SIZE,
    getDexChoices,
    createCollectorsSession,
    getCollectorsSession,
    findCollectorEntry,
    getCollectorBalls,
    buildCollectorsView,
};
