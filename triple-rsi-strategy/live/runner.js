'use strict';

/**
 * Triple RSI Strategy — daily scan (runOnce), scheduled by service.js at
 * 15:15-15:25 IST (moved from post-close 16:00-16:10 on 2026-09-22, see
 * service.js's doc comment).
 *
 * Refreshes daily candles for the 353-symbol halal-500 universe
 * (symbols.json), then -- since NSE hasn't closed yet at this run time and
 * Upstox won't publish today's real daily candle until well after 15:30 --
 * approximates today's not-yet-final candle from live intraday 1-minute
 * data (fetchIntradayCandles) and appends it in-memory ONLY for this run's
 * signal computation (never persisted to triple_rsi.daily_cache, which
 * stays real-published-candles-only). Runs triple_rsi_engine.js for each,
 * and upserts one row per position (open or closed) into
 * triple_rsi.positions.
 *
 * ALERT-ONLY (2026-09-20 decision, still holds): this service never places
 * or modifies an order, regardless of how the alert timing/instructions
 * change. It Telegram-alerts on two events, each exactly once per position
 * (deduped via entry_alerted/exit_alerted flags):
 *   - New entry signal, as of today's ~15:15 IST intraday price -> place a
 *     LIMIT order to BUY near market close (~15:29:59 IST) TODAY (changed
 *     2026-09-22 from "AMO for tomorrow's open" -- see README).
 *   - Position closed (stop hit, or RSI(5)>50 after the 7-day min hold) ->
 *     place a LIMIT order to SELL near market close (~15:29:59 IST) TODAY.
 *
 * Caveat inherent to this design: the recorded entry/exit price is the
 * ~15:15 intraday snapshot, not the actual ~15:29:59 fill price -- usually
 * close, occasionally not, in exchange for the ~15-minute lead time needed
 * to actually place the order before close.
 *
 * After the scan, syncs every open position into the dashboard's Portfolio
 * tab watchlist (db.syncPortfolioWatchlist) so it rides the existing
 * 08:00 IST TradingAgents job -- see that method's doc comment.
 *
 * Full recompute every run, no incremental engine state (same philosophy as
 * darvas_engine.js elsewhere in this repo) -- deterministic from the daily
 * bar history (plus today's synthetic bar), so there's no drift to
 * reconcile.
 *
 * Requires: DATABASE_URL (or .secrets/pg_url.txt) for state to persist and
 * for alert dedupe to work. TELEGRAM_BOT_TOKEN to actually send alerts (with
 * neither, the scan still runs and logs what it WOULD have alerted).
 * No Upstox token needed -- both daily and intraday candles are fetched
 * unauthenticated (see upstox_fetch.js).
 */

const { DB } = require('./db');
const { computeTradeLog, MIN_HOLD_BARS } = require('./triple_rsi_engine');
const { loadLocalStore, saveLocalStore, refreshSymbol, isoDate } = require('./daily_cache');
const { fetchIntradayCandles } = require('./upstox_fetch');
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
    `As of ~15:15 IST intraday price (${pos.entryDate}): ₹${pos.entryPrice.toFixed(2)}`,
    `Action: place a LIMIT order to BUY near this price at market close (~15:29:59 IST) TODAY.`,
    `Stop-loss: ₹${pos.stopPrice.toFixed(2)} (-15%)`,
    `Min hold: ${MIN_HOLD_BARS} trading days (exit only on RSI(5)>50 after that, or the stop, whichever first)`,
  ].join('\n');
}

function formatExitAlert(symbol, trade) {
  const emoji = trade.returnPct >= 0 ? '✅' : '🔴';
  return [
    `${emoji} TRIPLE RSI — EXIT SIGNAL: ${symbol}`,
    `Entry ${trade.entryDate} @ ₹${trade.entryPrice.toFixed(2)} → as of ~15:15 IST intraday price (${trade.exitDate}): ₹${trade.exitPrice.toFixed(2)}`,
    `Action: place a LIMIT order to SELL near this price at market close (~15:29:59 IST) TODAY.`,
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

    // Today's real daily candle isn't published yet at this run time (15:15 IST,
    // before the 15:30 close) -- approximate it from live intraday 1-minute data so
    // the signal reflects today's actual price action, not yesterday's close. Never
    // persisted to daily_cache (see daily_cache.js/db.saveDailyBars) -- purely local
    // to this run's computeTradeLog call. Falls back to the cached bars alone (i.e.
    // yesterday's close) if the intraday fetch fails or returns nothing (pre-market,
    // or a transient error) -- non-fatal, same "best effort" convention as elsewhere.
    let signalBars = dailyBars;
    if (dailyBars[dailyBars.length - 1]?.date < todayStr) {
      try {
        const intraday = await fetchIntradayCandles(instrumentKey, '1minute');
        if (intraday.length) {
          signalBars = [...dailyBars, {
            date: todayStr,
            open: intraday[0].open,
            high: Math.max(...intraday.map((c) => c.high)),
            low: Math.min(...intraday.map((c) => c.low)),
            close: intraday[intraday.length - 1].close,
            volume: intraday.reduce((s, c) => s + c.volume, 0),
          }];
        }
      } catch (e) {
        console.warn(`  ${symbol}: intraday fetch failed, signal based on last close only — ${e.message}`);
      }
    }

    const { closedTrades, openPosition } = computeTradeLog(signalBars);
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

      // Daily history for open positions only (see db.saveDailySnapshot): that day's
      // own day-over-day % move, plus whatever TradingAgents verdict exists as of this
      // run (usually that same morning's 08:00 IST analysis, since it runs before this
      // 15:15 IST scan). Uses signalBars (includes today's intraday-derived bar when
      // available) so this reflects today's actual move, not just the last published
      // close -- and the bar's OWN date, not todayStr, as a fallback for whenever the
      // intraday fetch didn't come through and signalBars is just the cached history.
      const latestBar = signalBars[signalBars.length - 1];
      const prevBar = signalBars[signalBars.length - 2];
      const dayChangePct = prevBar?.close ? round2(((latestBar.close - prevBar.close) / prevBar.close) * 100) : null;
      const analysis = await db.getLatestAnalysis(symbol);
      await db.saveDailySnapshot({
        symbol, snapshotDate: latestBar.date, dayChangePct,
        taDecision: analysis?.decision ?? null, taAnalysisDate: analysis?.analysis_date ?? null,
      });
    }

    await db.prunePositions(symbol, validEntryDates);
  });

  console.log(
    `Scan complete. ${positionsWritten} position row(s) written, ${newEntries} new entry alert(s), ` +
    `${newExits} new exit alert(s), ${failures} symbol fetch failure(s).`
  );

  // Sync the dashboard Portfolio tab's watchlist (see db.syncPortfolioWatchlist) so every
  // open position rides the existing 08:00 IST TradingAgents job -- always run last, right
  // after this run's own positions are final, and never allowed to fail the scan itself.
  try {
    const openPositions = await db.getOpenPositions();
    const { added, removed } = await db.syncPortfolioWatchlist(openPositions.map((p) => p.symbol));
    console.log(`Portfolio watchlist synced: +${added} -${removed} (${openPositions.length} open total).`);
  } catch (e) {
    console.warn(`Portfolio watchlist sync failed (non-fatal): ${e.message}`);
  }
}

module.exports = { runOnce };
