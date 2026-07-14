'use strict';

/**
 * Long-running process for the daily-rolling multibagger screen. Redesigned
 * from an original once-a-month full-universe scan (too slow, too much
 * scraping load in one sitting) to ~100 stocks/day via a persisted cursor
 * position — the full ~2,052-stock universe cycles roughly every ~21 days,
 * giving continuous rolling freshness instead of one big monthly burst,
 * and each day's run only takes minutes rather than hours.
 *
 * RUN_ONCE=1 runs today's batch immediately and exits, for manual testing.
 */

const fs = require('fs');
const path = require('path');
const { loginToScreener } = require('./fundamental_screener');
const { runDailyBatch } = require('./scan_multibagger');
const { diffAndUpdate } = require('./diff_tracker');
const { formatNewCandidateAlert, formatLostQualificationAlert } = require('./format_alerts');
const { commitAndPushTrackedState, syncFromRemote } = require('./git_state');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS = ['5937539323', '-5338709046'];
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '100', 10);
const IST_OFFSET_MIN = 5 * 60 + 30;
const TRIGGER_START_MIN = 20 * 60; // 20:00 IST, well after market close, low-traffic hours for scraping
const TRIGGER_END_MIN = 20 * 60 + 30;
const POLL_MS = 10 * 60 * 1000; // check every 10 min — only needs to fire once/day

const UNIVERSE_PATH = path.join(__dirname, 'nse_universe.json');
const CURSOR_PATH = path.join(__dirname, 'scan_cursor.json');
const TRACKED_PATH = path.join(__dirname, 'tracked_multibaggers.json');
const LOG_PATH = path.join(__dirname, 'forward_performance_log.json');

async function sendTelegramAlert(text) {
  console.log('[ALERT]', text.replace(/\n/g, ' | '));
  if (!TELEGRAM_TOKEN) return;
  for (const chatId of TELEGRAM_CHAT_IDS) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      if (!res.ok) console.warn(`  Telegram send failed for chat ${chatId}: HTTP ${res.status}`);
    } catch (e) {
      console.warn(`  Telegram send error for chat ${chatId}: ${e.message}`);
    }
  }
}

function istMinutesAndDate() {
  const now = new Date();
  const ist = new Date(now.getTime() + IST_OFFSET_MIN * 60 * 1000);
  return {
    minutesOfDay: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
    dateStr: ist.toISOString().slice(0, 10),
  };
}

/** Picks the next BATCH_SIZE symbols starting at the persisted cursor, wrapping around the universe. */
function pickTodaysBatch() {
  const universe = Object.keys(JSON.parse(fs.readFileSync(UNIVERSE_PATH, 'utf8')));
  let cursor = 0;
  if (fs.existsSync(CURSOR_PATH)) {
    const saved = JSON.parse(fs.readFileSync(CURSOR_PATH, 'utf8'));
    if (typeof saved.cursor === 'number') cursor = saved.cursor % universe.length;
  }
  const batch = [];
  for (let i = 0; i < BATCH_SIZE && i < universe.length; i++) {
    batch.push(universe[(cursor + i) % universe.length]);
  }
  const nextCursor = (cursor + batch.length) % universe.length;
  return { batch, cursor, nextCursor, universeSize: universe.length };
}

async function runOnce() {
  const { dateStr } = istMinutesAndDate();
  console.log(`\n=== Multibagger daily batch: ${new Date().toISOString()} (${dateStr}) ===`);

  syncFromRemote(); // must happen before reading cursor/tracked/all_results below — see git_state.js

  const { batch, cursor, nextCursor, universeSize } = pickTodaysBatch();
  console.log(`Cursor ${cursor}/${universeSize}. Today's batch: ${batch.length} stocks.`);

  const username = process.env.SCREENER_USERNAME;
  const password = process.env.SCREENER_PASSWORD;
  if (!username || !password) {
    console.error('FATAL: SCREENER_USERNAME/SCREENER_PASSWORD not set.');
    return;
  }
  const cookies = await loginToScreener(username, password);
  console.log('Logged in to Screener.in.');

  const { batchResults } = await runDailyBatch(batch, cookies);

  const tracked = fs.existsSync(TRACKED_PATH) ? JSON.parse(fs.readFileSync(TRACKED_PATH, 'utf8')) : {};
  const { newAlerts, lostAlerts, updatedTracked, logEntries } = diffAndUpdate(batchResults, tracked);
  console.log(`New candidates: ${newAlerts.length}. Lost qualification: ${lostAlerts.length}.`);

  for (const { symbol, data } of newAlerts) {
    await sendTelegramAlert(formatNewCandidateAlert(symbol, data));
  }
  for (const { symbol, firstQualified, failedChecks, currentData, previousData } of lostAlerts) {
    await sendTelegramAlert(formatLostQualificationAlert(symbol, firstQualified, failedChecks, currentData, previousData));
  }

  fs.writeFileSync(TRACKED_PATH, JSON.stringify(updatedTracked, null, 1));
  fs.writeFileSync(CURSOR_PATH, JSON.stringify({ cursor: nextCursor, lastRunDate: dateStr }, null, 1));

  if (logEntries.length > 0) {
    const log = fs.existsSync(LOG_PATH) ? JSON.parse(fs.readFileSync(LOG_PATH, 'utf8')) : [];
    log.push(...logEntries);
    fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 1));
  }

  await commitAndPushTrackedState(dateStr);
  console.log(`=== Batch complete: ${new Date().toISOString()} ===`);
}

function fmtMinutes(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

async function loop() {
  let lastRunDate = null;
  console.log(`Multibagger screener: waiting for the next ${fmtMinutes(TRIGGER_START_MIN)}-${fmtMinutes(TRIGGER_END_MIN)} IST window...`);
  while (true) {
    const { minutesOfDay, dateStr } = istMinutesAndDate();
    if (minutesOfDay >= TRIGGER_START_MIN && minutesOfDay < TRIGGER_END_MIN && lastRunDate !== dateStr) {
      lastRunDate = dateStr;
      try {
        await runOnce();
      } catch (e) {
        console.error('Daily batch failed:', e);
      }
      console.log("Waiting for tomorrow's window...");
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

module.exports = { pickTodaysBatch, runOnce };

if (require.main === module) {
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
}
