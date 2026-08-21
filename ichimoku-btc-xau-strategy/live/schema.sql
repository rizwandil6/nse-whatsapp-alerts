-- Ichimoku BTC/XAU MTF strategy -- forward-tracking schema (Pi42, alert-only).
-- Isolated in its own `ichimoku_btcxau` schema so it can live safely inside an
-- existing shared Postgres database. Idempotent: safe to re-run on startup.

CREATE SCHEMA IF NOT EXISTS ichimoku_btcxau;

-- 1. Confirmed MTF setups. No trade_date/one-per-day uniqueness -- these are
--    24/7 markets with no session boundary; the cooldown is a runtime state
--    machine (see mtf_engine.js), not a DB constraint.
CREATE TABLE IF NOT EXISTS ichimoku_btcxau.signals (
  id            bigserial PRIMARY KEY,
  symbol        text        NOT NULL,          -- BTCUSDT | XAUUSDT
  direction     text        NOT NULL,          -- LONG | SHORT
  entry_ts      timestamptz NOT NULL,
  entry_px      numeric     NOT NULL,
  stop_px       numeric     NOT NULL,
  target_px     numeric     NOT NULL,           -- fixed 2R target price
  r_value       numeric     NOT NULL,           -- |entry - stop|
  ema200_at_entry numeric,
  stop_buffer_pct numeric,                      -- STOP_BUFFER_PCT in effect at signal time
  criteria      jsonb,                          -- {h1, m30, m5Trigger, invalidationGate}
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- 2. Outcome -- 1:1 with a signal, filled in live as price develops.
CREATE TABLE IF NOT EXISTS ichimoku_btcxau.outcomes (
  signal_id       bigint PRIMARY KEY REFERENCES ichimoku_btcxau.signals(id) ON DELETE CASCADE,
  warning_fired   boolean     NOT NULL DEFAULT false,
  warning_ts      timestamptz,
  final_result    text,                          -- TARGET | SL | OPEN
  exit_px         numeric,
  r_multiple      numeric,
  mfe_r           numeric,                        -- max favourable excursion (R)
  mae_r           numeric,                        -- max adverse excursion (R)
  closed_ts       timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- 3. Audit of every Telegram push (startup, SETUP, WARNING, outcome).
CREATE TABLE IF NOT EXISTS ichimoku_btcxau.alerts (
  id          bigserial PRIMARY KEY,
  signal_id   bigint REFERENCES ichimoku_btcxau.signals(id) ON DELETE SET NULL,
  symbol      text,
  alert_type  text        NOT NULL,               -- STARTUP | SETUP | WARNING | TARGET | SL
  chat_id     text,
  text        text,
  sent_ok     boolean,
  sent_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ichimoku_btcxau_signals_symbol ON ichimoku_btcxau.signals (symbol, entry_ts);
