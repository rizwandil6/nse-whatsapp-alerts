"""
Self-contained results.html generator -- all CSS/JS inline, no external
dependencies or CDNs, works fully offline as a single file. Charts are
hand-rolled SVG (a static P&L-by-combo bar chart built server-side, and a
dynamic equity curve redrawn client-side from the embedded ledger JSON when
the combo dropdown changes) -- no charting library.
"""

import json
import math
from typing import List

import pandas as pd

import config


def _fmt_pct(v: float) -> str:
    if v != v:  # NaN
        return "-"
    if v == float("inf"):
        return "inf"
    return f"{v:+.2f}%"


def _fmt_rs(v: float) -> str:
    if v != v:  # NaN
        return "-"
    sign = "+" if v >= 0 else "−"
    return f"{sign}₹{abs(v):,.0f}"


def _safe_json(records: List[dict]) -> str:
    """json.dumps with inf/NaN converted to a JSON-safe sentinel (JSON has no literal for either)."""
    def clean(v):
        if isinstance(v, float):
            if v != v:
                return None
            if v == float("inf"):
                return "Infinity"
            if v == float("-inf"):
                return "-Infinity"
        return v

    cleaned = [{k: clean(v) for k, v in r.items()} for r in records]
    return json.dumps(cleaned, default=str)


def _bar_chart_svg(overall_df: pd.DataFrame, value_col: str = "total_pnl_pct", width: int = 920, height: int = 300) -> str:
    """Static P&L-by-combo bar chart, one bar per combo_id, sorted by combo_id (not rank) so the x-axis is stable/readable."""
    df = overall_df.sort_values("combo_id")
    values = df[value_col].tolist()
    combo_ids = df["combo_id"].tolist()
    n = len(values)
    if n == 0:
        return "<p>No data.</p>"

    pad_l, pad_r, pad_t, pad_b = 40, 10, 10, 30
    plot_w = width - pad_l - pad_r
    plot_h = height - pad_t - pad_b
    max_v = max(values + [0])
    min_v = min(values + [0])
    span = (max_v - min_v) or 1.0
    zero_y = pad_t + plot_h * (max_v / span)
    bar_w = plot_w / n * 0.7
    gap = plot_w / n

    bars = []
    for i, (cid, v) in enumerate(zip(combo_ids, values)):
        x = pad_l + i * gap + (gap - bar_w) / 2
        bar_h = abs(v) / span * plot_h
        y = zero_y - bar_h if v >= 0 else zero_y
        color = "var(--pos)" if v >= 0 else "var(--neg)"
        bars.append(
            f'<rect x="{x:.1f}" y="{y:.1f}" width="{bar_w:.1f}" height="{max(bar_h, 0.5):.1f}" fill="{color}">'
            f"<title>combo {cid}: {v:+.1f}%</title></rect>"
        )
        if n <= 40:
            bars.append(f'<text x="{x + bar_w/2:.1f}" y="{height - pad_b + 12}" font-size="8" text-anchor="middle" fill="var(--ink-dim)">{cid}</text>')

    return f"""
    <svg viewBox="0 0 {width} {height}" width="100%" height="{height}" role="img" aria-label="Net P&amp;L percent by combo">
      <line x1="{pad_l}" y1="{zero_y:.1f}" x2="{width - pad_r}" y2="{zero_y:.1f}" stroke="var(--rule)" stroke-width="1"/>
      <line x1="{pad_l}" y1="{pad_t}" x2="{pad_l}" y2="{height - pad_b}" stroke="var(--rule)" stroke-width="1"/>
      <text x="4" y="{pad_t + 8}" font-size="9" fill="var(--ink-dim)">{max_v:.0f}%</text>
      <text x="4" y="{height - pad_b}" font-size="9" fill="var(--ink-dim)">{min_v:.0f}%</text>
      {''.join(bars)}
    </svg>
    """


def _combo_label(row: dict) -> str:
    return f"#{row['combo_id']} · {row['brick_pct']:.2f}% brick · entry N={row['entry_confirm_n']} · SL K={row['sl_rejection_n']}"


