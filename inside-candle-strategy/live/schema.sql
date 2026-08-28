-- Inside Candle Sweep+Break strategy -- forward-tracking schema (Pi42, alert-only).
-- Isolated in its own `inside_candle` schema, same pattern as ichimoku_btcxau.
-- Idempotent: safe to re-run on startup.
--
-- 2026-08-28: added multi-timeframe support (15m + 30m run concurrently per symbol, each an
-- independent IcSymbolTracker instance in ic_engine.js/streamer.js) -- `timeframe` column added
-- via ALTER TABLE below since this table may already exist in production.

CREATE SCHEMA IF NOT EXISTS inside_candle;

-- 1. Confirmed setups. No trade_date/one-per-day uniqueness -- 24/7 markets, no session
--    boundary; cooldown is a runtime state machine (see ic_engine.js), not a DB constraint.
CREATE TABLE IF NOT EXISTS inside_candle.signals (
  id            bigserial PRIMARY KEY,
  symbol        text        NOT NULL,          -- BTCINR | XAUINR | SOLINR | XAGINR
  timeframe     text        NOT NULL DEFAULT '15m', -- 15m | 30m -- see 2026-08-28 multi-timeframe note below
  direction     text        NOT NULL,          -- LONG | SHORT
  entry_ts      timestamptz NOT NULL,
  entry_px      numeric     NOT NULL,           -- = ic_high (LONG) or ic_low (SHORT)
  stop_px       numeric     NOT NULL,           -- = ic_low (LONG) or ic_high (SHORT)
  target_px     numeric     NOT NULL,           -- fixed R-multiple target price (see R_TARGET)
  r_value       numeric     NOT NULL,           -- |entry - stop| = ic_high - ic_low
  ic_high       numeric     NOT NULL,           -- the inside candle's own high
  ic_low        numeric     NOT NULL,           -- the inside candle's own low
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- Migration for pre-existing deployments: CREATE TABLE IF NOT EXISTS won't add a column to an
-- already-existing table, so add it explicitly (idempotent, safe to re-run every startup).
-- Existing rows (all pre-dating multi-timeframe support) default to '15m', which is correct --
-- that's the only timeframe that existed before 2026-08-28.
ALTER TABLE inside_candle.signals ADD COLUMN IF NOT EXISTS timeframe text NOT NULL DEFAULT '15m';

-- 2. Outcome -- 1:1 with a signal, filled in live as price develops.
CREATE TABLE IF NOT EXISTS inside_candle.outcomes (
  signal_id       bigint PRIMARY KEY REFERENCES inside_candle.signals(id) ON DELETE CASCADE,
  final_result    text,                          -- TARGET | SL | OPEN
  exit_px         numeric,
  r_multiple      numeric,
  closed_ts       timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- 3. Audit of every Telegram push (startup, SETUP, outcome).
CREATE TABLE IF NOT EXISTS inside_candle.alerts (
  id          bigserial PRIMARY KEY,
  signal_id   bigint REFERENCES inside_candle.signals(id) ON DELETE SET NULL,
  symbol      text,
  alert_type  text        NOT NULL,               -- STARTUP | SETUP | TARGET | SL
  chat_id     text,
  text        text,
  sent_ok     boolean,
  sent_at     timestamptz NOT NULL DEFAULT now()
);

-- (symbol, timeframe) together, not symbol alone -- getOpenSignal/abandonOtherOpenSignals (db.js)
-- now scope by both, since a symbol can have an independent OPEN trade per timeframe.
CREATE INDEX IF NOT EXISTS idx_inside_candle_signals_symbol ON inside_candle.signals (symbol, timeframe, entry_ts);
