'use strict';

/**
 * Long-running process for the RS-momentum strategy. Daily cadence (RS
 * ranking is a whole-universe, once-a-day computation on Daily candles —
 * unlike multibagger-screener's rolling ~100/day batch, this can't be
 * partially updated: today's cross-sectional rank needs the whole
 * universe's data on the same day). Triggers once/day, 20:00-20:30 IST,
 * after market close (matches multibagger-screener's established timing —
 * Daily candles for the completed session should be available by then).
 *
 * Flow: sync state from GitHub -> fetch fresh ~14mo Nifty+universe data ->
 * compute today's RS ranks -> diff against tracked positions (new RS>=80
 * crossings, existing positions whose rank dropped below 50) -> gate new
 * candidates on Sales Growth 3Y >=15% via Screener.in (the source's
 * fundamental confirmation, live-only per the backtest's documented
 * limitation — Screener.in has no historical point-in-time data) -> alert
 * on Telegram -> persist state.
 *
 * RUN_ONCE=1 runs immediately and exits, for manual testing.
 */

const fs = require('fs');
const path = require('path');
const { fetchUniverse } = require('./fetch_universe');
const { computeTodayRanks } = require('./today_ranks');
const { diffRsMomentum } = require('./diff_tracker');
const { loginToScreener, fetchFundamentals } = require('./fundamental_screener');
const { syncFromRemote, commitAndPushTrackedState } = require('./git_state');

const UPSTOX_TOKEN = process.env.UPSTOX_ACCESS_TOKEN;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS = ['5937539323', '-5338709046'];
const SALES_GROWTH_MIN_PCT = 15; // matches multibagger-screener's own Sales Growth 3Y threshold

const TRIGGER_START_MIN = 20 * 60; // 20:00 IST
const TRIGGER_END_MIN = 20 * 60 + 30; // 20:30 IST
const POLL_MS = 10 * 60 * 1000;
const IST_OFFSET_MIN = 5 * 60 + 30;

const TRACKED_PATH = path.join(__dirname, 'tracked_rs_momentum.json');
const LOG_PATH = path.join(__dirname, 'rs_momentum_log.json');

if (!UPSTOX_TOKEN) {
  console.error('FATAL: UPSTOX_ACCESS_TOKEN env var not set. Cannot start.');
  process.exit(1);
}

function istMinutesAndDate() {
  const now = new Date();
  const ist = new Date(now.getTime() + IST_OFFSET_MIN * 60 * 1000);
  return { minutesOfDay: ist.getUTCHours() * 60 + ist.getUTCMinutes(), dateStr: ist.toISOString().slice(0, 10) };
}

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

function formatEntryAlert(c, fundamentals) {
  return [
    '[RS MOMENTUM] New position entered — LONG',
    `Stock: ${c.symbol}${fundamentals.companyName ? ' (' + fundamentals.companyName + ')' : ''}`,
    `Entry: ₹${c.price.toFixed(2)}`,
    `RS Rank: ${c.rsRankAtEntry.toFixed(1)}/100 (>=80 required)`,
    `Sales Growth 3Y: ${fundamentals.salesGrowth3Y}% (>=15% required)`,
    `Sector: ${fundamentals.sectorTags?.Industry || 'n/a'}`,
    'No fixed target/stop — holds while RS rank stays >=50, exits on relative weakness.',
    '(Positional, 1-2yr horizon. Alert only — no order placed.)',
  ].join('\n');
}

function formatExitAlert(e) {
  const pnlStr = (e.pnlPct >= 0 ? '+' : '') + e.pnlPct.toFixed(2) + '%';
  return [
    '[RS MOMENTUM] Position closed — relative weakness',
    `Stock: ${e.symbol}`,
    `Entry: ₹${e.entryPrice.toFixed(2)} (${e.entryDate})`,
    `Exit: ₹${e.exitPrice.toFixed(2)} (${e.date})`,
    `RS Rank at exit: ${e.exitRsRank.toFixed(1)}/100 (<50 triggered exit)`,
    `P&L: ${pnlStr}`,
  ].join('\n');
}

