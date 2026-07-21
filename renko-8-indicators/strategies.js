'use strict';

/**
 * 12 strategy definitions (8 individual indicators + 4 combination
 * frameworks) from the pasted source analysis, applied to Renko bricks.
 * Fresh build -- no logic shared with the earlier renko-strategy/ codebase.
 *
 * Each strategy exports { name, getEntry(i, ctx), getExit(i, ctx, pos), getStop(i, ctx, direction, entryIdx) }.
 * `ctx` = { bricks, stoch, bbands, donch, dmi14, dmi50, ao, sma50, sma20, sma10Offset }
 * (all precomputed once per symbol in backtest.js and reused across strategies).
 *
 * DISCLOSED DEFAULTS applied wherever the source left a rule unspecified:
 *   - Stop-loss (unspecified for every indicator except Darvas): the
 *     PREVIOUS brick's opposite extreme -- prevBrick.low for LONG,
 *     prevBrick.high for SHORT. A structural, Renko-native stop, applied
 *     uniformly so no strategy silently runs with unlimited risk.
 *   - Overbought/oversold for Stochastic: standard 80/20 (source says
 *     "standard rules referenced" without giving numbers).
 *   - Donchian offset: 10, matching Bollinger's suggested 10-15 (source:
 *     "used similarly to Bollinger Bands").
 *   - DMI length: 14 (traditional) for the standalone DMI indicator,
 *     since source tests 14 and 50 but "does not finalize a correct
 *     length." The DMI+Stochastic COMBO explicitly says "DMI(50)" in its
 *     own table row, so that combo uses 50 specifically.
 *   - Fibonacci: rolling 50-brick lookback for swing high/low, entry at
 *     the 61.8% retracement level (long) / its mirror (short), exit at a
 *     1.272 extension target -- the source itself flags this indicator's
 *     entry/exit as needing confirmation, so treat this as the most
 *     speculative of the 8, not a faithful unambiguous rule.
 *   - All exits described as "inferred" in the source are implemented as
 *     literally as the inference states.
 *
 * Every entry additionally requires the strategy's indicator warm-up
 * period to have elapsed (nulls skipped) and only fires when flat (one
 * position at a time per strategy per symbol).
 */

/**
 * Default stop, applied wherever the source leaves stop-loss unspecified:
 * exactly 1 brick-size away from entry, in the adverse direction.
 *
 * Originally tried "previous brick's opposite extreme" (a common ORB-style
 * structural stop), but that silently breaks here: several of these 8
 * indicators fire reversal signals on a brick still coloured the OPPOSITE
 * way from the trade direction (e.g. a bearish Stochastic cross can fire
 * on a brick that's still nominally 'up'). When that happens, the
 * previous brick sits on the WRONG side of entry, producing a "stop"
 * that's actually favorable to the position -- confirmed by inspecting
 * raw trades where STOP_LOSS exits showed positive P&L. A fixed
 * brick-size offset is correct by construction regardless of which
 * direction the signal brick itself moved.
 */
function prevBrickStop(i, ctx, direction, entryIdx) {
  const brick = ctx.bricks[entryIdx];
  const brickSize = Math.abs(brick.close - brick.open);
  return direction === 'LONG' ? brick.close - brickSize : brick.close + brickSize;
}

const strategies = [];

// ── 1. Stochastic Oscillator (5,3,3), crossover in oversold/overbought zone ──
strategies.push({
  name: 'Stochastic',
  getEntry(i, ctx) {
    const { k, d } = ctx.stoch;
    if (k[i] == null || d[i] == null || k[i - 1] == null || d[i - 1] == null) return null;
    const crossedUp = k[i - 1] <= d[i - 1] && k[i] > d[i];
    const crossedDown = k[i - 1] >= d[i - 1] && k[i] < d[i];
    if (crossedUp && k[i] < 20) return 'LONG';
    if (crossedDown && k[i] > 80) return 'SHORT';
    return null;
  },
  getExit(i, ctx, pos) {
    const { k, d } = ctx.stoch;
    if (k[i] == null || d[i] == null) return null;
    if (pos.direction === 'LONG' && k[i - 1] >= d[i - 1] && k[i] < d[i]) return 'OPPOSITE_CROSSOVER';
    if (pos.direction === 'SHORT' && k[i - 1] <= d[i - 1] && k[i] > d[i]) return 'OPPOSITE_CROSSOVER';
    return null;
  },
  getStop: prevBrickStop,
});

