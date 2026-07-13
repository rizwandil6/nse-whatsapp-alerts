'use strict';

/**
 * Long-running process wrapper around runner.js. Triggers exactly once per
 * calendar day, inside a 15:35-15:40 IST window (well after market close, so
 * today's Daily bar is final). Deliberately does NOT run immediately on
 * startup: a Railway redeploy (which happens for every push to main, even to
 * unrelated services — see project history) would otherwise risk re-sending
 * a duplicate "new signal" alert for whatever fired most recently. Gating to
 * a narrow daily time window makes ordinary restarts a no-op instead.
 *
 * Set RUN_ONCE=1 to run immediately and exit (for local testing / manual
 * verification) instead of entering the daily loop.
 */

const { runOnce } = require('./runner');

const IST_OFFSET_MIN = 5 * 60 + 30;
const TRIGGER_START_MIN = 15 * 60 + 35; // 15:35 IST
const TRIGGER_END_MIN = 15 * 60 + 40; // 15:40 IST
const POLL_MS = 60 * 1000;

function istMinutesAndDate() {
  const now = new Date();
  const istMs = now.getTime() + IST_OFFSET_MIN * 60 * 1000;
  const ist = new Date(istMs);
  const minutesOfDay = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const dateStr = ist.toISOString().slice(0, 10);
  return { minutesOfDay, dateStr };
}

async function loop() {
  let lastRunDate = null;
  console.log('Swing strategy live alerts: waiting for the next 15:35-15:40 IST window...');
  while (true) {
    const { minutesOfDay, dateStr } = istMinutesAndDate();
    if (minutesOfDay >= TRIGGER_START_MIN && minutesOfDay < TRIGGER_END_MIN && lastRunDate !== dateStr) {
      lastRunDate = dateStr;
      try {
        await runOnce();
      } catch (e) {
        console.error('Run failed:', e);
      }
      console.log('Waiting for tomorrow\'s window...');
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

if (process.env.RUN_ONCE === '1') {
  runOnce()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
} else {
  loop();
}