def _cap_ledger_for_report(trades_df: pd.DataFrame, overall_df: pd.DataFrame, max_rows: int, top_n: int):
    """
    trade_ledger.csv always has every trade -- this only bounds what's
    embedded as inline JSON in the HTML (see config.MAX_LEDGER_ROWS_IN_REPORT
    docstring). Budgets max_rows evenly across the top_n combos, and WITHIN
    each combo, evenly again across every symbol that has trades in it,
    taking each symbol's earliest trades up to its own share.

    This two-level split matters: an earlier version took each combo's
    earliest N trades chronologically pooled across ALL symbols together --
    which silently erased entire symbols with later entry_dates from the
    report. Confirmed live: RVNL (entry_date 2025-07-15) has 1,398 real
    trades in the top combo, but 8 other symbols starting Jan-Jun 2025
    filled the whole row budget before RVNL's window even began, so
    filtering the ledger to RVNL showed 0 trades despite the data being
    fine -- this is what that bug looked like from the report side.
    Per-symbol budgeting guarantees every symbol with real trades in a
    top-ranked combo gets SOME representation in the embedded sample.
    Returns (capped_df, included_combo_ids, excluded_combo_ids, any_combo_truncated: bool).
    """
    if trades_df.empty or len(trades_df) <= max_rows:
        all_ids = sorted(trades_df["combo_id"].unique().tolist()) if not trades_df.empty else []
        return trades_df, all_ids, [], False

    ranked_combo_ids = overall_df["combo_id"].tolist()[:top_n]  # already sorted desc by total_pnl_pct
    per_combo_cap = max(1, max_rows // max(1, len(ranked_combo_ids)))

    kept, included, any_truncated = [], [], False
    for cid in ranked_combo_ids:
        combo_trades = trades_df[trades_df["combo_id"] == cid]
        symbols_in_combo = combo_trades["symbol"].unique()
        per_symbol_cap = max(1, per_combo_cap // max(1, len(symbols_in_combo)))
        for sym in symbols_in_combo:
            sub = combo_trades[combo_trades["symbol"] == sym].sort_values("entry_time")
            if len(sub) > per_symbol_cap:
                sub = sub.head(per_symbol_cap)
                any_truncated = True
            kept.append(sub)
        included.append(cid)

    capped_df = pd.concat(kept, ignore_index=True)
    excluded = [cid for cid in overall_df["combo_id"].tolist() if cid not in included]
    return capped_df, included, excluded, any_truncated


def generate_report_html(
    trades_df: pd.DataFrame,
    overall_df: pd.DataFrame,
    per_symbol_df: pd.DataFrame,
    combos: List[dict],
    missing_symbols: List[str],
    top_n: int,
    max_ledger_rows: int,
    wf_split_date=None,
    walk_forward_df: pd.DataFrame = None,
) -> str:
    top_df = overall_df.head(top_n)
    default_combo_id = int(top_df.iloc[0]["combo_id"]) if len(top_df) else (combos[0]["combo_id"] if combos else 1)

    ledger_df, included_combo_ids, excluded_combo_ids, any_truncated = _cap_ledger_for_report(trades_df, overall_df, max_ledger_rows, top_n)

    combo_summary_json = _safe_json(overall_df.to_dict("records"))
    per_symbol_json = _safe_json(per_symbol_df.to_dict("records")) if not per_symbol_df.empty else "[]"
    ledger_records = ledger_df.to_dict("records") if not ledger_df.empty else []
    ledger_json = _safe_json(ledger_records)
    combo_labels_json = json.dumps({c["combo_id"]: _combo_label(c) for c in combos})
    included_combo_ids_json = json.dumps(included_combo_ids)
    symbols_json = json.dumps(sorted(trades_df["symbol"].unique().tolist()) if not trades_df.empty else [])

    truncation_note = ""
    if excluded_combo_ids or any_truncated:
        parts = [
            f'<p class="missing-note"><b>Ledger detail bounded for the HTML report:</b> '
            f"only the top {len(included_combo_ids)} combos (by net P&amp;L) have trade-level detail embedded here "
            f"({len(ledger_df)} of {len(trades_df)} total trades) -- kept the file shareable as one piece."
        ]
        if any_truncated:
            parts.append(" Combos with more trades than their share of the row budget show only their earliest trades chronologically, not the full set.")
        parts.append(f" <b>trade_ledger.csv always has every trade for all {len(combos)} combos, untruncated.</b></p>")
        truncation_note = "".join(parts)

    has_rupees = "total_pnl_rupees" in overall_df.columns
    has_net = "total_net_pnl_pct" in overall_df.columns
    bar_chart = _bar_chart_svg(overall_df, "total_net_pnl_pct" if has_net else "total_pnl_pct")

    has_wf = walk_forward_df is not None and not walk_forward_df.empty
    if has_wf:
        wf_train_mask = trades_df["entry_time"] < wf_split_date
        wf_train_trades_ct = int(wf_train_mask.sum())
        wf_test_trades_ct = int((~wf_train_mask).sum())
        wf_train_start = trades_df.loc[wf_train_mask, "entry_time"].min()
        wf_test_end = trades_df.loc[~wf_train_mask, "entry_time"].max()
        wf_json = _safe_json(walk_forward_df.to_dict("records"))
        wf_best = walk_forward_df.iloc[0]
    else:
        wf_json = "[]"

    def _top_card(i, row):
        headline_field = "total_net_pnl_pct" if has_net else "total_pnl_pct"
        headline_rs_field = "total_net_pnl_rupees" if has_net else "total_pnl_rupees"
        headline_val = row[headline_field]
        pf_field = "net_profit_factor" if has_net else "profit_factor"
        pf_val = row[pf_field]
        gross_line = ""
        if has_net:
            gross_pct_str = _fmt_pct(row["total_pnl_pct"])
            gross_rs_str = f' / {_fmt_rs(row["total_pnl_rupees"])}' if has_rupees else ""
            cost_str = f' &middot; costs: {_fmt_rs(row["total_cost_rupees"])}' if has_rupees else ""
            gross_line = f'<div class="top-card-gross">gross: {gross_pct_str}{gross_rs_str}{cost_str}</div>'
        return f"""
        <div class="top-card">
          <div class="top-card-rank">#{i+1}</div>
          <div class="top-card-body">
            <div class="top-card-title">Combo {int(row['combo_id'])}</div>
            <div class="top-card-sub">{row['brick_pct']:.2f}% brick &middot; entry N={int(row['entry_confirm_n'])} &middot; SL K={int(row['sl_rejection_n'])}</div>
            <div class="top-card-pnl {'pnl-pos' if headline_val >= 0 else 'pnl-neg'}">{_fmt_pct(headline_val)}</div>
            {f'<div class="top-card-rs {"pnl-pos" if row[headline_rs_field] >= 0 else "pnl-neg"}">{_fmt_rs(row[headline_rs_field])}</div>' if has_rupees else ''}
            {gross_line}
            <div class="top-card-meta">{int(row['total_trades'])} trades &middot; {row['win_rate_pct']:.1f}% win rate &middot; PF {'&infin;' if pf_val == float('inf') else f"{pf_val:.2f}"}</div>
          </div>
        </div>
        """

    top_cards = "".join(_top_card(i, row) for i, row in top_df.iterrows())

    missing_note = (
        f'<p class="missing-note"><b>Skipped (no data file found):</b> {", ".join(missing_symbols)}</p>'
        if missing_symbols
        else ""
    )

    if has_net:
        cost_model_note = (
            'Gross columns are the raw price move with nothing deducted. Net columns subtract a real '
            'round-trip transaction cost per trade, sourced from Upstox\'s own published intraday equity '
            'charges (upstox.com/brokerage-charges/): brokerage min &#8377;20 or 0.1% per leg whichever is '
            'lower, STT 0.025% on the sell leg only, exchange transaction charge &#8776;0.00297% both legs, '
            'SEBI turnover fee 0.0001% both legs, stamp duty 0.003% on the buy leg only, 18% GST on '
            'brokerage+exchange+SEBI. IPFT charges are not broken out by Upstox and are not modeled '
            '(negligible). This only applies to symbols with a qty in holdings.csv, since cost depends on '
            'real position size -- every ranking on this page uses net P&amp;L. Slippage is not modeled.'
        )
    else:
        cost_model_note = 'No transaction costs modeled. "Net P&amp;L" and "gross P&amp;L" are the same figure here.'

    if has_wf:
        wf_note = (
            "a single train/test split at one portfolio-wide calendar cutoff -- not full rolling/k-fold "
            "walk-forward analysis. It catches the case where the in-sample \"best\" combo's edge was mostly "
            "noise, but a strategy passing one split can still fail on a different time window; treat it as "
            "a sanity check, not proof of robustness. Still assumes zero slippage, same as the rest of this report."
        )
    else:
        wf_note = "not computed for this run (see config.WALK_FORWARD_ENABLED)."

    if config.EXPORT_BRICKS:
        bricks_note = (
            "every brick this engine built, across all 4 brick sizes, is exported to "
            "output/bricks/{symbol}.csv -- one file per symbol (timestamp, open, close, high, low, "
            "direction). Use these to check results against a real 5-min candlestick chart: a "
            "broker/TradingView-style Renko chart type will NOT reproduce this engine's bricks exactly, "
            "since this engine recomputes the brick threshold after every single brick (dynamic mode) "
            "while most platforms fix the box size once at chart load -- overlay the exported timestamps "
            "on a plain 5-min candle chart instead of trying to match Renko settings."
        )
    else:
        bricks_note = "not exported for this run (see config.EXPORT_BRICKS)."

    html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Renko Backtest Results</title>
<style>
:root {{
  --bg: #eef1ef; --bg-elevated: #ffffff; --ink: #1c2024; --ink-dim: #5b6068;
  --accent: #9c6b28; --accent-soft: #9c6b2820; --rule: #dcdfdd;
  --pos: #2f8f68; --neg: #b8492f; --pos-soft: #2f8f6818; --neg-soft: #b8492f18;
  --shadow: 0 1px 2px rgba(20,20,20,0.06), 0 8px 24px rgba(20,20,20,0.05);
}}
@media (prefers-color-scheme: dark) {{
  :root {{
    --bg: #12151a; --bg-elevated: #191d24; --ink: #e7e4dc; --ink-dim: #8b909a;
    --accent: #c8964a; --accent-soft: #c8964a26; --rule: #262b33;
    --pos: #4aa87c; --neg: #d9705a; --pos-soft: #4aa87c1f; --neg-soft: #d9705a1f;
    --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 12px 32px rgba(0,0,0,0.35);
  }}
}}
:root[data-theme="dark"] {{
  --bg: #12151a; --bg-elevated: #191d24; --ink: #e7e4dc; --ink-dim: #8b909a;
  --accent: #c8964a; --accent-soft: #c8964a26; --rule: #262b33;
  --pos: #4aa87c; --neg: #d9705a; --pos-soft: #4aa87c1f; --neg-soft: #d9705a1f;
  --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 12px 32px rgba(0,0,0,0.35);
}}
:root[data-theme="light"] {{
  --bg: #eef1ef; --bg-elevated: #ffffff; --ink: #1c2024; --ink-dim: #5b6068;
  --accent: #9c6b28; --accent-soft: #9c6b2820; --rule: #dcdfdd;
  --pos: #2f8f68; --neg: #b8492f; --pos-soft: #2f8f6818; --neg-soft: #b8492f18;
  --shadow: 0 1px 2px rgba(20,20,20,0.06), 0 8px 24px rgba(20,20,20,0.05);
}}
* {{ box-sizing: border-box; }}
body {{
  margin: 0; background: var(--bg); color: var(--ink);
  font-family: -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  font-size: 15px; line-height: 1.5; padding: 2.5rem 1.25rem 4rem;
}}
.page {{ max-width: 1220px; margin: 0 auto; display: flex; flex-direction: column; gap: 1.75rem; }}
.mono {{ font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }}
header {{ display: flex; flex-direction: column; gap: 0.4rem; }}
h1 {{ font: 600 2rem/1.15 "Iowan Old Style", Georgia, ui-serif, serif; margin: 0; }}
.subtitle {{ color: var(--ink-dim); font-size: 0.94rem; max-width: 80ch; }}
.chips {{ display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.3rem; }}
.chip {{ font-size: 0.72rem; font-weight: 700; color: var(--accent); background: var(--accent-soft); border-radius: 999px; padding: 0.28rem 0.7rem; }}
.missing-note {{ color: var(--neg); font-size: 0.85rem; }}
.panel {{ background: var(--bg-elevated); border: 1px solid var(--rule); border-radius: 10px; box-shadow: var(--shadow); overflow: hidden; }}
.panel-head {{ display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; padding: 1.1rem 1.25rem 0.6rem; flex-wrap: wrap; }}
.panel-head h2 {{ font: 600 1.05rem/1.2 "Iowan Old Style", Georgia, ui-serif, serif; margin: 0; }}
.panel-head .count {{ font-size: 0.8rem; color: var(--ink-dim); }}
.panel-body {{ padding: 0 1.25rem 1.25rem; }}
.table-scroll {{ overflow-x: auto; }}
.table-scroll.tall {{ max-height: 480px; overflow-y: auto; }}
table {{ width: 100%; border-collapse: collapse; font-size: 0.84rem; }}
thead th {{
  position: sticky; top: 0; background: var(--bg-elevated); z-index: 1;
  text-align: left; font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--ink-dim); font-weight: 600; padding: 0.5rem 0.7rem; border-bottom: 1px solid var(--rule); white-space: nowrap; cursor: pointer;
}}
thead th.num, td.num {{ text-align: right; }}
thead th:hover {{ color: var(--ink); }}
thead th .arrow {{ opacity: 0.5; font-size: 0.7em; }}
tbody td {{ padding: 0.42rem 0.7rem; border-bottom: 1px solid var(--rule); white-space: nowrap; }}
tbody tr:last-child td {{ border-bottom: none; }}
tbody tr:hover {{ background: var(--accent-soft); }}
td.symbol, td.combo {{ font-weight: 600; }}
.pnl-pos {{ color: var(--pos); }}
.pnl-neg {{ color: var(--neg); }}
.top-grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 0.9rem; padding: 0 1.25rem 1.25rem; }}
.top-card {{ display: flex; gap: 0.7rem; border: 1px solid var(--rule); border-radius: 8px; padding: 0.8rem 0.9rem; background: var(--bg); }}
.top-card-rank {{ font: 700 1rem/1 ui-monospace, monospace; color: var(--accent); }}
.top-card-title {{ font-weight: 700; }}
.top-card-sub {{ font-size: 0.75rem; color: var(--ink-dim); margin-top: 0.15rem; }}
.top-card-pnl {{ font: 700 1.15rem/1.4 ui-monospace, monospace; }}
.top-card-rs {{ font: 600 0.9rem/1.2 ui-monospace, monospace; opacity: 0.85; }}
.top-card-gross {{ font-size: 0.68rem; color: var(--ink-dim); margin-top: 0.1rem; }}
.top-card-meta {{ font-size: 0.72rem; color: var(--ink-dim); }}
.toolbar {{ display: flex; flex-wrap: wrap; align-items: center; gap: 0.8rem; padding: 0 1.25rem 1rem; }}
.control-group {{ display: flex; align-items: center; gap: 0.4rem; }}
.control-label {{ font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-dim); font-weight: 600; }}
select, input[type="search"] {{
  font: 500 0.84rem/1 -apple-system, sans-serif; color: var(--ink); background: var(--bg);
  border: 1px solid var(--rule); border-radius: 7px; padding: 0.42rem 0.6rem;
}}
.chart-wrap {{ padding: 0.5rem 1.25rem 1.25rem; }}
footer {{
  border-top: 1px solid var(--rule); padding-top: 1.1rem; margin-top: 0.5rem;
  color: var(--ink-dim); font-size: 0.82rem; display: flex; flex-direction: column; gap: 0.5rem; max-width: 90ch;
}}
footer b {{ color: var(--ink); }}
</style>
</head>
<body>