// ── 2. Bollinger Bands (20,2, offset 10) ──
strategies.push({
  name: 'BollingerBands',
  getEntry(i, ctx) {
    const { upper, lower } = ctx.bbands;
    if (upper[i] == null || lower[i] == null) return null;
    const c = ctx.bricks[i].close;
    if (c > upper[i]) return 'LONG';
    if (c < lower[i]) return 'SHORT';
    return null;
  },
  getExit(i, ctx, pos) {
    const { upper, lower } = ctx.bbands;
    if (upper[i] == null || lower[i] == null) return null;
    const c = ctx.bricks[i].close;
    const inside = c < upper[i] && c > lower[i];
    if (inside) return 'CLOSED_BACK_INSIDE_BAND';
    return null;
  },
  getStop: prevBrickStop,
});

// ── 3. Donchian Bands (length 52, offset 10) ──
strategies.push({
  name: 'DonchianBands',
  getEntry(i, ctx) {
    const { upper, lower } = ctx.donch;
    if (upper[i] == null || lower[i] == null) return null;
    const c = ctx.bricks[i].close;
    if (c > upper[i]) return 'LONG';
    if (c < lower[i]) return 'SHORT';
    return null;
  },
  getExit(i, ctx, pos) {
    const { upper, lower } = ctx.donch;
    if (upper[i] == null || lower[i] == null) return null;
    const c = ctx.bricks[i].close;
    if (c < upper[i] && c > lower[i]) return 'CLOSED_BACK_INSIDE_BAND';
    return null;
  },
  getStop: prevBrickStop,
});

// ── 4. Fibonacci Retracement (50-brick swing lookback) ──
const FIB_LOOKBACK = 50;
function fibLevels(ctx, i) {
  if (i < FIB_LOOKBACK) return null;
  let swingHigh = -Infinity, swingLow = Infinity;
  for (let j = i - FIB_LOOKBACK; j <= i; j++) {
    swingHigh = Math.max(swingHigh, ctx.bricks[j].high);
    swingLow = Math.min(swingLow, ctx.bricks[j].low);
  }
  const range = swingHigh - swingLow;
  return {
    swingHigh, swingLow, range,
    resistance618: swingLow + 0.618 * range, // long entry trigger
    support618: swingHigh - 0.618 * range,   // short entry trigger
    extLong: swingHigh + 0.272 * range,      // long target
    extShort: swingLow - 0.272 * range,      // short target
  };
}
strategies.push({
  name: 'FibonacciRetracement',
  getEntry(i, ctx) {
    const cur = fibLevels(ctx, i);
    const prev = fibLevels(ctx, i - 1);
    if (!cur || !prev) return null;
    const c = ctx.bricks[i].close;
    const pc = ctx.bricks[i - 1].close;
    if (pc <= prev.resistance618 && c > cur.resistance618) return 'LONG';
    if (pc >= prev.support618 && c < cur.support618) return 'SHORT';
    return null;
  },
  getExit(i, ctx, pos) {
    const c = ctx.bricks[i].close;
    if (pos.direction === 'LONG' && c >= pos.target) return 'EXTENSION_TARGET_HIT';
    if (pos.direction === 'SHORT' && c <= pos.target) return 'EXTENSION_TARGET_HIT';
    return null;
  },
  getStop: prevBrickStop,
  // Fibonacci needs a target computed at entry time -- attached via getEntryExtra, read by backtest.js.
  getEntryExtra(i, ctx, direction) {
    const levels = fibLevels(ctx, i);
    return { target: direction === 'LONG' ? levels.extLong : levels.extShort };
  },
});

