"""
Percentage-based Renko brick construction.

Standard "Traditional" Renko: a brick prints the instant price moves one
brick-size beyond the last brick's close in the SAME direction; a reversal
(opposite direction) requires a 2x brick-size move. No wicks -- a brick's
high/low is just max/min(open, close) of that brick, never the real
intracandle price path (see USE_CLOSE_OR_HL below for the one partial
exception, and its own documented caveat).

Brick size is expressed as a PERCENTAGE, not absolute points, and can be
computed two ways (config.FIXED_VS_DYNAMIC_PCT):
  'dynamic' (default) -- recomputed at every brick as pct * last_brick_close,
      so the brick step scales with price as it moves over the series.
  'fixed' -- computed once from the FIRST candle's close and held constant
      for the whole series.
"""

from dataclasses import dataclass
from typing import List, Literal, Optional

import pandas as pd


@dataclass
class Brick:
    index: int
    open: float
    close: float
    direction: int  # 1 = up, -1 = down
    high: float
    low: float
    timestamp: object  # pandas.Timestamp of the triggering candle


def _hl_ordered_prices(open_: float, high: float, low: float, close: float) -> List[float]:
    """
    FLAGGED ASSUMPTION (use_close_or_hl='hl' mode only): from OHLC alone we
    do not know whether a candle's high or low was touched first -- that
    ordering is genuinely ambiguous without tick data. This resolves it with
    a common, disclosed bar-replay heuristic: a bullish candle (close >=
    open) is assumed to have dipped to its low before rallying to its high
    (low-then-high); a bearish candle is assumed to have popped to its high
    before dropping to its low (high-then-low). This is a convention, not a
    fact -- review before trusting 'hl' mode results. 'close' mode (the
    default) has no such ambiguity, since it only ever uses one price per
    candle.
    """
    if close >= open_:
        return [low, high]
    return [high, low]


def build_renko_bricks(
    df: pd.DataFrame,
    brick_pct: float,
    fixed_vs_dynamic: Literal["fixed", "dynamic"] = "dynamic",
    use_close_or_hl: Literal["close", "hl"] = "close",
) -> List[Brick]:
    """
    df: columns datetime, open, high, low, close, volume, sorted ascending
        by datetime (caller's responsibility -- not re-sorted here so the
        caller can catch an out-of-order data bug instead of it being
        silently masked).
    brick_pct: percent, e.g. 0.15 means 0.15%.
    """
    if df.empty:
        return []

    pct = brick_pct / 100.0
    bricks: List[Brick] = []
    last_close = float(df.iloc[0]["close"])
    direction = 0  # 0 = none yet, 1 = up, -1 = down
    fixed_brick_size = last_close * pct  # only used when fixed_vs_dynamic == 'fixed'

    def brick_size() -> float:
        return fixed_brick_size if fixed_vs_dynamic == "fixed" else last_close * pct

    for row in df.itertuples(index=False):
        if use_close_or_hl == "close":
            price_sequence = [float(row.close)]
        else:
            price_sequence = _hl_ordered_prices(float(row.open), float(row.high), float(row.low), float(row.close))

        for price in price_sequence:
            # A single price point can trigger multiple bricks on a big move -- loop.
            while True:
                size = brick_size()
                if direction != -1 and price >= last_close + size:
                    open_ = last_close
                    last_close = last_close + size
                    direction = 1
                    bricks.append(_make_brick(len(bricks), open_, last_close, 1, row))
                    continue
                if direction != 1 and price <= last_close - size:
                    open_ = last_close
                    last_close = last_close - size
                    direction = -1
                    bricks.append(_make_brick(len(bricks), open_, last_close, -1, row))
                    continue
                if direction == 1 and price <= last_close - 2 * size:
                    open_ = last_close
                    last_close = last_close - size
                    direction = -1
                    bricks.append(_make_brick(len(bricks), open_, last_close, -1, row))
                    continue
                if direction == -1 and price >= last_close + 2 * size:
                    open_ = last_close
                    last_close = last_close + size
                    direction = 1
                    bricks.append(_make_brick(len(bricks), open_, last_close, 1, row))
                    continue
                break

    return bricks


def _make_brick(index: int, open_: float, close_: float, direction: int, row) -> Brick:
    return Brick(
        index=index,
        open=open_,
        close=close_,
        direction=direction,
        high=max(open_, close_),
        low=min(open_, close_),
        timestamp=row.datetime,
    )
