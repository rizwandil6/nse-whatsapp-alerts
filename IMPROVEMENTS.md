# Strategy improvements — 2026-07-10

Context: real price fluctuations were observed after order/contract announcements
that the bot wasn't capturing well. This documents what changed, why, what's still
unverified, and how to actually get real performance data instead of guessing.

## What changed

**New: `TradeRules.java` / `backtest/tradeRules.js`** — the partial-exit / trailing-
stop / hard-stop / time-exit decision logic used to be inline in
`UpstoxTradeService.monitorPosition()`. It's now a pure, dependency-free function
used by live trading, shadow-mode, AND the backtest simulator, so none of the three
can silently drift from what the other two actually do. The Java and JS copies are
hand-kept in sync (no cross-language build check exists) — if you change one, change
both.

**New: `TradeLog.java`** — every entry/partial-exit/exit (live or shadow) now
appends to `trades.csv`. Previously all trade state was in-memory only
(`activeTrade`, `consecutiveStops`) and history only ever reached you as a Telegram
message — there was no way to go back and measure win rate or P&L. **Caveat**: on
Railway (or anywhere without a persistent volume) this file does not survive a
redeploy, same limitation the old in-memory dedup set had. It's also echoed to the
application log line-by-line, so Railway's log retention is a fallback copy — but
you should pull `trades.csv` periodically rather than relying on that.

**New: shadow mode** (`upstox.shadow-enabled`, default `true`) — every rating≥7
signal that doesn't become a real order (outside market hours pre-queue, circuit
breaker active, NIFTY gate, already in a position, or `UPSTOX_ENABLED=false`
entirely) now gets simulated against real polled LTP using the identical
`TradeRules` logic, and logged. Shadow positions are NOT capital-constrained to one
at a time the way real trades are — every qualifying signal gets its own simulated
position — so you get more data points, faster, than live trading alone would ever
produce. **This is the realistic path to real performance numbers**, not a
historical backtest (see below for why).

**Pre-market signal queue** — `executeIfEligible()` used to silently drop any
signal rated before 09:15 IST with no retry. Order-win disclosures are commonly
filed before the bell specifically because boards approve them then, and that's
often when the biggest opening-gap move happens. Pre-market-eligible signals are
now queued and retried at 09:15:05 IST instead of discarded.

**Order fill confirmation** — `entryPrice` used to be the LTP snapshot taken
*before* placing the order, and a rejected order was never detected (the code would
still track a phantom `ActiveTrade`). `placeLiveEntry()` now polls
`GET /v2/order/details` after placing a BUY, uses the actual `average_price` /
`filled_quantity`, and does not open a position if the order didn't reach
`complete` status.

**Market-cap-aware rating** — the AI rating prompt weighs order-size vs *revenue*
only. Price reaction correlates more with order-size vs *market cap*, especially
for small caps. `AlertPoller` now fetches `FundamentalScreener` market cap in
**parallel** with the Anthropic call (not after — avoids adding latency, and avoids
scraping Screener.in twice for the same symbol) and nudges the rating based on
order-value/market-cap ratio. This is a simple, deliberately-conservative heuristic,
**not validated** — see "what's unverified" below.

**New: `backtest/`** — a standalone, runnable Node.js module implementing the same
trade rules against OHLC candle sequences, plus a runner (`run.js`) that fetches
real Upstox 1-minute candles and replays signals through it, plus a converter
(`from-tradelog.js`) that turns `trades.csv` into the runner's input format.

## What I verified vs. what I couldn't

