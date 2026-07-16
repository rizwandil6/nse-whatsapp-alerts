# Relative Strength Momentum Strategy — v1

A positional (multi-day to multi-year hold) momentum strategy: buy stocks
outperforming Nifty strongly enough to rank in the top 20% of the universe,
hold as long as that outperformance persists, exit when the stock's
"character changes" from strong to weak. **Independent of the other three
strategies in this repo** — own folder, own signal source. Not wired into
any live bot — backtest/research only.

Reuses `swing-strategy/mtf_candle_cache.json` for stock Daily candles (355
stocks); fetches its own Nifty 50 Daily benchmark (`nifty_daily_cache.json`,
2021-06 onward, via `fetch_nifty.js`).

## Final backtest result — read the median before the mean

**702 total trades. Mean avg P&L: +32.60%. Median P&L: -4.20%.** These
two numbers disagree because the distribution is heavily right-skewed — a
handful of enormous winners (real multibaggers, some 500-1700%+) pull the
average far above what a typical trade actually returns. Both numbers are
real; neither alone tells the honest story — see below.

**The cleanest evidence — RS_WEAKNESS-only (genuinely completed trades,
not marked-to-market or artificially time-capped):**

- **580 trades, 39.8% win rate, +16.83% avg P&L, median -4.20%**
- **Avg winner: +60.45%** (n=231) vs. **avg loser: -12.04%** (n=349) —
  a ~5:1 winner:loser ratio. This is the classic trend-following
  signature: lose small and often, win big and less often.
- **39 of these 580 (6.7%) had realized gains >=100%** — real,
  fully-completed multibaggers, not survivorship-skewed estimates.

**Two other exit buckets exist but are NOT clean completed-trade evidence:**

| Exit reason | n | Win rate | Avg P&L | What it actually means |
|---|---|---|---|---|
| RS_WEAKNESS | 580 | 39.8% | +16.83% | Real, completed exits — the strategy's own rule fired |
| DATA_EXHAUSTED | 108 | 85.2% | +32.08% | Still open when the 5-year data window ended — marked-to-market, not realized |
| MAX_HOLD_CAP | 14 | 100.0% | +690.06% | Still open after ~2 years with RS never once dropping below 50 — artificially cut off by the backtest's own cap, not a real exit signal |

The 100% win rates on the last two rows aren't a strategy result — they're
close to tautological: a position that's survived 2 years (or the entire
cached data window) without RS ever weakening is, almost by definition,
a big winner. Including their P&L in a blended "avg P&L per trade" figure
(as the headline +32.60% does) is real but optimistic — it's weighted
toward the strongest survivors. **Treat the 580-trade RS_WEAKNESS subset
as the trustworthy number, and the +32.60% blended average as an upper
bound, not a typical expectation.**

## Real multibaggers, not fabricated — top 10 trades

```
TARIL       2022-08-22 -> 2024-08-27 (499d) +1719.7% [MAX_HOLD_CAP]
MAZDOCK     2022-08-28 -> 2024-09-02 (499d) +1191.2% [MAX_HOLD_CAP]
RVNL        2022-11-03 -> 2024-11-06 (499d) +1001.0% [MAX_HOLD_CAP]
GVT&D       2023-04-16 -> 2025-04-06 (492d)  +839.8% [RS_WEAKNESS]
GALLANTT    2023-08-01 -> 2025-08-04 (499d)  +756.2% [MAX_HOLD_CAP]
```

These aren't backtest artifacts — TARIL, MAZDOCK, RVNL, COCHINSHIP and
several others in the top 10 are real infra/defense/PSU names that had
documented, massive rallies in India's 2022-2024 small-cap cycle. The
strategy's core mechanic (buy strength vs. Nifty, hold while it persists,
no fixed target to cap the upside) genuinely would have caught these —
that's a real, meaningful finding, not a coincidence of the backtest.

## Rules, as actually implemented

1. **Relative Strength ranking** (`rs_rank.js`): `RS_raw = 0.4×relRet(3mo)
   + 0.2×relRet(6mo) + 0.2×relRet(9mo) + 0.2×relRet(12mo)`, where
   `relRet(N)` = the stock's N-month return minus Nifty's N-month return
   over the same window. `RS_raw` is then percentile-ranked (0-100)
   **cross-sectionally across the whole universe, per trading day** — this
   is what makes it a "ranking," not just a raw performance number.
