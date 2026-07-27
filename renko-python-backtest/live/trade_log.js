'use strict';

/**
 * Persistent trade log for this Renko combo-grid live forward test, pushed
 * to a dedicated GitHub branch (never `main`) after every completed trade.
 * Same pattern as renko-8-indicators/live/trade_log.js (DarvasBox), for the
 * identical reason: any push to `main` redeploys EVERY Railway service in
 * this monorepo, so a strategy's own trade-log commits must never land
 * there.
 */

const fs = require('fs');
const path = require('path');
const { getRemoteFile, ensureBranchExists, putFile } = require('./github_contents');

const REPO_REL_PATH = 'renko-python-backtest/live/renko_live_paper_trade_log.json';
const DATA_BRANCH = 'data/renko-live-paper-trade-log';
const LOCAL_PATH = path.join(__dirname, 'renko_live_paper_trade_log.json');

async function syncFromRemote() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) { console.warn('GITHUB_TOKEN not set — trade log local-only.'); return; }
  try {
    const remote = await getRemoteFile(token, REPO_REL_PATH, DATA_BRANCH).catch(() => null);
    if (remote) fs.writeFileSync(LOCAL_PATH, remote.content);
    console.log(`Synced Renko live paper trade log from GitHub (${DATA_BRANCH}).`);
  } catch (e) {
    console.error('Trade log sync failed, proceeding with on-disk log as-is:', e.message);
  }
}

/**
 * Identifies a specific real ENTRY/EXIT event, independent of when it was
 * recorded. Brick reconstruction is deterministic (see renko_engine.js), so
 * a restart mid-day replays the same bricks and re-derives the same events
 * for trades that already happened and were logged before the restart --
 * same class of bug DarvasBox hit live (two redeploys duplicating early
 * trades in the log).
 *
 * Includes comboId (not brickPct) since 9 of the 36 combos share a
 * brick_pct -- brickPct alone isn't a strong enough disambiguator here;
 * comboId already uniquely encodes brick_pct+entry_confirm_n+sl_rejection_n
 * so it's sufficient on its own.
 */
function eventKey(e) {
  return e.type === 'ENTRY'
    ? ['ENTRY', e.symbol, e.direction, e.entry, e.timestampMs, e.comboId].join('|')
    : ['EXIT', e.symbol, e.direction, e.entry, e.exitPrice, e.action, e.entryTimestampMs, e.exitTimestampMs, e.comboId].join('|');
}

/**
 * Fails safe rather than crashing on empty/corrupt local content -- this
 * DID happen in production (2026-07-27: a >1MB remote file silently came
 * back empty from the Contents API, see github_contents.js's fix) and
 * crashed the whole process on the very next JSON.parse, which then
 * crash-looped since every restart re-synced the same bad content. If
 * this still fires after that fix, something else is wrong -- the loud
 * console.error is intentional, not swallowed.
 */
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
    console.log(`Skipping duplicate trade-log entry for ${exitEvent.symbol} combo ${exitEvent.comboId} (${exitEvent.type}${exitEvent.action ? ', ' + exitEvent.action : ''}) -- already recorded, likely a post-restart brick replay.`);
    return false;
  }
  log.push(exitEvent);
  fs.writeFileSync(LOCAL_PATH, JSON.stringify(log, null, 1));
  return true;
}

// Serializes every push -- a burst of near-simultaneous trades (e.g. many
// combos whose inherited run-length from seeded history already satisfies
// their entry_confirm_n on the very first live brick, all firing ENTRY in
// the same synchronous dispatch loop) previously raced on branch creation
// and stale-SHA writes to the same file (confirmed live: many "Reference
// already exists"/"Reference update failed" errors from concurrent
// ensureBranchExists + PUT calls). recordTrade() itself is safe (sync
// fs read/write, so local writes from a tight loop are never lost) --
// only the async GitHub push needed serializing. Chaining onto
// pushChain (rather than skipping when one is already in flight) means
// every call still gets ITS OWN fresh read-of-local-file when its turn
// comes, so no distinct trade's data is ever dropped from the eventual
// push -- unlike state_store.js's checkpoint debounce, missing a trade
// push isn't recoverable by "the next periodic tick," so skip-if-busy
// isn't safe here.
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
    await putFile(token, REPO_REL_PATH, DATA_BRANCH, localContent, `Renko live paper trade log update (${dateLabel})`, remote ? remote.sha : undefined);
    console.log(`Pushed Renko live paper trade log to GitHub (${DATA_BRANCH}).`);
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

module.exports = { syncFromRemote, recordAndPush, isDuplicateEvent };