**I have no JDK or Maven on this machine** (checked `/usr/libexec/java_home`,
sdkman, jenv, asdf, IntelliJ's bundled JDKs — nothing installed). This repo's own
README says it's meant to run inside Codespaces/devcontainer, which is consistent
with that. **This means none of the Java changes were compiled or test-run here.**
I wrote `TradeRulesTest.java` alongside `TradeRules.java` and reasoned through the
rest by hand against the existing code, but **you must run `mvn test` (in
Codespaces, or wherever you actually build this) before merging or deploying.**
Don't treat this as done until that's green.

**What I could and did verify**: the backtest simulator core
(`backtest/simulate.js` + `tradeRules.js`) is plain Node.js with no external
dependencies, and I ran its test suite here — all 10 tests pass
(`node --test backtest/`), covering hard-stop priority over target within the same
candle, partial-exit-then-trailing-stop math, time-exit override, and the
data-exhausted fallback. That's real, executed verification, not a claim.

**I did not run a historical backtest with real numbers, and I won't fabricate
one.** Two blockers, both confirmed by hand:
- Upstox's historical-candle API requires your live `UPSTOX_ACCESS_TOKEN` via
  OAuth header. I don't have it, and it shouldn't be pasted into a chat transcript
  — it's a live-trading credential. `backtest/run.js` reads it from an env var on
  whatever machine actually runs it.
- NSE's historical corporate-announcements endpoint blocked the request from here
  (timed out) — the exact bot-protection issue this repo's own `README.md` already
  documents for the live circulars fetch.

If you see a specific number claiming this strategy's backtested win rate or P&L
anywhere in this codebase (there's a comment in the old `UpstoxTradeService.java`
referencing "44 intraday trades" from a June 2026 backtest) — I could find no
data file, script, or commit backing that number. Treat it as unverified.

**Update, later the same day: the above blockers got resolved and a real backtest
ran.** See "Backtest results" below — both blockers were sidestepped, not solved
the way originally planned (no TradingView MCP session was live, and NSE's API is
still bot-blocked from automated fetches), but real data got through anyway:
you exported NSE's own announcement history as CSV directly from nseindia.com as a
logged-in human (sidesteps the bot-protection entirely, since it's not a scripted
fetch), and I fetched real price data from Upstox's historical-candle API using the
same access token already live on Railway (pulled via `railway variables`, written
straight to a local file, never printed into this conversation).

## Backtest results — 2026-07-10, real data, Apr-Jul 2026

**Data**: You provided 4 CSV exports from NSE's own website (`CF-AN-equities-*.csv`),
30,511 unique corporate announcements after de-duplicating overlapping date ranges.
Filtered through the exact same keyword logic `AlertPoller` uses in production
(`nse.announcement-keywords` / `ignore-keywords`) → **272 real order/contract
announcements**, Apr, Jun, and Jul 1-8 2026.

**Time-of-day distribution** (this changed my thinking from the first pass):

| Window | Count | % |
|---|---|---|
| Market hours (09:15-15:30) | 113 | 42% |
| After hours (weekday, post-15:30) | 113 | 42% |
| Weekend | 29 | 11% |
| Pre-market (before 09:15) | 17 | 6% |

The original pre-market-only queue fix (see above) only covered that last 6% —
after-hours and weekend signals (52% of everything) were still being silently
dropped. Fixed: `UpstoxTradeService`'s queue now covers all three, firing at the
next trading day's 09:15 open (see the updated class comment and
`fireQueuedSignals()`).

**Rating**: Ran the real Claude Haiku call (same model, same prompt as
`PromptRatingService.buildPrompt()`) against each of the 272 announcements, using
PDF text extracted from the NSE archive link where fetchable (269/272 — these PDFs
turned out to be fetchable with a normal browser User-Agent header; only the
interactive announcement-search API is bot-blocked, not the static archive), falling
back to the CSV's own detail text otherwise. **82/272 (30%) rated ≥7** — i.e. would
have triggered a live trade attempt.

**Note on scope**: this backtest evaluates the *raw* AI rating threshold, not the
market-cap-adjusted rating (`adjustRatingForMarketCapImpact()` in `AlertPoller`) —
computing market cap for 272 symbols via Screener.in scraping wasn't attempted this
pass. Whether that adjustment actually improves things is still unvalidated.

**Price simulation**: resolved 81/82 symbols to Upstox instrument keys (1 miss:
`VASCONEQ`, a real NSE-archive-symbol-vs-Upstox-symbol mismatch, same class of gap
`searchInstrumentKey()` already logs in production). Fetched real 1-minute candles,
ran them through the exact live `TradeRules` logic.

| Metric | Value |
|---|---|
| Trades simulated | 78 (3 dropped — no candle data at/after entry) |
| Win rate | 52.6% |
| Avg P&L | +0.32% of capital-per-trade |
| Best / worst | +4.83% / -3.35% |

By exit reason:

| Exit | n | Avg P&L | Win rate |
|---|---|---|---|
| Trail stop | 27 | +2.39% | 100% |
| Hard stop | 22 | -1.84% | 5% |
| Time exit | 28 | -0.03% | 43% |

The mechanism works as designed — trailing stop reliably locks in gains once
armed, hard stop caps losses near the -1.5% threshold — but the 45-minute
time-exit bucket (36% of trades) is dead weight, dragging the average down to a
thin +0.32%.

**Time-exit window sweep** (`backtest/tune_time_exit.js`, same 78 signals, cached
candles replayed at 15/30/45/60/90/120/180/375 min): flat between +0.25% and
+0.34% avg P&L across 15-90 minutes — no window in that range is a clear winner,
78 trades is too small a sample to distinguish them. 120min+ appear to show better
numbers but are increasingly contaminated by `DATA_EXHAUSTED` outcomes (candle data
running out before any rule fires — up to 26% of trades at the 375min setting,
mostly smaller-cap names where 1-minute prints thin out well before market close)
— **not a real improvement, a data artifact. Don't act on it.**

