'use strict';

/**
 * Local trade-log read/write + dedup, mirroring DarvasBox's trade_log.js
 * eventKey convention. GitHub sync/push is handled separately by
 * git_state.js (this file only touches the on-disk copy) since this
 * service bundles the trade log together with tracked_williams_r.json in
 * ONE commit per push, unlike DarvasBox's single-file push.
 */

const fs = require('fs');
const path = require('path');

const LOCAL_PATH = path.join(__dirname, 'williams_r_trade_log.json');

/** Identifies a specific real ENTRY/EXIT event, independent of when it was recorded -- same reasoning as DarvasBox's trade_log.js: a restart replaying the same bars must not re-alert something that already happened. */
function eventKey(e) {
  return e.type === 'ENTRY'
    ? ['ENTRY', e.symbol, e.direction, e.entry, e.timestampMs].join('|')
    : ['EXIT', e.symbol, e.direction, e.entry, e.exitPrice, e.action, e.entryTimestampMs, e.exitTimestampMs].join('|');
}

/** Fails safe rather than crashing on empty/corrupt local content. */
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
function recordTrade(event) {
  const log = readLocalLog();
  const key = eventKey(event);
  if (log.some((e) => eventKey(e) === key)) {
    console.log(`Skipping duplicate trade-log entry for ${event.symbol} (${event.type}) -- already recorded, likely a post-restart bar replay.`);
    return false;
  }
  log.push(event);
  fs.writeFileSync(LOCAL_PATH, JSON.stringify(log, null, 1));
  return true;
}

module.exports = { readLocalLog, isDuplicateEvent, recordTrade, eventKey, LOCAL_PATH };