2. **Entry**: the first day RS rank crosses from below 80 to 80-or-above
   (a fresh crossing, not "still above 80 from yesterday"). Entry price =
   next day's open (no lookahead).
3. **Exit**: the first day RS rank drops below 50 after entry (user-
   confirmed threshold, symmetric to the 80 entry, matches the source's
   own "avoid near 50 or below" framing) — OR a ~2-year cap (500 trading
   days) if RS never weakens that much.
4. **No fixed price stop or target.** Deliberate — the source describes a
   pure character-change exit ("logical stop... falling more than the
   index"), not a price level. This is a real design choice: it's what
   lets the big winners above run uncapped, but it also means a single
   trade's loss is theoretically unbounded until the next RS check (daily
   granularity, so in practice bounded by how far a stock can fall in one
   session before its rank updates).
5. **One position per stock at a time** — a fresh crossing while already
   holding that stock is ignored.

## Genuinely undefined terms in the source, and how they were resolved

| Ambiguity | Resolution |
|---|---|
| TradingView's "Relative Strength for Indian Market" indicator internals aren't public | Built a disclosed, standard IBD-style weighted-percentile proxy instead — user-confirmed choice. **Not a faithful replication of that specific script.** A differently-built RS indicator could rank differently. |
| Exit threshold — source only says "character changes... becomes weak" | RS rank < 50, user-confirmed, symmetric to the 80 entry. |
| Exact entry trigger beyond RS+fundamentals | **The source itself is vague here** — the author explicitly says he can't give full entry details in the video and points elsewhere. No additional technical trigger was invented; entry fires purely on the RS crossing. |
| "1-2 years" holding horizon | Modeled as a 500-trading-day (~2 year) cap — a backtest necessity, not a rule from the source; see the MAX_HOLD_CAP caveat above for why this likely truncates some real winners early. |

## A real limitation: Sales Growth isn't backtested

The source's fundamental confirmation ("wait to verify Sales Growth") is
**not applied in this backtest at all.** Screener.in (the data source used
by `multibagger-screener/`) only exposes current-moment ratios, not
historical point-in-time snapshots — there's no way to know what a
stock's Sales Growth actually was back in, say, August 2022 without
lookahead bias. This is the exact same limitation `multibagger-screener/`
already documented and worked around with forward-performance tracking
instead of a historical backtest.

**What this means**: the 702-trade backtest above tests the RS-momentum
technical rule alone. If this strategy is ever built for live alerting,
Sales Growth would be checked at alert time (always "current" for a live
system, unlike backtesting) — reusing `multibagger-screener/
fundamental_screener.js`'s existing Screener.in scraper directly, no new
data source needed.

## Known limitations

- **RS methodology is a disclosed proxy**, not the actual TradingView
  indicator — see above.
- **Sales Growth not backtested** — see above.
- **Transaction costs not modeled.**
- **MAX_HOLD_CAP and DATA_EXHAUSTED trades (122 of 702, ~17%) are
  marked-to-market or artificially truncated, not real completed exits**
  — they skew the blended average optimistically since they're
  systematically the strongest survivors. Use the 580-trade RS_WEAKNESS
  subset for an honest read.
- **No fixed stop-loss** means a single trade's downside isn't bounded by
  a price level, only by the next RS-rank re-evaluation (daily).
- **Entry trigger is under-specified in the source itself** — the author
  admits it. No invented technical trigger was added beyond the RS
  crossing.
- **Not wired to any execution path.** Backtest/research code only.

## File guide

| File | Purpose |
|---|---|
| `fetch_nifty.js` | Fetches Nifty 50 Daily candles (benchmark) from Upstox |
| `rs_rank.js` | RS_raw computation + cross-sectional percentile ranking |
| `signal_engine.js` | Entry detection: RS rank crossing above 80 |
| `simulate_rs.js` | Trade simulator: RS-weakness exit, max-hold cap |
| `scan_all.js` | **Main entry point** — full backtest across all cached stocks |
| `signals_found.json` | Full trade-level output of the last `scan_all.js` run |
| `nifty_daily_cache.json` | Cached Nifty 50 Daily candles (regeneratable) |
