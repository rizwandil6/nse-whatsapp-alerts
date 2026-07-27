'use strict';

/**
 * Traditional Renko brick construction (no wicks) -- fresh implementation,
 * not shared with the earlier renko-strategy/ codebase. Standard algorithm:
 * a brick prints the instant price moves one brick-size beyond the last
 * brick's close in the SAME direction; a REVERSAL (opposite direction)
 * requires a 2x brick-size move, per "Traditional" Renko convention
 * (TradingView's Traditional Renko mode has no separate reversal-amount
 * setting -- it's always 2x brick size). Built from each 5-min candle's
 * CLOSE only (not high/low path within the candle) -- a disclosed
 * simplification, since 5-min OHLC candles don't tell us the true
 * intra-candle price path a tick-built Renko chart would have used.
 *
 * Renko bricks are NOT reset daily -- Renko is a price-triggered chart,
 * not a time-triggered one, and no real platform resets it at each day's
 * open. Continuity is preserved across the whole multi-day series;
 * "intraday" is instead enforced at the trade level by the backtest
 * runner (entries only during market hours, forced EOD square-off) --
 * a standard domain convention for equity intraday backtests, not
 * anything specific to the earlier renko-strategy implementation.
 *
 * Brick size is fixed once per symbol as (first candle's close) x brickPct,
 * held constant for that symbol's entire brick series.
 */

function buildRenkoBricks(candles, brickPct) {
  if (candles.length === 0) return [];
  const brickSize = candles[0].close * brickPct;
  const bricks = [];
  let lastClose = candles[0].close;
  let direction = 0; // 0 = none yet, 1 = up, -1 = down

  for (const c of candles) {
    const price = c.close;
    // A single candle can trigger multiple bricks on a big move -- loop.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (direction !== -1 && price >= lastClose + brickSize) {
        const open = lastClose;
        lastClose += brickSize;
        direction = 1;
        bricks.push(makeBrick(open, lastClose, 'up', c));
        continue;
      }
      if (direction !== 1 && price <= lastClose - brickSize) {
        const open = lastClose;
        lastClose -= brickSize;
        direction = -1;
        bricks.push(makeBrick(open, lastClose, 'down', c));
        continue;
      }
      if (direction === 1 && price <= lastClose - 2 * brickSize) {
        const open = lastClose;
        lastClose -= brickSize;
        direction = -1;
        bricks.push(makeBrick(open, lastClose, 'down', c));
        continue;
      }
      if (direction === -1 && price >= lastClose + 2 * brickSize) {
        const open = lastClose;
        lastClose += brickSize;
        direction = 1;
        bricks.push(makeBrick(open, lastClose, 'up', c));
        continue;
      }
      break;
    }
  }
  return bricks;
}

function makeBrick(open, close, direction, sourceCandle) {
  return {
    open,
    close,
    direction,
    high: Math.max(open, close),
    low: Math.min(open, close),
    timestampMs: sourceCandle.timestampMs,
    volume: sourceCandle.volume,
  };
}

module.exports = { buildRenkoBricks };
