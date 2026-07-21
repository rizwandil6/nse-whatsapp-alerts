'use strict';

/**
 * DarvasBox PAPER-ALERT poller for the 23-stock watchlist.
 *
 * Explicitly a PAPER/unvalidated deployment (per user's own call, given
 * this strategy was built and backtested the same day it went live, with
 * zero live-execution history and one real bug already found and fixed
 * in the backtest code) -- every alert says so. No orders are placed.
 *
 * Design, and why it differs from the tick-level orb-live-streamer:
 * DarvasBox's rules (8-brick box breakout, trailing box stop) only need
 * PRICE, no volume/VWAP/Bollinger confirmation the way ORB does -- so
 * there's no tick-level execution-staleness risk to guard against the
 * way execution_revision.js exists for ORB. Given that, and given this
 * is a paper phase where alert latency doesn't matter yet, a REST poller
 * (rebuild today's Renko bricks from 5-min candles every 5 minutes) is
 * simpler and more faithful to how the strategy was actually backtested
 * (on 5-min bars) than standing up a full WebSocket tick pipeline would
 * be. Can graduate to tick-level live execution later if this earns
 * enough live confidence to trade for real.
 *
 * Renko bricks reset at each day's open here (unlike the 60-day
 * continuous series used for backtesting) -- avoids needing to replay
 * historical brick lineage on every restart, and DarvasBox already
 * force-closes at EOD so no position ever spans the reset anyway. This
 * is a disclosed, deliberate difference from the backtest, not an
 * oversight -- expect live brick boundaries (and therefore exact signal
 * timing) to differ somewhat from what the backtest would have shown for
 * the same day.
 */

const fs = require('fs');
const path = require('path');
const { buildRenkoBricks } = require('./renko');
const { DarvasLiveTracker } = require('./darvas_tracker');
const { syncFromRemote, recordAndPush } = require('./trade_log');

const UPSTOX_TOKEN = process.env.UPSTOX_ACCESS_TOKEN;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS = (process.env.DARVAS_TELEGRAM_CHAT_IDS || '5937539323,-5338709046').split(',');
const PAPER_ALERTS_ENABLED = process.env.DARVAS_TELEGRAM_ENABLED !== 'false';
const BRICK_PCT = parseFloat(process.env.DARVAS_BRICK_PCT || '0.5') / 100;
const POLL_MS = 5 * 60 * 1000; // 5 minutes -- matches the 5-min bar granularity bricks are built from
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const MARKET_OPEN_MIN = 9 * 60 + 15;
const MARKET_CLOSE_MIN = 15 * 60 + 30;

const symbols = require('./symbols.json');
const trackers = {};
for (const symbol of Object.keys(symbols)) trackers[symbol] = new DarvasLiveTracker(symbol);
let currentDate = null;

