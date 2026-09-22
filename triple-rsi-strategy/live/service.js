'use strict';

/**
 * Long-running wrapper around runner.js. Fires exactly once per calendar day
 * inside a 15:15-15:25 IST window -- moved earlier than NSE's 15:30 close
 * (2026-09-22 decision) specifically so entry/exit alerts land with enough
 * lead time for the user to place a market/limit order near today's close
 * (~15:29:59 IST), rather than the old post-close "AMO for tomorrow's open"
 * design. See runner.js for how today's not-yet-final candle is approximated
 * from live intraday data for this run's signal computation. Same self-
 * scheduling pattern as darvas-classic-strategy/live/service.js and
 * swing-strategy/live in this repo. Deliberately does NOT run on startup so
 * a Railway redeploy is a no-op rather than a re-run.
 *
 * Set RUN_ONCE=1 to run the daily scan immediately and exit (local testing /
 * manual verify).
 */

const { runOnce } = require('./runner');

const IST_OFFSET_MIN = 5 * 60 + 30;
const TRIGGER_START_MIN = 15 * 60 + 15;  // 15:15 IST
const TRIGGER_END_MIN = 15 * 60 + 25;    // 15:25 IST
const POLL_MS = 60 * 1000;

function istMinutesAndDate() {
  const ist = new Date(Date.now() + IST_OFFSET_MIN * 60 * 1000);
  return { minutesOfDay: ist.getUTCHours() * 60 + ist.getUTCMinutes(), dateStr: ist.toISOString().slice(0, 10) };
}

async function loop() {
  let lastRunDate = null;
  console.log('Triple RSI service: waiting for the next 15:15-15:25 IST window...');
  while (true) {
    const { minutesOfDay, dateStr } = istMinutesAndDate();
    if (minutesOfDay >= TRIGGER_START_MIN && minutesOfDay < TRIGGER_END_MIN && lastRunDate !== dateStr) {
      lastRunDate = dateStr;
      try { await runOnce(); } catch (e) { console.error('Run failed:', e); }
      console.log("Waiting for tomorrow's 15:15 IST window...");
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

if (process.env.RUN_ONCE === '1') {
  runOnce().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
} else {
  loop();
}
