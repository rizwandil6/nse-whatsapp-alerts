'use strict';

/**
 * Triple RSI Strategy — pure signal engine, mirrors the vault's canonical
 * backtest exactly (wiki/concepts/triple-rsi-strategy.md, mandatory config
 * locked in 2026-09-19/20):
 *
 * Entry (buy at close), all of:
 *   1. RSI(5) < 30
 *   2. RSI(5) down 3 days running
 *   3. RSI(5) was < 60 three trading days ago
 *   4. close > 200-day MA
 *   5. close >= 15% above the 200-day MA
 *
 * Exit (sell at close): RSI(5) crosses above 50, but not before 7 trading
 * days have passed since entry. A 15% stop-loss (checked against the day's
 * intraday low, fills at the stop price) can fire at any time, including
 * before day 7, and always takes priority over the RSI exit.
 *
 * Recomputes the full trade history from the daily bar array on every call
 * -- no incremental state, so there's nothing to drift (same philosophy as
 * darvas_engine.js in this repo). Bars must be ascending by date.
 */

const RSI_LEN = 5;
const RSI_OVERSOLD = 30;
const RSI_PRIOR_LEVEL = 60;
const RSI_EXIT_LEVEL = 50;
const MA_LEN = 200;
const MIN_DIST_PCT = 15.0;
const STOP_PCT = 0.15;
const MIN_HOLD_BARS = 7;

/** Wilder RSI (matches pandas .ewm(alpha=1/period, adjust=False).mean() far past warmup). */
function computeRSI(closes, period = RSI_LEN) {
  const n = closes.length;
  const rsi = new Array(n).fill(null);
  if (n < period + 2) return rsi;

  const gains = new Array(n).fill(0);
  const losses = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const diff = closes[i] - closes[i - 1];
    gains[i] = diff > 0 ? diff : 0;
    losses[i] = diff < 0 ? -diff : 0;
  }

  const alpha = 1 / period;
  let avgGain = gains[1];
  let avgLoss = losses[1];
  for (let i = 2; i < n; i++) {
    avgGain = alpha * gains[i] + (1 - alpha) * avgGain;
    avgLoss = alpha * losses[i] + (1 - alpha) * avgLoss;
    if (i >= period) {
      const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
      rsi[i] = avgLoss === 0 && avgGain === 0 ? 50 : 100 - 100 / (1 + rs);
    }
  }
  return rsi;
}

function computeSMA(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * bars: [{date, open, high, low, close, volume}, ...] ascending.
 * Returns { closedTrades: [...], openPosition: {...} | null, lastEntryCondition: bool }.
 * Each closed trade / the open position: { entryDate, entryPrice, stopPrice, exitDate,
 * exitPrice, exitReason, returnPct, barsHeld }.
 */
function computeTradeLog(bars) {
  const n = bars.length;
  const closes = bars.map((b) => b.close);
  const rsi = computeRSI(closes, RSI_LEN);
  const ma200 = computeSMA(closes, MA_LEN);

  const closedTrades = [];
  let openPosition = null;
  let inPos = false;
  let entryIdx = -1, entryPrice = 0, entryDate = null, stopPrice = 0;

  for (let i = 0; i < n; i++) {
    if (rsi[i] == null || ma200[i] == null) continue;

    if (!inPos) {
      if (i < 3 || rsi[i - 1] == null || rsi[i - 2] == null || rsi[i - 3] == null) continue;
      const down3 = rsi[i] < rsi[i - 1] && rsi[i - 1] < rsi[i - 2] && rsi[i - 2] < rsi[i - 3];
      const rsi3ago = rsi[i - 3];
      const distPct = (closes[i] / ma200[i] - 1) * 100;
      const entryCond = rsi[i] < RSI_OVERSOLD && down3 && rsi3ago < RSI_PRIOR_LEVEL &&
        closes[i] > ma200[i] && distPct >= MIN_DIST_PCT;
      if (entryCond) {
        inPos = true;
        entryIdx = i;
        entryPrice = closes[i];
        entryDate = bars[i].date;
        stopPrice = entryPrice * (1 - STOP_PCT);
      }
    } else {
      const barsHeld = i - entryIdx;
      const hitStop = bars[i].low <= stopPrice;
      const hitRsi = barsHeld >= MIN_HOLD_BARS && rsi[i] > RSI_EXIT_LEVEL;
      if (hitStop || hitRsi) {
        const exitPrice = hitStop ? stopPrice : closes[i];
        const exitReason = hitStop ? 'stop' : 'rsi';
        const returnPct = ((exitPrice - entryPrice) / entryPrice) * 100;
        closedTrades.push({
          entryDate, entryPrice, stopPrice, exitDate: bars[i].date, exitPrice,
          exitReason, returnPct, barsHeld,
        });
        inPos = false;
      }
    }
  }

  if (inPos) {
    const lastIdx = n - 1;
    const barsHeld = lastIdx - entryIdx;
    const lastClose = closes[lastIdx];
    openPosition = {
      entryDate, entryPrice, stopPrice, barsHeld,
      minHoldSatisfied: barsHeld >= MIN_HOLD_BARS,
      lastPrice: lastClose,
      unrealizedPct: ((lastClose - entryPrice) / entryPrice) * 100,
    };
  }

  return { closedTrades, openPosition };
}

module.exports = { computeTradeLog, computeRSI, computeSMA, MIN_HOLD_BARS, STOP_PCT, MIN_DIST_PCT };