// ── 5. Darvas Box (box length 8) -- source DOES specify the stop here ──
const DARVAS_LEN = 8;
strategies.push({
  name: 'DarvasBox',
  getEntry(i, ctx) {
    if (i < DARVAS_LEN) return null;
    let boxTop = -Infinity, boxBottom = Infinity;
    for (let j = i - DARVAS_LEN; j < i; j++) {
      boxTop = Math.max(boxTop, ctx.bricks[j].high);
      boxBottom = Math.min(boxBottom, ctx.bricks[j].low);
    }
    const c = ctx.bricks[i].close;
    if (c > boxTop) return 'LONG';
    if (c < boxBottom) return 'SHORT';
    return null;
  },
  getExit(i, ctx, pos) {
    // Trailing stop only (source: "implied trailing stop", "trail stops up as new boxes form").
    let boxTop = -Infinity, boxBottom = Infinity;
    const start = Math.max(0, i - DARVAS_LEN);
    for (let j = start; j < i; j++) {
      boxTop = Math.max(boxTop, ctx.bricks[j].high);
      boxBottom = Math.min(boxBottom, ctx.bricks[j].low);
    }
    if (pos.direction === 'LONG') {
      pos.trailStop = pos.trailStop == null ? boxBottom : Math.max(pos.trailStop, boxBottom);
      if (ctx.bricks[i].close < pos.trailStop) return 'TRAILING_BOX_STOP';
    } else {
      pos.trailStop = pos.trailStop == null ? boxTop : Math.min(pos.trailStop, boxTop);
      if (ctx.bricks[i].close > pos.trailStop) return 'TRAILING_BOX_STOP';
    }
    return null;
  },
  getStop: prevBrickStop, // initial hard backstop only; trailing box stop (above) is the real exit mechanism
});

// ── 6. DMI (14), state-transition (crossover) entry ──
strategies.push({
  name: 'DMI',
  getEntry(i, ctx) {
    const { plusDI, minusDI } = ctx.dmi14;
    if (plusDI[i] == null || minusDI[i] == null || plusDI[i - 1] == null || minusDI[i - 1] == null) return null;
    if (plusDI[i - 1] <= minusDI[i - 1] && plusDI[i] > minusDI[i]) return 'LONG';
    if (minusDI[i - 1] <= plusDI[i - 1] && minusDI[i] > plusDI[i]) return 'SHORT';
    return null;
  },
  getExit(i, ctx, pos) {
    const { plusDI, minusDI } = ctx.dmi14;
    if (plusDI[i] == null || minusDI[i] == null) return null;
    if (pos.direction === 'LONG' && minusDI[i] > plusDI[i]) return 'DI_FLIP';
    if (pos.direction === 'SHORT' && plusDI[i] > minusDI[i]) return 'DI_FLIP';
    return null;
  },
  getStop: prevBrickStop,
});

// ── 7. Awesome Oscillator (5,34), line-color change ──
strategies.push({
  name: 'AwesomeOscillator',
  getEntry(i, ctx) {
    const { color } = ctx.ao;
    if (color[i] == null || color[i - 1] == null) return null;
    if (color[i - 1] === 'red' && color[i] === 'green') return 'LONG';
    if (color[i - 1] === 'green' && color[i] === 'red') return 'SHORT';
    return null;
  },
  getExit(i, ctx, pos) {
    const { color } = ctx.ao;
    if (color[i] == null) return null;
    if (pos.direction === 'LONG' && color[i] === 'red') return 'AO_COLOR_FLIP';
    if (pos.direction === 'SHORT' && color[i] === 'green') return 'AO_COLOR_FLIP';
    return null;
  },
  getStop: prevBrickStop,
});

// ── 8. Moving Averages (50 SMA trend, 10 SMA offset-5 crosses through brick) ──
strategies.push({
  name: 'MovingAverages',
  getEntry(i, ctx) {
    const { sma50, sma10Offset } = ctx;
    if (sma50[i] == null || sma10Offset[i] == null || sma10Offset[i - 1] == null) return null;
    const brick = ctx.bricks[i];
    const c = brick.close;
    const crossedUpThroughBrick = sma10Offset[i - 1] < brick.low && sma10Offset[i] >= brick.low && sma10Offset[i] <= brick.high;
    const crossedDownThroughBrick = sma10Offset[i - 1] > brick.high && sma10Offset[i] <= brick.high && sma10Offset[i] >= brick.low;
    if (c > sma50[i] && crossedUpThroughBrick) return 'LONG';
    if (c < sma50[i] && crossedDownThroughBrick) return 'SHORT';
    return null;
  },
  getExit(i, ctx, pos) {
    const { sma50 } = ctx;
    if (sma50[i] == null) return null;
    const c = ctx.bricks[i].close;
    if (pos.direction === 'LONG' && c < sma50[i]) return 'CROSSED_BACK_BELOW_50SMA';
    if (pos.direction === 'SHORT' && c > sma50[i]) return 'CROSSED_BACK_ABOVE_50SMA';
    return null;
  },
  getStop: prevBrickStop,
});

