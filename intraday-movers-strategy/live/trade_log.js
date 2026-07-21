'use strict';

/**
 * Persistent, append-only log of completed ORB trades — one record per
 * trade, carrying both the entry-time order-book imbalance (tbq/tsq, see
 * orb_engine.js) and the eventual outcome (action, pnlPct), so evaluating
 * whether the imbalance predicts anything is a five-minute read of one
 * file instead of manually cross-referencing Telegram chat history.
 *
 * Pushed to a DEDICATED DATA BRANCH (see DATA_BRANCH below), never `main`.
 * Real incident, 2026-07-21: this used to push straight to `main` once a
 * day after close. Every push to `main` redeploys every Railway service
 * in this repo (confirmed via `railway status --json`: this service
 * watches `main` with empty watchPatterns, i.e. ANY change anywhere in
 * the repo triggers a redeploy, not just changes under this service's
 * root directory). At 15:35:00 IST that day, the unrelated
 * announcement-trading system pushed its own `trades.csv` update to
 * `main` — which redeployed orb-live-streamer 4 seconds later, killing
 * the instance that had been running the whole session, right before its
 * own scheduled EOD push could fire. That day's entire trade history
 * (25 real trades) was lost from this log — recovered only by manually
 * reconstructing from Telegram alert text.
 *
 * Fix: commit to DATA_BRANCH instead of `main`, so this log's own writes
 * (and everyone else's unrelated pushes to `main`) can never race with or
 * kill this service. Once decoupled from the deploy trigger, there's no
 * more reason to batch to once/day either — recordExitAndPush() below
 * pushes after every completed trade, so at most one trade is ever at
 * risk (a crash between recordTrade() and the push completing), not an
 * entire session.
 */

const fs = require('fs');
const path = require('path');

const REPO_OWNER = 'rizwandil6';
const REPO_NAME = 'nse-whatsapp-alerts';
const REPO_REL_PATH = 'intraday-movers-strategy/live/orb_trade_log.json';
const DATA_BRANCH = 'data/orb-trade-log'; // dedicated, non-deploy-triggering branch — see docstring above
const SOURCE_BRANCH = 'main'; // only used to seed DATA_BRANCH if it doesn't exist yet
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

async function getRemoteFile(token, branch) {
  const url = `${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${REPO_REL_PATH}?ref=${branch}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET trade log failed: HTTP ${res.status} — ${await res.text()}`);
  const body = await res.json();
  return { content: Buffer.from(body.content, 'base64').toString('utf8'), sha: body.sha };
}

/** Creates DATA_BRANCH pointing at SOURCE_BRANCH's current HEAD, if it doesn't already exist. Idempotent. */
async function ensureDataBranchExists(token) {
  const refUrl = `${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/git/ref/heads/${DATA_BRANCH}`;
  const existing = await fetch(refUrl, { headers: authHeaders(token) });
  if (existing.status === 200) return;
  if (existing.status !== 404) {
    throw new Error(`Checking ${DATA_BRANCH} failed: HTTP ${existing.status} — ${await existing.text()}`);
  }

  const sourceRefUrl = `${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/git/ref/heads/${SOURCE_BRANCH}`;
  const sourceRes = await fetch(sourceRefUrl, { headers: authHeaders(token) });
  if (!sourceRes.ok) throw new Error(`Reading ${SOURCE_BRANCH} ref failed: HTTP ${sourceRes.status} — ${await sourceRes.text()}`);
  const sourceRef = await sourceRes.json();

  const createUrl = `${GITHUB_API}/repos/${REPO_OWNER}/${REPO_NAME}/git/refs`;
  const createRes = await fetch(createUrl, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${DATA_BRANCH}`, sha: sourceRef.object.sha }),
  });
  if (!createRes.ok) throw new Error(`Creating ${DATA_BRANCH} failed: HTTP ${createRes.status} — ${await createRes.text()}`);
  console.log(`Created ${DATA_BRANCH} branch (seeded from ${SOURCE_BRANCH}).`);
}

/** Pulls the log down from GitHub to local disk at startup, so a mid-day restart doesn't lose earlier days' history. */
async function syncTradeLogFromRemote() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn('GITHUB_TOKEN not set — trade log will not sync from or push to GitHub, local only.');
    return { synced: false, reason: 'no_token' };
  }
  try {
    // Fall back to SOURCE_BRANCH if DATA_BRANCH doesn't exist yet (e.g. very first run after this fix) —
    // ensures a mid-day restart before the branch has been created still recovers prior history.
    let remote = await getRemoteFile(token, DATA_BRANCH).catch(() => null);
    if (!remote) remote = await getRemoteFile(token, SOURCE_BRANCH);
    if (remote) fs.writeFileSync(LOCAL_PATH, remote.content);
    console.log(`Synced ORB trade log from GitHub (${DATA_BRANCH}).`);
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

/** Pushes the local log to DATA_BRANCH as one commit, only if it actually changed since the last push. Never touches `main`. */
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
    await ensureDataBranchExists(token);
    const localContent = fs.readFileSync(LOCAL_PATH, 'utf8');
    const remote = await getRemoteFile(token, DATA_BRANCH);
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
        branch: DATA_BRANCH,
        ...(remote ? { sha: remote.sha } : {}),
      }),
    });
    if (!res.ok) throw new Error(`PUT trade log failed: HTTP ${res.status} — ${await res.text()}`);
    console.log(`Pushed ORB trade log to GitHub (${DATA_BRANCH}).`);
    return { pushed: true };
  } catch (e) {
    console.error('Trade log push failed:', e.message);
    return { pushed: false, reason: 'error', error: e.message };
  }
}

/**
 * Records one completed trade and pushes immediately — safe to call after
 * every exit now that pushes target DATA_BRANCH instead of `main` (see
 * docstring at top of file for why this used to be batched to once/day).
 * Failures are logged, not thrown: a push failure must never crash the
 * live streamer or block the next trade from being recorded locally.
 */
async function recordExitAndPush(exitEvent, dateLabel) {
  recordTrade(exitEvent);
  const result = await pushTradeLogToGitHub(dateLabel);
  if (!result.pushed && result.reason === 'error') {
    console.error(`Trade log push failed after recording ${exitEvent.symbol} — will retry on the next push (immediate or daily fallback).`);
  }
  return result;
}

module.exports = { syncTradeLogFromRemote, recordTrade, pushTradeLogToGitHub, recordExitAndPush };
