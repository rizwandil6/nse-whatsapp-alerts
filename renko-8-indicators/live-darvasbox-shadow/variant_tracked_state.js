'use strict';

/**
 * Restart persistence for the A/B variant experiment (see variant_tracker.js).
 * Identical mechanism to tracked_state.js, but its OWN file on the variant's
 * OWN branch -- the variant fills entries at the live LTP, so a mid-day
 * restart must restore the open position rather than re-derive it from a
 * brick replay (which would re-price the entry). Structurally isolated from
 * the real tracker's state, same as variant_log.js is from the real log.
 *
 * State lives on a SEPARATE branch from the trade log (2026-08-03 fix): both
 * this module and variant_log.js push to GitHub fire-and-forget from
 * dispatchVariantEvent, and each Contents-API PUT is a commit against the
 * branch head. When both targeted ONE branch, two concurrent commits raced
 * and the loser 409'd -- observed live on the variant's first event (IRCON
 * LONG, 2026-08-03): the state push landed but the log push was dropped, so
 * the trade never reached the experiment log. Giving state its own branch
 * leaves the log branch with a single serialized writer (variant_log.js's
 * own pushChain), so a log push can never conflict and no event is lost.
 * (The real tracker tolerates the shared-branch race because its high event
 * volume self-heals via re-push; the A/B experiment can't afford a dropped
 * event, so it's separated here.)
 */

const fs = require('fs');
const path = require('path');
const { getRemoteFile, ensureBranchExists, putFile } = require('./github_contents');

const REPO_REL_PATH = 'renko-8-indicators/live-darvasbox-shadow/tracked_darvasbox_variant.json';
// Own branch, deliberately NOT the log's branch -- see module docstring.
const DATA_BRANCH = 'data/darvasbox-variant-antichase-eodstop-state';
const LOCAL_PATH = path.join(__dirname, 'tracked_darvasbox_variant.json');

async function syncFromRemote() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) { console.warn('GITHUB_TOKEN not set — variant tracked state local-only.'); return; }
  try {
    const remote = await getRemoteFile(token, REPO_REL_PATH, DATA_BRANCH).catch(() => null);
    if (remote) fs.writeFileSync(LOCAL_PATH, remote.content);
    console.log(`Synced variant tracked state from GitHub (${DATA_BRANCH}).`);
  } catch (e) {
    console.error('Variant tracked state sync failed, proceeding with on-disk state as-is:', e.message);
  }
}

function loadTrackedState() {
  if (!fs.existsSync(LOCAL_PATH)) return {};
  const raw = fs.readFileSync(LOCAL_PATH, 'utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`Variant tracked state at ${LOCAL_PATH} is corrupt/unparseable (${e.message}) -- starting fresh rather than crashing.`);
    return {};
  }
}

let pushChain = Promise.resolve();

function saveAndPushTrackedState(trackers) {
  const state = {};
  for (const [symbol, tracker] of Object.entries(trackers)) {
    state[symbol] = tracker.toJSON();
  }
  fs.writeFileSync(LOCAL_PATH, JSON.stringify(state, null, 1));
  const run = () => doPush();
  pushChain = pushChain.then(run, run);
  return pushChain;
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
    await putFile(token, REPO_REL_PATH, DATA_BRANCH, localContent, 'DarvasBox variant tracked state update', remote ? remote.sha : undefined);
    console.log(`Pushed variant tracked state to GitHub (${DATA_BRANCH}).`);
    return { pushed: true };
  } catch (e) {
    console.error('Variant tracked state push failed:', e.message);
    return { pushed: false, reason: 'error', error: e.message };
  }
}

module.exports = { syncFromRemote, loadTrackedState, saveAndPushTrackedState };
