# Demand/Supply Confluence Swing Strategy — v1

A positional (CNC/delivery, multi-day hold) swing-trading strategy, translated
from the user's paid-course rulebook into precise, backtestable rules and
iteratively refined against real Upstox historical data. **Independent of the
NSE-announcement intraday strategy in `backtest/`** — separate capital pool,
separate signal source, separate code path. Not wired into the live bot
(`src/`) — this is backtest/research code only.

## Final backtest result (as of this save)

- **178 Nifty500 Shariah-compliant stocks**, ~4 years Daily/Weekly/Monthly history
- **26 trades, 57.7% win rate, +3.64% avg P&L/trade, ~17.8 day avg hold**
- Exit breakdown: 15 target-hit, 10 stop-loss, 1 time-cap (90-day cap, no data-exhausted)

Run `node scan_all.js` to reproduce (uses the cached candle data in this
folder — no API calls needed unless the cache is deleted).

## Rules, as actually implemented (not just as originally worded)

All conditions below are required simultaneously for a signal to fire — see
`separate_conditions.js` for proof that none of the three named conditions
(zone/RSI/BB) has real edge alone; the edge is specifically in the confluence.

1. **Trend filter** (`confluence.js`): Daily 50-SMA non-declining over 10 bars,
   AND capped at +2% slope over that window. (Cap added — see Proposal 2 below.)
2. **Demand zone** (`zones.js`): Daily zone recently touched (≤10 bars) and not
   since invalidated (not required to still contain today's close — see the
   doc comment in `zones.js` for why), scoring ≥5/7 on the rulebook's
   freshness/strength/time-at-base rubric, confluent with a Weekly or Monthly
   zone (within 3% or overlapping). **3-base-candle zones excluded** (empirically
   underperform 1- and 2-candle bases — see Proposal 4 below).
3. **RSI**: Daily RSI 50–60 (tightened from 50–75 — see Proposal 1), Weekly and
   Monthly RSI 50–75. No bearish divergence (classic or hidden) on the most
   recent Weekly or Monthly swing-high pair.
4. **Entry trigger**: 9 EMA crosses above 20 SMA (Bollinger middle band) on Daily.
5. **Sector strength**: the stock's sector index itself in a Monthly demand zone
   (158/178 stocks have a confident sector classification in `sector_map.json`;
   the remaining 20 pass through unfiltered — genuinely no clean index match,
   not a guess).
6. **Entry-gap cap**: skip if next-day open gaps >1% from signal-day close
   (Proposal 3 — cleanest single finding in the whole audit).

**Target**: nearest qualifying Daily or Weekly supply zone above entry (≥1:1
R:R), else 1:2 fixed R:R fallback. **Stop**: the demand zone's distal line.
**Max hold**: 90 trading days (a modeling cap, not a rulebook parameter — no
trade in the final backtest actually hit it via `DATA_EXHAUSTED`).

## What changed from the literal rulebook, and why (audit trail)

Every deviation below was driven by real backtested evidence, not guesswork —
see chat history / `audit_report.json` for full trade-ID-level citations.

| # | Change | Evidence |
|---|---|---|
| — | Zone check redefined from "price closes inside the zone today" to "zone touched within 10 bars, not since invalidated" | The literal same-day reading made RSI-60 and zone-touch nearly mutually exclusive (RSI recovers only as price *leaves* the zone) — see chat for the diagnostic. |
| — | Divergence lookback narrowed from 2-3 swing-high pairs to the most recent pair only | Older pairs are stale; checking them was disqualifying good setups on outdated signals. |
| 1 | Daily RSI ceiling tightened 75 → 60 | RSI 55–60 bucket: n=27, 59.3% win, +4.60% avg. RSI 60–70: n=18, 27.8% win, ~0% avg. |
| 2 | Trend slope capped at +2%/10 bars (previously unbounded) | Slope 0–2%: n=35, 54.3% win, +3.96% avg. Slope 2–5%: n=20, 40.0% win, +0.59% avg — steep runs look like a chase, not a genuine pullback. |
| 3 | Entry skipped if next-day gap >1% from signal close | Gap 0.5–1%: n=12, 75.0% win, +5.63% avg. Gap 1%+: n=12, 25.0% win, -1.66% avg. Cleanest finding in the audit. |
| 4 | 3-base-candle zones excluded | baseCount=2: n=20, 55.0% win, +4.30% avg. baseCount=3: n=7, 28.6% win, +0.20% avg — contradicts the rulebook's own "1-3 candles = powerful" framing. |
| 5 | Supply-zone target search extended to Weekly (not just Daily) | Only 15/88 trades found a Daily-only supply zone; Weekly search found more real targets without diluting quality. |
| — | Sector coverage extended 71% → 89% of the universe (127→158/178 stocks mapped) | Sector-mapped trades: 52.6% win/+4.01% avg vs unmapped 46.0%/+1.80% — not explained by sample skew. |