<div class="page">
  <header>
    <h1>Renko Backtest &mdash; Holdings Results</h1>
    <p class="subtitle">
      4 brick sizes &times; 3 entry-confirm windows &times; 3 rejection-SL windows = 36 combos,
      run across every symbol in your holdings. No fixed price stoploss by default &mdash; exits are
      confirmed-brick reversal or a rejection-based SL (see footer for the exact, flagged interpretation).
    </p>
    <div class="chips">
      <span class="chip">{len(combos)} combos</span>
      <span class="chip">{trades_df['symbol'].nunique() if not trades_df.empty else 0} symbols with trades</span>
      <span class="chip">{len(trades_df)} total trades</span>
      <span class="chip">brick sizing: {config.FIXED_VS_DYNAMIC_PCT}</span>
      <span class="chip">price ref: {config.USE_CLOSE_OR_HL}</span>
      {f'<span class="chip">best combo (net of costs): {_fmt_rs(top_df.iloc[0]["total_net_pnl_rupees"])}</span>' if has_net and has_rupees and len(top_df) else (f'<span class="chip">best combo: {_fmt_rs(top_df.iloc[0]["total_pnl_rupees"])} on your real holding sizes</span>' if has_rupees and len(top_df) else '')}
      {'<span class="chip">costs: Upstox intraday model applied</span>' if has_net else '<span class="chip">costs: none modeled</span>'}
      {f'<span class="chip">walk-forward split: {wf_split_date.date()}</span>' if has_wf else ''}
      {'<span class="chip">bricks exported: output/bricks/{symbol}.csv</span>' if config.EXPORT_BRICKS else ''}
    </div>
    {missing_note}
    {truncation_note}
  </header>

  <section class="panel">
    <div class="panel-head"><h2>Top {top_n} combos {'by net P&amp;L (after transaction costs)' if has_net else 'by gross P&amp;L'}</h2></div>
    <div class="top-grid">{top_cards}</div>
  </section>

  {f'''
  <section class="panel">
    <div class="panel-head"><h2>Walk-forward validation (out-of-sample check)</h2></div>
    <div class="panel-body">
      <p class="subtitle" style="margin:0 0 0.8rem;">
        All 36 combos above are ranked on the FULL dataset -- in-sample optimization, which will happily
        surface noise that looks like edge. This is a single train/test split at one portfolio-wide
        calendar cutoff: <b>train</b> = {wf_train_trades_ct} trades from {wf_train_start.date()} to {wf_split_date.date()}
        (used to rank combos, same as the main report above), <b>test</b> = {wf_test_trades_ct} trades from
        {wf_split_date.date()} to {wf_test_end.date()} (each combo's performance measured here, but NOT used to pick anything).
        If a combo's edge survives into test, that's real signal; if it collapses or flips negative, the in-sample
        number was likely noise.
      </p>
      <p class="missing-note" style="color:var(--accent);">
        Rank #1 in-sample (combo {int(wf_best["combo_id"])}): train net {_fmt_pct(wf_best["train_net_pnl_pct"])}
        ({int(wf_best["train_trades"])} trades) &rarr; test net {_fmt_pct(wf_best["test_net_pnl_pct"])}
        ({int(wf_best["test_trades"])} trades), landing at out-of-sample rank #{int(wf_best["test_rank"]) if pd.notna(wf_best["test_rank"]) else "-"} of {len(walk_forward_df)}.
      </p>
      <div class="table-scroll tall">
        <table id="wfTable">
          <thead><tr>
            <th data-key="train_rank" data-type="num" class="num">Train rank</th>
            <th data-key="combo_id" data-type="num">Combo</th>
            <th data-key="brick_pct" data-type="num" class="num">Brick %</th>
            <th data-key="entry_confirm_n" data-type="num" class="num">Entry N</th>
            <th data-key="sl_rejection_n" data-type="num" class="num">SL K</th>
            <th data-key="train_trades" data-type="num" class="num">Train trades</th>
            <th data-key="train_net_pnl_pct" data-type="num" class="num">Train net %</th>
            <th data-key="train_profit_factor" data-type="num" class="num">Train PF</th>
            <th data-key="test_rank" data-type="num" class="num">Test rank</th>
            <th data-key="test_trades" data-type="num" class="num">Test trades</th>
            <th data-key="test_net_pnl_pct" data-type="num" class="num">Test net %</th>
            <th data-key="test_profit_factor" data-type="num" class="num">Test PF</th>
            <th>Verdict</th>
          </tr></thead>
          <tbody id="wfBody"></tbody>
        </table>
      </div>
    </div>
  </section>
  ''' if has_wf else ''}

  <section class="panel">
    <div class="panel-head"><h2>{'Net' if has_net else 'Gross'} P&amp;L % by combo</h2></div>
    <div class="chart-wrap">{bar_chart}</div>
  </section>

  <section class="panel">
    <div class="panel-head">
      <h2>Equity curve</h2>
      <div class="control-group">
        {'<span class="control-label">Basis</span><select id="equityBasis"><option value="net">Net</option><option value="gross">Gross</option></select>' if has_net else ''}
        {'<span class="control-label">Unit</span><select id="equityUnit"><option value="pct">%</option><option value="rupees">&#8377;</option></select>' if has_rupees else ''}
        <span class="control-label">Combo</span>
        <select id="equityCombo"></select>
      </div>
    </div>
    <div class="chart-wrap" id="equityChartWrap"></div>
  </section>

  <section class="panel">
    <div class="panel-head">
      <h2>All combos</h2>
      <span class="count" id="comboCount"></span>
    </div>
    <div class="panel-body table-scroll">
      <table id="comboTable">
        <thead><tr>
          <th data-key="combo_id" data-type="num">Combo</th>
          <th data-key="brick_pct" data-type="num" class="num">Brick %</th>
          <th data-key="entry_confirm_n" data-type="num" class="num">Entry N</th>
          <th data-key="sl_rejection_n" data-type="num" class="num">SL K</th>
          <th data-key="total_trades" data-type="num" class="num">Trades</th>
          <th data-key="win_rate_pct" data-type="num" class="num">Win %</th>
          <th data-key="total_pnl_pct" data-type="num" class="num">Gross P&amp;L %</th>
          {'<th data-key="total_pnl_rupees" data-type="num" class="num">Gross &#8377;</th>' if has_rupees else ''}
          {'<th data-key="total_cost_rupees" data-type="num" class="num">Cost &#8377;</th>' if has_net else ''}
          {'<th data-key="total_net_pnl_pct" data-type="num" class="num">Net P&amp;L %</th>' if has_net else ''}
          {'<th data-key="total_net_pnl_rupees" data-type="num" class="num">Net &#8377;</th>' if has_net else ''}
          <th data-key="avg_win_pct" data-type="num" class="num">Avg win %</th>
          <th data-key="avg_loss_pct" data-type="num" class="num">Avg loss %</th>
          <th data-key="profit_factor" data-type="num" class="num">Gross PF</th>
          {'<th data-key="net_profit_factor" data-type="num" class="num">Net PF</th>' if has_net else ''}
          <th data-key="max_drawdown_pct" data-type="num" class="num">Gross Max DD %</th>
          {'<th data-key="net_max_drawdown_pct" data-type="num" class="num">Net Max DD %</th>' if has_net else ''}
          <th data-key="expectancy_pct" data-type="num" class="num">Expectancy %</th>
        </tr></thead>
        <tbody id="comboBody"></tbody>
      </table>
    </div>
  </section>

  <section class="panel">
    <div class="panel-head">
      <h2>Per-symbol breakdown</h2>
      <span class="count" id="perSymbolCount"></span>
    </div>
    <div class="toolbar">
      <div class="control-group">
        <span class="control-label">Combo</span>
        <select id="perSymbolCombo"></select>
      </div>
    </div>
    <div class="panel-body table-scroll tall">
      <table id="perSymbolTable">
        <thead><tr>
          <th>Symbol</th><th class="num">Trades</th><th class="num">Win %</th>
          <th class="num">Gross P&amp;L %</th>{'<th class="num">Gross &#8377;</th>' if has_rupees else ''}
          {'<th class="num">Net P&amp;L %</th>' if has_net else ''}{'<th class="num">Net &#8377;</th>' if has_net else ''}
          <th class="num">Profit factor</th><th class="num">Max DD %</th>
        </tr></thead>
        <tbody id="perSymbolBody"></tbody>
      </table>
    </div>
  </section>

  <section class="panel">
    <div class="panel-head">
      <h2>Trade ledger</h2>
      <span class="count" id="ledgerCount"></span>
    </div>
    <div class="toolbar">
      <div class="control-group">
        <span class="control-label">Symbol</span>
        <select id="ledgerSymbol"><option value="ALL">All symbols</option></select>
      </div>
      <div class="control-group">
        <span class="control-label">Combo</span>
        <select id="ledgerCombo"></select>
      </div>
      <div class="control-group">
        <input type="search" id="ledgerSearch" placeholder="Filter rows&hellip;" />
      </div>
    </div>
    <div class="panel-body table-scroll tall">
      <table id="ledgerTable">
        <thead><tr>
          <th>Symbol</th><th>Combo</th><th>Direction</th><th>Entry time</th><th class="num">Entry</th>
          <th>Exit time</th><th class="num">Exit</th><th class="num">Bricks held</th>
          <th class="num">Gross P&amp;L %</th><th class="num">Gross P&amp;L pts</th>{'<th class="num">Gross &#8377; (qty)</th>' if has_rupees else ''}
          {'<th class="num">Cost &#8377;</th>' if has_net else ''}{'<th class="num">Net P&amp;L %</th>' if has_net else ''}{'<th class="num">Net &#8377;</th>' if has_net else ''}
          <th>Exit reason</th>
        </tr></thead>
        <tbody id="ledgerBody"></tbody>
      </table>
    </div>
  </section>

  <footer>
    <p><b>Exit rule interpretation (flagged for review):</b> the base rule is "exit on the first confirmed opposite-direction brick" -- but only once the trade has reached "+1 brick profit" (defined here as: at least one further confirmed same-direction brick has formed after entry). Before that, the trade gets up to sl_rejection_n (K) consecutive opposite-direction bricks of room before being cut as a rejection stoploss. K=1 collapses to "exit on the very first opposite brick, always" regardless of profit status. This reconciles two rules stated together in the spec that are contradictory if taken fully literally -- see signals.py's docstring for the full reasoning and the alternative reading if this isn't what was meant.</p>
    <p><b>No fixed price stoploss.</b> Every exit is either a confirmed brick reversal or a rejection-SL as defined above -- there is no separate hard stop-loss price level in this engine.</p>
    <p><b>Per-symbol entry dates:</b> where holdings.csv provides an entry_date, only trades entered on/after that date count in every result on this page -- history before it is still fed to the strategy for Renko/box-confirmation warm-up, but nothing before your actual entry date is counted as a real trade.</p>
    <p><b>Renko construction:</b> bricks built from {config.USE_CLOSE_OR_HL} price only{" (see renko.py for the disclosed high/low ordering ambiguity)" if config.USE_CLOSE_OR_HL == "hl" else ""}, brick threshold {config.FIXED_VS_DYNAMIC_PCT} ({"recomputed each brick as pct &times; last brick close" if config.FIXED_VS_DYNAMIC_PCT == "dynamic" else "fixed from the first candle's close"}). Standard 2&times; reversal.</p>
    <p><b>No end-of-day square-off.</b> Positions can span multiple days until a genuine exit signal fires. Any position still open at the end of a symbol's data is closed at the last available price with exit_reason=END_OF_DATA -- a reporting convenience so metrics aren't skewed by unresolved trades, not a trading rule.</p>
    <p><b>Gross vs net:</b> {cost_model_note}</p>
    <p><b>Walk-forward validation:</b> {wf_note}</p>
    <p><b>Equity curve / max drawdown:</b> a simple additive (not compounded) running sum of each trade's pnl_pct, in chronological entry-time order, pooled across all symbols for that combo.</p>
    <p><b>Manual verification:</b> {bricks_note}</p>
  </footer>