async function runOnce() {
  const { dateStr } = istMinutesAndDate();
  console.log(`\n=== RS momentum daily run: ${new Date().toISOString()} (${dateStr}) ===`);

  await syncFromRemote();

  const universe = await fetchUniverse(UPSTOX_TOKEN);
  const todayRanks = computeTodayRanks(universe);
  console.log(`Computed RS ranks for ${Object.keys(todayRanks).length} stocks.`);

  const tracked = fs.existsSync(TRACKED_PATH) ? JSON.parse(fs.readFileSync(TRACKED_PATH, 'utf8')) : {};
  const { newCandidates, exits, updatedTracked } = diffRsMomentum(todayRanks, tracked);
  console.log(`RS>=80 crossings: ${newCandidates.length}. Exits (RS<50): ${exits.length}.`);

  const logEntries = [];

  for (const e of exits) {
    await sendTelegramAlert(formatExitAlert(e));
    logEntries.push({ type: 'EXIT', symbol: e.symbol, date: e.date, price: e.exitPrice, pnlPct: e.pnlPct });
  }

  if (newCandidates.length > 0) {
    const username = process.env.SCREENER_USERNAME;
    const password = process.env.SCREENER_PASSWORD;
    if (!username || !password) {
      console.error('SCREENER_USERNAME/SCREENER_PASSWORD not set — skipping Sales Growth gate, no new entries will be tracked this run.');
    } else {
      const cookies = await loginToScreener(username, password);
      for (const c of newCandidates) {
        try {
          const fundamentals = await fetchFundamentals(c.symbol, cookies);
          if (!fundamentals) {
            console.log(`  ${c.symbol}: could not fetch fundamentals, skipping.`);
            continue;
          }
          if (fundamentals.salesGrowth3Y == null || fundamentals.salesGrowth3Y < SALES_GROWTH_MIN_PCT) {
            console.log(`  ${c.symbol}: RS>=80 but Sales Growth 3Y (${fundamentals.salesGrowth3Y}%) doesn't clear ${SALES_GROWTH_MIN_PCT}% — not tracked.`);
            continue;
          }
          updatedTracked[c.symbol] = {
            entryDate: c.date,
            entryPrice: c.price,
            rsRankAtEntry: c.rsRankAtEntry,
            salesGrowth3Y: fundamentals.salesGrowth3Y,
          };
          await sendTelegramAlert(formatEntryAlert(c, fundamentals));
          logEntries.push({ type: 'ENTRY', symbol: c.symbol, date: c.date, price: c.price, rsRankAtEntry: c.rsRankAtEntry, salesGrowth3Y: fundamentals.salesGrowth3Y });
        } catch (e2) {
          console.warn(`  ${c.symbol}: fundamentals check failed (${e2.message}) — not tracked this run.`);
        }
      }
    }
  }

  fs.writeFileSync(TRACKED_PATH, JSON.stringify(updatedTracked, null, 1));
  if (logEntries.length > 0) {
    const log = fs.existsSync(LOG_PATH) ? JSON.parse(fs.readFileSync(LOG_PATH, 'utf8')) : [];
    log.push(...logEntries);
    fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 1));
  }

  await commitAndPushTrackedState(dateStr);
  console.log(`=== Run complete: ${new Date().toISOString()} ===`);
}

function fmtMinutes(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

async function loop() {
  let lastRunDate = null;
  console.log(`RS momentum strategy: waiting for the next ${fmtMinutes(TRIGGER_START_MIN)}-${fmtMinutes(TRIGGER_END_MIN)} IST window...`);
  while (true) {
    const { minutesOfDay, dateStr } = istMinutesAndDate();
    if (minutesOfDay >= TRIGGER_START_MIN && minutesOfDay < TRIGGER_END_MIN && lastRunDate !== dateStr) {
      lastRunDate = dateStr;
      try {
        await runOnce();
      } catch (e) {
        console.error('Daily run failed:', e);
      }
      console.log("Waiting for tomorrow's window...");
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

module.exports = { runOnce };

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
