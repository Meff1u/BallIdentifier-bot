const { Client, GatewayIntentBits, Partials, Collection, REST, Routes } = require("discord.js");
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { startServer, initializeServer } = require("./server");

const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const TOKEN = process.env.TOKEN;
const PRIVATE_GUILD_ID = "379676234566729742";
const PRIVATE_COMMANDS = ["refresh", "msg"];

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildIntegrations,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User, Partials.GuildMember],
});

client.identifyCooldowns = new Map();
client.reportCooldowns = new Map();

client.slashCommands = new Collection();

// Load commands
const commandsPath = path.join(__dirname, "commands");
const commandFiles = fs.readdirSync(commandsPath).filter((file) => 
    file.endsWith("-slash.js") || file.endsWith("-context.js")
);

const slashCommandsArray = commandFiles.reduce((acc, file) => {
    const command = require(path.join(commandsPath, file));
    if (command.data && command.execute) {
        client.slashCommands.set(command.data.name, command);
        acc.push(command.data.toJSON());
    }
    return acc;
}, []);

// Load events
const eventsPath = path.join(__dirname, "events");
fs.readdirSync(eventsPath)
    .filter((file) => file.endsWith(".js"))
    .forEach((file) => {
        const event = require(path.join(eventsPath, file));
        const handler = (...args) => event.execute(...args, client);
        event.once ? client.once(event.name, handler) : client.on(event.name, handler);
    });

client.once("ready", async () => {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    const appId = client.user.id;

    // Separate global and private commands
    const globalCommands = slashCommandsArray.filter((cmd) => !PRIVATE_COMMANDS.includes(cmd.name));
    const privateCommands = slashCommandsArray.filter((cmd) => PRIVATE_COMMANDS.includes(cmd.name));

    // Register commands in parallel
    const registrations = [
        rest.put(Routes.applicationCommands(appId), { body: globalCommands })
            .then(() => console.log("✅ Global commands registered."))
            .catch((err) => console.error("❌ Error registering global commands:", err)),
    ];

    if (privateCommands.length > 0) {
        registrations.push(
            rest.put(Routes.applicationGuildCommands(appId, PRIVATE_GUILD_ID), { body: privateCommands })
                .then(() => console.log(`✅ Private commands registered for guild ${PRIVATE_GUILD_ID}.`))
                .catch((err) => console.error("❌ Error registering private commands:", err))
        );
    }

    await Promise.allSettled(registrations);

    // Initialize and start Express server
    initializeServer(client);
    startServer();
});

// Utility function to send webhook
const sendWebhook = async (webhookUrl, payload) => {
    if (!webhookUrl) return;
    try {
        await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
    } catch (e) {
        console.error("Error sending webhook:", e);
    }
};

client.sendLog = async (logData) => {
    await sendWebhook(process.env.LOG_WEBHOOK_URL, {
        embeds: [{
            title: logData.title || "Log",
            description: logData.description || null,
            fields: logData.fields || [],
            color: logData.color || 0x6839a6,
            timestamp: new Date().toISOString(),
            ...(logData.thumbnail && { thumbnail: { url: logData.thumbnail } }),
            ...(logData.image && { image: { url: logData.image } }),
        }],
    });
};

// Error handlers
const handleError = async (title, description) => {
    await sendWebhook(process.env.ERROR_WEBHOOK_URL, {
        embeds: [{
            title,
            description,
            color: 0xff0000,
            timestamp: new Date().toISOString(),
        }],
    });
};

process.on("unhandledRejection", (reason, promise) => {
    handleError(
        "Unhandled Rejection",
        `**Reason:** ${reason instanceof Error ? reason.stack : reason}\n**Promise:** ${promise}`
    );
});

process.on("uncaughtException", (error) => {
    handleError("Uncaught Exception", error.stack || String(error));
});

client.login(TOKEN);
