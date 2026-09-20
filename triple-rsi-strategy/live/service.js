'use strict';

/**
 * Long-running wrapper around runner.js. Fires exactly once per calendar day
 * inside a 16:00-16:10 IST window (well after NSE's 15:30 close so the
 * day's daily bar is settled). Same self-scheduling pattern as
 * darvas-classic-strategy/live/service.js and swing-strategy/live in this
 * repo. Deliberately does NOT run on startup so a Railway redeploy is a
 * no-op rather than a re-run.
 *
 * Set RUN_ONCE=1 to run the daily scan immediately and exit (local testing /
 * manual verify).
 */

const { runOnce } = require('./runner');

const IST_OFFSET_MIN = 5 * 60 + 30;
const TRIGGER_START_MIN = 16 * 60;      // 16:00 IST
const TRIGGER_END_MIN = 16 * 60 + 10;   // 16:10 IST
const POLL_MS = 60 * 1000;

function istMinutesAndDate() {
  const ist = new Date(Date.now() + IST_OFFSET_MIN * 60 * 1000);
  return { minutesOfDay: ist.getUTCHours() * 60 + ist.getUTCMinutes(), dateStr: ist.toISOString().slice(0, 10) };
}

async function loop() {
  let lastRunDate = null;
  console.log('Triple RSI service: waiting for the next 16:00-16:10 IST window...');
  while (true) {
    const { minutesOfDay, dateStr } = istMinutesAndDate();
    if (minutesOfDay >= TRIGGER_START_MIN && minutesOfDay < TRIGGER_END_MIN && lastRunDate !== dateStr) {
      lastRunDate = dateStr;
      try { await runOnce(); } catch (e) { console.error('Run failed:', e); }
      console.log("Waiting for tomorrow's 16:00 IST window...");
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

if (process.env.RUN_ONCE === '1') {
  runOnce().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
} else {
  loop();
}
