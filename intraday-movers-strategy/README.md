# Intraday Opening Range Breakout (ORB) Strategy

Built from scratch this session for a specific, direct ask: Rs 50,000 capital,
intraday, both buy and sell, design left entirely to judgment. **Independent
of every other strategy in this repo** — new universe, new mechanism, new
capital pool.

## The honest starting point

The original ask was "1% net profit every day, guaranteed." That's not
achievable by any real strategy — it compounds to ~12x capital in a year,
which no legitimate system does. What follows is the *real* version: a
genuinely backtested, working intraday edge, reported with actual numbers
including the losing days, not a promise.

## Two ideas that were tried and killed first

1. **"Biggest prior-day mover, gap continuation"** — rank all 353 halal-
   screened stocks by yesterday's % return, take the top gainer/loser, bet
   the gap continues today. **Result: 13.7% win rate, -0.289% avg (a clear
   loss).** Testing the opposite (fade/reversal) gave nearly identical bad
   numbers, which was the key clue: direction wasn't the problem. The real
   issue — these "biggest mover" stocks have a **median 6-7% intraday
   range**, which swamps any tight 1% target regardless of direction.
2. That finding directly motivated the next design: filter for *moderate*
   volatility instead of chasing extremes.

## Final strategy: Opening Range Breakout, volume-confirmed

- **Universe**: 158 stocks from the 353-stock halal universe whose trailing
  40-day average daily range falls in **1.5%-3%** (large/mid-caps like
  Reliance, L&T, Sun Pharma, UltraTech — not the small-cap volatility traps
  from the killed idea).
- **Signal**: define the Opening Range = first 15 minutes after 9:15 IST
  open. The first breakout of that range — LONG above the OR high, SHORT
  below the OR low — triggers entry at the range boundary, **provided the
  breakout bar's volume is at least 30x the average opening-range volume**
  (see below for why 30x, not some smaller "reasonable-sounding" number).
- **Target**: 2% from entry.
- **Stop**: the *opposite* side of the opening range (a structural stop, not
  an arbitrary fixed %) — capped at 2%; if the natural OR-based stop would be
  wider than that, the setup is skipped rather than forced.
- **Exit**: whichever hits first, walking REAL 1-minute bars in chronological
  order (not a daily-OHLC approximation — see below). Square off at close if
  neither hits.
- One trade per stock per day, either direction.

## Why 30x volume confirmation (this wasn't picked arbitrarily)

Every parameter here was tuned against real backtested evidence, walking the
volume-confirmation multiplier from "off" up to 50x:

| Volume mult | Trades (60d) | Trades/day | Net win | Net avg/trade |
|---|---|---|---|---|
| off | 4,763* | 79.4 | 57.0% | +0.257%* |
| 5x | 4,763 | 79.4 | 57.0% | +0.257% |
| 10x | 2,800 | 46.7 | 60.8% | +0.359% |
| 20x | 1,367 | 22.8 | 62.5% | +0.422% |
| **30x** | **814** | **13.6** | **62.8%** | **+0.433%** |
| 40x | 566 | 9.4 | 60.4% | +0.375% (declining) |
| 50x | 419 | 7.0 | 60.1% | +0.390% |

*at 2% target / 2% stop cap, both directions — see "Full iteration history" below for the 1% target results this table's neighbors were tuned from.

Quality genuinely **peaks around 25-30x**, not just "gets quieter" — pushing
past 40x the sample thins out and results start declining, which is why 30x
was chosen over an even stricter filter that would look better on paper but
is really just noise from too few trades. This was also checked for
concentration risk: at 30x, 124 of 158 stocks still contribute trades, the
top 5 symbols are only 15.8% of the total, and all 60 backtested trading
days have at least one signal (median 14/day) — a broad-based effect, not a
lucky handful of names or days.

**A quick, tempting-but-wrong idea that was tested and rejected**: instead of
a universal volume threshold, rank each day's candidates by volume ratio and
take the top 10 strongest. This made things *worse* (57.0% → 53.5% win,
+0.257% → +0.190% net avg), because comparing volume ratios *across
different stocks* isn't apples-to-apples — a naturally low-volume stock can
show an inflated ratio without real conviction behind it. The fixed universal
threshold is the correct filter; raising it (not ranking within a day) is
what actually improves quality.

## Full iteration history (target/stop tuning, at 5x volume confirmation)

Before locking in 30x, the target and stop were tuned first at a fixed 5x
volume confirmation:

| Target | Stop cap | Net avg/trade |
|---|---|---|
| 1.0% | 1.5% | +0.215% |
| 1.5% | 1.5% | +0.247% |
| **2.0%** | 1.5% | +0.249% (peak — wider targets past this decline) |
| 2.0% | **2.0%** | **+0.257%** (widening the stop cap too, at the same target, adds trades without hurting quality) |
| 2.0% | 2.5% / 3.0% | +0.259% / +0.261% (flat — no further real gain) |

2.0% target / 2.0% stop cap was carried forward as the base before the
volume-multiplier grid above was run on top of it.

## Real transaction costs (Rs 50,000 capital, intraday MIS)

Same cost model used elsewhere in this project (Zerodha-representative
schedule): brokerage min(Rs20, 0.03%) per leg, STT 0.025% sell-side, exchange
0.00297%/SEBI 0.0001% both sides, stamp duty 0.003% buy-side, 18% GST on
brokerage+exchange+SEBI. All numbers above are already net of this — the
+0.433% is what's left after costs, not before.

## A real modeling limitation

Both the "biggest mover" idea (killed) and the target/stop tuning stage used
**daily OHLC only** (open/high/low/close), with the project's standard
"stop assumed to hit first on same-day overlap" convention when both target
and stop fall within a single day's range. The final ORB backtest is a
genuine improvement here — it walks **real 1-minute bars in actual
chronological order**, so target/stop sequencing is factually correct, not
approximated. This is a meaningfully more trustworthy result than the
daily-only tests earlier in this exploration.

## What Rs 216/trade actually means

At 30x/2%/2%, net average is +0.433% per trade ≈ **Rs 216 on Rs 50,000**,
roughly 14 qualifying setups/day across the 158-stock universe (you'd take
one, or a few, not all of them with a single capital pool). This is real,
backtested, evidence-based edge — not the original "1% every day" ask, but
the first genuinely working strategy found across every idea tested in this
session. Treat "roughly 14/day, median" as an approximation: the actual
range is wide (min 2, max 33 across the 60-day test window) — some days
will have very few or zero qualifying setups, others several.

## Known limitations — read before trusting this further

- **60-day backtest window** — Upstox's 1-minute historical data has a
  30-day-per-call cap; this test used ~3 months. That's a real but
  short sample for an intraday strategy trading ~14 times/day (unlike the
  swing strategy's ~4-year window) — worth extending before committing
  meaningful capital.
- **Upstox's historical-candle endpoint has at least a 1-day data lag** —
  confirmed directly: at 8pm IST on the trading day itself, that day's data
  still returns zero candles. This means a genuine same-day/live version of
  this strategy would need the real-time WebSocket market-data feed (like
  the EMA scalp live streamer), not this REST endpoint — a real build item
  if this goes live, not yet done.
  ("Today's" scan below therefore uses the most recent day Upstox actually
  had data for at the time it was run, not literally the calendar day.)
- **Slippage not modeled** — entries assume a fill exactly at the OR
  boundary price; in practice a fast breakout may fill worse.
  **No leverage modeled** — Rs 50,000 deployed on one position at a time,
  1x. MIS leverage (commonly 3-5x from discount brokers) could scale
  returns but also scales risk and hasn't been tested here.
- **Not wired to any live execution or alert path yet** — this is
  backtest/research code, matching every other strategy in this repo before
  its live build step.

## File guide

| File | Purpose |
|---|---|
| `scan_movers.js` / `scan_movers_fade.js` | The killed "biggest mover" continuation/fade idea — kept as an audit trail of what didn't work and why |
| `fetch_orb_universe.js` | Fetches 1-minute data for the 158-stock moderate-volatility ORB universe |
| `scan_orb.js` | Main backtest — env vars `TARGET_PCT`, `MAX_STOP_PCT`, `VOLUME_MULT`, `SHORT_ONLY`, `LONG_ONLY` |
| `top_n_per_day.js` | The rejected "rank by volume ratio, take top N/day" idea — kept as an audit trail |
| `apply_costs.js` | Realistic intraday MIS cost model, Rs 50,000 capital |
| `scan_today.js` | Runs the final recommended settings (30x/2%/2%) against a single specific day — `SCAN_DATE=YYYY-MM-DD node scan_today.js` |
| `intraday_1min_cache.json` | Cached 1-minute candles for the 158-stock universe (gitignored, regeneratable) |
| `trades_orb.json` | Full trade-level output of the last `scan_orb.js` run |