**Rating-threshold check**: only 9 announcements (11 trades, some symbols repeated)
scored ≥8; none scored ≥9. That subset's backtest performance (36.4% win rate,
-0.20% avg P&L) was *worse* than the ≥7 pool, not better — but n=11 is far too
small to conclude tightening the threshold hurts. Honest reading: **no evidence
yet that raising the rating bar improves outcomes**, and not enough data to know
either way.

**Bottom line**: real backtest infrastructure and real numbers now exist. The
strategy shows a thin, not-statistically-significant positive edge (52.6% win,
+0.32% avg) on 78 real trades, with **no transaction costs modeled** (brokerage,
STT, exchange charges, GST — could plausibly erode or reverse a +0.32% edge on a
₹5,000 trade size with up to 3 orders per round trip). Tuning time-exit window or
rating threshold didn't show a clear improvement in this pass. The queue-coverage
fix (after-hours/weekend) is the one change from this pass with a solid rationale
independent of the thin backtest numbers — it's fixing a real, measured gap (52%
of matching announcements were being silently dropped), not chasing curve-fit
parameters on 78 trades.

**Reproducing this**: the 272-signal dataset and rating pipeline (`rate.py`,
`prep_signals.py`, `build_instrument_map.py`) were one-off scratchpad scripts (not
committed — hardcoded local paths, Python rather than the repo's Node/Java stack)
built to process the NSE CSV export you provided. If you want to re-run this
against a fresh NSE export or accumulated `trades.csv` shadow data, the reusable
pieces are all committed: `backtest/upstoxCandles.js` (candle fetching, now shared
between `run.js` and `tune_time_exit.js`), `backtest/tune_time_exit.js` (parameter
sweep against cached candles), `backtest/from-tradelog.js` (trades.csv → signals.csv
converter). The rating step would need to be rebuilt or re-requested — ask for it
again with a fresh CSV export from nseindia.com and I can reconstruct the pipeline.

## Pre-existing issue found, not fixed (out of scope for this change)

`PromptRatingServiceTest.java` references a field `openAiApiKey` and a 4-arg
`buildPrompt(title, description, link, documentText)` that don't exist on the
current `PromptRatingService` (it has `anthropicApiKey` and a 3-arg
`buildPrompt(companyName, subject, documentText)`). This test suite looks stale
relative to the current source — it likely doesn't compile. I didn't fix it since
it's unrelated to the trading-strategy changes above, but you should know your test
suite has probably been broken for a while independent of anything here.

## Recommended next steps, in order

1. ~~Run `mvn test`~~ — done in a later session: JDK 17 + Maven installed locally,
   `mvn compile` and the full test suite ran clean. `TradeRulesTest` (new, 8/8) and
   `AnalysisResultTest`/`DocumentFetcherTest` pass. `TelegramSenderTest` (3
   failures) and `PromptRatingServiceTest` (2 errors, the stale-test issue noted
   above) fail on **both** this change and the prior commit — confirmed
   pre-existing, not caused by anything here.
2. ~~Deploy with `UPSTOX_ENABLED=false`~~ — done: found it was actually `true` in
   Railway (already live before this work), flipped to `false`, confirmed clean
   redeploy with shadow mode active.
3. ~~Get real backtest numbers~~ — done via NSE CSV export + Upstox historical
   candles instead of accumulated shadow data (see "Backtest results" above) —
   faster than waiting weeks for `trades.csv` to accumulate, though the
   `from-tradelog.js` path is still there for whenever you want to validate the
   live/shadow pipeline's own signals specifically, not just re-derived historical
   ones.
4. **Not done yet, and I wouldn't flip `UPSTOX_ENABLED=true` without it**: model
   real transaction costs (brokerage, STT, exchange charges, GST, stamp duty) into
   the backtest simulator. A +0.32% avg edge on 78 trades is thin enough that
   realistic costs could plausibly erase or reverse it — this matters more than
   any of the parameter tuning attempted so far.
5. Validate the market-cap rating adjustment specifically (it wasn't included in
   this backtest pass — see caveat above) before trusting it's actually helping.
6. Consider whether 78 trades over ~3 months is enough to trust any of these
   numbers at all — letting shadow mode keep accumulating in parallel, and
   re-running this same analysis against a larger combined dataset later, would
   narrow the confidence intervals a lot.
