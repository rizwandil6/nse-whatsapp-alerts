'use strict';

/**
 * Local read/write of tracked_williams_r.json -- per-symbol
 * WilliamsRLiveTracker state (position, watch flags, streaks,
 * lastProcessedTimestampMs). Unlike DarvasBox (which rebuilds its tracker
 * fresh every trading day and never needs to persist it), this strategy's
 * positions can span multiple days with no forced EOD close, so the
 * CURRENT open position and in-progress watch state must survive a
 * restart -- this is the file that makes that possible. GitHub sync/push
 * is handled by git_state.js; this file only touches the on-disk copy.
 */

const fs = require('fs');
const path = require('path');

const LOCAL_PATH = path.join(__dirname, 'tracked_williams_r.json');

/** Fails safe rather than crashing on empty/corrupt local content -- treated as "cold start for every symbol", same philosophy as trade_log.js. */
function readTrackedState() {
  if (!fs.existsSync(LOCAL_PATH)) return {};
  const raw = fs.readFileSync(LOCAL_PATH, 'utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`Tracked state at ${LOCAL_PATH} is corrupt/unparseable (${e.message}) -- treating as empty (cold start for every symbol) rather than crashing. Investigate if this recurs.`);
    return {};
  }
}

function writeTrackedState(stateBySymbol) {
  fs.writeFileSync(LOCAL_PATH, JSON.stringify(stateBySymbol, null, 1));
}

module.exports = { readTrackedState, writeTrackedState, LOCAL_PATH };
