# Ichimoku BTC/XAU MTF — Live Scanner (Pi42)

Live intraday scanner for **"The Secret Mindset"'s multi-timeframe (MTF) Ichimoku trend
system**, run on **BTCUSDT** and **XAUUSDT** perpetuals via **Pi42** (a crypto/commodity
derivatives broker) — the **day-trading timeframe trio** (1H / 30min / 5min). Streams Pi42's
public market-data socket, evaluates the MTF alignment rules on every completed 5-min bar per
symbol, pushes **Telegram** alerts, and logs everything to **PostgreSQL** as a forward-test
dataset.

**Alert-only. This service never places, modifies, or cancels any order.** See "Execution — a
deliberately separate future phase" below.

Strategy write-up: `wiki/concepts/ichimoku-cloud.md` → "Trading strategy — multi-timeframe (MTF)
trend system (The Secret Mindset)" and `wiki/sources/secretmindset-ichimoku-mtf-strategy-video.md`
(Trading Brain vault). Broker reference: `wiki/reference/pi42-api.md`.

## Restart resilience (fixed 2026-08-21)

Open-position state now **survives a process restart** (a Railway redeploy, a crash, a manual
restart). On startup, `seedSymbol()` checks Postgres for a still-`OPEN` signal per symbol and
calls `MtfSymbolTracker#resumeTrade()` to reattach it — replaying any seeded bars between the
original entry and now to catch up a stop/target/warning that happened while the process was
down, instead of losing it. Before this fix, every restart forgot the open trade in memory and
re-entered fresh on the next qualifying candle, producing duplicate `signals` rows per symbol and
orphaning the original's outcome forever (caught in production on 2026-08-21 — three duplicate
XAUUSDT entries and two duplicate BTCUSDT entries accumulated across that day's redeploys, none
of which ever resolved). The duplicates were deleted from Postgres (kept only the first entry per
symbol); any future restart-caused duplicates are instead marked `ABANDONED` in `outcomes.
final_result` by `db.js#abandonOtherOpenSignals()`, so they're distinguishable from a genuine
`TARGET`/`SL` close in the stats rather than silently corrupting them.

No EOD force-flat was added despite this incident prompting the question — deliberately: BTC and
XAU perpetuals trade near-continuously on Pi42 (no NSE-style session close), so the cooldown stays
purely outcome-based (a position stays open until it actually hits stop or 2R target). Confirmed
with the user 2026-08-21.

---

## What it does

### 1. The MTF rule set (day-trading trio: 1H / 30min / 5min)

Standard Ichimoku (Tenkan 9 / Kijun 26 / displacement 26, Senkou B kept at the conventional 52)
computed on the two higher timeframes. On the **entry timeframe (5min) only**, the chart is
stripped down to just the **Baseline (Kijun-26)** and a **200 EMA** — no cloud/Tenkan/Chikou
for the trigger itself, though Chikou-vs-cloud is still computed on the 5min bars purely as an
invalidation gate.

**Long entry — checked top-down, ALL must hold simultaneously (mirror for short):**
1. **1H (highest):** price above cloud AND above baseline (green cloud ideal, not mandatory here).
2. **30min (middle):** price above cloud AND above baseline AND cloud green (mandatory).
3. **5min (entry) trigger:** Baseline (Kijun) above the 200 EMA.
4. **Invalidation gate (5min):** the setup does NOT fire if price is currently inside the cloud
   body, OR if the Chikou span is still inside the cloud — even if 1-3 all hold.

Exact index math (which "cloud hovering over price" means for a forward-displaced indicator,
and how the Chikou gate reads the cloud as it stood 26 bars back) is documented in
`live/ichimoku.js` and `live/mtf_engine.js`'s header comments.

### 2. Cooldown / re-entry — a state machine, not a fixed timer

There's no natural "trading day" boundary for 24/7 crypto/commodity markets, so re-entry is
gated by the strategy's own logic rather than a clock: once a signal fires for a symbol, no new
signal fires until the tracked trade's outcome (TARGET or SL) is reached. By construction this
also satisfies the spec's "or conditions broke and reformed" clause — a signal only ever fires
the instant all 4 conditions first become simultaneously true, so there's never a window where
conditions sit continuously true without either an open trade or a fired signal. See
`live/mtf_engine.js`'s `MtfSymbolTracker` for the implementation.

### 3. Stop / target / early-exit

