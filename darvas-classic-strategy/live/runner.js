'use strict';

/**
 * Classic Darvas Box (weekly) — daily scan (runOnce), scheduled by service.js.
 *
 * Refreshes weekly candles for the 530-symbol universe (symbols.json, same
 * universe as swing-strategy/live), runs the box/entry/exit engine
 * (darvas_engine.js) for each, diffs the result against what was persisted
 * last run, and Telegram-alerts + logs whatever is new (entry, pyramid add,
 * trailing stop raised, stop-loss/trail-stop exit).
 *
 * Requires: TELEGRAM_BOT_TOKEN, and DATABASE_URL (or .secrets/pg_url.txt)
 * for state to persist across runs. No Upstox token needed -- historical
 * candles are fetched unauthenticated (see upstox_fetch.js).
 */

const { DB } = require('./db');
const { computeTradeLog } = require('./darvas_engine');
const { loadLocalStore, saveLocalStore, refreshSymbol } = require('./weekly_cache');
const symbolMap = require('./symbols.json');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS = ['5937539323', '-5338709046']; // personal + group (same as other bots)
const CONCURRENCY = 4; // unauthenticated Upstox endpoint rate-limits (HTTP 429) above this on a full backfill

let db = null; // set at the top of each runOnce() call

async function sendTelegram(text) {
  console.log('[ALERT]', text.replace(/\n/g, ' | '));
  if (!TELEGRAM_TOKEN) return false;
  let allOk = true;
  for (const chatId of TELEGRAM_CHAT_IDS) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      if (!res.ok) { allOk = false; console.warn(`  Telegram send failed for ${chatId}: HTTP ${res.status}`); }
    } catch (e) { allOk = false; console.warn(`  Telegram send error for ${chatId}: ${e.message}`); }
  }
  return allOk;
}

async function emit(alertType, symbol, text) {
  const ok = await sendTelegram(text);
  await db.insertAlert({ symbol, alertType, chatId: TELEGRAM_CHAT_IDS.join(','), text, sentOk: ok });
}

const f = (x) => (x == null ? '—' : Number(x).toFixed(2));

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

async function runOnce() {
  if (!TELEGRAM_TOKEN) console.warn('WARNING: TELEGRAM_BOT_TOKEN not set. Alerts logged, not sent.');
  db = new DB();
  const todayStr = new Date().toISOString().slice(0, 10);
  await db.init();
  const localStore = db.enabled ? {} : loadLocalStore();
  const priorState = await db.loadAllState(); // { symbol: { closedCount, openLegCount, openTrailStop } }

  const entries = Object.entries(symbolMap);
  console.log(`Darvas Classic weekly scan — ${todayStr} — ${entries.length} symbols`);

  const results = await mapLimit(entries, CONCURRENCY, async ([symbol, instrumentKey]) => {
    let weekly;
    try {
      weekly = await refreshSymbol(db, localStore, symbol, instrumentKey, todayStr);
    } catch (e) {
      console.warn(`  ${symbol}: fetch failed — ${e.message}`);
      return null;
    }
    if (weekly.length < 52) return null;
    const { closedTrades, openPosition } = computeTradeLog(weekly);
    return { symbol, closedTrades, openPosition };
  });

  let newEvents = 0;
  for (const r of results) {
    if (!r) continue;
    const { symbol, closedTrades, openPosition } = r;

    // First time this symbol has ever been scanned (no prior state row at all,
    // as opposed to a row with zero trades) -- seed the baseline from the full
    // recomputed history WITHOUT alerting on it. Without this guard, every
    // symbol's entire multi-year trade history looks "new" on its first run
    // and gets Telegram-alerted as if it just happened (confirmed live 2026-08-23:
    // years-old trades went out as fresh entry/exit alerts before this was caught).
    if (!(symbol in priorState)) {
      await db.saveState(symbol, {
        closedCount: closedTrades.length,
        openLegCount: openPosition ? openPosition.totalLegs : 0,
        openTrailStop: openPosition ? openPosition.trailStop : null,
        openPosition: openPosition || null,
        lastClosedTrade: closedTrades.length ? closedTrades[closedTrades.length - 1] : null,
      });
      continue;
    }

    const prev = priorState[symbol];

    // New closed trade-leg-groups since last run (STOP_LOSS / TRAIL_STOP exits).
    if (closedTrades.length > prev.closedCount) {
      const fresh = closedTrades.slice(prev.closedCount);
      // Each fresh row is one leg's exit record; legs sharing an exitDate exited together.
      const groups = new Map();
      for (const t of fresh) {
        const k = t.exitDate;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(t);
      }
      for (const [exitDate, legs] of groups) {
        const reason = legs[0].exitReason;
        newEvents++;
        for (const leg of legs) {
          await db.insertTradeEvent({
            symbol, legIndex: leg.legIndex, eventType: reason, eventDate: exitDate,
            price: leg.exitPrice,
          });
        }
        await emit(reason, symbol,
          `${reason === 'STOP_LOSS' ? '🔴' : '🟠'} ${reason.replace('_', ' ')} — ${symbol}\n` +
          `Exit @ ${f(legs[0].exitPrice)} · ${legs.length} leg(s) · ${exitDate}`
        );
      }
    }

    // New legs on the currently open position (ENTRY / PYRAMID).
    const openLegCount = openPosition ? openPosition.totalLegs : 0;
    const wasFreshlyOpened = closedTrades.length > prev.closedCount; // just exited above -> baseline resets
    const baselineLegCount = wasFreshlyOpened ? 0 : prev.openLegCount;
    if (openPosition && openLegCount > baselineLegCount) {
      const freshLegs = openPosition.legs.slice(baselineLegCount);
      for (const leg of freshLegs) {
        newEvents++;
        const alertType = leg.legIndex === 1 ? 'ENTRY' : 'PYRAMID';
        await db.insertTradeEvent({
          symbol, legIndex: leg.legIndex, eventType: alertType, eventDate: leg.entryDate,
          price: leg.entryPrice, boxTop: leg.boxTop, trailStop: openPosition.trailStop,
        });
        await emit(alertType, symbol,
          `${leg.legIndex === 1 ? '🟢 ENTRY' : `🟢 PYRAMID ADD (leg ${leg.legIndex})`} — ${symbol}\n` +
          `Breakout @ ${f(leg.entryPrice)} (box top ${f(leg.boxTop)} +1%) · Stop ${f(openPosition.trailStop)} · ${leg.entryDate}`
        );
      }
    }

    // Trailing stop raised (box confirmed higher) with no new leg this run.
    if (openPosition && !wasFreshlyOpened && openLegCount === baselineLegCount &&
        prev.openTrailStop != null && openPosition.trailStop > prev.openTrailStop) {
      newEvents++;
      await emit('TRAIL_RAISED', symbol,
        `⬆️ TRAIL STOP RAISED — ${symbol}\nNew stop ${f(openPosition.trailStop)} (was ${f(prev.openTrailStop)})`
      );
    }

    await db.saveState(symbol, {
      closedCount: closedTrades.length,
      openLegCount,
      openTrailStop: openPosition ? openPosition.trailStop : null,
      // Full snapshot for the dashboard tab -- avoids re-deriving this from
      // trade_events server-side on every page load.
      openPosition: openPosition || null,
      lastClosedTrade: closedTrades.length ? closedTrades[closedTrades.length - 1] : null,
    });
  }

  if (!db.enabled) saveLocalStore(localStore);
  if (db.pool) await db.pool.end();
  console.log(`Scan complete. ${newEvents} new event(s).`);
}

module.exports = { runOnce };
