'use strict';

/**
 * Long-running wrapper around runner.js. Fires exactly once per calendar day
 * inside a 17:00-17:10 IST window (well after market close so the day's
 * weekly-in-progress bar is settled). Mirrors swing-strategy/live/service_pg.js's
 * self-scheduling design; deliberately does NOT run on startup so a Railway
 * redeploy is a no-op rather than a re-run.
 *
 * Also starts intraday_watcher's market-hours polling loop alongside the
 * daily scan loop, in the same process -- it Telegram-alerts on a real-time
 * watchlist breakout (see that file's header).
 *
 * Set RUN_ONCE=1 to run the daily scan immediately and exit (local testing /
 * manual verify) -- skips the watchlist watcher in that mode.
 */

const { runOnce } = require('./runner');
const watchlistWatcher = require('./intraday_watcher');

const IST_OFFSET_MIN = 5 * 60 + 30;
const TRIGGER_START_MIN = 17 * 60;      // 17:00 IST
const TRIGGER_END_MIN = 17 * 60 + 10;   // 17:10 IST
const POLL_MS = 60 * 1000;

function istMinutesAndDate() {
  const ist = new Date(Date.now() + IST_OFFSET_MIN * 60 * 1000);
  return { minutesOfDay: ist.getUTCHours() * 60 + ist.getUTCMinutes(), dateStr: ist.toISOString().slice(0, 10) };
}

async function loop() {
  let lastRunDate = null;
  console.log('Darvas Classic (weekly) service: waiting for the next 17:00-17:10 IST window...');
  while (true) {
    const { minutesOfDay, dateStr } = istMinutesAndDate();
    if (minutesOfDay >= TRIGGER_START_MIN && minutesOfDay < TRIGGER_END_MIN && lastRunDate !== dateStr) {
      lastRunDate = dateStr;
      try { await runOnce(); } catch (e) { console.error('Run failed:', e); }
      console.log("Waiting for tomorrow's 17:00 IST window...");
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

if (process.env.RUN_ONCE === '1') {
  runOnce().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
} else {
  loop();
  watchlistWatcher.loop();
}
