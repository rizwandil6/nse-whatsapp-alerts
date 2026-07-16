'use strict';

/**
 * Persistent, append-only log of completed ORB trades — one record per
 * trade, carrying both the entry-time order-book imbalance (tbq/tsq, see
 * orb_engine.js) and the eventual outcome (action, pnlPct), so evaluating
 * whether the imbalance predicts anything is a five-minute read of one
 * file instead of manually cross-referencing Telegram chat history.
 *
 * Pushed to GitHub ONCE PER DAY (after market close), not on every trade.
 * Every push to `main` redeploys every Railway service in this repo
 * (including reactivating explicitly-paused ones) — pushing per-trade
 * during market hours would cause several redeploy cycles a day and wipe
 * this same service's own in-memory ORBSymbolTracker state mid-session
 * (the exact bug that motivated the "only deploy outside market hours"
 * rule in the first place). Batching to one push after close avoids that
 * entirely, same reasoning as multibagger-screener's daily batch design.
 */

const fs = require('fs');
const path = require('path');

const REPO_OWNER = 'rizwandil6';
const REPO_NAME = 'nse-whatsapp-alerts';
const REPO_REL_PATH = 'intraday-movers-strategy/live/orb_trade_log.json';
const BRANCH = 'main';
const GITHUB_API = 'https://api.github.com';
const LOCAL_PATH = path.join(__dirname, 'orb_trade_log.json');

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'orb-live-streamer',
  };
}

async function getRemoteFile(token) {
  const url = `${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${REPO_REL_PATH}?ref=${BRANCH}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET trade log failed: HTTP ${res.status} — ${await res.text()}`);
  const body = await res.json();
  return { content: Buffer.from(body.content, 'base64').toString('utf8'), sha: body.sha };
}

/** Pulls the log down from GitHub to local disk at startup, so a mid-day restart doesn't lose earlier days' history. */
async function syncTradeLogFromRemote() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn('GITHUB_TOKEN not set — trade log will not sync from or push to GitHub, local only.');
    return { synced: false, reason: 'no_token' };
  }
  try {
    const remote = await getRemoteFile(token);
    if (remote) fs.writeFileSync(LOCAL_PATH, remote.content);
    console.log('Synced ORB trade log from GitHub.');
    return { synced: true };
  } catch (e) {
    console.error('Trade log sync failed — proceeding with on-disk log as-is:', e.message);
    return { synced: false, reason: 'error', error: e.message };
  }
}

/** Appends one completed trade to the local log immediately (cheap, no network). */
function recordTrade(exitEvent) {
  const log = fs.existsSync(LOCAL_PATH) ? JSON.parse(fs.readFileSync(LOCAL_PATH, 'utf8')) : [];
  log.push({
    symbol: exitEvent.symbol,
    direction: exitEvent.direction,
    entry: exitEvent.entry,
    stop: exitEvent.stop,
    tbq: exitEvent.tbq ?? null,
    tsq: exitEvent.tsq ?? null,
    obImbalance: exitEvent.obImbalance ?? null,
    action: exitEvent.action,
    exitPrice: exitEvent.exitPrice,
    pnlPct: exitEvent.pnlPct,
    entryTimestampMs: exitEvent.entryTimestampMs ?? null,
    exitTimestampMs: exitEvent.exitTimestampMs ?? null,
  });
  fs.writeFileSync(LOCAL_PATH, JSON.stringify(log, null, 1));
}

/** Pushes the local log to GitHub as one commit, only if it actually changed since the last push. */
async function pushTradeLogToGitHub(dateLabel) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn('GITHUB_TOKEN not set — skipping trade log push. Today\'s entries are local-only and will NOT survive a restart.');
    return { pushed: false, reason: 'no_token' };
  }
  if (!fs.existsSync(LOCAL_PATH)) {
    console.log('No trade log file yet — nothing to push.');
    return { pushed: false, reason: 'no_file' };
  }
  try {
    const localContent = fs.readFileSync(LOCAL_PATH, 'utf8');
    const remote = await getRemoteFile(token);
    if (remote && remote.content === localContent) {
      console.log('Trade log unchanged since last push — nothing to commit.');
      return { pushed: false, reason: 'no_changes' };
    }
    const res = await fetch(`${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${REPO_REL_PATH}`, {
      method: 'PUT',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `ORB trade log update (${dateLabel})`,
        content: Buffer.from(localContent, 'utf8').toString('base64'),
        branch: BRANCH,
        ...(remote ? { sha: remote.sha } : {}),
      }),
    });
    if (!res.ok) throw new Error(`PUT trade log failed: HTTP ${res.status} — ${await res.text()}`);
    console.log('Pushed ORB trade log to GitHub.');
    return { pushed: true };
  } catch (e) {
    console.error('Trade log push failed:', e.message);
    return { pushed: false, reason: 'error', error: e.message };
  }
}

module.exports = { syncTradeLogFromRemote, recordTrade, pushTradeLogToGitHub };