</div>

<script>
const COMBO_SUMMARY = {combo_summary_json};
const PER_SYMBOL_SUMMARY = {per_symbol_json};
const LEDGER = {ledger_json};
const COMBO_LABELS = {combo_labels_json};
const SYMBOLS = {symbols_json};
const DEFAULT_COMBO_ID = {default_combo_id};
const INCLUDED_COMBO_IDS = {included_combo_ids_json}; // combos with full trade-level detail embedded (see truncation note)
const HAS_RUPEES = {json.dumps(has_rupees)}; // true if holdings.csv provided qty for real-position-size rupee P&L
const HAS_NET = {json.dumps(has_net)}; // true if the Upstox-intraday-equity cost model was applied (needs qty)
const HAS_WF = {json.dumps(has_wf)}; // true if a walk-forward train/test split was computed (see walkforward.py)
const WALK_FORWARD_SUMMARY = {wf_json};

function fmtPct(v) {{
  if (v === null || v === undefined) return '-';
  if (v === 'Infinity') return '&infin;';
  if (v === '-Infinity') return '-&infin;';
  return (v >= 0 ? '+' : '') + Number(v).toFixed(2) + '%';
}}
function fmtNum(v, d) {{
  if (v === null || v === undefined) return '-';
  if (v === 'Infinity') return '&infin;';
  if (v === '-Infinity') return '-&infin;';
  return Number(v).toFixed(d === undefined ? 2 : d);
}}
function pnlClass(v) {{ return (v === 'Infinity' || v >= 0) ? 'pnl-pos' : 'pnl-neg'; }}
function fmtDate(v) {{ if (!v) return '-'; return String(v).replace('T', ' ').slice(0, 16); }}
function fmtRs(v) {{
  if (v === null || v === undefined) return '-';
  const sign = v >= 0 ? '+' : '−';
  return sign + '₹' + Math.abs(Number(v)).toLocaleString('en-IN', {{ maximumFractionDigits: 0 }});
}}

