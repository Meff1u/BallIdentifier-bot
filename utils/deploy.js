/**
 * Deferred website deploys. The dex edits are committed to the website repo right away, but the website (its own
 * container, serving a checkout of the repo) only picks them up on a deploy: the bot calls SITE_DEPLOY_HOOK
 * (http://web:8888/_internal/deploy, with DEPLOY_SECRET) and the website runs git pull.
 * A deploy starts from Moderation -> Deploy (owner), or from the website's GitHub webhook (functions/github-webhook.js)
 * when someone pushes code. Until then the dex commits are listed as waiting.
 *
 * The changelog entries of those edits wait with them (pending[].changelog) and are written once per deploy: one entry
 * per dex (plus one for website notes) instead of one per edit.
 */

const { getData, updateData } = require("./helpers");

const MAX_PENDING = 200;
/** Commits made by the bot carry this, so the website's webhook doesn't deploy because of them. */
const SKIP_MARKER = "[skip deploy]";

let client = null;
let deploying = false;

const setClient = (c) => {
    client = c;
};

// Lazy: dex-editor requires this module too
const editor = () => require("./dex-editor");

const hookUrl = () => {
    const url = (process.env.SITE_DEPLOY_HOOK || "").trim();
    return /^https?:\/\/\S+$/.test(url) ? url : null;
};
const enabled = () => Boolean(hookUrl());

function userError(message, status = 400) {
    const error = new Error(message);
    error.status = status;
    return error;
}

/** Commit message of a bot commit (the marker tells the website's GitHub webhook not to deploy it). */
const commitMessage = (message) => `${message} ${SKIP_MARKER}`;

/** entry: { title, changes: string[], actor, sha, url, changelog?: { type, dex?, changes, items? } } */
function record(entry) {
    if (!enabled()) return;
    updateData((data) => {
        data.deploy ??= {};
        data.deploy.pending = [...(data.deploy.pending || []), { at: new Date().toISOString(), ...entry }].slice(-MAX_PENDING);
    });
}

function status() {
    const deploy = getData().deploy || {};
    return { enabled: enabled(), deploying, pending: deploy.pending || [], lastDeployAt: deploy.lastDeployAt || null };
}

const PART_TEXT = {
    rename: (part) => `renamed from ${part.from}`,
    art: () => "new spawn art",
    previous: () => "the old art moved to Previous arts",
    diff: (part) => `${part.label} ${part.from} → ${part.to}`,
};

/** One changelog line for everything changed on one collectible in an edit: "Name: new spawn art, artist A → B". */
function editLine(name, parts) {
    return `${name}: ${parts.map((part) => PART_TEXT[part.type](part)).join(", ")}`;
}

/** Adds the parts of a later edit: the first "from" stays, the last "to" wins ("rarity T3 → T4" then "T4 → T5" is "T3 → T5"). */
function mergeParts(into, parts) {
    for (const part of parts) {
        const same = into.find((item) => item.type === part.type && (part.type !== "diff" || item.label === part.label));
        if (!same) into.push({ ...part });
        else if (part.type === "diff") same.to = part.to;
    }
}

/**
 * Pending changelog notes -> one entry per dex (type "dex") and one for website notes, newest first.
 * Edits of the same collectible (note.items) become one line, also across several saves and renames.
 */
function mergeChangelog(items) {
    const groups = new Map();
    const names = new Map(); // group key -> Map(collectible name -> its merged edit)
    for (const item of items) {
        const note = item.changelog;
        if (!note?.changes?.length) continue;
        const type = note.type || "dex";
        const key = `${type}|${note.dex || ""}`;
        if (!groups.has(key)) {
            groups.set(key, { type, ...(note.dex ? { dex: note.dex } : {}), changes: [] });
            names.set(key, new Map());
        }
        const group = groups.get(key);
        const byName = names.get(key);
        const edits = note.items || [];
        for (const line of note.changes) if (!edits.some((edit) => edit.line === line) && !group.changes.includes(line)) group.changes.push(line);
        for (const edit of edits) {
            const rename = edit.parts.find((part) => part.type === "rename");
            let merged = rename ? byName.get(rename.from) : null;
            if (merged) byName.delete(rename.from);
            else merged = byName.get(edit.name);
            if (!merged) {
                merged = { parts: [] };
                group.changes.push(merged);
            }
            merged.name = edit.name;
            byName.set(edit.name, merged);
            mergeParts(merged.parts, edit.parts);
        }
    }
    const now = Math.floor(Date.now() / 1000);
    const lines = (group) =>
        group.changes
            .map((line) => {
                if (typeof line === "string") return line;
                // Changes that cancel out (artist A → B → A, a rename back) are left out
                const parts = line.parts.filter((part) => !(part.type === "diff" && part.from === part.to) && !(part.type === "rename" && part.from === line.name));
                return parts.length ? editLine(line.name, parts) : null;
            })
            .filter(Boolean);
    return [...groups.values()]
        .map((group) => ({ ...group, changes: lines(group) }))
        .filter((group) => group.changes.length)
        .map((group, index) => ({ timestamp: String(now - index), ...group }));
}

/** The website pulls the repo as it is now; the changes listed so far are then live (in a few seconds). */
async function trigger() {
    const url = hookUrl();
    if (!url) throw userError("SITE_DEPLOY_HOOK isn't set in the bot's environment.", 412);
    if (deploying) throw userError("A deploy was just started.", 409);
    deploying = true;
    try {
        const sent = new Set((getData().deploy?.pending || []).map((item) => item.sha));

        // One changelog commit for everything waiting, made before the pull so it goes live together with the edits
        const withNotes = (getData().deploy?.pending || []).filter((item) => item.changelog);
        if (withNotes.length) {
            await editor().commitChangelog(mergeChangelog(withNotes));
            // Written: if the pull below fails, a retry must not add the same notes again
            const done = new Set(withNotes.map((item) => item.sha));
            updateData((data) => {
                data.deploy ??= {};
                data.deploy.pending = (data.deploy.pending || []).map((item) => {
                    if (!done.has(item.sha)) return item;
                    const { changelog, ...rest } = item;
                    return rest;
                });
            });
        }

        const response = await fetch(url, {
            method: "POST",
            headers: { "X-Deploy-Secret": process.env.DEPLOY_SECRET || "" },
            signal: AbortSignal.timeout(60000),
        });
        if (!response.ok) throw new Error(`Website deploy (git pull) failed: ${response.status}`);

        // Changes committed while the request was running stay in the list for the next deploy
        updateData((data) => {
            data.deploy ??= {};
            data.deploy.pending = (data.deploy.pending || []).filter((item) => !sent.has(item.sha));
            data.deploy.lastDeployAt = new Date().toISOString();
        });
        client?.log?.("SYSTEM", `🚀 Website deployed (${sent.size} dex change${sent.size === 1 ? "" : "s"})`);
        return status();
    } finally {
        deploying = false;
    }
}

module.exports = { setClient, enabled, commitMessage, editLine, record, status, trigger, SKIP_MARKER };
