"""
Orchestrates the full run: load holdings + per-symbol data -> run the 36
combos across every holding -> compute metrics -> write trade_ledger.csv,
combo_summary.csv, walk_forward_summary.csv, bricks/{symbol}.csv, results.html.

Usage:
    python3 main.py                 # run against data/{symbol}.csv per holdings.csv
    python3 main.py --synthetic     # generate synthetic holdings+data first, then run
"""

import argparse
import os
import sys
import time

import pandas as pd

import config
from backtest import run_all
from bricks_export import write_bricks_csv
from metrics import build_combo_summary, top_n_combos
from report import generate_report_html
from walkforward import build_walk_forward_summary

REQUIRED_COLUMNS = {"datetime", "open", "high", "low", "close", "volume"}


def load_holdings(holdings_path: str):
    """
    Returns (symbols: list[str], entry_dates: dict[str, pd.Timestamp], quantities: dict[str, float]).
    entry_date and qty are both OPTIONAL columns.
      - entry_date: if present, trades entered before a symbol's own entry_date
        are excluded from the results (bricks/box-warmup still use the full
        available history; see backtest.run_all's docstring). Symbols with no
        entry_date are backtested over their entire available data, unfiltered.
      - qty: if present, each trade also gets a pnl_rupees = qty * pnl_points
        column (your actual real holding size, not a capital-scaled notional).
        Symbols with no qty just don't get a rupee figure -- pnl_pct is always
        available regardless.
    """
    if not os.path.exists(holdings_path):
        print(f"ERROR: holdings file not found at {holdings_path}", file=sys.stderr)
        print("Run with --synthetic to generate one for testing, or provide holdings.csv (column: symbol).", file=sys.stderr)
        sys.exit(1)
    df = pd.read_csv(holdings_path)
    if "symbol" not in df.columns:
        print(f"ERROR: {holdings_path} must have a 'symbol' column.", file=sys.stderr)
        sys.exit(1)
    symbols = df["symbol"].dropna().astype(str).tolist()

    entry_dates = {}
    if "entry_date" in df.columns:
        for _, row in df.iterrows():
            if pd.notna(row.get("entry_date")):
                entry_dates[str(row["symbol"])] = pd.Timestamp(row["entry_date"])

    quantities = {}
    if "qty" in df.columns:
        for _, row in df.iterrows():
            if pd.notna(row.get("qty")):
                quantities[str(row["symbol"])] = float(row["qty"])

    return symbols, entry_dates, quantities


IST_OFFSET = pd.Timedelta(hours=5, minutes=30)


def make_data_loader(data_dir: str):
    """
    data/{symbol}.csv datetime columns are UTC-naive (confirmed: a trading
    day's rows span 03:45-09:55, which is exactly NSE's 09:15-15:30 IST
    session shifted back by 5:30 -- an artifact of the original Upstox JSON
    -> CSV conversion not applying the IST offset). Shifted here at load
    time so every downstream timestamp (bricks, trade_ledger.csv,
    results.html) is real IST, not just a display-layer patch.
    """
    def loader(symbol: str):
        path = os.path.join(data_dir, f"{symbol}.csv")
        if not os.path.exists(path):
            return None
        df = pd.read_csv(path, parse_dates=["datetime"])
        missing_cols = REQUIRED_COLUMNS - set(df.columns)
        if missing_cols:
            print(f"WARNING: {symbol}.csv missing columns {missing_cols}, skipped.", file=sys.stderr)
            return None
        df["datetime"] = df["datetime"] + IST_OFFSET
        return df.sort_values("datetime").reset_index(drop=True)

    return loader


