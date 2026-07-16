# RS Momentum Strategy — Live Service

Daily-cadence live version of `rs-momentum-strategy/`'s backtested RS
ranking rules (see the parent folder's README for the full methodology,
backtest results, and interpretation choices — this file only covers the
live-specific additions). **LONG-only** — no short-selling logic anywhere
in this codebase; every alert is a buy (entry) or a sell-to-close (exit),
confirmed directly and explicit in the Telegram alert text.

## Why daily, not rolling-batch like multibagger-screener

RS ranking is a **cross-sectional** computation — a stock's percentile
rank only means something relative to the whole universe on the *same*
day. Unlike multibagger-screener's independent per-stock checks (safe to
roll through ~100/day), this can't be partially updated — every run
fetches and ranks the full ~353-stock universe together.

## What's added vs. the backtest

- **No persisted raw price cache.** The backtest's `mtf_candle_cache.json`
  holds 5 years of Daily data; this only needs a rolling ~12-month window
  for the RS lookbacks, so `fetch_universe.js` re-fetches ~354 instruments
  (Nifty + universe) fresh every run rather than committing a large,
  ever-growing cache to git.
- **Sales Growth 3Y >15% gate**, via Screener.in (`fundamental_screener.js`,
  copied from `multibagger-screener/` for a self-contained deploy) — the
  source's fundamental confirmation, live-only since Screener.in has no
  historical point-in-time data (can't be backtested, see parent README).
  **Known limitation**: checked only on the crossing day — a stock that
  fails this gate once is never reconsidered later even if it stays
  RS>=80 for weeks, since the RS>=80 crossing itself only fires once.
- **State persistence**: `tracked_rs_momentum.json` (currently-held
  positions) + `rs_momentum_log.json` (permanent append-only entry/exit
  log) — same git-committed-JSON pattern as multibagger-screener, single
  commit per run via the Git Data API (git binary isn't available in
  Railway's Node buildpack — a real bug already found and fixed in
  `multibagger-screener/git_state.js`; this service is built with that
  lesson applied from the start).

## Verified end-to-end before deploying

A real `RUN_ONCE=1` run (2026-07-16) fetched 353/353 stocks (0 failures),
found 5 real RS>=80 crossings, correctly filtered 3 via the Sales Growth
gate (ABB and ENRIN had no growth data, CARBORUNIV was only 4%), and
alerted + tracked 2 genuine candidates: **TRITURBINE** (Triveni Turbine,
20% growth) and **ZYDUSLIFE** (Zydus Lifesciences, 16% growth). State
committed to GitHub in one real commit.

## File guide

| File | Purpose |
|---|---|
| `fetch_universe.js` | Fresh ~14-month Daily fetch, Nifty 50 + full stock universe |
| `rs_rank.js` | RS_raw + cross-sectional percentile ranking (copied from the backtest) |
| `today_ranks.js` | Extracts today's + yesterday's rank per stock from a fresh fetch |
| `diff_tracker.js` | New RS>=80 crossings vs. tracked positions dropping below 50 |
| `fundamental_screener.js` / `halal_classifier.js` | Screener.in Sales Growth check (copied from `multibagger-screener/`) |
| `git_state.js` | Single-commit GitHub REST API state sync/push |
| `server.js` | Daily trigger (20:00-20:30 IST), orchestrates the full flow |
| `symbols.json` | 353-stock instrument-key map (copied from `swing-strategy/`) |
| `tracked_rs_momentum.json` | Currently-held positions (git-committed) |
| `rs_momentum_log.json` | Permanent entry/exit log (git-committed, never deletes) |
