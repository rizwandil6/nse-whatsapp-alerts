-- Opening Loser Short scalp — forward-tracking schema.
-- Isolated in its own `opening_loser_short` schema so it can live safely
-- inside an existing shared Postgres database. Idempotent: safe to re-run.

CREATE SCHEMA IF NOT EXISTS opening_loser_short;

-- One row per trading day: the top loser picked at ~09:15:30 and shorted.
CREATE TABLE IF NOT EXISTS opening_loser_short.signals (
  id                bigserial PRIMARY KEY,
  symbol            text        NOT NULL,
  trade_date        date        NOT NULL,
  prev_close        numeric     NOT NULL,
  open_pct_change   numeric     NOT NULL,   -- (entry_px - prev_close) / prev_close * 100
  entry_ts          timestamptz NOT NULL,
  entry_px          numeric     NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trade_date)                        -- one pick per day, across the whole universe
);

-- Outcome — 1:1 with a signal, filled in live as the position closes.
CREATE TABLE IF NOT EXISTS opening_loser_short.outcomes (
  signal_id     bigint PRIMARY KEY REFERENCES opening_loser_short.signals(id) ON DELETE CASCADE,
  exit_ts       timestamptz,
  exit_px       numeric,
  exit_reason   text,                        -- CIRCUIT | TIME_930
  pnl_pct       numeric,                     -- SHORT: (entry - exit) / entry * 100
  result        text,                        -- WIN | LOSS | FLAT
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Audit of what was actually pushed to Telegram (dedupe / idempotency).
CREATE TABLE IF NOT EXISTS opening_loser_short.alerts (
  id          bigserial PRIMARY KEY,
  signal_id   bigint REFERENCES opening_loser_short.signals(id) ON DELETE SET NULL,
  symbol      text,
  alert_type  text        NOT NULL,          -- ENTRY | EXIT
  chat_id     text,
  text        text,
  sent_ok     boolean,
  sent_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ols_signals_date ON opening_loser_short.signals (trade_date);
