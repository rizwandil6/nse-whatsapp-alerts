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

## Pre-existing issue found, not fixed (out of scope for this change)

`PromptRatingServiceTest.java` references a field `openAiApiKey` and a 4-arg
`buildPrompt(title, description, link, documentText)` that don't exist on the
current `PromptRatingService` (it has `anthropicApiKey` and a 3-arg
`buildPrompt(companyName, subject, documentText)`). This test suite looks stale
relative to the current source — it likely doesn't compile. I didn't fix it since
it's unrelated to the trading-strategy changes above, but you should know your test
suite has probably been broken for a while independent of anything here.

## Recommended next steps, in order

1. Run `mvn test` in Codespaces to confirm the Java changes actually compile —
   nothing here should be deployed before that's green.
2. Deploy with `UPSTOX_ENABLED=false`, `UPSTOX_SHADOW_ENABLED=true` for a stretch
   (at least a couple of weeks of active trading days) to accumulate real
   `trades.csv` data with zero capital risk.
3. Pull `trades.csv` periodically — it does not survive a Railway redeploy.
4. Run `node backtest/from-tradelog.js trades.csv --mode=shadow > signals.csv`
   then `UPSTOX_ACCESS_TOKEN=xxx node backtest/run.js signals.csv` to get real
   win-rate / P&L numbers on accumulated shadow data, replayed through the exact
   live rule engine.
5. Only then decide whether to flip `UPSTOX_ENABLED=true`, and whether the
   market-cap rating adjustment / 2%-1.5%-1%/45min thresholds need retuning based
   on what the data actually shows.
