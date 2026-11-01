/**
 * Deferred website deploys. Netlify deploys on every commit to the website repo, so while a Netlify build hook is set
 * (NETLIFY_BUILD_HOOK in .env) the dex edits are still committed right away, but marked "[skip netlify]": no deploy.
 * They are listed in Moderation -> Deploy and go live all at once when the owner presses Deploy (the hook builds the
 * branch as it is). Without the hook everything works as before: each commit deploys by itself.
 */

const { getData, updateData } = require("./helpers");

const SKIP_TAG = "[skip netlify]";
const MAX_PENDING = 200;
const HOOK_PATTERN = /^https:\/\/api\.netlify\.com\/build_hooks\/[\w-]+/;

let client = null;
let deploying = false;

const setClient = (c) => {
    client = c;
};

const hookUrl = () => {
    const url = (process.env.NETLIFY_BUILD_HOOK || "").trim();
    return HOOK_PATTERN.test(url) ? url : null;
};
const enabled = () => Boolean(hookUrl());

function userError(message, status = 400) {
    const error = new Error(message);
    error.status = status;
    return error;
}

/** Commit message for a change that waits for Deploy (unchanged when deploys aren't deferred). */
const commitMessage = (message) => (enabled() ? `${message}\n\n${SKIP_TAG}` : message);

/** entry: { title, changes: string[], actor, sha, url } */
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

/** Build the website from the repo as it is now; the changes listed so far are then live (in about 2 minutes). */
async function trigger() {
    const url = hookUrl();
    if (!url) throw userError("NETLIFY_BUILD_HOOK isn't set in the bot's .env.", 412);
    if (deploying) throw userError("A deploy was just started.", 409);
    deploying = true;
    try {
        const sent = new Set((getData().deploy?.pending || []).map((item) => item.sha));
        const target = `${url}${url.includes("?") ? "&" : "?"}trigger_title=${encodeURIComponent("Dex changes (BallIdentifier bot)")}`;
        const response = await fetch(target, { method: "POST", signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`Netlify build hook failed: ${response.status}`);

        // Changes committed while the request was running stay in the list for the next deploy
        updateData((data) => {
            data.deploy ??= {};
            data.deploy.pending = (data.deploy.pending || []).filter((item) => !sent.has(item.sha));
            data.deploy.lastDeployAt = new Date().toISOString();
        });
        client?.log?.("SYSTEM", `🚀 Owner deployed the website (${sent.size} dex change${sent.size === 1 ? "" : "s"})`);
        return status();
    } finally {
        deploying = false;
    }
}

module.exports = { setClient, enabled, commitMessage, record, status, trigger };
