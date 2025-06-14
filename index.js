const { Client, GatewayIntentBits, Partials, Collection, REST, Routes } = require("discord.js");
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const token = process.env.TOKEN;

const client = new Client({
    intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.Guilds,
    ],
    partials: [Partials.Channel],
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

    try {
        console.log("Global commands refreshing...");
        await rest.put(Routes.applicationCommands(client.user.id), { body: slashCommandsArray });
        console.log("Commands registered.");
    } catch (error) {
        console.error("Error while registering commands:", error);
    }
});

client.login(token);
