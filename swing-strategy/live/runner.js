'use strict';

/**
 * Stateless daily run of the demand/supply confluence swing strategy.
 *
 * Unlike the EMA-scalp live streamer (tick-by-tick, needs a persistent open-
 * position log), this strategy trades Daily bars and holds for days/weeks.
 * Rather than persist an open-positions file across Railway restarts (Trial
 * plan has no Volumes — see ema-scalp-strategy's live/ README notes), every
 * run recomputes signals FRESH from historical candles:
 *
 *   - "New position entered" alert: checkSignal() fires at YESTERDAY's close
 *     (i === lastIdx - 1). Entry has already executed at TODAY's open by the
 *     time we run (after today's close), so the real entry price is known.
 *     Note: checkSignal cannot fire at TODAY's close itself (i === lastIdx) —
 *     its entry-gap check needs tomorrow's open, which doesn't exist yet, so
 *     it always evaluates to fires=false there. Confirmed via truncation
 *     testing against a known historical trade before deploying.
 *   - "Position closed" alert: a signal that fired further in the past (up to
 *     ~100 trading days back, comfortably covering the 90-day hold cap)
 *     resolves (target/stop/time-cap) exactly on today's bar, per
 *     simulatePositionalTrade().
 *   - Still-open positions (simulator returns DATA_EXHAUSTED, i.e. ran out of
 *     real data before resolving) produce no alert — already alerted on
 *     entry, nothing new to report.
 *
 * This needs no persisted state at all: run it once a day after market
 * close and it always reconstructs the correct picture from scratch. The
 * only in-memory-only safeguard is a same-process dedup set, to avoid a
 * double alert if the daily scheduler somehow fires twice before a restart.
 */

const fs = require('fs');
const path = require('path');
const { precompute, checkSignal } = require('./confluence');
const { simulatePositionalTrade } = require('./simulate_positional');
const { fetchCandles, isoDate } = require('./upstox_fetch');

const UPSTOX_TOKEN = process.env.UPSTOX_ACCESS_TOKEN;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS = ['5937539323', '-5338709046'];

const LOOKBACK_DAYS_FOR_SIGNALS = 100; // > MAX_HOLD_DAYS (90), so any position that could still resolve today is covered
const FETCH_YEARS_DAY_WEEK = 3;
const FETCH_YEARS_MONTH = 3;
const FETCH_DELAY_MS = 120; // be polite to Upstox across ~190 sequential calls

const symbolMap = require('./symbols.json');
const sectorMap = require('./sector_map.json');