function istMinutesOfDay(ms) {
  const ist = new Date(ms + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}
function istDateStr(ms) {
  const ist = new Date(ms + IST_OFFSET_MS);
  return ist.toISOString().slice(0, 10);
}
function nowIst() {
  const now = Date.now();
  return { minutesOfDay: istMinutesOfDay(now), dateStr: istDateStr(now) };
}

async function fetchTodaysOneMinCandles(instrumentKey) {
  const url = `https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/minutes/1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${UPSTOX_TOKEN}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.status !== 'success') throw new Error(`status: ${body.status}`);
  return (body.data.candles || [])
    .map((c) => ({ timestampMs: new Date(c[0]).getTime(), open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

function aggregateTo5Min(oneMinCandles) {
  const buckets = new Map();
  for (const c of oneMinCandles) {
    const min = istMinutesOfDay(c.timestampMs);
    if (min < MARKET_OPEN_MIN) continue;
    const bucketIdx = Math.floor((min - MARKET_OPEN_MIN) / 5);
    const key = String(bucketIdx);
    if (!buckets.has(key)) {
      buckets.set(key, { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, timestampMs: c.timestampMs });
    } else {
      const b = buckets.get(key);
      b.high = Math.max(b.high, c.high);
      b.low = Math.min(b.low, c.low);
      b.close = c.close;
      b.volume += c.volume;
    }
  }
  return [...buckets.values()].sort((a, b) => a.timestampMs - b.timestampMs);
}

async function sendTelegramAlert(text) {
  const label = PAPER_ALERTS_ENABLED ? '[DARVAS-PAPER]' : '[DARVAS-PAPER-SUPPRESSED]';
  console.log(label, text.replace(/\n/g, ' | '));
  if (!PAPER_ALERTS_ENABLED || !TELEGRAM_TOKEN) return;
  for (const chatId of TELEGRAM_CHAT_IDS) {
    try {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
    } catch (e) {
      console.error(`Telegram send failed for chat ${chatId}:`, e.message);
    }
  }
}

function formatEntryAlert(e) {
  const arrow = e.direction === 'LONG' ? '↑' : '↓';
  return `📝 PAPER ALERT — DarvasBox (unvalidated, not a trade signal)\n${arrow} ${e.direction}: ${e.symbol}\nEntry: ₹${e.entry.toFixed(2)}\nStop: ₹${e.stop.toFixed(2)}\nNo target — trailing box stop`;
}
function formatExitAlert(e) {
  const sign = e.pnlPct >= 0 ? '+' : '';
  return `📝 PAPER ALERT — DarvasBox position closed (unvalidated)\n${e.symbol} ${e.direction}\nEntry: ₹${e.entry.toFixed(2)} → Exit: ₹${e.exitPrice.toFixed(2)}\nReason: ${e.action}\nP&L: ${sign}${e.pnlPct.toFixed(2)}% (gross, no costs applied)`;
}

async function pollSymbol(symbol, instrumentKey, atOrPastClose) {
  const oneMin = await fetchTodaysOneMinCandles(instrumentKey);
  const fiveMin = aggregateTo5Min(oneMin);
  if (fiveMin.length === 0) return;
  const bricks = buildRenkoBricks(fiveMin, BRICK_PCT);
  const tracker = trackers[symbol];
  const events = tracker.processBricks(bricks);

  if (atOrPastClose) {
    const eodEvent = tracker.forceEodClose(bricks);
    if (eodEvent) events.push(eodEvent);
  }

  for (const e of events) {
    if (e.type === 'ENTRY') {
      await sendTelegramAlert(formatEntryAlert(e));
    } else if (e.type === 'EXIT') {
      await sendTelegramAlert(formatExitAlert(e));
      const { dateStr } = nowIst();
      await recordAndPush(e, dateStr);
    }
  }
}

async function pollAll() {
  const { minutesOfDay, dateStr } = nowIst();

  if (dateStr !== currentDate) {
    currentDate = dateStr;
    for (const tracker of Object.values(trackers)) tracker.resetForNewDay();
    console.log(`New trading day: ${dateStr}. Trackers reset (Renko bricks are not continued across days in the live poller).`);
  }

  if (minutesOfDay < MARKET_OPEN_MIN || minutesOfDay > MARKET_CLOSE_MIN + 15) {
    console.log(`Outside market hours (minute ${minutesOfDay}) — skipping poll.`);
    return;
  }

  const atOrPastClose = minutesOfDay >= MARKET_CLOSE_MIN;
  for (const [symbol, instrumentKey] of Object.entries(symbols)) {
    try {
      await pollSymbol(symbol, instrumentKey, atOrPastClose);
    } catch (e) {
      console.warn(`Poll failed for ${symbol}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 150)); // pace across 23 symbols, avoid rate limits
  }
}

async function main() {
  if (!UPSTOX_TOKEN) {
    console.error('UPSTOX_ACCESS_TOKEN not set — cannot poll.');
    process.exit(1);
  }
  console.log(`DarvasBox PAPER-ALERT poller starting. ${Object.keys(symbols).length} symbols, brick size ${(BRICK_PCT * 100).toFixed(2)}%, polling every ${POLL_MS / 60000} min.`);
  console.log(`Telegram alerts: ${PAPER_ALERTS_ENABLED ? 'ENABLED (paper-labeled)' : 'SUPPRESSED (logging only)'}`);
  await syncFromRemote();

  await pollAll();
  setInterval(() => {
    pollAll().catch((e) => console.error('pollAll error:', e.message));
  }, POLL_MS);
}

main();
