# EMA Scalp Strategy — 9/15 EMA Cash-Equity Scalping — v1

A short-hold (single-day, ~25 min avg) intraday scalping strategy built on
9/15 EMA trend alignment + candle-pattern triggers + cross-index
confirmation. **Independent of the announcement strategy (`backtest/`), the
swing strategy (`swing-strategy/`), the Box strategy (`box-strategy/`), and
the SMC strategy (`smc-strategy/`)** — separate signal source, separate code
path. Unlike the other three, this one **is live**: `live/streamer.js` is
deployed as its own Railway service (`ema-scalp-live-streamer`), streaming
Upstox's official V3 market-data WebSocket feed and alerting via Telegram.
Alert-only — no real orders are placed anywhere in this project.

## Stock universe — widened from 178 to 353 (2026-07-13)

The strategy launched validated against a 178-stock Shariah-compliant
universe (halal screen: no banks/NBFCs/alcohol/gambling/tobacco/high-debt
companies, sourced from the Nifty 500). On 2026-07-13, the universe was
rebuilt from scratch with a reproducible, file-backed screen (unlike the
original, which wasn't recoverable — see "Universe screening methodology"
below) and widened to **353 stocks**. `symbols.json` (and its copy in
`live/`, used by the deployed streamer) now reflects this 353-stock list;
the original 178 is preserved at `symbols_178_backup.json`.

**Backtest comparison, 353 vs the original 178** (same signal rules, same
data window):

| | 178-stock (original) | 353-stock (current) |
|---|---|---|
| Trades | 157 | 330 |
| Gross win / avg P&L | 70.1% / +0.471% | 67.6% / +0.454% |
| Net win / avg P&L (after costs) | 68.2% / +0.389% | 66.4% / +0.372% |

Splitting the 330 trades by origin: the 156 trades from the original
176-overlap stocks perform almost identically to the original validation
(69.9%/+0.471% gross — matches, since it's essentially the same signals
minus 2 stocks that dropped out). The 174 trades from the **177 newly
eligible stocks** (added by narrowing the debt screen to debt-to-assets
< 33% instead of dropping it, then removing insurance companies) are real
but meaningfully weaker: 65.5% win / +0.440% gross avg — still profitable,
but roughly 4-5 points below the core set, plausibly because higher-leverage
names (Vodafone Idea, Adani Green Energy, GMR Airports, etc., all newly
eligible once the debt threshold was applied instead of removed) trend
less cleanly than lower-debt names. Both universes still concentrate
signals on the same 2 calendar days (2026-06-23, 2026-07-08) — widening
the stock count doesn't change which days the market-wide condition fires,
only how many stocks participate on those days.

### Universe screening methodology (reproducible, unlike the original)

1. Fetched the official Nifty 500 constituent list directly from NSE
   (`nsearchives.nseindia.com/content/indices/ind_nifty500list.csv`) — 500
   companies with NSE's own industry classification.
2. Excluded by business/sector, using NSE's classification plus manual
   company-name review within `Financial Services` (which mixes banks,
   NBFCs, insurers, AMCs, and exchanges) and `Fast Moving Consumer Goods`
   (alcohol/tobacco): 26 banks, 37 NBFCs, 4 alcohol producers, 2 tobacco
   companies. No gambling/casino companies are currently in the Nifty 500.
3. Excluded 13 insurance companies separately — not part of the user's
   literal "banks/NBFCs" instruction, but excluded on request as a
   business-model judgment call (note: all 13 had near-zero reported debt
   and would have passed the debt screen regardless).
4. For the remaining companies, fetched real debt-to-total-assets ratios
   from Screener.in (authenticated scrape, same method as
   `src/main/java/com/adil/nsealerts/FundamentalScreener.java`'s existing
   live per-stock check) and kept only debt-to-assets < 33% — the same
   threshold already used elsewhere in this project.
5. Resolved each surviving symbol to its Upstox instrument key via the
   full NSE_EQ instrument master (129,496 instruments checked; all 353
   resolved cleanly, no manual fallback needed).

