'use strict';

/**
 * Backtest: "Opening Loser Short" scalp.
 *
 * Rules (as specified):
 *  - Universe: F&O-eligible ∩ halal-352 (137 stocks, symbols.json)
 *  - Screen ~30s after open (approximated here by the 09:15 1-min bar's
 *    open price vs prior day's close — finest resolution 1-min data allows)
 *  - No band restriction — pick the single top loser (most negative
 *    open-vs-prevClose %) across the whole universe, whatever the magnitude.
 *  - Halal filter is pre-applied at the universe level (symbols.json).
 *  - Entry: SHORT at the 09:15 bar's open price.
 *  - No stop-loss — the position runs uncapped until 09:30 or a circuit exit.
 *  - Lower-circuit exit: if the stock freezes (no traded volume for a bar)
 *    while the trade is open, exit immediately at the last traded price —
 *    see LIMITATIONS, this is a liquidity-freeze proxy, not a true circuit
 *    flag.
 *  - Exit: cover at 09:30 (09:30 bar's open price) if neither of the above
 *    fires first.
 *  - One trade per day (single top-loser pick across the whole universe).
 *
 * LIMITATIONS (read before trusting results):
 *  - No true lower-circuit flag in this data (Upstox 1-min candles don't
 *    carry exchange circuit-band info). The proxy used here is "a bar
 *    inside the holding window has zero traded volume" — i.e. the stock
 *    stopped printing trades, which is what a circuit freeze looks like
 *    from OHLC alone, but a merely illiquid quiet minute can look the same.
 *    This may misfire (exit early on a stock that wasn't actually
 *    circuit-locked) or miss real circuit locks that still print token
 *    trades — a known approximation, not silently hidden.
 *  - Removing the band means the top loser can now be an extreme mover
 *    (double-digit % down) — exactly the kind of name most likely to
 *    actually hit a real circuit, so this condition matters more now than
 *    it did under the -4%/-5% band.
 *  - 1-min bar resolution means "30 seconds after open" is approximated by
 *    the 09:15 bar's open (effectively t=0, not t=30s) and stop-checks
 *    within the entry bar itself can't distinguish whether the high came
 *    before or after entry — same "assume stop can hit same-bar" convention
 *    used elsewhere in this repo's daily-OHLC backtests, but here at 1-min
 *    resolution so the error window is much smaller (worst case ~60s).
 *  - No slippage modeled on entry, stop-fill, or circuit-exit fill; real
 *    fills on a stock already down sharply at the open will likely be
 *    worse, especially entry.
 */

const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, 'intraday_1min_cache.json');
const IST_OFFSET_MS = 5.5 * 3600000;

function istHHMM(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return d.toISOString().slice(11, 16);
}
function istDate(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return d.toISOString().slice(0, 10);
}

