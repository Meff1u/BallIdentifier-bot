const { Client, GatewayIntentBits, Partials, Collection, REST, Routes } = require("discord.js");
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { startServer, initializeServer } = require("./server");
const { addLog, logEmbed, logError, flushAllBatches } = require("./utils/logger");
const { closeDatabase, initializeDatabase } = require("./utils/database");

const TOKEN = process.env.TOKEN;
const { PRIVATE_GUILD_ID } = require("./utils/constants");
const PRIVATE_COMMANDS = ["refresh", "msg", "bdcompare"];

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

// Logging: everything goes to threads of the log channel (see utils/logger.js), errors also to the console
client.log = (category, message) => addLog(category, message, client);
client.logDiscord = (message) => client.log("COMMANDS", message);
client.logImage = (message) => client.log("NOTIFIER", message);
client.logAPI = (message) => client.log("API", message);
client.logGeneral = (message) => client.log("SYSTEM", message);
client.logError = (title, detail) => logError(title, detail, client);

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

// Handle disconnect - flush pending logs
client.on("shardDisconnect", async () => {
    console.warn("[BOT] Disconnected from Discord");
    await flushAllBatches(client);
});

client.once("clientReady", async () => {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    const appId = client.user.id;

    try {
        await initializeDatabase();
    } catch (error) {
        client.logError("MongoDB unavailable", error.message);
    }

    // Separate global and private commands
    const globalCommands = slashCommandsArray.filter((cmd) => !PRIVATE_COMMANDS.includes(cmd.name));
    const privateCommands = slashCommandsArray.filter((cmd) => PRIVATE_COMMANDS.includes(cmd.name));

    // Register commands in parallel
    const registrations = [
        rest.put(Routes.applicationCommands(appId), { body: globalCommands })
            .then(() => client.logGeneral("Global commands registered"))
            .catch((err) => client.logError("Registering global commands failed", err)),
    ];

    if (privateCommands.length > 0) {
        registrations.push(
            rest.put(Routes.applicationGuildCommands(appId, PRIVATE_GUILD_ID), { body: privateCommands })
                .then(() => client.logGeneral(`Private commands registered for guild ${PRIVATE_GUILD_ID}`))
                .catch((err) => client.logError("Registering private commands failed", err))
        );
    }

    await Promise.allSettled(registrations);

    // Initialize and start Express server
    initializeServer(client);
    startServer();
});

// Identify logs (embed data, as the webhook used to take)
client.sendLog = async (logData) => {
    const embed = {
        title: logData.title || "Log",
        description: logData.description || undefined,
        fields: logData.fields || [],
        color: logData.color || 0x6839a6,
        timestamp: new Date().toISOString(),
        ...(logData.thumbnail && { thumbnail: { url: logData.thumbnail } }),
        ...(logData.image && { image: { url: logData.image } }),
    };
    await logEmbed("IDENTIFY", embed, client);
};

process.on("unhandledRejection", (reason) => {
    client.logError("Unhandled Rejection", reason instanceof Error ? reason : String(reason));
});

process.on("uncaughtException", (error) => {
    client.logError("Uncaught Exception", error);
});

// Handle graceful shutdown
process.on("SIGINT", async () => {
    console.log("[BOT] Gracefully shutting down...");
    await flushAllBatches(client);
    await closeDatabase();
    await client.destroy();
    process.exit(0);
});

process.on("SIGTERM", async () => {
    console.log("[BOT] Gracefully shutting down...");
    await flushAllBatches(client);
    await closeDatabase();
    await client.destroy();
    process.exit(0);
});

client.login(TOKEN);