Final count: 500 → 431 (business/sector screen) → 418 (minus insurance) →
**353** (debt-to-assets < 33%). Cross-checked against the original 178:
176 stocks overlap cleanly; 2 (BATAINDIA, TORNTPHARM) now fail the debt
screen on freshly-fetched data (36.7% and 34.5% debt-to-assets — both
were likely under the threshold when the original 178 was built, or were
included for a different reason no longer recoverable); 177 are genuinely
new. Full per-company data: see the scratchpad's `nifty500/` working
directory for `debt_results.json`, `final_eligible.json`, and the full
Nifty 500 pass/fail breakdown — none of this is committed to git.

## Translated from options to cash equity

The source material described this as a **Nifty/Bank Nifty options**
scalping system. Options trading is F&O, which conflicts with the
project's standing halal constraint (no F&O). Per explicit user direction,
this was rebuilt for **cash equity**: the Nifty/Bank Nifty EMA
cross-confirmation became stock-vs-Nifty-50 EMA cross-confirmation (both
must show the same-direction trend), and the underlying instrument is the
stock itself rather than an options contract.

## Final result — the strongest of the four new strategies after costs

**Narrowed to SHORT + BIG_BAR only, plus a 14:30 IST entry cutoff** (see
Rule Narrowing and Entry-Time Cutoff below):

- **157 trades across 137/178 stocks, ~2 months of data (2026-05-06 to
  2026-07-08)**
- **Gross: 70.1% win rate, +0.471% avg P&L**
- **Net of realistic transaction costs: 68.2% win rate, +0.389% avg P&L**
- ~36 min avg hold
- Run `node scan_short_bigbar.js` then `node apply_costs.js` to reproduce
  (uses cached data — no API calls needed)

| Split (gross, pre-cost, full 4-way signal, no time cutoff) | n | Win rate | Avg P&L |
|---|---|---|---|
| LONG | 218 | 45.0% | +0.120% |
| SHORT | 318 | 63.5% | +0.311% |
| PIN_BAR | 134 | 49.3% | +0.107% |
| FLOWER_BODY | 74 | 50.0% | +0.150% |
| BIG_BAR | 328 | 60.1% | +0.304% |
| SHORT+BIG_BAR (isolated, no time cutoff) | 248 | 64.1% | +0.341% |
| **SHORT+BIG_BAR + 14:30 cutoff (current)** | **157** | **70.1%** | **+0.471%** |

Isolating the intersection of the two strongest splits *improved* on both
individual splits rather than diluting between them — the opposite of what
happened when isolating single conditions in the swing strategy (there,
no single condition alone had edge; here, the strongest combination
compounds). LONG+PIN_BAR is barely above breakeven and was dropped.

This is the only one of the three intraday/short-hold strategies (Box,
SMC, this one) whose edge **comfortably survives a real transaction-cost
model** — see Transaction Costs below. **Read the Entry-Time Cutoff and
Known Limitations sections before trusting the 70.1%/+0.471% figure** —
it is confounded with a data-concentration issue described there.

## Rules, as actually implemented

1. **EMA trend filter**: 9-EMA vs 15-EMA on 5-minute candles. Trend =
   BULLISH if `EMA9 > EMA15` AND `EMA9`'s slope over the last 5 bars is
   positive and exceeds a threshold; BEARISH if the mirror condition holds.
   Flat/disagreeing markets return no trend (filtered out).
2. **"30 degree slope"** *(proposed interpretation)*: the source's slope
   language is a visual chart-angle description with no defined chart
   scaling, so it isn't literally computable. Translated to a % change of
   the 9-EMA over a 5-bar lookback (`SLOPE_THRESHOLD_PCT`, currently 0.3%),
   empirically tunable rather than guessed once and left.
3. **Cross-index confirmation** *(translated from Nifty-vs-BankNifty)*: the
   stock's 5-min EMA trend AND the Nifty 50 index's 5-min EMA trend
   (computed the same way) must agree in direction. Both must be BULLISH
   or both BEARISH — disagreement kills the signal.
4. **Candle trigger** (any of three, evaluated on the trend-confirmed bar):
   - **Pin Bar**: body < 30% of range, opposite-direction wick ≥ 60% of range.
   - **Flower Body / engulfing**: body ≥ 60% of range, engulfs the prior
     candle's full body, correct color for the trade direction.
   - **Big Bar**: candle range ≥ 1.5× the average range of the preceding
     10 candles, correct color for the trade direction.
