'use strict';

/**
 * Persistent log for the dual-filter shadow experiment (see
 * shadow_dual_filter_tracker.js's module docstring for the full design
 * rationale). Deliberately its OWN branch and file, completely separate
 * from trade_log.js's real trade log -- this experiment must be
 * structurally incapable of contaminating real trade data, the dashboard,
 * or any live metric, even if this module has a bug.
 *
 * Same dedup-by-event-key discipline as trade_log.js (a restart replays
 * today's bricks from scratch, and this tracker's own pending-confirmation
 * scan is deterministic against a given bricks array, so a restart would
 * re-derive the same shadow events without this).
 */

const fs = require('fs');
const path = require('path');
const { getRemoteFile, ensureBranchExists, putFile } = require('./github_contents');

const REPO_REL_PATH = 'renko-8-indicators/live-darvasbox-shadow/darvasbox_shadow_dual_filter_experiment_log.json';
const DATA_BRANCH = 'data/darvasbox-shadow-dual-filter-experiment';
const LOCAL_PATH = path.join(__dirname, 'darvasbox_shadow_dual_filter_experiment_log.json');

async function syncFromRemote() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) { console.warn('GITHUB_TOKEN not set — shadow experiment log local-only.'); return; }
  try {
    const remote = await getRemoteFile(token, REPO_REL_PATH, DATA_BRANCH).catch(() => null);
    if (remote) fs.writeFileSync(LOCAL_PATH, remote.content);
    console.log(`Synced shadow dual-filter experiment log from GitHub (${DATA_BRANCH}).`);
  } catch (e) {
    console.error('Shadow experiment log sync failed, proceeding with on-disk log as-is:', e.message);
  }
}

// Price is deliberately excluded from the key -- same reasoning as trade_log.js's
// eventKey fix (2026-07-31): a restart's brick replay could in principle re-derive
// a shadow event with a slightly different price, and that must still count as
// "already recorded", not a new event.
function eventKey(e) {
  return e.type === 'ENTRY'
    ? ['ENTRY', e.symbol, e.direction, e.timestampMs].join('|')
    : ['EXIT', e.symbol, e.direction, e.action, e.entryTimestampMs, e.exitTimestampMs].join('|');
}

function readLocalLog() {
  if (!fs.existsSync(LOCAL_PATH)) return [];
  const raw = fs.readFileSync(LOCAL_PATH, 'utf8');
  if (!raw.trim()) return [];
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`Shadow experiment log at ${LOCAL_PATH} is corrupt/unparseable (${e.message}) -- treating as empty.`);
    return [];
  }
}

function recordShadowEvent(event) {
  const log = readLocalLog();
  const key = eventKey(event);
  if (log.some((e) => eventKey(e) === key)) return false;
  log.push(event);
  fs.writeFileSync(LOCAL_PATH, JSON.stringify(log, null, 1));
  return true;
}

let pushChain = Promise.resolve();

function pushToGitHub(dateLabel) {
  const run = () => doPush(dateLabel);
  pushChain = pushChain.then(run, run);
  return pushChain;
}

async function doPush(dateLabel) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return { pushed: false, reason: 'no_token' };
  if (!fs.existsSync(LOCAL_PATH)) return { pushed: false, reason: 'no_file' };
  try {
    await ensureBranchExists(token, DATA_BRANCH);
    const localContent = fs.readFileSync(LOCAL_PATH, 'utf8');
    const remote = await getRemoteFile(token, REPO_REL_PATH, DATA_BRANCH);
    if (remote && remote.content === localContent) return { pushed: false, reason: 'no_changes' };
    await putFile(token, REPO_REL_PATH, DATA_BRANCH, localContent, `Shadow dual-filter experiment log update (${dateLabel})`, remote ? remote.sha : undefined);
    console.log(`Pushed shadow dual-filter experiment log to GitHub (${DATA_BRANCH}).`);
    return { pushed: true };
  } catch (e) {
    console.error('Shadow experiment log push failed:', e.message);
    return { pushed: false, reason: 'error', error: e.message };
  }
}

async function recordAndPush(event, dateLabel) {
  const added = recordShadowEvent(event);
  if (!added) return { pushed: false, reason: 'duplicate' };
  return pushToGitHub(dateLabel).catch((e) => console.error('shadow_log recordAndPush threw:', e.message));
}

module.exports = { syncFromRemote, recordAndPush };
