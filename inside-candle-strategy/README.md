# Inside Candle Sweep+Break — BTCINR/XAUINR (Pi42, alert-only)

Live scanner for the Inside Candle Sweep+Break setup, validated as Pine indicators against
live TradingView data before this port — see
`/Users/adilrizwan/Downloads/second brain/wiki/concepts/inside-candle-liquidity-sweep-scalp.md`
(the strategy writeup, source-confirmed rules) and
`wiki/reference/inside-candle-next-candle-sweep-break.pine` (the exact Pine version this Node
engine mirrors — no trend filter, no structure filter, the simplified version confirmed live).

## The rule

1. A **15-minute** candle forms whose full range sits inside the immediately preceding 15-min
   candle's range ("inside candle").
2. Check **only the very next 15-min candle**. Within that one candle:
   - Low breaches first, then high breaks → **LONG**, entry = IC high, stop = IC low.
   - High breaches first, then low breaks → **SHORT**, entry = IC low, stop = IC high.
   - Only one side happens, neither happens, or the wrong side happens first → **no trade**.
3. No trend filter, no structure/swing-extreme filter — every inside candle is a candidate.
4. Target = fixed **`R_TARGET`** multiple of risk (env-overridable, default **3** — source states
   minimum 1:3, sometimes 1:4).

Order-of-events within the single next 15-min candle is resolved using **1-minute bars streamed
in real time** (`ic_engine.js#addM1Bar`) — the same role `request.security_lower_tf()` plays in
the Pine version.

## Architecture (mirrors `ichimoku-btc-xau-strategy` exactly)

- `live/pi42_client.js` — public, unauthenticated Pi42 REST client (history seeding only).
- `live/ic_engine.js` — per-symbol state machine (`IcSymbolTracker`), emits `SETUP`/`OUTCOME` events.
- `live/db.js` / `live/schema.sql` — Postgres persistence, own `inside_candle.*` schema, same
  shared instance as every other strategy in this repo.
- `live/streamer.js` — main entry: seeds history via REST, streams live via Pi42's public
  Socket.IO WebSocket (`{symbol}@kline_1m`, `{symbol}@kline_15m`), fires Telegram alerts.

## Symbols

`BTCINR`/`XAUINR` — same INR-margined pairs as `ichimoku-btc-xau-strategy` (see that strategy's
README, "Symbol-set switch"), for consistency and to trade directly in INR capital.

## Deploy on Railway

Same pattern as every sibling strategy — a **separate Railway service** in the same project:

1. **New service** → deploy from this repo.
2. **Root directory:** `inside-candle-strategy/live`
3. **Start command:** `npm start` (build/install inferred from `package.json`).
4. **Variables:** `TELEGRAM_BOT_TOKEN`, `DATABASE_URL` (+ `PGSSL=disable` if needed), optionally
   `R_TARGET` to override the default 3R target.

## Dashboard

Signals + outcomes surface in the same **Crypto/Forex tab** as Ichimoku, filterable by strategy
(`Ichimoku` / `Inside Candle`) — see `CryptoForexService.java`.

## Safety boundary

Read-only market data + alerts only. There is **no order-placement code path** anywhere in this
service, and no authenticated Pi42 request of any kind — identical boundary to
`ichimoku-btc-xau-strategy`. Trading decisions and executions stay entirely manual, in the user's
own Pi42 account.

## Known limitations / assumptions not yet empirically verified

- **Pi42's `15m`/`1m` kline WebSocket topics are assumed to exist** in the same shape as the
  `5m`/`30m`/`1h` topics `ichimoku-btc-xau-strategy` already confirmed live — not independently
  re-verified for this bot before first deploy. Watch the first `[seed]`/`Subscribed:` log lines
  and the first few `kline` events on deploy to confirm.
- **Same-1-min-bar-breaches-both-sides edge case** (see `ic_engine.js#addM1Bar`) is treated as no
  signal — a deliberate simplification, not a source-confirmed rule, since order can't be
  determined at 1-min resolution in that case.
