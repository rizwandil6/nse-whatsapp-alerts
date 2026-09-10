'use strict';

/**
 * Classic Darvas Box (weekly) — pure state-machine engine.
 *
 * Rules (as specified in the "Classic Darvas Box · Weekly Trade Ledger"
 * reference backtest — see darvas-classic-strategy/README.md):
 *   - Box formation: a week whose high breaks the FIXED high of the prior
 *     complete calendar year starts a forming box (top = that week's high,
 *     bottom = that week's low) -- e.g. for any week in 2025, the gate is
 *     2024's Jan-Dec high, a single number that doesn't change as 2025's
 *     weeks roll by (corrected 2026-09-09 from a rolling 52-bar window,
 *     which could "forget" a genuine higher peak the moment it aged past
 *     bar #52 -- see calendarYearHighs() below). A week that stays fully
 *     inside [bottom, top] counts toward containment; a week that makes a
 *     NEW high extends the top and resets the containment count; a week
 *     that breaks the bottom invalidates the forming box (must wait for
 *     the next break of that same fixed prior-year high to restart).
 *   - Box confirmation: 3 consecutive contained weeks -> box confirmed.
 *   - Entry: close/high breaks 1% above the confirmed box top, on volume
 *     >= 1.25x the trailing 10-week average volume (lookback not specified
 *     by the source spec; 10 weeks is this implementation's assumption —
 *     documented so it can be tuned), AND daily RSI(14) > 70 AND close above
 *     EMA50/100/200, all at the time of breakout (added 2026-09-10 per
 *     explicit request + backtest: RSI alone roughly halved trade count but
 *     took return 8.47% -> 19.95%, win rate 44% -> 71%; adding EMA50/100/200
 *     on top nudged that further to 22.26%/73% -- a small, near-redundant
 *     improvement over RSI alone, kept per explicit instruction).
 *   - Initial stop: 6% below entry.
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
const INITIAL_STOP_PCT = 0.06;  // 6% below entry (widened from 3% per explicit request, 2026-09-09 -- backtested +1.29pp avg/position vs 3% on 2025 data)
const RSI_PERIOD = 14;          // daily
const RSI_THRESHOLD = 70;       // added 2026-09-10 -- see header
const EMA_PERIODS = [50, 100, 200]; // daily, added 2026-09-10 -- see header

function avgVolume(bars, uptoIdxExclusive) {
  const start = Math.max(0, uptoIdxExclusive - VOLUME_LOOKBACK);
  const slice = bars.slice(start, uptoIdxExclusive);
  if (slice.length === 0) return null;
  return slice.reduce((s, b) => s + b.volume, 0) / slice.length;
}

// Fixed-calendar-year high per year present in `bars` -- e.g. map.get(2024) is
// the highest weekly high anywhere in Jan-Dec 2024. Corrected 2026-09-09: the
// box-formation gate previously used a rolling 52-BAR window, which "forgets"
// a genuine higher peak the moment it ages past bar #52 -- confirmed on
// NESTLEIND: Sep 23 2024's 1389 high was excluded from the reference for an
// Oct 2025 bar purely because it fell a few bars outside a 52-bar slice,
// letting a lower 1311.60 pass as a "new high." Fixed-calendar-year avoids
// that: a bar in year Y is checked against the ENTIRE prior calendar year
// Y-1's high, a number that doesn't shift as weeks roll by -- exactly "fetch
// previous year's high, then check forward for the break."
function calendarYearHighs(bars) {
  const map = new Map();
  for (const b of bars) {
    const year = Number(b.date.slice(0, 4));
    map.set(year, Math.max(map.get(year) ?? -Infinity, b.high));
  }
  return map;
}

// Wilder's RSI(14) on daily closes. Standard smoothing: first avg gain/loss
// is a plain average of the first RSI_PERIOD deltas, every value after that
// rolls forward with the (period-1)/period Wilder smoothing factor.
function dailyRsi(dailyBars) {
  const out = new Array(dailyBars.length).fill(null);
  if (dailyBars.length < RSI_PERIOD + 1) return out;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= RSI_PERIOD; i++) {
    const delta = dailyBars[i].close - dailyBars[i - 1].close;
    if (delta >= 0) gainSum += delta; else lossSum -= delta;
  }
  let avgGain = gainSum / RSI_PERIOD, avgLoss = lossSum / RSI_PERIOD;
  out[RSI_PERIOD] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = RSI_PERIOD + 1; i < dailyBars.length; i++) {
    const delta = dailyBars[i].close - dailyBars[i - 1].close;
    const gain = delta >= 0 ? delta : 0, loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (RSI_PERIOD - 1) + gain) / RSI_PERIOD;
    avgLoss = (avgLoss * (RSI_PERIOD - 1) + loss) / RSI_PERIOD;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// Standard EMA, seeded with a plain SMA of the first `period` closes (same
// convention as dailyRsi's Wilder seed above).
function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Duplicated from weekly_cache.js's weekKey() (Monday of the trading week a
// date falls in) rather than imported -- this module is documented as a pure
// state-machine engine with no I/O/module dependencies, and this is 6 lines.
function weekKeyOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay();
  const diffToMonday = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diffToMonday);
  return d.toISOString().slice(0, 10);
}

// Map<weekMondayDate, boolean> -- true only if, on the LAST daily bar of that
// week (a later day in the same week overwrites an earlier one, so this
// naturally ends up as the week's most recent trading day): RSI(14) >
// RSI_THRESHOLD AND close is above EMA50, EMA100, AND EMA200 (added
// 2026-09-10 alongside RSI per explicit request -- backtested on top of the
// RSI-only gate: 138->137 legs, return 22.07%->22.26%, win rate 72.5%->73% --
// confirms the earlier finding that EMA is nearly redundant with RSI alone,
// kept anyway per explicit instruction). A week with no daily bars mapped to
// it, or not enough RSI/EMA history yet, is simply absent from the map --
// gatePasses() below treats that as "no", not "yes by default".
function weeklyRsiGate(dailyBars) {
  const rsi = dailyRsi(dailyBars);
  const closes = dailyBars.map((b) => b.close);
  const emas = EMA_PERIODS.map((p) => ema(closes, p));
  const gate = new Map();
  for (let i = 0; i < dailyBars.length; i++) {
    if (rsi[i] == null) continue;
    if (emas.some((e) => e[i] == null)) continue;
    const close = dailyBars[i].close;
    const pass = rsi[i] > RSI_THRESHOLD && emas.every((e) => close > e[i]);
    gate.set(weekKeyOf(dailyBars[i].date), pass);
  }
  return gate;
}

/**
 * @param {Array<{date:string, open:number, high:number, low:number, close:number, volume:number}>} bars
 *   Weekly bars, ascending by date. The LAST bar may be the current,
 *   still-forming week (partial data) -- that's fine, it's treated like
 *   any other bar.
 * @param {Array<{date:string, close:number}>} [dailyBars] -- daily candles
 *   for the SAME symbol (ascending by date), used to compute the
 *   RSI(14)>70 AND close>EMA50/100/200 entry condition. Production callers
 *   (runner.js) always pass this. If omitted, the gate is simply not applied
 *   (permissive) -- useful for isolated box-mechanics testing that doesn't
 *   care about RSI/EMA at all.
 * @param {{initialStopPct?: number, independentLegStops?: boolean, dailyGate?: Map|Function}} [overrides]
 *   -- for sensitivity analysis only; production callers pass nothing and
 *   get INITIAL_STOP_PCT with one shared group-level trailing stop, and the
 *   default RSI(14)>70+EMA50/100/200 gate derived from dailyBars. independentLegStops=true
 *   switches to each pyramid leg carrying its OWN trailing stop (own initial
 *   entry*(1-pct), independently raised by later box confirmations,
 *   independently exited) instead of the whole group sharing one stop set
 *   from leg 1. Under the shared-stop default, a late pyramid add can lose
 *   far more than the nominal stop % if the group gets stopped out at leg
 *   1's (much lower) level before any new box confirms -- confirmed live
 *   2025 backtest: a leg entered at 853 lost -33.5% when the group's shared
 *   stop, set from a leg entered near 585, finally hit. overrides.dailyGate
 *   (a Map<weekDate,boolean> or (weekDate)=>boolean), when given, REPLACES
 *   the default RSI-derived gate entirely -- for testing a different daily
 *   condition (e.g. an EMA-only gate) instead of RSI.
 * @returns {{ closedTrades: Array, openPosition: object|null, formingBox: object|null, confirmedBox: object|null }}
 */