const alertedKeys = new Set(); // in-memory only, resets on restart — see doc comment above

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function dateRange(years) {
  const to = new Date();
  const from = new Date();
  from.setFullYear(from.getFullYear() - years);
  return { from: isoDate(from), to: isoDate(to) };
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

function formatEntryAlert(symbol, sector, trade, stopLoss, target, targetSource) {
  return [
    '[SWING STRATEGY] New position entered',
    `Stock: ${symbol}${sector ? ` (${sector})` : ''}`,
    `Entry: ${trade.entryPrice.toFixed(2)} (today's open)`,
    `Stop-loss: ${stopLoss.toFixed(2)}`,
    `Target: ${target.toFixed(2)} (${targetSource})`,
    '(Positional swing trade, holds days-to-weeks. Alert only — no order placed.)',
  ].join('\n');
}

function formatExitAlert(symbol, sector, trade, stopLoss) {
  const pnlStr = (trade.pnlPct >= 0 ? '+' : '') + trade.pnlPct.toFixed(2) + '%';
  return [
    '[SWING STRATEGY] Position closed',
    `Stock: ${symbol}${sector ? ` (${sector})` : ''}`,
    `Entry: ${trade.entryPrice.toFixed(2)}`,
    `Exit: ${trade.exitPrice.toFixed(2)} (${trade.action})`,
    `Stop-loss was: ${stopLoss.toFixed(2)}`,
    `P&L: ${pnlStr} over ${trade.holdDays} days`,
  ].join('\n');
}

function formatSameDayEntryExitAlert(symbol, sector, trade, stopLoss, target, targetSource) {
  const pnlStr = (trade.pnlPct >= 0 ? '+' : '') + trade.pnlPct.toFixed(2) + '%';
  return [
    '[SWING STRATEGY] Position entered AND closed same day',
    `Stock: ${symbol}${sector ? ` (${sector})` : ''}`,
    `Entry: ${trade.entryPrice.toFixed(2)} (today's open)`,
    `Exit: ${trade.exitPrice.toFixed(2)} (${trade.action})`,
    `Stop-loss was: ${stopLoss.toFixed(2)}, target was: ${target.toFixed(2)} (${targetSource})`,
    `P&L: ${pnlStr}`,
  ].join('\n');
}

async function fetchAllData() {
  const dayWeekRange = dateRange(FETCH_YEARS_DAY_WEEK);
  const monthRange = dateRange(FETCH_YEARS_MONTH);

  const data = {};
  const symbols = Object.entries(symbolMap);
  let ok = 0;
  for (const [symbol, instrumentKey] of symbols) {
    try {
      const day = await fetchCandles(instrumentKey, 'day', dayWeekRange.from, dayWeekRange.to, UPSTOX_TOKEN);
      await sleep(FETCH_DELAY_MS);
      const week = await fetchCandles(instrumentKey, 'week', dayWeekRange.from, dayWeekRange.to, UPSTOX_TOKEN);
      await sleep(FETCH_DELAY_MS);
      const month = await fetchCandles(instrumentKey, 'month', monthRange.from, monthRange.to, UPSTOX_TOKEN);
      await sleep(FETCH_DELAY_MS);
      if (day.length < 100) continue;
      data[symbol] = { day, week, month };
      ok++;
    } catch (e) {
      console.warn(`  FAILED fetching ${symbol}: ${e.message}`);
    }
  }
  console.log(`Fetched ${ok}/${symbols.length} stocks.`);

  const sectorNames = [...new Set(Object.values(sectorMap))];
  const sectorData = {};
  for (const name of sectorNames) {
    try {
      const month = await fetchCandles(`NSE_INDEX|${name}`, 'month', monthRange.from, monthRange.to, UPSTOX_TOKEN);
      await sleep(FETCH_DELAY_MS);
      sectorData[name] = month;
    } catch (e) {
      console.warn(`  FAILED fetching sector ${name}: ${e.message}`);
    }
  }
  console.log(`Fetched ${Object.keys(sectorData).length}/${sectorNames.length} sector indices.`);

  return { data, sectorData };
}

async function runOnce() {
  console.log(`\n=== Swing strategy daily run: ${new Date().toISOString()} ===`);
  if (!UPSTOX_TOKEN) {
    console.error('FATAL: UPSTOX_ACCESS_TOKEN not set.');
    return;
  }

  const { data, sectorData } = await fetchAllData();
  const sectorPrecomputed = {};
  for (const [name, candles] of Object.entries(sectorData)) sectorPrecomputed[name] = precompute(candles);

  let newSignals = 0;
  let closedPositions = 0;

  for (const [symbol, tf] of Object.entries(data)) {
    const dailyP = precompute(tf.day);
    const weeklyP = precompute(tf.week);
    const monthlyP = precompute(tf.month);
    const sectorName = sectorMap[symbol];
    const sectorMonthly = sectorName ? sectorPrecomputed[sectorName] : null;

    const lastIdx = tf.day.length - 1;
    const startIdx = Math.max(60, lastIdx - LOOKBACK_DAYS_FOR_SIGNALS);

    // i === lastIdx is deliberately excluded: checkSignal's entry-gap check
    // needs tomorrow's open (dCandles[i+1]), which doesn't exist yet for the
    // most recent close — it always evaluates fires=false there. The
    // earliest a signal can actually confirm (per the strategy's own gap
    // rule) is the day AFTER it fires, once entry has executed at that day's
    // open — see chat/README for how this was found via truncation testing.
    for (let i = startIdx; i < lastIdx; i++) {
      const result = checkSignal(dailyP, weeklyP, monthlyP, i, sectorMonthly);
      if (!result.fires) continue;

      const signalDate = new Date(tf.day[i].timestampMs).toISOString().slice(0, 10);

      if (i === lastIdx - 1) {
        // Fired yesterday's close -> entered at today's open, price now known.
        const trade = simulatePositionalTrade(tf.day, i, result.stopLoss, result.target);
        const key = `entry:${symbol}:${signalDate}`;
        if (alertedKeys.has(key)) continue;
        alertedKeys.add(key);
        newSignals++;
        if (trade.action !== 'DATA_EXHAUSTED') {
          await sendTelegramAlert(formatSameDayEntryExitAlert(symbol, sectorName, trade, result.stopLoss, result.target, result.targetSource));
        } else {
          await sendTelegramAlert(formatEntryAlert(symbol, sectorName, trade, result.stopLoss, result.target, result.targetSource));
        }
        continue;
      }

      // Fired further in the past -> check whether it resolves exactly today.
      const trade = simulatePositionalTrade(tf.day, i, result.stopLoss, result.target);
      if (!trade || trade.action === 'DATA_EXHAUSTED') continue; // still open, nothing new
      if (trade.exitDayIndex !== lastIdx) continue; // resolved on some earlier day, already alerted then

      const key = `exit:${symbol}:${signalDate}`;
      if (alertedKeys.has(key)) continue;
      alertedKeys.add(key);
      closedPositions++;
      await sendTelegramAlert(formatExitAlert(symbol, sectorName, trade, result.stopLoss));
    }
  }

  console.log(`Run complete. New signals: ${newSignals}. Closed positions: ${closedPositions}.`);
}

module.exports = { runOnce };