def main():
    parser = argparse.ArgumentParser(description="Renko backtesting engine over a holdings universe.")
    parser.add_argument("--synthetic", action="store_true", help="generate synthetic holdings+data before running (won't overwrite existing files)")
    parser.add_argument("--holdings", default=config.HOLDINGS_PATH, help="path to holdings.csv")
    parser.add_argument("--data-dir", default=config.DATA_DIR, help="directory containing {symbol}.csv files")
    parser.add_argument("--output-dir", default=config.OUTPUT_DIR, help="directory to write trade_ledger.csv / combo_summary.csv / results.html")
    args = parser.parse_args()

    if args.synthetic:
        import synthetic_data
        synthetic_data.generate_all(holdings_path=args.holdings, data_dir=args.data_dir)

    os.makedirs(args.output_dir, exist_ok=True)

    holdings, entry_dates, quantities = load_holdings(args.holdings)
    print(f"Holdings: {len(holdings)} symbols ({len(entry_dates)} with an entry_date filter, {len(quantities)} with a qty for rupee P&L).")

    loader = make_data_loader(args.data_dir)

    t0 = time.time()
    trades, combos, missing_symbols, all_bricks = run_all(
        holdings,
        loader,
        config.BRICK_PCTS,
        config.ENTRY_CONFIRM_N_VALUES,
        config.SL_REJECTION_N_VALUES,
        config.FIXED_VS_DYNAMIC_PCT,
        config.USE_CLOSE_OR_HL,
        config.FORCE_CLOSE_AT_END_OF_DATA,
        entry_dates,
        quantities,
    )
    print(f"Backtest done in {time.time() - t0:.2f}s -- {len(combos)} combos, {len(trades)} trades, {len(missing_symbols)} symbols skipped.")
    if missing_symbols:
        print(f"  Skipped (no data file): {', '.join(missing_symbols)}")

    if config.EXPORT_BRICKS:
        brick_counts = write_bricks_csv(all_bricks, args.output_dir)
        total_bricks = sum(brick_counts.values())
        print(f"Wrote {len(brick_counts)} files to {os.path.join(args.output_dir, 'bricks')}/ ({total_bricks} bricks total, all brick_pcts).")

    trades_df = pd.DataFrame(trades)
    overall_df, per_symbol_df = build_combo_summary(trades_df, combos)
    top_df = top_n_combos(overall_df, config.TOP_N_COMBOS)

    ledger_path = os.path.join(args.output_dir, "trade_ledger.csv")
    summary_path = os.path.join(args.output_dir, "combo_summary.csv")
    report_path = os.path.join(args.output_dir, "results.html")

    trades_df.to_csv(ledger_path, index=False)
    overall_df.to_csv(summary_path, index=False)
    print(f"Wrote {ledger_path} ({len(trades_df)} rows).")
    print(f"Wrote {summary_path} ({len(overall_df)} rows).")

    split_date, train_overall_df, test_overall_df, walk_forward_df = (None, pd.DataFrame(), pd.DataFrame(), pd.DataFrame())
    if config.WALK_FORWARD_ENABLED:
        split_date, train_overall_df, test_overall_df, walk_forward_df = build_walk_forward_summary(
            trades_df, combos, config.WALK_FORWARD_TRAIN_FRACTION
        )
        if not walk_forward_df.empty:
            wf_path = os.path.join(args.output_dir, "walk_forward_summary.csv")
            walk_forward_df.to_csv(wf_path, index=False)
            print(f"Wrote {wf_path} ({len(walk_forward_df)} rows) -- train/test split at {split_date.date()}.")

            best = walk_forward_df.iloc[0]
            test_rank_str = str(int(best["test_rank"])) if pd.notna(best["test_rank"]) else "-"
            print(
                f"  Combo {int(best['combo_id'])} (rank #1 in-sample): "
                f"train net {best['train_net_pnl_pct']:+.2f}% ({int(best['train_trades'])} trades) "
                f"-> test net {best['test_net_pnl_pct']:+.2f}% ({int(best['test_trades'])} trades), "
                f"out-of-sample rank #{test_rank_str} of {len(walk_forward_df)}."
            )
        else:
            print("Walk-forward split skipped: not enough data on both sides of the split.")

    html = generate_report_html(
        trades_df, overall_df, per_symbol_df, combos, missing_symbols, config.TOP_N_COMBOS, config.MAX_LEDGER_ROWS_IN_REPORT,
        split_date, walk_forward_df,
    )
    with open(report_path, "w") as f:
        f.write(html)
    print(f"Wrote {report_path} ({len(html) / 1e6:.2f} MB).")

    has_net = "total_net_pnl_pct" in top_df.columns
    print("\nTop combos (ranked by net P&L after transaction costs):" if has_net else "\nTop combos by gross P&L (no qty -> no cost model applied):")
    cols = ["combo_id", "brick_pct", "entry_confirm_n", "sl_rejection_n", "total_trades", "win_rate_pct", "total_pnl_pct"]
    if has_net:
        cols += ["total_net_pnl_pct", "net_profit_factor", "net_max_drawdown_pct"]
    else:
        cols += ["profit_factor", "max_drawdown_pct"]
    print(top_df[cols].to_string(index=False))


if __name__ == "__main__":
    main()
