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
2. **Trend filter (default ON, see below) gates which candles even arm.** The "mother" candle
   (the one the inside candle sits inside of) must be a swing extreme, and that extreme must line
   up with the current trend: bearish trend + mother at a swing low → pre-commit **LONG**;
   bullish trend + mother at a swing high → pre-commit **SHORT**. Trend/location don't line up →
   the inside candle never arms, no sweep is watched for at all.
3. Check **only the very next 15-min candle**, against the pre-committed direction:
   - Pre-committed LONG: low must breach first, then high breaks → **LONG**, entry = IC high,
     stop = IC low.
   - Pre-committed SHORT: high must breach first, then low breaks → **SHORT**, entry = IC low,
     stop = IC high.
   - Wrong side breaches first, only one side happens, or neither happens → **no trade** —
     cancelled, not retried.
4. Target = fixed **`R_TARGET`** multiple of risk (env-overridable, default **3** — source states
   minimum 1:3, sometimes 1:4).

### Trend filter

Ported from the source's own trend rule (confirmed via NotebookLM re-verification — see
`wiki/concepts/inside-candle-liquidity-sweep-scalp.md`) and mirrors
`wiki/reference/inside-candle-next-candle-trend-filtered.pine` (IC-NextCandle-Trend) exactly:
HH/HL vs LH/LL swing structure over a trailing window decides both the trend bias and whether a
candle's mother sits at a swing extreme. This is **this wiki's own codification** of the source's
undefined "look at the chart, a kid could tell you the trend" trend-read, not a decoded rule.

- `TREND_FILTER_ENABLED` (env, default **true`/unset**) — set to `false` to run the original
  untrended IC-NextCandle behaviour (fires whichever direction the sweep order happens to
  produce, no trend/location gate).
- `SWING_LOOKBACK` (env, default **5**) — trailing-bar window for the swing-extreme/trend read,
  matches the commercial indicator's own "Swing Pivot Lookback" setting.

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
   `R_TARGET` to override the default 3R target, `TREND_FILTER_ENABLED=false` to disable the
   trend filter (default on), `SWING_LOOKBACK` to override the default 5-bar swing window.

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