function populateComboSelects() {{
  const allOptions = COMBO_SUMMARY.slice().sort((a,b)=>a.combo_id-b.combo_id)
    .map(c => `<option value="${{c.combo_id}}">${{COMBO_LABELS[c.combo_id]}}</option>`).join('');
  const includedSet = new Set(INCLUDED_COMBO_IDS);
  const includedOptions = COMBO_SUMMARY.slice().sort((a,b)=>a.combo_id-b.combo_id)
    .filter(c => includedSet.has(c.combo_id))
    .map(c => `<option value="${{c.combo_id}}">${{COMBO_LABELS[c.combo_id]}}</option>`).join('');

  document.getElementById('perSymbolCombo').innerHTML = allOptions;
  document.getElementById('perSymbolCombo').value = String(DEFAULT_COMBO_ID);

  document.getElementById('equityCombo').innerHTML = includedOptions;
  document.getElementById('equityCombo').value = includedSet.has(DEFAULT_COMBO_ID) ? String(DEFAULT_COMBO_ID) : (INCLUDED_COMBO_IDS[0] !== undefined ? String(INCLUDED_COMBO_IDS[0]) : '');

  document.getElementById('ledgerCombo').innerHTML = '<option value="ALL">All (embedded) combos</option>' + includedOptions;
}}
function populateSymbolSelect() {{
  const sel = document.getElementById('ledgerSymbol');
  sel.innerHTML = '<option value="ALL">All symbols</option>' + SYMBOLS.map(s => `<option value="${{s}}">${{s}}</option>`).join('');
}}

