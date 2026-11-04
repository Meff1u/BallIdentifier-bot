/**
 * Deferred website deploys. The dex edits are committed to the website repo right away, but the website (its own
 * container, serving a checkout of the repo) only picks them up when the owner presses Deploy in Moderation -> Deploy:
 * the bot calls SITE_DEPLOY_HOOK (http://web:8888/_internal/deploy, with DEPLOY_SECRET) and the website runs git pull.
 * Until then the commits are listed there as waiting.
 */

const { getData, updateData } = require("./helpers");

const MAX_PENDING = 200;

let client = null;
let deploying = false;

const setClient = (c) => {
    client = c;
};

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

/** Commit message for a dex change (kept as a hook in case deploys ever need a marker in the message again). */
const commitMessage = (message) => message;

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

/** The website pulls the repo as it is now; the changes listed so far are then live (in a few seconds). */
async function trigger() {
    const url = hookUrl();
    if (!url) throw userError("SITE_DEPLOY_HOOK isn't set in the bot's environment.", 412);
    if (deploying) throw userError("A deploy was just started.", 409);
    deploying = true;
    try {
        const sent = new Set((getData().deploy?.pending || []).map((item) => item.sha));
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
        client?.log?.("SYSTEM", `🚀 Owner deployed the website (${sent.size} dex change${sent.size === 1 ? "" : "s"})`);
        return status();
    } finally {
        deploying = false;
    }
}

module.exports = { setClient, enabled, commitMessage, record, status, trigger };
