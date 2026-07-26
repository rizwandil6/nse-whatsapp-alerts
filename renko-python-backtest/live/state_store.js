'use strict';

/**
 * Checkpoints the small per-lane state (DynamicRenkoBuilder + ComboTracker
 * snapshots, see renko_engine.js/combo_signal_engine.js's toJSON()) to a
 * dedicated GitHub branch, loaded FIRST on startup before falling back to
 * the much more expensive seed_data + historical_gap_fill path.
 *
 * Why this exists: without it, every Railway redeploy would have to
 * re-seed months of history through 23 symbols x 4 brick builders before
 * the service is live again -- a real risk of missing a market open, not
 * just a performance nit. Because the resumable state is O(1) per lane
 * (see renko_engine.js's docstring), the whole checkpoint for all 23
 * symbols x 4 builders x 36 combo trackers is tiny (a few KB of JSON), so
 * pushing it is cheap -- but still debounced separately from trade_log.js's
 * pushes (which are already naturally rate-limited by real trade events),
 * since all 23x4 builders can advance near-simultaneously on every 5-min
 * bar close and would otherwise spam the GitHub Contents API.
 */

const fs = require('fs');
const path = require('path');
const { getRemoteFile, ensureBranchExists, putFile } = require('./github_contents');

const REPO_REL_PATH = 'renko-python-backtest/live/state_checkpoint.json';
const DATA_BRANCH = 'data/renko-live-state-checkpoint';
const LOCAL_PATH = path.join(__dirname, 'state_checkpoint.json');
const DEBOUNCE_MS = 90 * 1000; // don't push more often than this, regardless of how often save() is called

let lastPushedAtMs = 0;
let pushInFlight = false;

/** Pulls the checkpoint from GitHub into the local file (if present) and returns the parsed object, or null on true cold start. */
async function loadCheckpoint() {
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    try {
      const remote = await getRemoteFile(token, REPO_REL_PATH, DATA_BRANCH).catch(() => null);
      if (remote) fs.writeFileSync(LOCAL_PATH, remote.content);
    } catch (e) {
      console.error('State checkpoint sync failed, proceeding with on-disk checkpoint (if any):', e.message);
    }
  }
  if (!fs.existsSync(LOCAL_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(LOCAL_PATH, 'utf8'));
  } catch (e) {
    console.error('State checkpoint on disk is corrupt, ignoring it (cold start):', e.message);
    return null;
  }
}

/**
 * Writes the checkpoint locally every time (cheap), but only pushes to
 * GitHub if at least DEBOUNCE_MS has passed since the last push (unless
 * `force` is set -- used on a clean SIGTERM/SIGINT shutdown, where we want
 * the freshest possible state pushed regardless of the debounce window, so
 * the next restart's checkpoint restore is as current as possible).
 *
 * Returns a Promise that resolves once the push (if any) has actually
 * completed -- callers on a shutdown path MUST await this before calling
 * process.exit(), otherwise the async GitHub push gets killed mid-flight.
 * Callers on the periodic scheduleBarFlush tick can safely fire-and-forget
 * (the debounce makes frequent calls cheap either way).
 */
function saveCheckpoint(stateObj, force) {
  const content = JSON.stringify({ savedAtMs: Date.now(), state: stateObj }, null, 1);
  fs.writeFileSync(LOCAL_PATH, content);

  const token = process.env.GITHUB_TOKEN;
  if (!token || pushInFlight) return Promise.resolve();
  const now = Date.now();
  if (!force && now - lastPushedAtMs < DEBOUNCE_MS) return Promise.resolve();

  pushInFlight = true;
  lastPushedAtMs = now;
  return (async () => {
    try {
      await ensureBranchExists(token, DATA_BRANCH);
      const remote = await getRemoteFile(token, REPO_REL_PATH, DATA_BRANCH);
      if (remote && remote.content === content) return; // nothing changed since last push
      await putFile(token, REPO_REL_PATH, DATA_BRANCH, content, `State checkpoint (${new Date(now).toISOString()})`, remote ? remote.sha : undefined);
    } catch (e) {
      console.error('State checkpoint push failed:', e.message);
    } finally {
      pushInFlight = false;
    }
  })();
}

module.exports = { loadCheckpoint, saveCheckpoint };
