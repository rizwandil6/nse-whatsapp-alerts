"""
Synthetic holdings.csv + data/{symbol}.csv generator, so the engine can be
run end-to-end before plugging in real intraday data. Not real market data
-- a seeded random walk with a slow drift/regime component layered in so
Renko bricks actually trend sometimes (pure zero-drift noise tends to be
too choppy to meaningfully differentiate the entry-confirm / rejection-SL
combos from each other).
"""

import os
from datetime import datetime, time, timedelta

import numpy as np
import pandas as pd

import config

SYMBOLS = [
    ("SYNTHA", 250.0, 0.018),
    ("SYNTHB", 1200.0, 0.014),
    ("SYNTHC", 65.0, 0.024),
    ("SYNTHD", 480.0, 0.016),
    ("SYNTHE", 90.0, 0.021),
    ("SYNTHF", 3100.0, 0.012),
]

BARS_PER_DAY_MINUTES = 5
MARKET_OPEN = time(9, 15)
MARKET_CLOSE = time(15, 30)
NUM_TRADING_DAYS = 130
START_DATE = datetime(2025, 1, 6)  # a Monday


def _trading_days(start_date: datetime, num_days: int):
    d = start_date
    count = 0
    while count < num_days:
        if d.weekday() < 5:
            yield d
            count += 1
        d += timedelta(days=1)


def generate_symbol_ohlc(symbol: str, base_price: float, daily_vol: float, seed: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    rows = []
    price = base_price

    # A few slow regime segments (trend up / down / flat) layered on top of
    # the per-bar noise, so Renko bricks form real directional runs
    # sometimes instead of pure noise the whole series.
    regimes = rng.choice([1, -1, 0], size=8, p=[0.4, 0.35, 0.25])
    regime_days = NUM_TRADING_DAYS / len(regimes)

    for day_idx, d in enumerate(_trading_days(START_DATE, NUM_TRADING_DAYS)):
        regime = regimes[min(int(day_idx / regime_days), len(regimes) - 1)]
        drift_per_bar = regime * daily_vol * 0.04  # small persistent push per bar within the regime

        bar_time = datetime.combine(d.date(), MARKET_OPEN)
        end_time = datetime.combine(d.date(), MARKET_CLOSE)
        while bar_time <= end_time:
            noise = rng.normal(0, daily_vol / np.sqrt(75))
            ret = drift_per_bar + noise
            o = price
            c = max(price * (1 + ret), 0.5)
            wick = abs(rng.normal(0, daily_vol / 250))
            hi = max(o, c) * (1 + wick)
            lo = min(o, c) * (1 - wick)
            vol = int(rng.integers(500, 60000))
            rows.append((bar_time, round(o, 2), round(hi, 2), round(lo, 2), round(c, 2), vol))
            price = c
            bar_time += timedelta(minutes=BARS_PER_DAY_MINUTES)

    return pd.DataFrame(rows, columns=["datetime", "open", "high", "low", "close", "volume"])


def generate_all(holdings_path: str = None, data_dir: str = None, overwrite: bool = False):
    holdings_path = holdings_path or config.HOLDINGS_PATH
    data_dir = data_dir or config.DATA_DIR
    os.makedirs(data_dir, exist_ok=True)

    if os.path.exists(holdings_path) and not overwrite:
        print(f"{holdings_path} already exists, skipping (pass overwrite=True to regenerate).")
        return

    holdings_df = pd.DataFrame({"symbol": [s for s, _, _ in SYMBOLS]})
    holdings_df.to_csv(holdings_path, index=False)
    print(f"Wrote {holdings_path} ({len(holdings_df)} symbols).")

    for i, (symbol, base_price, vol) in enumerate(SYMBOLS):
        df = generate_symbol_ohlc(symbol, base_price, vol, seed=1000 + i)
        out_path = os.path.join(data_dir, f"{symbol}.csv")
        df.to_csv(out_path, index=False)
        print(f"Wrote {out_path} ({len(df)} bars).")


if __name__ == "__main__":
    generate_all(overwrite=True)
