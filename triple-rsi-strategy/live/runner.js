'use strict';

/**
 * Triple RSI Strategy — daily scan (runOnce), scheduled by service.js.
 *
 * Refreshes daily candles for the 353-symbol halal-500 universe
 * (symbols.json), runs triple_rsi_engine.js for each, and upserts one row
 * per position (open or closed) into triple_rsi.positions.
 *
 * ALERT-ONLY (2026-09-20 decision): this service never places or modifies
 * an order. It Telegram-alerts on two events, each exactly once per
 * position (deduped via entry_alerted/exit_alerted flags):
 *   - New entry signal confirmed at today's close -> place an AMO to buy at
 *     tomorrow's open (see README for why AMO, not same-day MOC).
 *   - Position closed (stop hit, or RSI(5)>50 after the 7-day min hold).
 *
 * Full recompute every run, no incremental engine state (same philosophy as
 * darvas_engine.js elsewhere in this repo) -- deterministic from the daily
 * bar history, so there's no drift to reconcile.
 *
 * Requires: DATABASE_URL (or .secrets/pg_url.txt) for state to persist and
 * for alert dedupe to work. TELEGRAM_BOT_TOKEN to actually send alerts (with
 * neither, the scan still runs and logs what it WOULD have alerted).
 * No Upstox token needed -- historical candles are fetched unauthenticated
 * (see upstox_fetch.js).
 */

const { DB } = require('./db');
const { computeTradeLog, MIN_HOLD_BARS } = require('./triple_rsi_engine');
const { loadLocalStore, saveLocalStore, refreshSymbol, isoDate } = require('./daily_cache');
const { sendTelegram } = require('./telegram');
const symbolMap = require('./symbols.json');

const CONCURRENCY = 3; // unauthenticated Upstox endpoint rate-limits (HTTP 429) aggressively above this
const REQUEST_STAGGER_MS = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function formatEntryAlert(symbol, pos) {
  return [
    `🟢 TRIPLE RSI — NEW SIGNAL: ${symbol}`,
    `Confirmed at today's close (${pos.entryDate}): ₹${pos.entryPrice.toFixed(2)}`,
    `Action: place an AMO to BUY at tomorrow's open.`,
    `Stop-loss: ₹${pos.stopPrice.toFixed(2)} (-15%)`,
    `Min hold: ${MIN_HOLD_BARS} trading days (exit only on RSI(5)>50 after that, or the stop, whichever first)`,
  ].join('\n');
}

function formatExitAlert(symbol, trade) {
  const emoji = trade.returnPct >= 0 ? '✅' : '🔴';
  return [
    `${emoji} TRIPLE RSI — CLOSED: ${symbol}`,
    `Entry ${trade.entryDate} @ ₹${trade.entryPrice.toFixed(2)} → Exit ${trade.exitDate} @ ₹${trade.exitPrice.toFixed(2)}`,
    `Reason: ${trade.exitReason === 'stop' ? '15% stop-loss' : 'RSI(5) > 50'}`,
    `Return: ${trade.returnPct >= 0 ? '+' : ''}${trade.returnPct.toFixed(2)}% (held ${trade.barsHeld} trading days)`,
  ].join('\n');
}

async function runOnce() {
  const db = new DB();
  const todayStr = isoDate(new Date());
  await db.init();
  const localStore = db.enabled ? {} : loadLocalStore();

  const entries = Object.entries(symbolMap);
  console.log(`Triple RSI scan — ${todayStr} — ${entries.length} symbols`);

  let newEntries = 0, newExits = 0, positionsWritten = 0, failures = 0, done = 0;

  await mapLimit(entries, CONCURRENCY, async ([symbol, instrumentKey]) => {
    let dailyBars;
    try {
      dailyBars = await refreshSymbol(db, localStore, symbol, instrumentKey, todayStr);
    } catch (e) {
      failures++;
      console.warn(`  ${symbol}: fetch failed — ${e.message}`);
      return;
    } finally {
      await sleep(REQUEST_STAGGER_MS);
      done++;
      if (done % 50 === 0) console.log(`  [${done}/${entries.length}] processed`);
    }
    if (dailyBars.length < 210) return; // not enough history for the 200-day MA yet

    const { closedTrades, openPosition } = computeTradeLog(dailyBars);
    const validEntryDates = [];

    // Alert gate: ONLY today's events, regardless of backfill depth or DB
    // state. A full recompute over 2 years of history can surface many
    // long-past closed trades (especially on the very first run before any
    // rows exist) -- without this same-day gate, those would all look "new"
    // and flood Telegram (darvas-classic-strategy/live/schema.sql documents
    // exactly this failure mode from an earlier bot in this repo: "the bad
    // data from the first run's alert-flood incident"). entry_alerted /
    // exit_alerted in the DB are a same-day-retry safety net on top of this,
    // not the primary gate.
    for (const t of closedTrades) {
      validEntryDates.push(t.entryDate);
      const existing = await db.getPosition(symbol, t.entryDate);
      const alreadyEntryAlerted = existing?.entry_alerted ?? false;
      const alreadyExitAlerted = existing?.exit_alerted ?? false;

      if (t.entryDate === todayStr && !alreadyEntryAlerted) {
        await sendTelegram(formatEntryAlert(symbol, { entryDate: t.entryDate, entryPrice: t.entryPrice, stopPrice: t.stopPrice }));
        newEntries++;
      }
      if (t.exitDate === todayStr && !alreadyExitAlerted) {
        await sendTelegram(formatExitAlert(symbol, t));
        newExits++;
      }

      await db.upsertPosition({
        symbol, entryDate: t.entryDate, entryPrice: round2(t.entryPrice), stopPrice: round2(t.stopPrice),
        status: 'closed', barsHeld: t.barsHeld, minHoldSatisfied: true,
        exitDate: t.exitDate, exitPrice: round2(t.exitPrice), exitReason: t.exitReason, returnPct: round2(t.returnPct),
        lastPrice: round2(t.exitPrice), entryAlerted: true, exitAlerted: true,
      });
      positionsWritten++;
    }

    if (openPosition) {
      validEntryDates.push(openPosition.entryDate);
      const existing = await db.getPosition(symbol, openPosition.entryDate);
      const alreadyEntryAlerted = existing?.entry_alerted ?? false;
      const isNewToday = openPosition.entryDate === todayStr;
      if (isNewToday && !alreadyEntryAlerted) {
        await sendTelegram(formatEntryAlert(symbol, openPosition));
        newEntries++;
      }
      await db.upsertPosition({
        symbol, entryDate: openPosition.entryDate, entryPrice: round2(openPosition.entryPrice),
        stopPrice: round2(openPosition.stopPrice), status: 'open', barsHeld: openPosition.barsHeld,
        minHoldSatisfied: openPosition.minHoldSatisfied, returnPct: round2(openPosition.unrealizedPct),
        lastPrice: round2(openPosition.lastPrice), entryAlerted: isNewToday || alreadyEntryAlerted, exitAlerted: false,
      });
      positionsWritten++;
    }

    await db.prunePositions(symbol, validEntryDates);
  });

  console.log(
    `Scan complete. ${positionsWritten} position row(s) written, ${newEntries} new entry alert(s), ` +
    `${newExits} new exit alert(s), ${failures} symbol fetch failure(s).`
  );
}

module.exports = { runOnce };
