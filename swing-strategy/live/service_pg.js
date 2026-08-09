'use strict';

/**
 * Long-running wrapper around trimmed_runner.js. Fires exactly once per
 * calendar day inside a 19:00-19:10 IST window (7 pm, well after market close
 * so the daily bar is final / intraday-synthesizable). Mirrors server.js's
 * self-scheduling design; deliberately does NOT run on startup so a Railway
 * redeploy is a no-op rather than a re-run.
 *
 * Set RUN_ONCE=1 to run immediately and exit (local testing / manual verify).
 */

const { runOnce } = require('./trimmed_runner');

const IST_OFFSET_MIN = 5 * 60 + 30;
const TRIGGER_START_MIN = 19 * 60;      // 19:00 IST
const TRIGGER_END_MIN = 19 * 60 + 10;   // 19:10 IST
const POLL_MS = 60 * 1000;

function istMinutesAndDate() {
  const ist = new Date(Date.now() + IST_OFFSET_MIN * 60 * 1000);
  return { minutesOfDay: ist.getUTCHours() * 60 + ist.getUTCMinutes(), dateStr: ist.toISOString().slice(0, 10) };
}

async function loop() {
  let lastRunDate = null;
  console.log('Swing strategy (trimmed) service: waiting for the next 19:00-19:10 IST window...');
  while (true) {
    const { minutesOfDay, dateStr } = istMinutesAndDate();
    if (minutesOfDay >= TRIGGER_START_MIN && minutesOfDay < TRIGGER_END_MIN && lastRunDate !== dateStr) {
      lastRunDate = dateStr;
      try { await runOnce(); } catch (e) { console.error('Run failed:', e); }
      console.log("Waiting for tomorrow's 19:00 IST window...");
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

if (process.env.RUN_ONCE === '1') {
  runOnce().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
} else {
  loop();
}