- **Stop:** the far side of the 200 EMA, pushed a further **`STOP_BUFFER_PCT`% buffer** beyond
  it (env var, **default 0.15%**). *This is a documented placeholder, not a risk decision* — the
  source video gives no numeric buffer, and the user explicitly said risk-per-trade/stop-loss
  numbers are **TBD, to discuss later**. 0.15% is reused from
  `ichimoku-momentum-strategy`'s identical reasoning (small enough not to meaningfully change the
  R being risked, large enough to avoid a same-candle-wick stop-out on the exact EMA value).
  Override via `STOP_BUFFER_PCT` — no code change needed.
- **Target:** fixed **2:1** risk-reward (the video's stated default). The video also describes an
  optional trailing-stop variant (recent swings or the 200 EMA, citing an 8:1 backtest example) —
  **not implemented in this phase**, noted here as a documented future option to keep scope tight.
- **Early-exit warning (alert only, no auto-exit):** if the Baseline crosses back through the 200
  EMA against an open tracked position, a distinct warning alert fires once (edge-triggered, same
  pattern as `ichimoku-momentum-strategy`'s Chikou-warning).

### 4. Broker: Pi42, and why `XAUUSDT` not `XAUTUSDT`/`PAXGUSDT`

Pi42's `exchangeInfo` lists three different "gold" tickers. Only **`XAUUSDT`** ("Gold
Derivatives", `TRADIFI_PERPETUAL`, max leverage 75x) actually tracks the real gold spot price.
`XAUTUSDT` (Tether Gold token) and `PAXGUSDT` (Pax Gold token) are tokenized-gold *products* —
they track a token's market price, which can and does drift from spot gold. This is a real
footgun in Pi42's contract list if you're not careful. `BTCUSDT` (`PERPETUAL`, max leverage
150x) is the plain BTC perpetual, no ambiguity there.

### 5. WebSocket transport — Socket.IO, confirmed empirically

Pi42's docs give topic strings (`btcusdt@kline_5m`, `btcusdt@markPrice`, …) but don't state the
transport. The JS examples' named event handlers (`connect`, etc.) read like Socket.IO rather
than a raw `ws` connection — this was **tested empirically before writing the streamer**, per a
throwaway script that connected with `socket.io-client` against `https://fawss.pi42.com/`,
subscribed to `btcusdt@kline_1m` and `btcusdt@markPrice`, and started receiving live `kline` /
`markPriceUpdate` events within ~1 second. **Socket.IO is what this service uses** —
`socket.io-client`, not the `ws` package, not raw-`ws`-over-the-engine.io-upgrade-URL. A parallel
raw-`ws` throwaway test was written too but not pursued further once Socket.IO worked cleanly (no
need to force the alternative once the preferred path — the docs' own event-handler style — was
confirmed live). No polling fallback was needed.

Multi-symbol, multi-interval subscription on a single connection was also verified live: one
socket, subscribed to `kline_5m`/`kline_30m`/`kline_1h` for both `btcusdt` and `xauusdt`,
delivers all six streams concurrently without cross-talk.

Bar-close detection: each `kline` event carries a `k.t` (bar start time) and `k.x` (closed flag).
The streamer finalizes a bar either when `x === true`, or when a new event arrives with a
different `k.t` (bar rollover) — the latter is a robustness fallback in case `x` isn't reliably
set on every stream, mirroring how Binance-style kline streams are typically consumed.

### 6. History seeding

At startup, `live/pi42_client.js` pulls history via the **public** (unauthenticated)
`POST /v1/market/klines` endpoint: **100 bars on 1H**, **100 bars on 30min** (both comfortably
cover Tenkan/Kijun/Senkou-B lookback with margin), and **300 bars on 5min** (the entry TF's 200
EMA needs 200 periods warmed up — ~16.7 hours of 5-min bars — plus headroom for the
Chikou/cloud invalidation gate, which itself needs another ~78 bars of lookback). Live bars are
then appended as they close from the WebSocket stream. One empirical quirk: Pi42's `klines`
endpoint sometimes ignores the requested `limit` and returns its own default page (observed:
500 bars regardless of a requested 100/300) — `pi42_client.js` trims the response to the
requested depth client-side so seed depth stays predictable.

### 7. Alerts (Telegram) & persistence (Postgres)

Same `TELEGRAM_BOT_TOKEN` / chat IDs (`5937539323` personal + `-5338709046` group) as every
sibling bot in this repo. Alerts fire for: **STARTUP** (symbols subscribed), **SETUP** (entry,
stop, target, which TF conditions were met), the **early-reversal WARNING**, and the **terminal
OUTCOME** (TARGET or SL).

Postgres schema `ichimoku_btcxau.*` (auto-created idempotently on startup, `live/schema.sql`):

- `ichimoku_btcxau.signals` — confirmed MTF setups (entry/stop/target/criteria JSON). No
  one-per-day uniqueness constraint — these are 24/7 markets, the cooldown is the runtime state
  machine in `mtf_engine.js`, not a DB constraint.
- `ichimoku_btcxau.outcomes` — 1:1 with a signal, filled live (warning timestamp, final result,
  R-multiple, MFE/MAE).
- `ichimoku_btcxau.alerts` — audit of every Telegram push.

If no connection string is configured, the scanner still streams and alerts — it just skips
persistence and logs a warning (same graceful-degrade convention as every sibling bot).

---

## Execution — a deliberately separate future phase

**This build contains zero authenticated Pi42 request code.** Everything above runs entirely
against Pi42's public, unauthenticated market-data API (klines + the public WebSocket) — no API
key is needed for any of it. The user does not yet have a Pi42 API key, and risk-per-trade /
stop-loss numeric defaults are explicitly **TBD, to be discussed later**. A live-execution phase
(order placement via Pi42's authenticated REST endpoints, HMAC-SHA256 request signing) is
planned once both of those are settled — it is intentionally **not** built here, not stubbed,
and not half-implemented. See `wiki/reference/pi42-api.md` for the order-management endpoints
that phase will use.

## Configuration (env vars)

| Var | Purpose | Notes |
|-----|---------|-------|
| `TELEGRAM_BOT_TOKEN`  | Telegram sends | Same bot token already in `.secrets/telegram_bot_token.txt` |
| `DATABASE_URL`        | Postgres connection string | Or put it in `.secrets/pg_url.txt` for local runs |
| `PGSSL`               | Set to `disable` for a non-SSL Postgres | Default assumes SSL for non-localhost |
| `STOP_BUFFER_PCT`     | Stop-loss buffer beyond the 200 EMA, in percent | Default `0.15`. **Placeholder — pending the user's own risk discussion**, see "Stop / target / early-exit" above |
| `PI42_PRICE_TYPE`     | `MARK_PRICE` or `LAST_PRICE` for the klines REST call | Default `MARK_PRICE` |

No Pi42 API key / secret of any kind is used or needed in this phase.

**Secrets are never committed** (`.secrets/` is gitignored) and never appear in code — the
connection string and Telegram token are read at runtime from env / `.secrets`.

## Run locally

```bash
cd ichimoku-btc-xau-strategy/live
npm install
export TELEGRAM_BOT_TOKEN=$(cat ../../.secrets/telegram_bot_token.txt)
# put the Postgres URL where the code looks (either works), optional:
#   export DATABASE_URL=postgres://user:pass@host:5432/db
#   echo 'postgres://user:pass@host:5432/db' > ../../.secrets/pg_url.txt
npm start
```

No API key is required — this runs entirely against Pi42's public data. On startup it seeds
history for `BTCUSDT`/`XAUUSDT` on all three timeframes, connects the Socket.IO stream, sends a
startup Telegram alert (or logs it if `TELEGRAM_BOT_TOKEN` isn't set), and then evaluates the MTF
rules on every completed 5-min bar.

Run the offline engine self-test (no network/DB needed):

```bash
npm test
```

## Deploy on Railway

Same pattern as every sibling strategy — a **separate Railway service** in the same project:

1. **New service** → deploy from this repo.
2. **Root directory:** `ichimoku-btc-xau-strategy/live`
3. **Start command:** `npm start` (build/install inferred from `package.json`).
4. **Variables:** `TELEGRAM_BOT_TOKEN`, `DATABASE_URL` (+ `PGSSL=disable` if needed). No
   `STOP_BUFFER_PCT` override needed unless the default is being tuned.

## Safety boundary

Read-only market data + alerts only. There is **no order-placement code path** anywhere in this
service, and no authenticated Pi42 request of any kind. Trading decisions and executions stay
entirely manual, in the user's own Pi42 account, until the future execution phase described
above is explicitly built.