5. **Entry**: next candle's open after the trigger candle closes (no
   lookahead — the source's "enter at the trigger candle's close" isn't
   achievable in a backtest without using future information).
6. **Stop-loss**: the trigger candle's low (LONG) / high (SHORT).
7. **Target**: fixed 1:2 risk-reward from entry.
8. **Exit**: stop-loss, target-hit, or 15:20 IST time cutoff (same-day
   square-off, no overnight hold), whichever comes first. Stop assumed to
   hit first if both stop and target fall within the same bar's range
   (conservative convention used throughout this project).

## Rule narrowing — SHORT + BIG_BAR only

The full 4-way signal (LONG/SHORT × 3 pattern types) produced 536 trades at
56.0% win / +0.233% avg P&L. Splitting by direction and pattern showed:

- SHORT (63.5%/+0.311%) meaningfully outperformed LONG (45.0%/+0.120%)
- BIG_BAR (60.1%/+0.304%) meaningfully outperformed PIN_BAR (49.3%/+0.107%)
  and FLOWER_BODY (50.0%/+0.150%)

Narrowing to their intersection (`findDaySignalShortBigBarOnly` in
`signals.js`) gave 248 trades at 64.1%/+0.341% — better than either split
alone, confirming this isn't just noise from a smaller sample cherry-picked
after the fact; it's the two strongest signals reinforcing each other.

## Entry-time cutoff — fixes a real problem, but the improvement number is unproven

Before the cutoff, 85/248 trades (34%) exited via `TIME_EXIT` (ran out of
time before hitting stop or target) at 69.4% win / +0.239% avg — clearly
worse than `TARGET_HIT` trades. Diagnosis (`diagnose_time_exit.js`):

- 61% of `TIME_EXIT` trades entered in the 15:00-15:19 window (last 20 min
  before the 15:20 square-off), vs. only 8% of `TARGET_HIT` trades.
- Median bars remaining until cutoff *at entry* for `TIME_EXIT` trades: 2
  bars (10 minutes).
- **0 of the 85** `TIME_EXIT` trades ever moved against the position — every
  one was still net favorable, just hadn't traveled far enough. 20% were
  ≥80% of the way to target when the clock ran out.
- 90% of `TARGET_HIT` trades resolve within 50 minutes of entry.

This is a genuine mechanical problem, not a signal-quality problem: the
strategy generates valid trend signals late in the day that then can't
possibly reach a 1:2 target before the mandatory square-off. A
**14:30 IST entry cutoff** (`ENTRY_CUTOFF_MINUTES` in `signals.js`) — chosen
to leave ~50 minutes of runway, matching the 90th-percentile winner's hold
time, not chosen by sweeping for the best backtest number — is applied in
the saved version.

**However: don't trust the resulting 70.1%/+0.471% figure as validated.**
All 248 pre-cutoff trades came from just **3 calendar days** in the fetch
window (2026-07-08: 142 trades, 2026-05-29: 85, 2026-06-23: 21) — this SHORT
strategy only fires during broad market-wide selloffs (it requires the
stock AND Nifty to both be bearish at once), so each "day" is really one
correlated market event producing dozens of simultaneous single-stock
signals, not independent trials. Checking the cutoff's effect per day: **it
didn't trim each day proportionally — it eliminated 2026-05-29 entirely**
(all 85 of that day's signals fired after 14:30; the weakest day by far, at
9% target-hit rate). So the improved number is statistically
indistinguishable from "delete the one bad day out of three," which could
be coincidence (that day's sell-off may have been a late-session,
low-quality move for reasons unrelated to time-of-day generally) rather
than a real, generalizable timing edge. The cutoff itself is kept because
it's sound on its own mechanical logic regardless of this confound, but
**the backtest numbers with vs. without it should not be used to conclude
the cutoff "improved" the strategy** until more independent trading days
of data are available to check whether it holds up.

## No-opposing-wick filter — tested, not adopted

