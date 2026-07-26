"""
Walk-forward out-of-sample validation.

The main report ranks all 36 combos on the FULL dataset -- classic in-sample
optimization, which will happily surface combos whose apparent edge is just
overfit noise. This module adds a single train/test split: everything before
one global cutoff date is "train" (ranked exactly like the main report),
everything on/after is "test" (each combo's performance measured but NOT used
to pick anything). If a combo's edge survives into test, that's real signal;
if it collapses or flips negative, the in-sample number was likely noise.

The cutoff is ONE wall-clock date applied across the whole portfolio, not a
per-symbol fraction of each symbol's own history. This is deliberate -- it
mirrors how you'd actually use this in live trading: you pick a combo using
everything known up to "today", then trade it forward. A symbol you only
recently bought naturally contributes less (or no) train data and starts
showing up mostly/only in test, which is realistic, not a bug: you wouldn't
have had much history on it to optimize with either. The cutoff itself is
computed as train_fraction of the way through [earliest trade entry_time,
latest trade entry_time] across ALL counted trades.

This is a single split, not full k-fold rolling walk-forward analysis --
good enough to catch "the in-sample number was noise" but it's still only
one train/test boundary, so treat it as a sanity check, not proof the
strategy is robust across arbitrary time periods.
"""

from typing import List, Optional, Tuple

import pandas as pd

from metrics import build_combo_summary


def compute_split_date(trades_df: pd.DataFrame, train_fraction: float) -> Optional[pd.Timestamp]:
    if trades_df.empty:
        return None
    lo = trades_df["entry_time"].min()
    hi = trades_df["entry_time"].max()
    return lo + (hi - lo) * train_fraction


def split_trades(trades_df: pd.DataFrame, split_date: pd.Timestamp) -> Tuple[pd.DataFrame, pd.DataFrame]:
    train_df = trades_df[trades_df["entry_time"] < split_date]
    test_df = trades_df[trades_df["entry_time"] >= split_date]
    return train_df, test_df


def build_walk_forward_summary(trades_df: pd.DataFrame, combos: List[dict], train_fraction: float):
    """
    Returns (split_date, train_overall_df, test_overall_df, walk_forward_df).
    All empty/None if there isn't enough data on both sides of the split to
    say anything meaningful.

    walk_forward_df: one row per combo, ordered by TRAIN rank (the selection
    you'd have made using only in-sample data) -- train_* and test_* metrics
    side by side, plus test_rank (where that same combo actually lands when
    ranking is done using ONLY the test period), so rank drift between
    "what looked best in-sample" and "what actually held up out-of-sample"
    is visible directly.
    """
    split_date = compute_split_date(trades_df, train_fraction)
    if split_date is None:
        return None, pd.DataFrame(), pd.DataFrame(), pd.DataFrame()

    train_df, test_df = split_trades(trades_df, split_date)
    if train_df.empty or test_df.empty:
        return split_date, pd.DataFrame(), pd.DataFrame(), pd.DataFrame()

    train_overall, _ = build_combo_summary(train_df, combos)
    test_overall, _ = build_combo_summary(test_df, combos)

    test_rank_map = {cid: i + 1 for i, cid in enumerate(test_overall["combo_id"].tolist())}
    test_by_id = test_overall.set_index("combo_id")

    rows = []
    for train_rank, row in enumerate(train_overall.to_dict("records"), start=1):
        cid = row["combo_id"]
        test_row = test_by_id.loc[cid].to_dict() if cid in test_by_id.index else {}
        rows.append({
            "combo_id": cid,
            "brick_pct": row["brick_pct"],
            "entry_confirm_n": row["entry_confirm_n"],
            "sl_rejection_n": row["sl_rejection_n"],
            "train_rank": train_rank,
            "test_rank": test_rank_map.get(cid),
            "train_trades": row.get("total_trades", 0),
            "test_trades": test_row.get("total_trades", 0),
            "train_win_rate_pct": row.get("win_rate_pct", 0.0),
            "test_win_rate_pct": test_row.get("win_rate_pct", 0.0),
            "train_net_pnl_pct": row.get("total_net_pnl_pct", row.get("total_pnl_pct", 0.0)),
            "test_net_pnl_pct": test_row.get("total_net_pnl_pct", test_row.get("total_pnl_pct", 0.0)),
            "train_profit_factor": row.get("net_profit_factor", row.get("profit_factor", 0.0)),
            "test_profit_factor": test_row.get("net_profit_factor", test_row.get("profit_factor", 0.0)),
        })
    walk_forward_df = pd.DataFrame(rows)
    return split_date, train_overall, test_overall, walk_forward_df