let comboSortKey = HAS_NET ? 'total_net_pnl_pct' : 'total_pnl_pct', comboSortDir = -1;
function renderComboTable() {{
  const rows = COMBO_SUMMARY.slice().sort((a,b) => {{
    const av = a[comboSortKey], bv = b[comboSortKey];
    return (av > bv ? 1 : av < bv ? -1 : 0) * comboSortDir;
  }});
  document.getElementById('comboBody').innerHTML = rows.map(r => `<tr>
    <td class="combo mono">${{r.combo_id}}</td>
    <td class="num mono">${{fmtNum(r.brick_pct, 2)}}</td>
    <td class="num mono">${{r.entry_confirm_n}}</td>
    <td class="num mono">${{r.sl_rejection_n}}</td>
    <td class="num mono">${{r.total_trades}}</td>
    <td class="num mono">${{fmtNum(r.win_rate_pct, 1)}}</td>
    <td class="num mono ${{pnlClass(r.total_pnl_pct)}}">${{fmtPct(r.total_pnl_pct)}}</td>
    ${{HAS_RUPEES ? `<td class="num mono ${{pnlClass(r.total_pnl_rupees)}}">${{fmtRs(r.total_pnl_rupees)}}</td>` : ''}}
    ${{HAS_NET ? `<td class="num mono">${{fmtRs(r.total_cost_rupees)}}</td>` : ''}}
    ${{HAS_NET ? `<td class="num mono ${{pnlClass(r.total_net_pnl_pct)}}">${{fmtPct(r.total_net_pnl_pct)}}</td>` : ''}}
    ${{HAS_NET ? `<td class="num mono ${{pnlClass(r.total_net_pnl_rupees)}}">${{fmtRs(r.total_net_pnl_rupees)}}</td>` : ''}}
    <td class="num mono pnl-pos">${{fmtPct(r.avg_win_pct)}}</td>
    <td class="num mono pnl-neg">${{fmtPct(r.avg_loss_pct)}}</td>
    <td class="num mono">${{fmtNum(r.profit_factor, 2)}}</td>
    ${{HAS_NET ? `<td class="num mono">${{fmtNum(r.net_profit_factor, 2)}}</td>` : ''}}
    <td class="num mono pnl-neg">${{fmtNum(r.max_drawdown_pct, 2)}}</td>
    ${{HAS_NET ? `<td class="num mono pnl-neg">${{fmtNum(r.net_max_drawdown_pct, 2)}}</td>` : ''}}
    <td class="num mono">${{fmtPct(r.expectancy_pct)}}</td>
  </tr>`).join('');
  document.getElementById('comboCount').textContent = `${{rows.length}} combos`;
}}
document.getElementById('comboTable').querySelector('thead').addEventListener('click', (e) => {{
  const th = e.target.closest('th[data-key]');
  if (!th) return;
  const key = th.dataset.key;
  comboSortDir = (comboSortKey === key) ? -comboSortDir : -1;
  comboSortKey = key;
  renderComboTable();
}});

