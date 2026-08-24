'use strict';

/**
 * Market-hours watcher for darvas_classic.watchlist (symbols with a
 * confirmed box but no open position yet, written by the daily 17:00 IST
 * scan -- see runner.js). Polls every 5 minutes between 09:15-15:30 IST on
 * trading days for a REAL-TIME breakout: today's high crossing the box's
 * +1% trigger, combined with this trading week's cumulative volume (already-
 * closed days from the daily cache + today's volume so far, live) crossing
 * darvas_engine's VOLUME_MULT (1.25x) times the trailing 10-week average.
 * Uses the SAME threshold as darvas_engine.js's actual entry logic -- kept
 * as one constant so the watcher never alerts on a bar the daily scan
 * wouldn't also treat as a real entry. The moment both fire for a symbol, it
 * Telegram-alerts once (deduped per symbol per week via
 * darvas_classic.watchlist_alerts) -- this is the only Telegram alerting in
 * this service; the daily scan itself is dashboard-only.
 *
 * No UPSTOX_ACCESS_TOKEN needed -- today's intraday candles come from the
 * same unauthenticated Upstox endpoint used for the daily backfill.
 */

const { DB } = require('./db');
const { fetchIntradayCandles } = require('./upstox_fetch');
const { weekKey } = require('./weekly_cache');
const { sendTelegram } = require('./telegram');
const { VOLUME_MULT } = require('./darvas_engine');
const symbolMap = require('./symbols.json');

const IST_OFFSET_MIN = 5 * 60 + 30;
const MARKET_OPEN_MIN = 9 * 60 + 15;   // 09:15 IST
const MARKET_CLOSE_MIN = 15 * 60 + 30; // 15:30 IST
const POLL_MS = 5 * 60 * 1000;         // 5 minutes
const CONCURRENCY = 4;

function istNow() {
  const ist = new Date(Date.now() + IST_OFFSET_MIN * 60 * 1000);
  return { minutesOfDay: ist.getUTCHours() * 60 + ist.getUTCMinutes(), dateStr: ist.toISOString().slice(0, 10), dayOfWeek: ist.getUTCDay() };
}
function isMarketHours() {
  const { minutesOfDay, dayOfWeek } = istNow();
  return dayOfWeek >= 1 && dayOfWeek <= 5 && minutesOfDay >= MARKET_OPEN_MIN && minutesOfDay < MARKET_CLOSE_MIN;
}

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

const f = (x) => (x == null ? '—' : Number(x).toFixed(2));

/** Sum of volumes for THIS trading week's already-closed days (Monday..yesterday), from the cached daily bars. */
function closedDaysVolumeThisWeek(dailyBars, todayStr) {
  if (!dailyBars || !dailyBars.length) return 0;
  const thisWeekStart = weekKey(todayStr);
  return dailyBars
    .filter((b) => b.date >= thisWeekStart && b.date < todayStr)
    .reduce((s, b) => s + b.volume, 0);
}

async function pollOnce(db) {
  const watchlist = await db.getWatchlist();
  if (!watchlist.length) { console.log('Watchlist poll: watchlist is empty, nothing to check.'); return; }
  const { dateStr: todayStr } = istNow();
  const weekStart = weekKey(todayStr);
  console.log(`Watchlist poll: checking ${watchlist.length} symbol(s) at ${new Date().toISOString()}`);

  let closest = null;
  await mapLimit(watchlist, CONCURRENCY, async (row) => {
    const instrumentKey = symbolMap[row.symbol];
    if (!instrumentKey) return;

    let intraday, dailyBars;
    try {
      [intraday, dailyBars] = await Promise.all([
        fetchIntradayCandles(instrumentKey, '1minute'),
        db.getDailyBars(row.symbol),
      ]);
    } catch (e) {
      console.warn(`  ${row.symbol}: intraday fetch failed — ${e.message}`);
      return;
    }
    if (!intraday.length) return; // no candles yet today (pre-market / just opened)

    const todayHigh = Math.max(...intraday.map((c) => c.high));
    const todayVolume = intraday.reduce((s, c) => s + c.volume, 0);
    const weekVolumeSoFar = closedDaysVolumeThisWeek(dailyBars, todayStr) + todayVolume;
    const avgVol = Number(row.avg_volume);
    const triggerPrice = Number(row.trigger_price);

    const priceOk = todayHigh >= triggerPrice;
    const volRatio = avgVol ? weekVolumeSoFar / avgVol : null;
    const volumeOk = volRatio != null && volRatio >= VOLUME_MULT;

    // Track the closest-to-firing candidate this poll for a one-line summary
    // log -- without this, a quiet poll (the common case) leaves no trace at
    // all to check "is this actually working." Ranked by volume ratio, not
    // price gap: volume is consistently the harder/slower constraint to
    // clear (confirmed 2026-08-24 -- price-gap ranking kept surfacing a
    // stock that had already broken out on price but was nowhere close on
    // volume, while a much closer-on-volume candidate went unmentioned).
    const priceGapPct = ((triggerPrice - todayHigh) / triggerPrice) * 100;
    if (!closest || (volRatio ?? -1) > (closest.volRatio ?? -1)) {
      closest = { symbol: row.symbol, priceGapPct, volRatio, priceOk, volumeOk };
    }

    if (!priceOk || !volumeOk) return;
    if (await db.hasAlertedThisWeek(row.symbol, weekStart)) return;

    await db.recordWatchlistAlert({ symbol: row.symbol, weekStart, alertPrice: todayHigh, volumeRatio: volRatio });
    await sendTelegram(
      `🟢 DARVAS CLASSIC BREAKOUT — ${row.symbol}\n` +
      `Box top ${f(row.box_top)} · Trigger ${f(triggerPrice)} · Today's high ${f(todayHigh)}\n` +
      `Week volume ${volRatio.toFixed(2)}x avg (>=${VOLUME_MULT}x required) · confirmed intraday, not yet in tomorrow's dashboard scan`
    );
  });

  if (closest) {
    console.log(
      `Watchlist poll done. Closest: ${closest.symbol} — ` +
      `${closest.priceOk ? 'price OK' : closest.priceGapPct.toFixed(1) + '% below trigger'}, ` +
      `volume ${closest.volRatio != null ? closest.volRatio.toFixed(2) + 'x avg' : 'n/a'} (need >=${VOLUME_MULT}x)`
    );
  }
}

async function loop() {
  const db = new DB();
  await db.init();
  console.log('Darvas Classic watchlist watcher: polling every 5 min during 09:15-15:30 IST market hours...');
  while (true) {
    if (isMarketHours()) {
      try { await pollOnce(db); } catch (e) { console.error('Watchlist poll failed:', e); }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

module.exports = { loop, isMarketHours, pollOnce };
