"""
Per-combo metrics: aggregated across all holdings, and broken down per
symbol.

Gross vs net: gross_pnl_pct / total_pnl_pct / pnl_rupees are the raw price
move, with NO transaction costs deducted. When trades_df has a qty (and
therefore a cost_rupees/net_pnl_rupees/net_pnl_pct column, from costs.py's
Upstox-intraday-equity round-trip cost model applied in backtest.py), matching
net_* metrics are computed too. Ranking for the top-N combos uses
total_net_pnl_pct when it's available (real, cost-adjusted performance),
falling back to the gross total_pnl_pct only for combos/symbols with no
qty at all.

If trades_df has a pnl_rupees column (holdings.csv provided a qty for that
symbol), matching *_rupees metrics are computed alongside every %-based one
-- your actual real position size, not a flat capital-scaled notional.
Symbols without a qty just don't contribute a rupee figure (and therefore no
net figure either, since cost depends on position size).

Equity curve / max drawdown: built as a simple ADDITIVE cumulative sum of
each trade's pnl_pct (or pnl_rupees), in chronological entry-time order --
not compounded (geometric) equity. This matches "report P&L in percent as
the primary unit" and is the standard simplification for a per-trade
backtest summary; flagged here since a compounded curve would look
different.
"""

from typing import List, Tuple

import pandas as pd


def compute_trade_metrics(trades_df: pd.DataFrame) -> dict:
    has_rupees = "pnl_rupees" in trades_df.columns
    has_net = "net_pnl_pct" in trades_df.columns

    n = len(trades_df)
    if n == 0:
        base = {
            "total_trades": 0,
            "win_rate_pct": 0.0,
            "gross_pnl_pct": 0.0,
            "avg_win_pct": 0.0,
            "avg_loss_pct": 0.0,
            "profit_factor": 0.0,
            "max_drawdown_pct": 0.0,
            "expectancy_pct": 0.0,
        }
        if has_rupees:
            base.update({"total_pnl_rupees": 0.0, "avg_win_rupees": 0.0, "avg_loss_rupees": 0.0, "max_drawdown_rupees": 0.0})
        if has_net:
            base.update({
                "total_cost_rupees": 0.0,
                "total_net_pnl_pct": 0.0,
                "avg_net_win_pct": 0.0,
                "avg_net_loss_pct": 0.0,
                "net_profit_factor": 0.0,
                "net_max_drawdown_pct": 0.0,
                "net_expectancy_pct": 0.0,
                "total_net_pnl_rupees": 0.0,
                "avg_net_win_rupees": 0.0,
                "avg_net_loss_rupees": 0.0,
                "net_max_drawdown_rupees": 0.0,
            })
        return base

    wins = trades_df[trades_df["pnl_pct"] > 0]
    losses = trades_df[trades_df["pnl_pct"] <= 0]

    sum_wins = wins["pnl_pct"].sum()
    sum_losses_abs = abs(losses["pnl_pct"].sum())
    if sum_losses_abs > 0:
        profit_factor = sum_wins / sum_losses_abs
    elif sum_wins > 0:
        profit_factor = float("inf")
    else:
        profit_factor = 0.0

    ordered = trades_df.sort_values("entry_time")
    cum = ordered["pnl_pct"].cumsum()
    running_max = cum.cummax()
    drawdown = cum - running_max
    max_drawdown = float(drawdown.min()) if len(drawdown) else 0.0

    result = {
        "total_trades": n,
        "win_rate_pct": len(wins) / n * 100.0,
        "gross_pnl_pct": float(trades_df["pnl_pct"].sum()),
        "avg_win_pct": float(wins["pnl_pct"].mean()) if len(wins) else 0.0,
        "avg_loss_pct": float(losses["pnl_pct"].mean()) if len(losses) else 0.0,
        "profit_factor": profit_factor,
        "max_drawdown_pct": max_drawdown,
        "expectancy_pct": float(trades_df["pnl_pct"].mean()),
    }

    if has_rupees:
        rwins = trades_df[trades_df["pnl_rupees"] > 0]
        rlosses = trades_df[trades_df["pnl_rupees"] <= 0]
        cum_rs = ordered["pnl_rupees"].cumsum()
        dd_rs = cum_rs - cum_rs.cummax()
        result.update({
            "total_pnl_rupees": float(trades_df["pnl_rupees"].sum()),
            "avg_win_rupees": float(rwins["pnl_rupees"].mean()) if len(rwins) else 0.0,
            "avg_loss_rupees": float(rlosses["pnl_rupees"].mean()) if len(rlosses) else 0.0,
            "max_drawdown_rupees": float(dd_rs.min()) if len(dd_rs) else 0.0,
        })

    if has_net:
        nwins = trades_df[trades_df["net_pnl_pct"] > 0]
        nlosses = trades_df[trades_df["net_pnl_pct"] <= 0]
        sum_nwins = nwins["net_pnl_pct"].sum()
        sum_nlosses_abs = abs(nlosses["net_pnl_pct"].sum())
        if sum_nlosses_abs > 0:
            net_profit_factor = sum_nwins / sum_nlosses_abs
        elif sum_nwins > 0:
            net_profit_factor = float("inf")
        else:
            net_profit_factor = 0.0

        cum_net = ordered["net_pnl_pct"].cumsum()
        dd_net = cum_net - cum_net.cummax()

        rnwins = trades_df[trades_df["net_pnl_rupees"] > 0]
        rnlosses = trades_df[trades_df["net_pnl_rupees"] <= 0]
        cum_net_rs = ordered["net_pnl_rupees"].cumsum()
        dd_net_rs = cum_net_rs - cum_net_rs.cummax()

        result.update({
            "total_cost_rupees": float(trades_df["cost_rupees"].sum()),
            "total_net_pnl_pct": float(trades_df["net_pnl_pct"].sum()),
            "avg_net_win_pct": float(nwins["net_pnl_pct"].mean()) if len(nwins) else 0.0,
            "avg_net_loss_pct": float(nlosses["net_pnl_pct"].mean()) if len(nlosses) else 0.0,
            "net_profit_factor": net_profit_factor,
            "net_max_drawdown_pct": float(dd_net.min()) if len(dd_net) else 0.0,
            "net_expectancy_pct": float(trades_df["net_pnl_pct"].mean()),
            "total_net_pnl_rupees": float(trades_df["net_pnl_rupees"].sum()),
            "avg_net_win_rupees": float(rnwins["net_pnl_rupees"].mean()) if len(rnwins) else 0.0,
            "avg_net_loss_rupees": float(rnlosses["net_pnl_rupees"].mean()) if len(rnlosses) else 0.0,
            "net_max_drawdown_rupees": float(dd_net_rs.min()) if len(dd_net_rs) else 0.0,
        })

    return result


