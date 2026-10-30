/**
 * How Catch stats recognizes a catch message of each dex bot.
 *
 * The phrases are set per dex on the website (Moderation -> Dexes -> Catch phrases) and saved in
 * assets/jsons/dexes.json; dexes without their own list use DEFAULT_CATCH below.
 *
 * A catch message answers the spawn message (the dex bot's reply to the "Catch me!" button).
 *   phrases  - the message counts as a catch when its text contains ANY of these (case-insensitive)
 *   ignore   - ...unless it also contains any of these (e.g. "wrong name" answers)
 *   user     - pattern whose first group is the catcher's Discord ID (usually their mention)
 *   ball     - pattern whose first group is the ball's name (the first **bold** text)
 * Lines starting with ">" (quotes, e.g. custom catch phrases of players) are ignored before matching.
 */

const { DEX_REGISTRY } = require("./constants");

const MENTION = /<@!?(\d{17,20})>/;
const FIRST_BOLD = /\*\*(.+?)\*\*/;

// Ballsdex wording (checked)
const DEFAULT_CATCH = {
    phrases: ["You caught", "secured!", "almost slipped away but", "has joined your collection!"],
    ignore: ["Wrong name", "already been caught", "not the right"],
};

/** Rules for one dex bot, or null when it isn't an enabled dex. */
function rulesFor(botId) {
    const dex = DEX_REGISTRY.find((entry) => entry.botId === botId && entry.enabled);
    if (!dex) return null;
    return {
        phrases: dex.catchPhrases?.length ? dex.catchPhrases : DEFAULT_CATCH.phrases,
        ignore: dex.catchIgnore ?? DEFAULT_CATCH.ignore,
        user: MENTION,
        ball: FIRST_BOLD,
    };
}

module.exports = { DEFAULT_CATCH, rulesFor };
