'use strict';

/**
 * Long-running process for the full-NSE-universe multibagger screen.
 * Triggers once a month (1st of the month, IST) — a full run takes hours
 * (2,052 stocks scraped at a polite pace to avoid Screener.in rate
 * limiting), so unlike the daily swing-strategy alerts this isn't a quick
 * in-and-out check. RUN_ONCE=1 runs immediately and exits, for manual
 * testing.
 */

const fs = require('fs');
const path = require('path');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS = ['5937539323', '-5338709046'];
const TRACKED_PATH = path.join(__dirname, 'tracked_multibaggers.json');
const RAW_CHECKPOINT_PATH = path.join(__dirname, 'raw_fundamentals_checkpoint.json');
const IST_OFFSET_MIN = 5 * 60 + 30;
const POLL_MS = 60 * 60 * 1000; // check hourly — this only needs to fire once a month

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

function istMonthDayAndLabel() {
  const now = new Date();
  const ist = new Date(now.getTime() + IST_OFFSET_MIN * 60 * 1000);
  return {
    dayOfMonth: ist.getUTCDate(),
    monthLabel: ist.toISOString().slice(0, 7), // YYYY-MM
  };
}

async function runOnce() {
  const { monthLabel } = istMonthDayAndLabel();
  console.log(`\n=== Multibagger scan starting: ${new Date().toISOString()} (month=${monthLabel}) ===`);

  // Fresh universe each run (cheap — one API call) so delistings/new listings are picked up.
  console.log('Refreshing NSE universe...');
  require('child_process').execSync('node fetch_universe.js', { cwd: __dirname, stdio: 'inherit' });

  // Clear the raw-fetch checkpoint if it's from a PRIOR month (a stale
  // checkpoint from last month's run must not be reused as this month's
  // data) — but keep it if it's from THIS month (resuming after a crash).
  if (fs.existsSync(RAW_CHECKPOINT_PATH)) {
    const stat = fs.statSync(RAW_CHECKPOINT_PATH);
    const fileMonth = new Date(stat.mtime.getTime() + IST_OFFSET_MIN * 60 * 1000).toISOString().slice(0, 7);
    if (fileMonth !== monthLabel) {
      console.log(`Clearing stale checkpoint from ${fileMonth} (this run is ${monthLabel}).`);
      fs.unlinkSync(RAW_CHECKPOINT_PATH);
    } else {
      console.log(`Resuming from this month's existing checkpoint.`);
    }
  }

  console.log('Running full scan (this takes hours)...');
  require('child_process').execSync('node scan_multibagger.js', { cwd: __dirname, stdio: 'inherit' });

  const scanResults = JSON.parse(fs.readFileSync(path.join(__dirname, 'scan_results.json'), 'utf8'));
  const tracked = fs.existsSync(TRACKED_PATH) ? JSON.parse(fs.readFileSync(TRACKED_PATH, 'utf8')) : {};

  const { diffAndUpdate } = require('./diff_tracker');
  const { formatNewCandidateAlert, formatLostQualificationAlert } = require('./format_alerts');
  const { newAlerts, lostAlerts, updatedTracked } = diffAndUpdate(scanResults, tracked);

  console.log(`New candidates: ${newAlerts.length}. Lost qualification: ${lostAlerts.length}.`);

  for (const { symbol, data } of newAlerts) {
    await sendTelegramAlert(formatNewCandidateAlert(symbol, data));
  }
  for (const { symbol, firstQualified, failedChecks, currentData, previousData } of lostAlerts) {
    await sendTelegramAlert(formatLostQualificationAlert(symbol, firstQualified, failedChecks, currentData, previousData));
  }

  fs.writeFileSync(TRACKED_PATH, JSON.stringify(updatedTracked, null, 1));

  const { commitAndPushTrackedState } = require('./git_state');
  commitAndPushTrackedState(monthLabel);

  // Clean up this month's raw checkpoint now that the run completed successfully.
  if (fs.existsSync(RAW_CHECKPOINT_PATH)) fs.unlinkSync(RAW_CHECKPOINT_PATH);

  console.log(`=== Multibagger scan complete: ${new Date().toISOString()} ===`);
}

async function loop() {
  let lastRunMonth = null;
  console.log('Multibagger screener: waiting for the 1st of the month (IST)...');
  while (true) {
    const { dayOfMonth, monthLabel } = istMonthDayAndLabel();
    if (dayOfMonth === 1 && lastRunMonth !== monthLabel) {
      lastRunMonth = monthLabel;
      try {
        await runOnce();
      } catch (e) {
        console.error('Monthly run failed:', e);
      }
      console.log("Waiting for next month's run...");
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