def build_combo_summary(trades_df: pd.DataFrame, combos: List[dict]) -> Tuple[pd.DataFrame, pd.DataFrame]:
    """
    Returns (overall_summary_df, per_symbol_summary_df). Sorted by
    total_net_pnl_pct desc (real, cost-adjusted P&L) when every trade has a
    qty and therefore a net figure; falls back to the gross total_pnl_pct
    otherwise.
    """
    overall_rows = []
    for combo in combos:
        sub = trades_df[trades_df["combo_id"] == combo["combo_id"]] if not trades_df.empty else trades_df
        m = compute_trade_metrics(sub)
        overall_rows.append({**combo, **m, "total_pnl_pct": m["gross_pnl_pct"]})
    overall_df = pd.DataFrame(overall_rows)
    rank_col = "total_net_pnl_pct" if "total_net_pnl_pct" in overall_df.columns else "total_pnl_pct"
    overall_df = overall_df.sort_values(rank_col, ascending=False).reset_index(drop=True)

    per_symbol_rows = []
    if not trades_df.empty:
        combo_by_id = {c["combo_id"]: c for c in combos}
        for (combo_id, symbol), sub in trades_df.groupby(["combo_id", "symbol"]):
            combo = combo_by_id[combo_id]
            m = compute_trade_metrics(sub)
            per_symbol_rows.append({"symbol": symbol, **combo, **m, "total_pnl_pct": m["gross_pnl_pct"]})
    per_symbol_df = pd.DataFrame(per_symbol_rows)
    if not per_symbol_df.empty:
        per_symbol_rank_col = "total_net_pnl_pct" if "total_net_pnl_pct" in per_symbol_df.columns else "total_pnl_pct"
        per_symbol_df = per_symbol_df.sort_values(["combo_id", per_symbol_rank_col], ascending=[True, False]).reset_index(drop=True)

    return overall_df, per_symbol_df


def top_n_combos(overall_df: pd.DataFrame, n: int) -> pd.DataFrame:
    return overall_df.head(n).reset_index(drop=True)