User observation comparing winning vs. losing trade charts: winning SHORT
trades' Big Bar trigger candles tended to show almost no lower wick (no
sign of buying pressure mid-candle before the close), while losing trades
often showed a visible one — "there was buy pressure in the losing trades."
Investigated directly (`diagnose_wick.js`, `sweep_wick.js`) rather than
taken on faith:

- **The literal version (near-zero wick tolerance) does not hold up.**
  Sweeping tolerances from 5% to 20% of candle range *reduced* win rate
  versus no filter at all (70.1% baseline → 66-69%), while cutting the
  sample by 35-67%. Median lower-wick fraction for winners (0.14) is barely
  different from losers (0.13) across the full range — "small wick" doesn't
  cleanly separate outcomes in this data.
- **There is a real but weaker effect at the extreme tail.** Bucketing all
  157 trigger candles into wick-fraction quintiles, the bottom four buckets
  all win 65-78% with no clear ordering, but the worst quintile (wick
  fraction > ~0.35) wins only 58.6%. STOP_LOSS trades do average a
  meaningfully higher wick than TARGET_HIT trades (0.29 vs 0.19) —
  consistent with the user's read, just concentrated at the tail rather
  than a smooth gradient. A looser filter (~35-40% tolerance, excluding
  only the worst outliers) gave a modest apparent gain: 142 trades,
  71.8%/+0.491% gross vs. baseline's 157/70.1%/+0.471%.
- **Not adopted.** Even the loose version was found by sweeping 8
  thresholds on the same 157-trade, effectively-2-day sample — the same
  overfitting risk already flagged for the entry-time cutoff, and here it
  actively contradicts what the tight version of the user's own hypothesis
  predicted. Presented to the user with the full sweep and direct
  correlation numbers; decision was to leave the strategy as-is rather than
  add an unproven filter. The infrastructure (`isBigBarNoOpposingWick` in
  `candle_patterns.js`, `setWickTolerance` in `signals.js`) is left in
  place, disabled by default (`WICK_TOLERANCE = null`), in case more data
  later supports revisiting this.

## Transaction costs

Modeled realistic Indian intraday-equity (MIS) costs on a ₹1,00,000
position size (the capital-per-trade convention established for the swing
strategy earlier this session), using the commonly-published Zerodha
discount-broker schedule as a representative real-world reference:

- Brokerage: `min(₹20, 0.03% of order value)` per executed order (2 orders
  per round trip — entry + exit)
- STT: 0.025% on sell-side turnover only
- Exchange transaction charges (NSE): 0.00297% on total turnover (both legs)
- SEBI turnover fee: 0.0001% on total turnover (both legs)
- Stamp duty: 0.003% on buy-side turnover only
- GST: 18% on (brokerage + exchange transaction charges + SEBI fee)

Average round-trip cost: **0.082% of capital**. Applying this per-trade:

| | Win rate | Avg P&L |
|---|---|---|
| Gross | 70.1% | +0.471% |
| **Net** | **68.2%** | **+0.389%** |

By exit reason: `TARGET_HIT` (n=92) barely dents (+0.947% → +0.864%, 100%
win either way); `STOP_LOSS` (n=34) worsens slightly as expected (-0.436% →
-0.518%, 0% win either way); `TIME_EXIT` (n=31) absorbs the most relative
damage and flips from a net positive to a net negative on average (+0.056%
gross → -0.027% net, 58.1% → 48.4% win rate) — the *remaining* TIME_EXIT
trades after the cutoff are, on average, weaker than the ones removed,
which makes sense since the cutoff specifically removed the
worst-positioned (latest-entry) ones. Only 3/157 trades flip from a gross
win to a net loss/breakeven. Run `node apply_costs.js` to reproduce.

## Known limitations

- **Only 3 independent trading days of signal activity in the fetch
  window** (2026-07-08, 2026-05-29, 2026-06-23) — this is the single
  biggest caveat for this strategy. Because the signal requires both the
  stock and the Nifty 50 index to be in a bearish EMA trend simultaneously,
  it only fires during broad market-wide selloffs, and on such a day it
  fires across dozens of stocks at once. The "157 trades" or "248 trades"
  headline numbers are real trade counts but are **not 157/248 independent
  trials** — they're draws from ~3 correlated market events. Every
  percentage in this README should be read with that in mind. Validating
  this strategy properly requires accumulating more independent trading
  days (either a longer historical window than Upstox's 90-day 1-minute
  cap allows, or live/forward monitoring over time), not just more stocks.
