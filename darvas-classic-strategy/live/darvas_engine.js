'use strict';

/**
 * Classic Darvas Box (weekly) — pure state-machine engine.
 *
 * Rules (as specified in the "Classic Darvas Box · Weekly Trade Ledger"
 * reference backtest — see darvas-classic-strategy/README.md):
 *   - Box formation: a new 52-week high starts a forming box (top = that
 *     week's high, bottom = that week's low). A week that stays fully
 *     inside [bottom, top] counts toward containment; a week that makes a
 *     NEW high extends the top and resets the containment count; a week
 *     that breaks the bottom invalidates the forming box (must wait for
 *     the next fresh 52-week high to restart).
 *   - Box confirmation: 3 consecutive contained weeks -> box confirmed.
 *   - Entry: close/high breaks 1% above the confirmed box top, on volume
 *     >= 1.25x the trailing 10-week average volume (lookback not specified
 *     by the source spec; 10 weeks is this implementation's assumption —
 *     documented so it can be tuned).
 *   - Initial stop: 3% below entry.
 *   - Trailing stop: whenever a NEW box confirms while the position is
 *     open, the stop is raised (never lowered) to that box's bottom.
 *   - Pyramiding: every subsequent confirmed box's breakout (same 1%/1.25x
 *     trigger, off that box's own top) adds another leg. All legs in a
 *     group share one trailing stop and exit together.
 *   - Exit: a week whose low touches/breaks the current trailing stop
 *     closes every leg in the group at the stop price, same date.
 *   - Long only.
 *
 * Recomputes deterministically from the full weekly bar history every call
 * (no incremental state) — cheap at ~260 bars/symbol, and avoids state
 * drift between runs. The caller diffs the output against what was last
 * persisted to decide what's new since the previous run.
 */

const MIN_BOX_WEEKS = 3;
const BREAKOUT_PCT = 0.01;      // 1% above box top
const VOLUME_MULT = 1.25;       // >= 1.25x avg volume (lowered from 1.5x per explicit request, 2026-08-24)
const VOLUME_LOOKBACK = 10;     // weeks, trailing average (assumption -- see header)
const INITIAL_STOP_PCT = 0.03;  // 3% below entry
const HIGH_LOOKBACK = 52;       // weeks, rolling high gate to start a forming box

function avgVolume(bars, uptoIdxExclusive) {
  const start = Math.max(0, uptoIdxExclusive - VOLUME_LOOKBACK);
  const slice = bars.slice(start, uptoIdxExclusive);
  if (slice.length === 0) return null;
  return slice.reduce((s, b) => s + b.volume, 0) / slice.length;
}

function rollingHigh(bars, uptoIdxExclusive, lookback) {
  const start = Math.max(0, uptoIdxExclusive - lookback);
  const slice = bars.slice(start, uptoIdxExclusive);
  if (slice.length === 0) return -Infinity;
  return Math.max(...slice.map((b) => b.high));
}

/**
 * @param {Array<{date:string, open:number, high:number, low:number, close:number, volume:number}>} bars
 *   Weekly bars, ascending by date. The LAST bar may be the current,
 *   still-forming week (partial data) -- that's fine, it's treated like
 *   any other bar.
 * @returns {{ closedTrades: Array, openPosition: object|null, formingBox: object|null, confirmedBox: object|null }}
 */
function computeTradeLog(bars) {
  const closedTrades = [];
  let forming = null;     // { top, bottom, containedCount }
  let confirmed = null;   // { top, bottom }
  let position = null;    // { legs: [{legIndex, entryIdx, entryDate, entryPrice}], trailStop, totalLegs }
  let nextPositionId = 1; // shared across all legs of one pyramided group, so callers can regroup closedTrades/openPosition by position

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    // ---- 1. position management (uses box state as of strictly before this bar) ----
    if (position) {
      if (bar.low <= position.trailStop) {
        const exitPrice = position.trailStop;
        const exitReason = position.trailStop === position.initialStop ? 'STOP_LOSS' : 'TRAIL_STOP';
        for (const leg of position.legs) {
          closedTrades.push({
            positionId: position.positionId,
            legIndex: leg.legIndex,
            totalLegs: position.legs.length,
            entryDate: leg.entryDate,
            entryPrice: leg.entryPrice,
            exitDate: bar.date,
            exitPrice,
            exitReason,
          });
        }
        position = null;
      } else if (confirmed) {
        const avgVol = avgVolume(bars, i);
        const breakoutLevel = confirmed.top * (1 + BREAKOUT_PCT);
        const brokeOut = bar.high >= breakoutLevel && avgVol != null && bar.volume >= VOLUME_MULT * avgVol;
        if (brokeOut && !position.legs.some((l) => l.boxTop === confirmed.top)) {
          const legIndex = position.legs.length + 1;
          position.legs.push({
            legIndex,
            entryIdx: i,
            entryDate: bar.date,
            entryPrice: breakoutLevel,
            boxTop: confirmed.top,
          });
        }
      }
    } else if (confirmed) {
      const avgVol = avgVolume(bars, i);
      const breakoutLevel = confirmed.top * (1 + BREAKOUT_PCT);
      const brokeOut = bar.high >= breakoutLevel && avgVol != null && bar.volume >= VOLUME_MULT * avgVol;
      if (brokeOut) {
        const entryPrice = breakoutLevel;
        const initialStop = entryPrice * (1 - INITIAL_STOP_PCT);
        position = {
          positionId: nextPositionId++,
          legs: [{ legIndex: 1, entryIdx: i, entryDate: bar.date, entryPrice, boxTop: confirmed.top }],
          trailStop: initialStop,
          initialStop,
        };
      }
    }

    // ---- 2. box formation/confirmation (strictly prior-history gate, no lookahead) ----
    const priorHigh = rollingHigh(bars, i, HIGH_LOOKBACK);
    if (!forming) {
      if (bar.high > priorHigh) {
        forming = { top: bar.high, bottom: bar.low, containedCount: 0 };
      }
    } else {
      if (bar.low < forming.bottom) {
        forming = bar.high > priorHigh ? { top: bar.high, bottom: bar.low, containedCount: 0 } : null;
      } else if (bar.high > forming.top) {
        forming = { top: bar.high, bottom: forming.bottom, containedCount: 0 };
      } else {
        forming.containedCount += 1;
        if (forming.containedCount >= MIN_BOX_WEEKS) {
          confirmed = { top: forming.top, bottom: forming.bottom, confirmedDate: bar.date };
          forming = null;
          if (position && confirmed.bottom > position.trailStop) {
            position.trailStop = confirmed.bottom;
          }
        }
      }
    }
  }

  return {
    closedTrades,
    openPosition: position
      ? {
          positionId: position.positionId,
          legs: position.legs.map(({ legIndex, entryDate, entryPrice, boxTop }) => ({ legIndex, entryDate, entryPrice, boxTop })),
          trailStop: position.trailStop,
          totalLegs: position.legs.length,
        }
      : null,
    formingBox: forming,
    confirmedBox: confirmed,
  };
}

module.exports = { computeTradeLog, avgVolume, MIN_BOX_WEEKS, BREAKOUT_PCT, VOLUME_MULT, VOLUME_LOOKBACK, INITIAL_STOP_PCT, HIGH_LOOKBACK };
