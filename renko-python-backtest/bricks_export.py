"""
Exports the exact brick series each combo was simulated against, so results
can be manually verified against a real 5-min candlestick chart instead of
trying to reproduce this engine's specific dynamic-percentage Renko algorithm
in a third-party charting tool (which won't match brick-for-brick -- see
renko.py's docstring on 'dynamic' vs 'fixed' brick sizing, and note that
platforms like TradingView's "Percentage" Renko mode fixes the box size once
at chart load rather than recomputing it every brick like this engine does).

One CSV per symbol (output/bricks/{symbol}.csv, all brick_pcts in one file
distinguished by a brick_pct column) rather than one combined file, so it's
easy to open just the symbol you're checking without loading everything.
"""

import os
from typing import Dict, List, Tuple

import pandas as pd

from renko import Brick

DIRECTION_LABEL = {1: "UP", -1: "DOWN"}


def write_bricks_csv(all_bricks: Dict[Tuple[str, float], List[Brick]], output_dir: str) -> Dict[str, int]:
    """Writes output/bricks/{symbol}.csv for every symbol present in all_bricks. Returns {symbol: row_count}."""
    bricks_dir = os.path.join(output_dir, "bricks")
    os.makedirs(bricks_dir, exist_ok=True)

    by_symbol: Dict[str, list] = {}
    for (symbol, brick_pct), bricks in all_bricks.items():
        rows = by_symbol.setdefault(symbol, [])
        for b in bricks:
            rows.append({
                "brick_pct": brick_pct,
                "brick_index": b.index,
                "direction": DIRECTION_LABEL[b.direction],
                "open": b.open,
                "close": b.close,
                "high": b.high,
                "low": b.low,
                "timestamp": b.timestamp,
            })

    counts = {}
    for symbol, rows in by_symbol.items():
        df = pd.DataFrame(rows).sort_values(["brick_pct", "brick_index"]).reset_index(drop=True)
        path = os.path.join(bricks_dir, f"{symbol}.csv")
        df.to_csv(path, index=False)
        counts[symbol] = len(df)

    return counts