function computeTradeLog(bars, dailyBars, overrides) {
  const initialStopPct = overrides?.initialStopPct ?? INITIAL_STOP_PCT;
  const independentLegStops = overrides?.independentLegStops ?? false;
  // Entry condition beyond price+volume: by default, RSI(14)>70 AND
  // close>EMA50/100/200 derived from dailyBars (see header) -- EVERY entry
  // (fresh or pyramid leg) requires this to be true for that week's date.
  // overrides.dailyGate replaces it entirely (ad-hoc backtest use); passing
  // neither dailyBars nor an override leaves the gate permissive (always
  // passes).
  const dailyGate = overrides?.dailyGate ?? (dailyBars ? weeklyRsiGate(dailyBars) : null);
  function gatePasses(barDate) {
    if (!dailyGate) return true;
    return typeof dailyGate === 'function' ? dailyGate(barDate) === true : dailyGate.get(barDate) === true;
  }
  const yearHighs = calendarYearHighs(bars); // fixed prior-calendar-year high gate -- see calendarYearHighs() header
  const closedTrades = [];
  let forming = null;     // { top, bottom, containedCount }
  let confirmed = null;   // { top, bottom }
  let position = null;    // shared-stop mode: { legs, trailStop, initialStop }. independent mode: { legs: [{..., trailStop, initialStop}], nextLegIndex, totalEverOpened }
  let nextPositionId = 1; // shared across all legs of one pyramided group, so callers can regroup closedTrades/openPosition by position

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    // ---- 1. position management (uses box state as of strictly before this bar) ----
    if (independentLegStops) {
      if (position) {
        const stillActive = [];
        for (const leg of position.legs) {
          if (bar.low <= leg.trailStop) {
            closedTrades.push({
              positionId: position.positionId,
              legIndex: leg.legIndex,
              totalLegs: position.totalEverOpened,
              entryDate: leg.entryDate,
              entryPrice: leg.entryPrice,
              exitDate: bar.date,
              exitPrice: leg.trailStop,
              exitReason: leg.trailStop === leg.initialStop ? 'STOP_LOSS' : 'TRAIL_STOP',
            });
          } else {
            stillActive.push(leg);
          }
        }
        position.legs = stillActive;
        if (position.legs.length === 0) {
          position = null;
        } else if (confirmed) {
          const avgVol = avgVolume(bars, i);
          const breakoutLevel = confirmed.top * (1 + BREAKOUT_PCT);
          const brokeOut = bar.high >= breakoutLevel && avgVol != null && bar.volume >= VOLUME_MULT * avgVol && gatePasses(bar.date);
          if (brokeOut && !position.legs.some((l) => l.boxTop === confirmed.top)) {
            const initialStop = breakoutLevel * (1 - initialStopPct);
            position.legs.push({
              legIndex: position.nextLegIndex++,
              entryIdx: i, entryDate: bar.date, entryPrice: breakoutLevel, boxTop: confirmed.top,
              trailStop: initialStop, initialStop,
            });
            position.totalEverOpened++;
          }
        }
      } else if (confirmed) {
        const avgVol = avgVolume(bars, i);
        const breakoutLevel = confirmed.top * (1 + BREAKOUT_PCT);
        const brokeOut = bar.high >= breakoutLevel && avgVol != null && bar.volume >= VOLUME_MULT * avgVol && gatePasses(bar.date);
        if (brokeOut) {
          const initialStop = breakoutLevel * (1 - initialStopPct);
          position = {
            positionId: nextPositionId++,
            legs: [{ legIndex: 1, entryIdx: i, entryDate: bar.date, entryPrice: breakoutLevel, boxTop: confirmed.top, trailStop: initialStop, initialStop }],
            nextLegIndex: 2,
            totalEverOpened: 1,
          };
        }
      }
    } else if (position) {
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
        const brokeOut = bar.high >= breakoutLevel && avgVol != null && bar.volume >= VOLUME_MULT * avgVol && gatePasses(bar.date);
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
      const brokeOut = bar.high >= breakoutLevel && avgVol != null && bar.volume >= VOLUME_MULT * avgVol && gatePasses(bar.date);
      if (brokeOut) {
        const entryPrice = breakoutLevel;
        const initialStop = entryPrice * (1 - initialStopPct);
        position = {
          positionId: nextPositionId++,
          legs: [{ legIndex: 1, entryIdx: i, entryDate: bar.date, entryPrice, boxTop: confirmed.top }],
          trailStop: initialStop,
          initialStop,
        };
      }
    }

    // ---- 2. box formation/confirmation (strictly prior-history gate, no lookahead) ----
    // Fixed prior-calendar-year high, not a rolling 52-bar window -- see
    // calendarYearHighs() header. -Infinity (no gate at all) only for a bar
    // whose year has no complete prior year in the data at all.
    const priorHigh = yearHighs.get(Number(bar.date.slice(0, 4)) - 1) ?? -Infinity;
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
          if (position) {
            if (independentLegStops) {
              for (const leg of position.legs) {
                if (confirmed.bottom > leg.trailStop) leg.trailStop = confirmed.bottom;
              }
            } else if (confirmed.bottom > position.trailStop) {
              position.trailStop = confirmed.bottom;
            }
          }
        }
      }
    }
  }

  return {
    closedTrades,
    openPosition: position
      ? independentLegStops
        ? {
            positionId: position.positionId,
            legs: position.legs.map(({ legIndex, entryDate, entryPrice, boxTop, trailStop }) => ({ legIndex, entryDate, entryPrice, boxTop, trailStop })),
            totalLegs: position.totalEverOpened,
          }
        : {
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

module.exports = { computeTradeLog, avgVolume, calendarYearHighs, dailyRsi, ema, weeklyRsiGate, MIN_BOX_WEEKS, BREAKOUT_PCT, VOLUME_MULT, VOLUME_LOOKBACK, INITIAL_STOP_PCT, RSI_PERIOD, RSI_THRESHOLD, EMA_PERIODS };
