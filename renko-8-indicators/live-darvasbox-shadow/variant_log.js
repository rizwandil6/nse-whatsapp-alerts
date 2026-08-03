'use strict';

/**
 * Persistent log for the A/B variant experiment (see variant_tracker.js's
 * module docstring). Its OWN branch and file, completely separate from
 * trade_log.js (real) and shadow_log.js (dual-filter experiment) -- this
 * experiment must be structurally incapable of contaminating real trade data,
 * the dashboard, or the dual-filter shadow, even with a bug here.
 *
 * Same dedup-by-event-key discipline as trade_log.js/shadow_log.js. Price is
 * excluded from the key so a restart's brick replay re-deriving an event at a
 * slightly different live price still counts as "already recorded".
 */

const fs = require('fs');
const path = require('path');
const { getRemoteFile, ensureBranchExists, putFile } = require('./github_contents');
const { serialize } = require('./github_push_queue');

const REPO_REL_PATH = 'renko-8-indicators/live-darvasbox-shadow/darvasbox_variant_antichase_eodstop_log.json';
const DATA_BRANCH = 'data/darvasbox-variant-antichase-eodstop';
const LOCAL_PATH = path.join(__dirname, 'darvasbox_variant_antichase_eodstop_log.json');

async function syncFromRemote() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) { console.warn('GITHUB_TOKEN not set — variant experiment log local-only.'); return; }
  try {
    const remote = await getRemoteFile(token, REPO_REL_PATH, DATA_BRANCH).catch(() => null);
    if (remote) fs.writeFileSync(LOCAL_PATH, remote.content);
    console.log(`Synced variant experiment log from GitHub (${DATA_BRANCH}).`);
  } catch (e) {
    console.error('Variant experiment log sync failed, proceeding with on-disk log as-is:', e.message);
  }
}

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
    console.error(`Variant experiment log at ${LOCAL_PATH} is corrupt/unparseable (${e.message}) -- treating as empty.`);
    return [];
  }
}

function recordVariantEvent(event) {
  const log = readLocalLog();
  const key = eventKey(event);
  if (log.some((e) => eventKey(e) === key)) return false;
  log.push(event);
  fs.writeFileSync(LOCAL_PATH, JSON.stringify(log, null, 1));
  return true;
}

// Pushed through the SHARED per-branch queue (github_push_queue.js), not a local
// pushChain -- variant_tracked_state.js shares this DATA_BRANCH, and a local-only
// chain here couldn't stop this push from racing against that one (same class of
// bug confirmed live 2026-08-03 on trade_log.js/tracked_state.js's shared branch).
function pushToGitHub(dateLabel) {
  return serialize(DATA_BRANCH, () => doPush(dateLabel));
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
    await putFile(token, REPO_REL_PATH, DATA_BRANCH, localContent, `Variant experiment log update (${dateLabel})`, remote ? remote.sha : undefined);
    console.log(`Pushed variant experiment log to GitHub (${DATA_BRANCH}).`);
    return { pushed: true };
  } catch (e) {
    console.error('Variant experiment log push failed:', e.message);
    return { pushed: false, reason: 'error', error: e.message };
  }
}

async function recordAndPush(event, dateLabel) {
  const added = recordVariantEvent(event);
  if (!added) return { pushed: false, reason: 'duplicate' };
  return pushToGitHub(dateLabel).catch((e) => console.error('variant_log recordAndPush threw:', e.message));
}

module.exports = { syncFromRemote, recordAndPush };