// ── COMBO A: Trend-Momentum (DMI(50) state + Stochastic crossover) ──
strategies.push({
  name: 'Combo_TrendMomentum_DMI50_Stoch',
  getEntry(i, ctx) {
    const { plusDI, minusDI } = ctx.dmi50;
    const { k, d } = ctx.stoch;
    if (plusDI[i] == null || minusDI[i] == null || k[i] == null || d[i] == null || k[i - 1] == null || d[i - 1] == null) return null;
    const crossedUp = k[i - 1] <= d[i - 1] && k[i] > d[i];
    const crossedDown = k[i - 1] >= d[i - 1] && k[i] < d[i];
    if (plusDI[i] > minusDI[i] && crossedUp) return 'LONG';
    if (minusDI[i] > plusDI[i] && crossedDown) return 'SHORT';
    return null;
  },
  getExit(i, ctx, pos) {
    const { k, d } = ctx.stoch;
    if (k[i] == null || d[i] == null) return null;
    if (pos.direction === 'LONG' && k[i - 1] >= d[i - 1] && k[i] < d[i]) return 'STOCH_CROSS_DOWN';
    if (pos.direction === 'SHORT' && k[i - 1] <= d[i - 1] && k[i] > d[i]) return 'STOCH_CROSS_UP';
    return null;
  },
  getStop: prevBrickStop,
});

// ── COMBO B: Color-Flow (AO turns green/red while Stochastic crosses) ──
strategies.push({
  name: 'Combo_ColorFlow_AO_Stoch',
  getEntry(i, ctx) {
    const { color } = ctx.ao;
    const { k, d } = ctx.stoch;
    if (color[i] == null || k[i] == null || d[i] == null || k[i - 1] == null || d[i - 1] == null) return null;
    const crossedUp = k[i - 1] <= d[i - 1] && k[i] > d[i];
    const crossedDown = k[i - 1] >= d[i - 1] && k[i] < d[i];
    if (color[i] === 'green' && crossedUp) return 'LONG';
    if (color[i] === 'red' && crossedDown) return 'SHORT';
    return null;
  },
  getExit(i, ctx, pos) {
    const { color } = ctx.ao;
    const { k, d } = ctx.stoch;
    if (color[i] == null) return null;
    if (pos.direction === 'LONG' && (color[i] === 'red' || (k[i] != null && d[i] != null && k[i - 1] >= d[i - 1] && k[i] < d[i]))) return 'AO_RED_OR_STOCH_DOWN';
    if (pos.direction === 'SHORT' && (color[i] === 'green' || (k[i] != null && d[i] != null && k[i - 1] <= d[i - 1] && k[i] > d[i]))) return 'AO_GREEN_OR_STOCH_UP';
    return null;
  },
  getStop: prevBrickStop,
});

// ── COMBO C: Multi-MA Timing (price > 50 SMA + 10 SMA offset-5 crosses through brick) ──
// Identical rule to standalone MovingAverages #8 -- the source describes them as the
// same mechanism (one row given for Long only in the combo table); included separately
// since the source lists it as a distinct named framework, mirrored to Short for symmetry.
strategies.push({
  name: 'Combo_MultiMA_Timing',
  getEntry(i, ctx) {
    return strategies[7].getEntry(i, ctx); // reuse MovingAverages' exact rule
  },
  getExit(i, ctx, pos) {
    return strategies[7].getExit(i, ctx, pos);
  },
  getStop: prevBrickStop,
});

module.exports = { strategies, FIB_LOOKBACK, DARVAS_LEN };
