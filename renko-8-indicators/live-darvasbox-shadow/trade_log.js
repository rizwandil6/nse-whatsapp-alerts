'use strict';

/**
 * Persistent trade log for the 0.25%-brick / flat-1%-stop / LTP-confirmed
 * DarvasBox shadow trade, pushed to a dedicated GitHub branch (never
 * `main`) after every completed trade -- same reasoning as every other
 * live/ strategy in this repo: a push to `main` redeploys every Railway
 * service, so a strategy's own trade-log commits must never land there.
 *
 * Built with two fixes from day one, both learned tonight the hard way on
 * the sibling renko-python-backtest/live/ service:
 *   1. getRemoteFile (github_contents.js) falls back to
 *      raw.githubusercontent.com once the log exceeds the Contents API's
 *      ~1MB inline-content limit, instead of silently treating a large
 *      file as empty.
 *   2. readLocalLog() fails safe (logs loudly, returns []) instead of
 *      crashing on corrupt/empty local content -- defense in depth in case
 *      (1) is ever bypassed some other way.
 */

const fs = require('fs');
const path = require('path');
const { getRemoteFile, ensureBranchExists, putFile } = require('./github_contents');
const { serialize } = require('./github_push_queue');

const REPO_REL_PATH = 'renko-8-indicators/live-darvasbox-shadow/darvasbox_shadow_trade_log.json';
const DATA_BRANCH = 'data/darvasbox-shadow-0.25pct-1pctSL-trade-log';
const LOCAL_PATH = path.join(__dirname, 'darvasbox_shadow_trade_log.json');

async function syncFromRemote() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) { console.warn('GITHUB_TOKEN not set — trade log local-only.'); return; }
  try {
    const remote = await getRemoteFile(token, REPO_REL_PATH, DATA_BRANCH).catch(() => null);
    if (remote) fs.writeFileSync(LOCAL_PATH, remote.content);
    console.log(`Synced DarvasBox shadow trade log from GitHub (${DATA_BRANCH}).`);
  } catch (e) {
    console.error('Trade log sync failed, proceeding with on-disk log as-is:', e.message);
  }
}

/**
 * Identifies a specific real ENTRY/EXIT event, independent of when it was
 * recorded. Renko brick reconstruction is deterministic, so a restart
 * mid-day replays the same bricks and re-derives the same events for
 * trades that already happened and were already logged -- same class of
 * bug as DarvasBox's original live tracker hit (two redeploys duplicating
 * early trades). Single brick size / single stop level here (no combo grid
 * to disambiguate), so the key is simpler than the N/K-grid or
 * multi-brick-size forward test's.
 *
 * Deliberately does NOT include entry/exit PRICE (fixed 2026-07-31, real
 * incident): a backfill replay's live-price availability at the moment of
 * reprocessing isn't guaranteed to match the original live pass (the
 * WebSocket hasn't connected yet during startupBackfillIfNeeded, so
 * _liveOrTheoretical always falls back to theoreticalEntry then) --
 * confirmed live across TWO separate incidents (2026-07-28's TRAILING_BOX_
 * STOP-era duplicates, and 2026-07-31's EMA-cross-era ones) where a replay
 * re-derived a DIFFERENT price for an already-recorded trade, and the old
 * price-inclusive key treated it as a brand-new event instead of a
 * duplicate. The brick timestamp(s) alone already uniquely identify a
 * specific trade -- price was never actually needed for that.
 */
function eventKey(e) {
  return e.type === 'ENTRY'
    ? ['ENTRY', e.symbol, e.direction, e.timestampMs].join('|')
    : ['EXIT', e.symbol, e.direction, e.action, e.entryTimestampMs, e.exitTimestampMs].join('|');
}

/** Fails safe rather than crashing on empty/corrupt local content -- see module docstring. */
function readLocalLog() {
  if (!fs.existsSync(LOCAL_PATH)) return [];
  const raw = fs.readFileSync(LOCAL_PATH, 'utf8');
  if (!raw.trim()) return [];
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`Trade log at ${LOCAL_PATH} is corrupt/unparseable (${e.message}) -- treating as empty rather than crashing. Investigate if this recurs.`);
    return [];
  }
}

/**
 * Rebuilds today's already-recorded EXIT events -- used at startup to
 * restore the in-memory running day-total (dayStats in streamer.js) after
 * any restart. Without this, a mid-day restart (redeploy, crash-recover,
 * a token update) would silently reset "day so far" to zero and could
 * even trigger a premature EOD summary showing 0 trades if positions
 * happened to all be flat at that exact moment. dateStr = IST calendar
 * date (bar_aggregator.js's istDateStr format), matched against each
 * EXIT's exitTimestampMs.
 */
function getTodaysExits(dateStr, istDateStrFn) {
  const log = readLocalLog();
  return log.filter((e) => e.type === 'EXIT' && istDateStrFn(e.exitTimestampMs) === dateStr);
}

/** Pre-check so callers can skip sending a Telegram alert entirely for a replayed event, not just skip persisting it. */
function isDuplicateEvent(event) {
  const log = readLocalLog();
  const key = eventKey(event);
  return log.some((e) => eventKey(e) === key);
}

/** Returns true if the event was newly appended, false if it was a duplicate (and therefore skipped). */
function recordTrade(exitEvent) {
  const log = readLocalLog();
  const key = eventKey(exitEvent);
  if (log.some((e) => eventKey(e) === key)) {
    console.log(`Skipping duplicate trade-log entry for ${exitEvent.symbol} (${exitEvent.type}${exitEvent.action ? ', ' + exitEvent.action : ''}) -- already recorded, likely a post-restart brick replay.`);
    return false;
  }
  log.push(exitEvent);
  fs.writeFileSync(LOCAL_PATH, JSON.stringify(log, null, 1));
  return true;
}

// Serializes every push through the SHARED per-branch queue (github_push_queue.js),
// not a local pushChain -- tracked_state.js pushes to this same DATA_BRANCH, and a
// local-only chain here couldn't stop this file's push from racing against that one
// (confirmed live 2026-08-03: this push was losing that race almost every time,
// failing with a stale-SHA 409 with no retry -- see github_push_queue.js).
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
    await putFile(token, REPO_REL_PATH, DATA_BRANCH, localContent, `DarvasBox shadow trade log update (${dateLabel})`, remote ? remote.sha : undefined);
    console.log(`Pushed DarvasBox shadow trade log to GitHub (${DATA_BRANCH}).`);
    return { pushed: true };
  } catch (e) {
    console.error('Trade log push failed:', e.message);
    return { pushed: false, reason: 'error', error: e.message };
  }
}

async function recordAndPush(exitEvent, dateLabel) {
  const added = recordTrade(exitEvent);
  if (!added) return { pushed: false, reason: 'duplicate' };
  return pushToGitHub(dateLabel).catch((e) => console.error('recordAndPush threw:', e.message));
}

module.exports = { syncFromRemote, recordAndPush, isDuplicateEvent, getTodaysExits, eventKey, recordTrade };
