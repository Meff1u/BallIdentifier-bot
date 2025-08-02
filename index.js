const { Client, GatewayIntentBits, Partials, Collection, REST, Routes } = require("discord.js");
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const token = process.env.TOKEN;

const client = new Client({
    intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildIntegrations,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User, Partials.GuildMember],
});

client.slashCommands = new Collection();

// Commands
const slashCommandsPath = path.join(__dirname, "commands");
const slashCommandFiles = fs
    .readdirSync(slashCommandsPath)
    .filter((file) => file.endsWith("-slash.js") || file.endsWith("-context.js"));
const slashCommandsArray = [];
for (const file of slashCommandFiles) {
    const command = require(path.join(slashCommandsPath, file));
    if (command.data && command.execute) {
        client.slashCommands.set(command.data.name, command);
        slashCommandsArray.push(command.data.toJSON());
    }
}

// Events
const eventsPath = path.join(__dirname, "events");
const eventFiles = fs.readdirSync(eventsPath).filter((file) => file.endsWith(".js"));
for (const file of eventFiles) {
    const event = require(path.join(eventsPath, file));
    if (event.once) {
        client.once(event.name, (...args) => event.execute(...args, client));
    } else {
        client.on(event.name, (...args) => event.execute(...args, client));
    }
}

client.once("ready", async () => {
    const rest = new REST({ version: "10" }).setToken(token);

    // Register global commands (exclude refresh and msg)
    const globalCommands = slashCommandsArray.filter(
        (cmd) => cmd.name !== "refresh" && cmd.name !== "msg"
    );
    try {
        console.log("Global commands refreshing...");
        await rest.put(Routes.applicationCommands(client.user.id), { body: globalCommands });
        console.log("Global commands registered.");
    } catch (error) {
        console.error("Error while registering global commands:", error);
    }

    // Register refresh and msg command (private)
    const refreshCmd = slashCommandsArray.find((cmd) => cmd.name === "refresh");
    const msgCmd = slashCommandsArray.find((cmd) => cmd.name === "msg");
    if (refreshCmd || msgCmd) {
        try {
            await rest.put(Routes.applicationGuildCommands(client.user.id, "379676234566729742"), {
                body: [refreshCmd, msgCmd],
            });
            console.log("refresh/msg command registered for guild 379676234566729742.");
        } catch (error) {
            console.error("Error while registering refresh/msg command for guild:", error);
        }
    }
});

client.sendLog = async (logData) => {
    const webhookUrl = process.env.LOG_WEBHOOK_URL;
    if (!webhookUrl) return;
    try {
        await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                embeds: [
                    {
                        title: logData.title || "Log",
                        description: logData.description || null,
                        fields: logData.fields || [],
                        color: logData.color || 0x6839a6,
                        timestamp: new Date().toISOString(),
                        ...(logData.thumbnail ? { thumbnail: { url: logData.thumbnail } } : {}),
                        ...(logData.image ? { image: { url: logData.image } } : {}),
                    },
                ],
            }),
        });
    } catch (e) {
        console.error("Error sending log:", e);
    }
};

process.on("unhandledRejection", async (reason, promise) => {
    const webhookUrl = process.env.ERROR_WEBHOOK_URL;
    if (!webhookUrl) return;
    try {
        await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                embeds: [
                    {
                        title: "Unhandled Rejection",
                        description: `**Reason:** ${
                            reason instanceof Error ? reason.stack : reason
                        }\n**Promise:** ${promise}`,
                        color: 0xff0000,
                        timestamp: new Date().toISOString(),
                    },
                ],
            }),
        });
    } catch (e) {}
});

process.on("uncaughtException", async (error) => {
    const webhookUrl = process.env.ERROR_WEBHOOK_URL;
    if (!webhookUrl) return;
    try {
        await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                embeds: [
                    {
                        title: "Uncaught Exception",
                        description: error.stack || String(error),
                        color: 0xff0000,
                        timestamp: new Date().toISOString(),
                    },
                ],
            }),
        });
    } catch (e) {}
});

client.login(token);
