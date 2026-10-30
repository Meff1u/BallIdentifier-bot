/**
 * How Catch stats recognizes a catch message of each dex bot. EDIT THIS FILE to match each bot's real messages.
 *
 * A catch message must be a reply to the spawn message (the bot answers the "Catch me!" button).
 * For every dex bot:
 *   phrases  - the message counts as a catch when its text contains ANY of these (case-insensitive)
 *   ignore   - ...unless it also contains any of these (e.g. "wrong name" answers)
 *   user     - pattern whose first group is the catcher's Discord ID (usually their mention)
 *   ball     - pattern whose first group is the ball's name (usually the first **bold** text)
 *
 * Lines starting with ">" (quotes) are ignored before matching.
 * Tip: copy a real catch message from Discord (with "Copy Text") and check the patterns against it.
 */

const MENTION = /<@!?(\d{17,20})>/;
const FIRST_BOLD = /\*\*(.+?)\*\*/;

// Ballsdex wording (checked); the other dexes start from the same template, change them if they write it differently
const DEFAULT = {
    phrases: ["You caught", "secured!", "almost slipped away but", "has joined your collection!"],
    ignore: ["Wrong name", "wrong name", "already been caught", "not the right"],
    user: MENTION,
    ball: FIRST_BOLD,
};

module.exports = {
    // Ballsdex
    "999736048596816014": { ...DEFAULT },
    // HistoryDex
    "1120942938126553190": { ...DEFAULT },
    // JoJoDex
    "1425109627636285511": { ...DEFAULT },
    // Empireballs Reboot
    "1500173453880197162": { ...DEFAULT },
    // MapsDex
    "1406796704807915630": { ...DEFAULT },
    // FlagsDex
    "1485343094064021625": { ...DEFAULT },
};