let wfSortKey = 'train_rank', wfSortDir = 1;
function wfVerdict(r) {{
  if (r.test_net_pnl_pct <= 0) return ['NEGATIVE OOS', 'pnl-neg'];
  if (r.train_net_pnl_pct > 0 && r.test_net_pnl_pct < r.train_net_pnl_pct * 0.3) return ['weak', 'pnl-neg'];
  return ['holds up', 'pnl-pos'];
}}
function renderWfTable() {{
  if (!HAS_WF) return;
  const rows = WALK_FORWARD_SUMMARY.slice().sort((a,b) => {{
    const av = a[wfSortKey], bv = b[wfSortKey];
    return (av > bv ? 1 : av < bv ? -1 : 0) * wfSortDir;
  }});
  document.getElementById('wfBody').innerHTML = rows.map(r => {{
    const [verdictText, verdictClass] = wfVerdict(r);
    return `<tr>
    <td class="num mono">${{r.train_rank}}</td>
    <td class="combo mono">${{r.combo_id}}</td>
    <td class="num mono">${{fmtNum(r.brick_pct, 2)}}</td>
    <td class="num mono">${{r.entry_confirm_n}}</td>
    <td class="num mono">${{r.sl_rejection_n}}</td>
    <td class="num mono">${{r.train_trades}}</td>
    <td class="num mono ${{pnlClass(r.train_net_pnl_pct)}}">${{fmtPct(r.train_net_pnl_pct)}}</td>
    <td class="num mono">${{fmtNum(r.train_profit_factor, 2)}}</td>
    <td class="num mono">${{r.test_rank ?? '-'}}</td>
    <td class="num mono">${{r.test_trades}}</td>
    <td class="num mono ${{pnlClass(r.test_net_pnl_pct)}}">${{fmtPct(r.test_net_pnl_pct)}}</td>
    <td class="num mono">${{fmtNum(r.test_profit_factor, 2)}}</td>
    <td class="${{verdictClass}}" style="font-weight:600;">${{verdictText}}</td>
  </tr>`;
  }}).join('');
}}
if (HAS_WF) {{
  document.getElementById('wfTable').querySelector('thead').addEventListener('click', (e) => {{
    const th = e.target.closest('th[data-key]');
    if (!th) return;
    const key = th.dataset.key;
    wfSortDir = (wfSortKey === key) ? -wfSortDir : 1;
    wfSortKey = key;
    renderWfTable();
  }});
}}

function renderPerSymbol() {{
  const comboId = Number(document.getElementById('perSymbolCombo').value);
  const sortField = HAS_NET ? 'total_net_pnl_pct' : 'total_pnl_pct';
  const rows = PER_SYMBOL_SUMMARY.filter(r => r.combo_id === comboId).sort((a,b) => b[sortField] - a[sortField]);
  document.getElementById('perSymbolBody').innerHTML = rows.map(r => `<tr>
    <td class="symbol">${{r.symbol}}</td>
    <td class="num mono">${{r.total_trades}}</td>
    <td class="num mono">${{fmtNum(r.win_rate_pct, 1)}}</td>
    <td class="num mono ${{pnlClass(r.total_pnl_pct)}}">${{fmtPct(r.total_pnl_pct)}}</td>
    ${{HAS_RUPEES ? `<td class="num mono ${{pnlClass(r.total_pnl_rupees)}}">${{fmtRs(r.total_pnl_rupees)}}</td>` : ''}}
    ${{HAS_NET ? `<td class="num mono ${{pnlClass(r.total_net_pnl_pct)}}">${{fmtPct(r.total_net_pnl_pct)}}</td>` : ''}}
    ${{HAS_NET ? `<td class="num mono ${{pnlClass(r.total_net_pnl_rupees)}}">${{fmtRs(r.total_net_pnl_rupees)}}</td>` : ''}}
    <td class="num mono">${{fmtNum(r.profit_factor, 2)}}</td>
    <td class="num mono pnl-neg">${{fmtNum(r.max_drawdown_pct, 2)}}</td>
  </tr>`).join('');
  document.getElementById('perSymbolCount').textContent = `${{rows.length}} symbols for this combo`;
}}
document.getElementById('perSymbolCombo').addEventListener('change', renderPerSymbol);

function currentLedgerRows() {{
  const symbol = document.getElementById('ledgerSymbol').value;
  const comboVal = document.getElementById('ledgerCombo').value;
  let rows = LEDGER;
  if (symbol !== 'ALL') rows = rows.filter(t => t.symbol === symbol);
  if (comboVal !== 'ALL') {{ const cid = Number(comboVal); rows = rows.filter(t => t.combo_id === cid); }}
  return rows;
}}
function renderLedger() {{
  const comboVal = document.getElementById('ledgerCombo').value;
  let rows = currentLedgerRows();
  const search = document.getElementById('ledgerSearch').value.toLowerCase();
  if (search) rows = rows.filter(t => t.symbol.toLowerCase().includes(search) || t.exit_reason.toLowerCase().includes(search) || t.direction.toLowerCase().includes(search));
  const MAX_ROWS = 3000;
  const shown = rows.slice(0, MAX_ROWS);
  document.getElementById('ledgerBody').innerHTML = shown.map(t => `<tr>
    <td class="symbol">${{t.symbol}}</td>
    <td class="mono">${{t.combo_id}}</td>
    <td>${{t.direction}}</td>
    <td class="mono">${{fmtDate(t.entry_time)}}</td>
    <td class="num mono">${{fmtNum(t.entry_price, 2)}}</td>
    <td class="mono">${{fmtDate(t.exit_time)}}</td>
    <td class="num mono">${{fmtNum(t.exit_price, 2)}}</td>
    <td class="num mono">${{t.bricks_held}}</td>
    <td class="num mono ${{pnlClass(t.pnl_pct)}}">${{fmtPct(t.pnl_pct)}}</td>
    <td class="num mono ${{pnlClass(t.pnl_points)}}">${{fmtNum(t.pnl_points, 2)}}</td>
    ${{HAS_RUPEES ? `<td class="num mono ${{pnlClass(t.pnl_rupees)}}">${{fmtRs(t.pnl_rupees)}} <span style="color:var(--ink-dim);font-size:0.75em;">(${{fmtNum(t.qty,0)}})</span></td>` : ''}}
    ${{HAS_NET ? `<td class="num mono">${{fmtRs(t.cost_rupees)}}</td>` : ''}}
    ${{HAS_NET ? `<td class="num mono ${{pnlClass(t.net_pnl_pct)}}">${{fmtPct(t.net_pnl_pct)}}</td>` : ''}}
    ${{HAS_NET ? `<td class="num mono ${{pnlClass(t.net_pnl_rupees)}}">${{fmtRs(t.net_pnl_rupees)}}</td>` : ''}}
    <td>${{t.exit_reason}}</td>
  </tr>`).join('');
  const note = rows.length > MAX_ROWS ? ` (showing first ${{MAX_ROWS}} of ${{rows.length}} -- narrow the filter to see more)` : '';
  let partialNote = '';
  if (comboVal !== 'ALL') {{
    const symbolVal = document.getElementById('ledgerSymbol').value;
    if (symbolVal !== 'ALL') {{
      // symbol + combo both picked -- compare against that EXACT (combo, symbol) pair's true count,
      // not the whole combo's, since per-symbol sampling can under-represent one symbol specifically.
      // PER_SYMBOL_SUMMARY is built from the full, untruncated data -- if there's no row
      // here for this (combo, symbol) pair, that symbol genuinely has zero trades in this
      // combo, not a sampling artifact.
      const trueRow = PER_SYMBOL_SUMMARY.find(r => r.combo_id === Number(comboVal) && r.symbol === symbolVal);
      const embeddedCount = LEDGER.filter(t => t.combo_id === Number(comboVal) && t.symbol === symbolVal).length;
      if (trueRow && trueRow.total_trades > embeddedCount) partialNote = ` -- PARTIAL SAMPLE (${{symbolVal}} has ${{trueRow.total_trades}} total trades in this combo, see trade_ledger.csv)`;
    }} else {{
      const trueRow = COMBO_SUMMARY.find(c => c.combo_id === Number(comboVal));
      const embeddedCount = LEDGER.filter(t => t.combo_id === Number(comboVal)).length;
      if (trueRow && trueRow.total_trades > embeddedCount) partialNote = ` -- PARTIAL SAMPLE (combo has ${{trueRow.total_trades}} total trades, see trade_ledger.csv)`;
    }}
  }}
  document.getElementById('ledgerCount').textContent = `${{rows.length}} trades${{note}}${{partialNote}}`;
}}
document.getElementById('ledgerSymbol').addEventListener('change', renderLedger);
document.getElementById('ledgerCombo').addEventListener('change', renderLedger);
document.getElementById('ledgerSearch').addEventListener('input', renderLedger);

