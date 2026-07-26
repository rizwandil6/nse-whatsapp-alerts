"""
Backtest loop: wires renko.py + signals.py together across the full combo
grid (brick_pct x entry_confirm_n x sl_rejection_n) and every holding.

Performance note: entry_confirm_n and sl_rejection_n don't affect brick
construction at all -- only brick_pct does. So bricks are built once per
(symbol, brick_pct) pair and reused across all 9 (entry_confirm_n,
sl_rejection_n) combos that share that brick size, instead of rebuilding
identical bricks 9x.
"""

from typing import Callable, Dict, List, Optional

import pandas as pd

from costs import cost_rupees
from renko import Brick, build_renko_bricks
from signals import ExitResult, detect_entry, simulate_exit


def generate_combos(brick_pcts: List[float], entry_confirm_n_values: List[int], sl_rejection_n_values: List[int]) -> List[dict]:
    combos = []
    combo_id = 1
    for brick_pct in brick_pcts:
        for n in entry_confirm_n_values:
            for k in sl_rejection_n_values:
                combos.append({
                    "combo_id": combo_id,
                    "brick_pct": brick_pct,
                    "entry_confirm_n": n,
                    "sl_rejection_n": k,
                })
                combo_id += 1
    return combos


def _build_trade_row(symbol: str, combo: dict, direction: str, entry_brick: Brick, exit_brick: Brick, exit_result: ExitResult, qty: Optional[float]) -> dict:
    entry_price = entry_brick.close
    exit_price = exit_result.exit_price
    pnl_points = (exit_price - entry_price) if direction == "LONG" else (entry_price - exit_price)
    pnl_pct = (pnl_points / entry_price) * 100.0
    row = {
        "symbol": symbol,
        "combo_id": combo["combo_id"],
        "brick_pct": combo["brick_pct"],
        "entry_confirm_n": combo["entry_confirm_n"],
        "sl_rejection_n": combo["sl_rejection_n"],
        "direction": direction,
        "entry_time": entry_brick.timestamp,
        "entry_price": entry_price,
        "exit_time": exit_brick.timestamp,
        "exit_price": exit_price,
        "bricks_held": exit_result.bricks_held,
        "pnl_pct": pnl_pct,
        "pnl_points": pnl_points,
        "exit_reason": exit_result.exit_reason,
    }
    if qty is not None:
        row["qty"] = qty
        row["pnl_rupees"] = pnl_points * qty  # your actual real holding size, not a capital-scaled notional
        cost_rs = cost_rupees(entry_price, exit_price, qty, direction)
        row["cost_rupees"] = cost_rs
        row["net_pnl_rupees"] = row["pnl_rupees"] - cost_rs
        row["net_pnl_pct"] = pnl_pct - (cost_rs / (qty * entry_price)) * 100.0
    return row


def simulate_combo_on_bricks(symbol: str, bricks: List[Brick], combo: dict, force_close_at_end: bool, qty: Optional[float] = None) -> List[dict]:
    trades: List[dict] = []
    n = len(bricks)
    i = 0
    while i < n:
        direction = detect_entry(bricks, i, combo["entry_confirm_n"])
        if direction is None:
            i += 1
            continue

        entry_brick = bricks[i]
        exit_result = simulate_exit(bricks, i, direction, combo["sl_rejection_n"])

        if exit_result is None:
            if not force_close_at_end or n - 1 <= i:
                break  # trade never resolves within the data; not forced closed, so not recorded
            last_idx = n - 1
            last = bricks[last_idx]
            exit_result = ExitResult(
                exit_brick_index=last_idx,
                exit_price=last.close,
                exit_reason="END_OF_DATA",
                bricks_held=last_idx - i,
            )

        exit_brick = bricks[exit_result.exit_brick_index]
        trades.append(_build_trade_row(symbol, combo, direction, entry_brick, exit_brick, exit_result, qty))
        i = exit_result.exit_brick_index + 1  # resume scanning for the next entry right after this exit

    return trades


def run_all(
    holdings: List[str],
    data_loader: Callable[[str], Optional[pd.DataFrame]],
    brick_pcts: List[float],
    entry_confirm_n_values: List[int],
    sl_rejection_n_values: List[int],
    fixed_vs_dynamic: str,
    use_close_or_hl: str,
    force_close_at_end: bool,
    entry_dates: Optional[Dict[str, "pd.Timestamp"]] = None,
    quantities: Optional[Dict[str, float]] = None,
):
    """
    entry_dates: optional {symbol: earliest date to COUNT a trade}. Bricks are
    still built from the full available history per symbol (so box-confirmation
    warm-up is unaffected) -- only trades whose entry_time falls before the
    symbol's own entry_date are dropped afterward, same "since buy" pattern
    used throughout this project's other backtests: history before the date
    you actually held the position doesn't count as a real result, but it's
    still useful runway for the strategy's state machine to warm up on.

    quantities: optional {symbol: real held quantity}. When present, each
    trade also gets qty and pnl_rupees (= qty * pnl_points) columns -- your
    actual position size, not a flat capital-scaled notional. Symbols absent
    from this dict simply don't get a rupee figure; pnl_pct is unaffected.

    Returns (all_trades: list[dict], combos: list[dict], missing_symbols: list[str],
    all_bricks: dict[(symbol, brick_pct), list[Brick]]). all_bricks is the exact
    brick series each combo sharing that brick_pct was simulated against --
    built once per (symbol, brick_pct) pair as noted above, handed back here
    (not just discarded) so it can be exported for manual/chart verification
    without re-running the whole backtest (see bricks_export.py).
    """
    entry_dates = entry_dates or {}
    quantities = quantities or {}
    combos = generate_combos(brick_pcts, entry_confirm_n_values, sl_rejection_n_values)
    combos_by_brick: Dict[float, List[dict]] = {}
    for c in combos:
        combos_by_brick.setdefault(c["brick_pct"], []).append(c)

    all_trades: List[dict] = []
    missing_symbols: List[str] = []
    all_bricks: Dict[tuple, List[Brick]] = {}

    for symbol in holdings:
        df = data_loader(symbol)
        if df is None or df.empty:
            missing_symbols.append(symbol)
            continue

        cutoff = entry_dates.get(symbol)
        qty = quantities.get(symbol)

        for brick_pct, combo_list in combos_by_brick.items():
            bricks = build_renko_bricks(df, brick_pct, fixed_vs_dynamic, use_close_or_hl)
            all_bricks[(symbol, brick_pct)] = bricks
            for combo in combo_list:
                trades = simulate_combo_on_bricks(symbol, bricks, combo, force_close_at_end, qty)
                if cutoff is not None:
                    trades = [t for t in trades if t["entry_time"] >= cutoff]
                all_trades.extend(trades)

    return all_trades, combos, missing_symbols, all_bricks
