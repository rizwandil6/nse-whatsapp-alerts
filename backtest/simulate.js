'use strict';

const { Action, decide } = require('./tradeRules');

/**
 * Simulates one trade against a sequence of 1-minute OHLC candles starting at
 * (or just after) entry. Each candle: {timestampMs, open, high, low, close}.
 *
 * LIMITATION: live monitoring polls LTP every 3 seconds; 1-minute candles are the
 * finest granularity Upstox's historical API offers. To approximate intra-candle
 * moves instead of only checking the close, each candle is evaluated using its LOW
 * for downside triggers (hard stop, trailing stop) and its HIGH for upside triggers
 * (partial-exit target) — hard stop is checked before target within the same candle,
 * so a candle that plausibly touches both within the same minute resolves to the
 * conservative (bad) outcome rather than the lucky one. This is a real approximation
 * of what a 3-second poll would have caught, not a tick-accurate replay.
 *
 * @param {number} entryPrice
 * @param {number} entryTimeMs
 * @param {Array<{timestampMs:number, open:number, high:number, low:number, close:number}>} candles
 *        Must be sorted ascending by timestampMs, starting at/after entryTimeMs.
 * @param {{targetPct:number, stopLossPct:number, trailPct:number, timeExitMinutes:number}} params
 * @returns {{events:Array, partial:Object|null, final:Object|null, pnlPctOfCapital:number}}
 */
function simulateTrade(entryPrice, entryTimeMs, candles, params) {
  let maxGainPct = 0;
  let partialExitDone = false;
  const events = [];

  for (const candle of candles) {
    const ageMinutes = Math.floor((candle.timestampMs - entryTimeMs) / 60000);
    const lowGainPct = ((candle.low - entryPrice) / entryPrice) * 100;
    const highGainPct = ((candle.high - entryPrice) / entryPrice) * 100;
    const closeGainPct = ((candle.close - entryPrice) / entryPrice) * 100;
    maxGainPct = Math.max(maxGainPct, highGainPct);

    // 1. Time exit — independent of price
    let decision = decide(params, closeGainPct, maxGainPct, partialExitDone, ageMinutes);
    if (decision.action === Action.TIME_EXIT) {
      events.push(toEvent(decision, candle.close, candle.timestampMs, closeGainPct));
      return finish(events);
    }

    // 2. Hard stop — worst case within the minute
    decision = decide(params, lowGainPct, maxGainPct, partialExitDone, ageMinutes);
    if (decision.action === Action.HARD_STOP) {
      events.push(toEvent(decision, candle.low, candle.timestampMs, lowGainPct));
      return finish(events);
    }

    // 3. Partial exit at target — best case within the minute
    if (!partialExitDone) {
      decision = decide(params, highGainPct, maxGainPct, partialExitDone, ageMinutes);
      if (decision.action === Action.PARTIAL_EXIT) {
        partialExitDone = true;
        events.push(toEvent(decision, candle.high, candle.timestampMs, highGainPct));
        continue;
      }
    }

    // 4. Trailing stop on remaining half — worst case within the minute
    if (partialExitDone) {
      decision = decide(params, lowGainPct, maxGainPct, partialExitDone, ageMinutes);
      if (decision.action === Action.TRAIL_STOP) {
        events.push(toEvent(decision, candle.low, candle.timestampMs, lowGainPct));
        return finish(events);
      }
    }
  }

  const last = candles[candles.length - 1];
  if (last) {
    const gainPct = ((last.close - entryPrice) / entryPrice) * 100;
    events.push({
      action: 'DATA_EXHAUSTED',
      reason: 'Candle data ran out before any exit rule fired',
      price: last.close,
      timestampMs: last.timestampMs,
      gainPct,
    });
  }
  return finish(events);
}

function toEvent(decision, price, timestampMs, gainPct) {
  return { action: decision.action, reason: decision.reason, price, timestampMs, gainPct };
}

function finish(events) {
  const partial = events.find((e) => e.action === Action.PARTIAL_EXIT) || null;
  const final = events.filter((e) => e.action !== Action.PARTIAL_EXIT).at(-1) || null;

  // P&L as a percent of the ORIGINAL capital: 50% of qty realizes the partial-exit
  // gain, the other 50% (or 100% if no partial exit fired) realizes the final gain.
  let pnlPctOfCapital = 0;
  if (partial && final) {
    pnlPctOfCapital = 0.5 * partial.gainPct + 0.5 * final.gainPct;
  } else if (final) {
    pnlPctOfCapital = final.gainPct;
  }

  return { events, partial, final, pnlPctOfCapital };
}

module.exports = { simulateTrade };