function main() {
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  const symbols = Object.keys(cache);

  // Index: symbol -> date -> [bars for that day, sorted]
  const bySymbolDay = {};
  // symbol -> sorted list of trading dates present
  const datesBySymbol = {};

  for (const sym of symbols) {
    const bars = cache[sym];
    const byDay = {};
    for (const b of bars) {
      const d = istDate(b.timestampMs);
      (byDay[d] = byDay[d] || []).push(b);
    }
    for (const d of Object.keys(byDay)) byDay[d].sort((a, b) => a.timestampMs - b.timestampMs);
    bySymbolDay[sym] = byDay;
    datesBySymbol[sym] = Object.keys(byDay).sort();
  }

  // Universe of all trading dates seen (union), sorted
  const allDatesSet = new Set();
  for (const sym of symbols) for (const d of datesBySymbol[sym]) allDatesSet.add(d);
  const allDates = [...allDatesSet].sort();

  // prevClose lookup: symbol -> date -> prior trading day's close (last bar of prior day THIS symbol traded)
  function prevClose(sym, dateIdx, dateList) {
    for (let i = dateIdx - 1; i >= 0; i--) {
      const d = dateList[i];
      const bars = bySymbolDay[sym][d];
      if (bars && bars.length) return { close: bars[bars.length - 1].close, date: d };
    }
    return null;
  }

  const trades = [];
  const skippedNoQualifier = [];

  for (const date of allDates) {
    // Build candidate list: symbols with a 09:15 bar today AND a resolvable prevClose
    const candidates = [];
    for (const sym of symbols) {
      const today = bySymbolDay[sym][date];
      if (!today || !today.length) continue;
      const bar915 = today.find((b) => istHHMM(b.timestampMs) === '09:15');
      if (!bar915 || !bar915.volume) continue; // no real print to establish entry from
      const dIdx = datesBySymbol[sym].indexOf(date);
      const pc = prevClose(sym, dIdx, datesBySymbol[sym]);
      if (!pc) continue;
      const pctChange = ((bar915.open - pc.close) / pc.close) * 100;
      candidates.push({ sym, date, bar915, prevClose: pc.close, pctChange, todayBars: today });
    }

    // Rank most-negative-first; no band — just take the single top loser.
    candidates.sort((a, b) => a.pctChange - b.pctChange);
    const pick = candidates[0];

    if (!pick || pick.pctChange >= 0) {
      skippedNoQualifier.push(date);
      continue;
    }

    // Simulate: SHORT at bar915.open, no SL, cover at 09:30 open (or circuit exit)
    const entry = pick.bar915.open;
    const barsFrom915 = pick.todayBars.filter((b) => {
      const t = istHHMM(b.timestampMs);
      return t >= '09:15' && t <= '09:29';
    });

    let exitPrice = null;
    let exitReason = 'TIME_930';
    let exitTime = '09:30';
    let lastTradedPrice = entry;

    for (const b of barsFrom915) {
      // Circuit/liquidity-freeze proxy: a bar with zero traded volume while
      // the trade is open — exit at the last price that actually traded.
      if (!b.volume) {
        exitPrice = lastTradedPrice;
        exitReason = 'CIRCUIT';
        exitTime = istHHMM(b.timestampMs);
        break;
      }
      lastTradedPrice = b.close;
    }

    if (exitPrice === null) {
      const bar930 = pick.todayBars.find((b) => istHHMM(b.timestampMs) === '09:30');
      if (bar930) {
        exitPrice = bar930.open;
      } else {
        // no 09:30 bar (e.g. thin trading) — fall back to last bar <= 09:30
        const upTo930 = pick.todayBars.filter((b) => istHHMM(b.timestampMs) <= '09:30');
        exitPrice = upTo930.length ? upTo930[upTo930.length - 1].close : entry;
      }
    }

    const pnlPct = ((entry - exitPrice) / entry) * 100; // SHORT: profit if exit < entry
    trades.push({
      date,
      symbol: pick.sym,
      direction: 'SHORT',
      prevClose: pick.prevClose,
      openPctChange: pick.pctChange,
      entry,
      exitPrice,
      exitReason,
      exitTime,
      pnlPct,
    });
  }

  fs.writeFileSync(path.join(__dirname, 'trades_opening_loser_short.json'), JSON.stringify(trades, null, 2));
  console.log(`Trading days scanned: ${allDates.length}`);
  console.log(`Trades taken: ${trades.length}`);
  console.log(`Days with no qualifier (no valid top loser that day): ${skippedNoQualifier.length}`);

  const wins = trades.filter((t) => t.pnlPct > 0).length;
  const grossAvg = trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : 0;
  const slHits = trades.filter((t) => t.exitReason === 'SL').length;
  const circuitHits = trades.filter((t) => t.exitReason === 'CIRCUIT').length;
  console.log(`Gross win rate: ${trades.length ? ((wins / trades.length) * 100).toFixed(1) : 0}%`);
  console.log(`Gross avg P&L/trade: ${grossAvg >= 0 ? '+' : ''}${grossAvg.toFixed(3)}%`);
  console.log(`Stopped out (SL): ${slHits}/${trades.length}`);
  console.log(`Circuit/freeze exits: ${circuitHits}/${trades.length}`);
}

main();
