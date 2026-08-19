# Opening Loser Short — Scalp

Live intraday scanner: shorts the single biggest opening loser across the **F&O-eligible ∩
halal** universe, ~30 seconds after market open, and covers at 09:30 IST. **Independent of
every other strategy in this repo** — new universe, new mechanism, own capital pool.

**Alert-only. This service never places, modifies, or cancels any order.**

## Rules (final, "as is")

| Field | Rule |
|---|---|
| Universe | F&O-eligible ∩ halal-352 — **137 stocks** (`symbols.json`, `underlying_symbol` intersect derived from Upstox's own `NSE_FO` instrument master, so it's exchange-authoritative, not scraped) |
| Screen time | ~09:15:30 IST |
| Selection | No band — single most-negative (open vs. prior close) mover across the whole universe |
| Direction | Short (sell to open) |
| Entry | At LTP, MIS/intraday |
| Position size | ₹20,000 fixed per trade (manual — this service is alert-only, sizing is on you) |
| Stop-loss | **None** |
| Circuit/freeze exit | If the picked stock stops printing trades (no `ltt` advance) for 60s while the trade is open, exit at last known LTP — a liquidity-freeze proxy, not a true circuit flag (see LIMITATIONS in `scan_opening_loser_short.js`) |
| Exit | Cover at 09:30:00 IST if not already closed by the above |
| No-trade condition | No stock down at all across the universe → skip |

## Backtest results (before going live — read this)

62 trading days, ~3 months of Upstox 1-min data, same universe. Full methodology and honest
limitations (1-min bar resolution vs. true 30-second snapshot, no circuit-band ground truth,
no slippage modeling) are documented in `scan_opening_loser_short.js`'s header comment.

| Variant | n | Net win rate | Net avg/trade | Net total (₹20k/trade) |
|---|---|---|---|---|
| Banded (-4%/-5%) + 2% SL | 10 | 60.0% | +0.111% | +₹222 |
| Unbanded + 2% SL | 61 | 42.6% | -0.145% | -₹1,770 |
| **Unbanded, no SL (this config)** | **61** | **42.6%** | **-0.288%** | **-₹3,512** |

**This exact configuration backtested net negative.** It's running live anyway per explicit
request, specifically to forward-test with real data — treat every alert as a paper-trade
signal, not a validated edge, until the live/forward dataset (`opening_loser_short.*` in
Postgres) says otherwise. The stop-loss removal made results worse, not better, in the
backtest — it was capping losing trades, not needlessly clipping winners.

## How it works

1. **Connect** — Upstox V3 market-data WebSocket, `ltpc` mode (lightweight: ltp, last-trade-time,
   and the prior day's close — `cp` — all arrive on every tick, no separate historical fetch
   needed for previous close).
2. **09:15:30 IST** — snapshot every subscribed symbol's `(ltp - cp) / cp`, rank most-negative,
   pick the single top loser (whatever it has, ticks accumulated by then).
3. **Entry** — SHORT alert fires immediately with LTP, prior close, and % move.
4. **Monitor** — every second, checks for a 60s trade-freeze (circuit/illiquidity proxy) on the
   held symbol.
5. **09:30:00 IST** — force-covers if still open, computes P&L%, sends the win/loss summary.
6. **Postgres** — every signal + outcome + alert persisted to `opening_loser_short.*` (schema
   auto-created on startup, idempotent) as a forward-test dataset.
7. One trade per day, always — the process resets at IST date rollover.

## Configuration (env vars)

| Var | Purpose | Notes |
|-----|---------|-------|
| `UPSTOX_ACCESS_TOKEN` | Live feed | Same daily-refreshed token the other bots use — **updated manually into Railway each day** |
| `TELEGRAM_BOT_TOKEN`  | Telegram sends | Same bot token already in `.secrets/telegram_bot_token.txt` |
| `DATABASE_URL`        | Postgres connection string | Or `.secrets/pg_url.txt` for local runs |
| `PGSSL`               | Set to `disable` for a non-SSL Postgres | Default assumes SSL for non-localhost |

Chat IDs are hardcoded in `live/streamer.js` (`TELEGRAM_CHAT_IDS`) — personal `5937539323` +
group `-5338709046`, same as every other bot in this repo.

## Verified locally (2026-08-12, market closed)

- Protobuf schema loads, Upstox `/v3/feed/market-data-feed/authorize` returns 200, WebSocket
  connects, subscribes in `ltpc` mode, and decodes real ticks — confirmed `ltp`/`ltt`/`cp` all
  populate correctly on live instrument keys.
- Telegram send confirmed working (test message delivered to the personal chat).
- Postgres path confirmed to degrade safely (no real local DB configured — `.secrets/pg_url.txt`
  is still a placeholder) — will pick up the real Railway `DATABASE_URL` in production.
- **Not yet verified**: a full live trading-day run (entry pick, circuit-freeze logic, 09:30
  exit) — only possible during actual market hours. Watch the first live day closely.

## Run locally

```bash
cd opening-loser-short-strategy/live
npm install   # or copy node_modules/ from pdh-pdl-strategy/live (same 3 deps)
export UPSTOX_ACCESS_TOKEN=...      # fresh token
export TELEGRAM_BOT_TOKEN=$(cat ../../.secrets/telegram_bot_token.txt)
npm start
```

## Deploy on Railway

Separate Railway service, same project as the other live strategies:

1. **New service** → deploy from this repo.
2. **Root directory:** `opening-loser-short-strategy/live`
3. **Start command:** `npm start`.
4. **Variables:** `UPSTOX_ACCESS_TOKEN` (refresh daily, manual), `TELEGRAM_BOT_TOKEN`,
   `DATABASE_URL` (+ `PGSSL=disable` if your Postgres has no SSL).
5. Service must be running continuously (24/7) so it's connected and subscribed well before
   09:15 IST — it self-resets at IST date rollover, no daily restart needed.

## Backtest / research files (repo root of this folder)

| File | Purpose |
|---|---|
| `fetch_universe.js` | Pulled ~90 days of 1-min candles for the 137-stock universe (`intraday_1min_cache.json`, gitignored) |
| `scan_opening_loser_short.js` | The backtest engine — full rules + limitations documented in its header |
| `apply_costs.js` | Zerodha-representative intraday MIS cost model, ₹20,000/trade |
| `trades_opening_loser_short.json` | Full trade-level output of the last backtest run |

## Safety boundary

Read-only market data + alerts only. There is **no order-placement code path** anywhere in this
service. Trading decisions and executions stay entirely manual, in your own broker app.