**Known bug found and fixed during the audit**: an earlier edit accidentally
deleted the line that computes the supply-zone target, silently forcing every
trade onto the weaker FIXED_RR fallback for several rounds of testing. Fixed —
`confluence.js` line ~194 (`supplyZone = nearestSupplyZoneTarget(...)`). If
you ever see 0 `SUPPLY_ZONE`-sourced trades in a rerun, check this line first.

## Known limitations — read before trusting this further

- **n=26 is a small sample** over ~4 years (~6-7 trades/year). Six rounds of
  sequential refinement got here — each individually verified, but stacking
  refinements on a modest dataset risks fitting noise. Treat this as a
  reasonable stopping point for backtest-only refinement.
- **Transaction costs are NOT included** in `scan_all.js` output. Rough
  estimate from chat: ~0.25% round-trip (STT + brokerage + charges) per trade
  eats a meaningful chunk of the smaller-P&L trades.
- **CAGR context**: ~6.4-7.5%/year on the peak capital you'd need reserved
  (₹5L, for the one moment multiple positions overlapped) vs ~31%/year on
  capital actually deployed on average (~₹95K) — see chat for the full
  capital-efficiency discussion. Comparable to a fixed deposit on the
  conservative framing; meaningfully better on the capital-efficiency framing.
- **Data source caveats**: sector index candles have `volume=0` (indices don't
  trade); Upstox's `month` interval caps at 10 years back, `day`/`week` tested
  to 5+ years. `symbols.json` covers 178 of the ~350+ Nifty500 Shariah
  constituents — the smallest-weight tail wasn't mapped (see chat for the
  original CSV-sourcing discussion).
- **Not wired to any execution path.** This is backtest/analysis code. If you
  ever want to run this live, it needs its own signal-poller and order-placement
  wiring — nothing here talks to Upstox for trading, only for historical data.

## File guide

| File | Purpose |
|---|---|
| `indicators.js` | EMA/SMA/RSI/Bollinger Bands, trend-rising/golden-cross helpers |
| `zones.js` | Demand/supply zone detection + 7-point scoring rubric |
| `divergence.js` | Classic/hidden bearish divergence (RSI vs price swing highs) |
| `confluence.js` | Wires everything into the full signal-firing decision + target/stop logic |
| `simulate_positional.js` | Multi-day trade simulator (target/stop/90-day cap) |
| `scan_all.js` | **Main entry point** — runs the full backtest across all 178 stocks |
| `separate_conditions.js` | Isolates zone/RSI/BB as standalone signals (proves the edge is in the confluence) |
| `audit_conditions.js` | Per-trade rule-condition audit + entry-day drift detection |
| `fetch_all.js` / `fetch_sectors.js` | Upstox data fetchers (re-run only if cache is deleted/stale) |
| `sector_map.json` | Stock → Nifty sector-index classification (158/178 mapped) |
| `symbols.json` | Verified NSE symbol → Upstox instrument_key map (178 stocks) |
| `mtf_candle_cache.json` / `sector_candle_cache.json` | Cached historical candles (large — 26MB — regeneratable, consider gitignoring if committing) |