function renderEquityCurve() {{
  const comboId = Number(document.getElementById('equityCombo').value);
  const unitEl = document.getElementById('equityUnit');
  const unit = (HAS_RUPEES && unitEl) ? unitEl.value : 'pct';
  const basisEl = document.getElementById('equityBasis');
  const basis = (HAS_NET && basisEl) ? basisEl.value : 'gross';
  const field = basis === 'net'
    ? (unit === 'rupees' ? 'net_pnl_rupees' : 'net_pnl_pct')
    : (unit === 'rupees' ? 'pnl_rupees' : 'pnl_pct');
  const fmt = unit === 'rupees' ? fmtRs : fmtPct;

  const trades = LEDGER.filter(t => t.combo_id === comboId).slice().sort((a,b) => new Date(a.entry_time) - new Date(b.entry_time));
  const wrap = document.getElementById('equityChartWrap');
  if (trades.length === 0) {{ wrap.innerHTML = '<p>No trades for this combo.</p>'; return; }}

  const trueRow = COMBO_SUMMARY.find(c => c.combo_id === comboId);
  const isPartial = trueRow && trueRow.total_trades > trades.length;
  const trueTotalField = basis === 'net'
    ? (unit === 'rupees' ? 'total_net_pnl_rupees' : 'total_net_pnl_pct')
    : (unit === 'rupees' ? 'total_pnl_rupees' : 'total_pnl_pct');
  const partialWarning = isPartial ? `
    <p style="font-size:0.8rem;color:var(--neg);margin:0 0 0.6rem;font-weight:600;">
      &#9888; Showing only the first ${{trades.length}} of ${{trueRow.total_trades}} actual trades for this combo (row-budget cap on the embedded report) --
      this curve and its final P&amp;L are a PARTIAL sample, not the true result. True combo total: ${{fmt(trueRow[trueTotalField])}} (see the All combos table above, or trade_ledger.csv).
    </p>` : '';

  let cum = 0, peak = -Infinity, maxDd = 0;
  const points = trades.map(t => {{ cum += Number(t[field]); peak = Math.max(peak, cum); maxDd = Math.min(maxDd, cum - peak); return cum; }});

  const width = 920, height = 280, padL = 56, padR = 10, padT = 10, padB = 24;
  const plotW = width - padL - padR, plotH = height - padT - padB;
  const maxV = Math.max(...points, 0), minV = Math.min(...points, 0);
  const span = (maxV - minV) || 1;
  const xStep = points.length > 1 ? plotW / (points.length - 1) : 0;
  const yFor = (v) => padT + plotH * (1 - (v - minV) / span);
  const zeroY = yFor(0);

  const path = points.map((v, i) => `${{i === 0 ? 'M' : 'L'}}${{(padL + i * xStep).toFixed(1)}},${{yFor(v).toFixed(1)}}`).join(' ');
  const finalPnl = points[points.length - 1];
  const strokeColor = finalPnl >= 0 ? 'var(--pos)' : 'var(--neg)';
  const axisFmt = (v) => unit === 'rupees' ? '₹' + Math.round(v).toLocaleString('en-IN') : v.toFixed(0) + '%';

  wrap.innerHTML = `
    ${{partialWarning}}
    <svg viewBox="0 0 ${{width}} ${{height}}" width="100%" height="${{height}}" role="img" aria-label="Equity curve">
      <line x1="${{padL}}" y1="${{zeroY.toFixed(1)}}" x2="${{width - padR}}" y2="${{zeroY.toFixed(1)}}" stroke="var(--rule)" stroke-width="1"/>
      <line x1="${{padL}}" y1="${{padT}}" x2="${{padL}}" y2="${{height - padB}}" stroke="var(--rule)" stroke-width="1"/>
      <text x="4" y="${{padT + 8}}" font-size="9" fill="var(--ink-dim)">${{axisFmt(maxV)}}</text>
      <text x="4" y="${{height - padB}}" font-size="9" fill="var(--ink-dim)">${{axisFmt(minV)}}</text>
      <path d="${{path}}" fill="none" stroke="${{strokeColor}}" stroke-width="1.5"/>
    </svg>
    <p style="font-size:0.78rem;color:var(--ink-dim);margin:0.4rem 0 0;">
      ${{trades.length}}${{isPartial ? ' (partial)' : ''}} trades pooled across symbols &middot; ${{isPartial ? 'partial-sample' : 'final'}} cumulative P&amp;L ${{fmt(finalPnl)}} &middot; max drawdown ${{unit === 'rupees' ? fmtRs(maxDd) : maxDd.toFixed(2) + '%'}}
    </p>
  `;
}}
document.getElementById('equityCombo').addEventListener('change', renderEquityCurve);
if (HAS_RUPEES && document.getElementById('equityUnit')) {{
  document.getElementById('equityUnit').addEventListener('change', renderEquityCurve);
}}
if (HAS_NET && document.getElementById('equityBasis')) {{
  document.getElementById('equityBasis').addEventListener('change', renderEquityCurve);
}}

populateComboSelects();
populateSymbolSelect();
renderComboTable();
renderWfTable();
renderPerSymbol();
renderLedger();
renderEquityCurve();
</script>

</body>
</html>
"""
    return html
