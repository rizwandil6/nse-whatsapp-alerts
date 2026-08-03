'use strict';

/**
 * Persists each symbol's DarvasLiveTracker.toJSON() (currently just
 * `position`) across restarts, on the SAME data branch as the trade log --
 * see darvas_tracker.js's toJSON docstring for the real incident this fixes
 * (a mid-day restart re-deriving an already-open position's entry price
 * from theoreticalEntry instead of the real LTP-confirmed entry, producing
 * a wrongly-priced duplicate EOD close). A symbol with no open position is
 * simply absent from the file (or has `position: null`) -- nothing to
 * restore for it, and the tracker starts fresh exactly as before this
 * change.
 */

const fs = require('fs');
const path = require('path');
const { getRemoteFile, ensureBranchExists, putFile } = require('./github_contents');
const { serialize } = require('./github_push_queue');

const REPO_REL_PATH = 'renko-8-indicators/live-darvasbox-shadow/tracked_darvasbox_shadow.json';
const DATA_BRANCH = 'data/darvasbox-shadow-0.25pct-1pctSL-trade-log'; // same branch trade_log.js already uses
const LOCAL_PATH = path.join(__dirname, 'tracked_darvasbox_shadow.json');

async function syncFromRemote() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) { console.warn('GITHUB_TOKEN not set — tracked state local-only.'); return; }
  try {
    const remote = await getRemoteFile(token, REPO_REL_PATH, DATA_BRANCH).catch(() => null);
    if (remote) fs.writeFileSync(LOCAL_PATH, remote.content);
    console.log(`Synced DarvasBox tracked state from GitHub (${DATA_BRANCH}).`);
  } catch (e) {
    console.error('Tracked state sync failed, proceeding with on-disk state as-is:', e.message);
  }
}

/** {} (not an error) if the file doesn't exist yet or is corrupt -- same fail-safe
 * philosophy as trade_log.js's readLocalLog. */
function loadTrackedState() {
  if (!fs.existsSync(LOCAL_PATH)) return {};
  const raw = fs.readFileSync(LOCAL_PATH, 'utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`Tracked state at ${LOCAL_PATH} is corrupt/unparseable (${e.message}) -- starting fresh rather than crashing.`);
    return {};
  }
}

/** trackers = the symbol -> DarvasLiveTracker map; writes/pushes the FULL current
 * snapshot every time (cheap -- one small JSON object per symbol, ~18 symbols total).
 * Pushed through the SHARED per-branch queue (github_push_queue.js), not a local
 * pushChain -- this shares DATA_BRANCH with trade_log.js, and a local-only chain
 * here couldn't stop trade_log.js's push from racing against this one (confirmed
 * live 2026-08-03: trade_log.js's push -- the dashboard's actual data source --
 * was losing that race almost every time). */
function saveAndPushTrackedState(trackers) {
  const state = {};
  for (const [symbol, tracker] of Object.entries(trackers)) {
    state[symbol] = tracker.toJSON();
  }
  fs.writeFileSync(LOCAL_PATH, JSON.stringify(state, null, 1));

  return serialize(DATA_BRANCH, () => doPush());
}

async function doPush() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return { pushed: false, reason: 'no_token' };
  if (!fs.existsSync(LOCAL_PATH)) return { pushed: false, reason: 'no_file' };
  try {
    await ensureBranchExists(token, DATA_BRANCH);
    const localContent = fs.readFileSync(LOCAL_PATH, 'utf8');
    const remote = await getRemoteFile(token, REPO_REL_PATH, DATA_BRANCH);
    if (remote && remote.content === localContent) return { pushed: false, reason: 'no_changes' };
    await putFile(token, REPO_REL_PATH, DATA_BRANCH, localContent, 'DarvasBox tracked state update', remote ? remote.sha : undefined);
    console.log(`Pushed DarvasBox tracked state to GitHub (${DATA_BRANCH}).`);
    return { pushed: true };
  } catch (e) {
    console.error('Tracked state push failed:', e.message);
    return { pushed: false, reason: 'error', error: e.message };
  }
}

module.exports = { syncFromRemote, loadTrackedState, saveAndPushTrackedState };