- **Candle pattern definitions are proposed interpretations** — the source
  gives visual descriptions (pin bar, "flower body", big bar) with no
  mathematical thresholds. The exact cutoffs used here (30%/60% body
  fractions, 1.5× range multiple) are reasonable but not sourced.
- **Slope threshold is a proxy, not the literal "30 degrees."** Chart-angle
  slope depends on axis scaling that the source never specifies. Tunable
  via `setSlopeThreshold()` in `ema_trend.js` if the user wants to sweep it.
- **~2 months of data (90-day fetch window)** — Upstox's 1-minute interval
  caps at 30 calendar days per request (chunked to 90 total here). This is
  the shortest data window of any of the four strategies; the swing
  strategy's daily/weekly data spans 5 years.
- **137/178 stocks contributed trades** after the entry cutoff (was 161/178
  before it) — stocks whose only signals fired after 14:30 on 2026-05-29
  dropped out entirely.
- **Transaction costs assume a specific broker's published rate schedule**
  and a flat ₹1,00,000 position size; a different broker, position size, or
  added slippage assumption would shift the net numbers.
- **Not wired to any execution path.** Backtest/analysis only.

## File guide

| File | Purpose |
|---|---|
| `indicators.js` | EMA calculation (copied from `swing-strategy/`) |
| `candle_patterns.js` | Pin Bar / Flower Body (engulfing) / Big Bar trigger detectors |
| `ema_trend.js` | 9/15 EMA series + slope-based trend classification |
| `signals.js` | `findDaySignal` (full 4-way) and `findDaySignalShortBigBarOnly` (recommended narrowed version, includes the 14:30 entry cutoff), Nifty cross-confirmation |
| `simulate_intraday.js` | Same-day trade simulator, 15:20 IST cutoff |
| `scan_all.js` | Full 4-way backtest across all 178 stocks (536 trades, 56.0%/+0.233%, no entry cutoff) |
| `scan_short_bigbar.js` | **Recommended** — narrowed SHORT+BIG_BAR backtest with 14:30 entry cutoff (157 trades, 70.1%/+0.471% gross — see caveat above) |
| `apply_costs.js` | Applies the transaction-cost model to `trades_short_bigbar.json`, reports net results |
| `diagnose_time_exit.js` | Diagnoses TIME_EXIT trades (entry-hour distribution, progress-to-target, runway remaining) — the analysis behind the entry cutoff |
| `sweep_cutoff.js` | Sweeps candidate entry-time cutoffs and reports win rate/avg P&L at each — the tool that surfaced the 3-day concentration confound |
| `diagnose_wick.js` | Correlates trigger-candle lower-wick fraction with trade outcome directly (deciles, by exit reason) — the analysis behind the wick-filter finding |
| `sweep_wick.js` | Sweeps candidate wick-tolerance thresholds and reports win rate/avg P&L at each — tested, not adopted (see README) |
| `fetch_data.js` | Upstox fetcher: 1-min → 5-min aggregation for the stock universe + Nifty 50 index |
| `symbols.json` | **Current live universe — 353 stocks** (widened 2026-07-13, see above). Same list copied into `live/symbols.json` for the deployed streamer's self-contained build. |
| `symbols_178_backup.json` | The original 178-stock universe used for every backtest number in this README except the 353-stock comparison table |
| `intraday_cache.json` | Cached 5-min candles for the original 178-stock backtest (large — regeneratable via `fetch_data.js`) |
| `nifty_cache.json` | Cached 5-min candles for the Nifty 50 index (`NSE_INDEX\|Nifty 50`) |
| `trades.json` | Full 4-way trade list |
| `trades_short_bigbar.json` | Narrowed SHORT+BIG_BAR trade list (gross) |
| `trades_short_bigbar_with_costs.json` | Narrowed trade list with per-trade cost and net P&L fields |
