-- PDH/PDL break-&-retest scalp — forward-tracking schema.
-- Isolated in its own `pdh_pdl` schema so it can live safely inside an
-- existing shared Postgres database. Idempotent: safe to re-run on startup.

CREATE SCHEMA IF NOT EXISTS pdh_pdl;

-- 1. Every 15-min break that ARMS a bias (even if no setup follows) — base rates.
CREATE TABLE IF NOT EXISTS pdh_pdl.armed (
  id            bigserial PRIMARY KEY,
  symbol        text        NOT NULL,
  trade_date    date        NOT NULL,
  direction     text        NOT NULL,           -- LONG | SHORT
  level_type    text        NOT NULL,           -- PDH | PDL
  level         numeric     NOT NULL,
  break_ts      timestamptz NOT NULL,
  break_close   numeric     NOT NULL,
  led_to_setup  boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (symbol, trade_date)                    -- first break of the day wins
);

-- 2. The SETUP (confirmed retest entry) — one row per stock per day.
CREATE TABLE IF NOT EXISTS pdh_pdl.signals (
  id                bigserial PRIMARY KEY,
  symbol            text        NOT NULL,
  trade_date        date        NOT NULL,
  direction         text        NOT NULL,        -- LONG | SHORT
  pdh               numeric,
  pdl               numeric,
  level             numeric     NOT NULL,
  level_type        text        NOT NULL,         -- PDH | PDL
  break_ts          timestamptz,
  entry_ts          timestamptz NOT NULL,
  entry_px          numeric     NOT NULL,
  sl                numeric     NOT NULL,
  r_value           numeric     NOT NULL,         -- |entry - sl|
  t_1p5             numeric     NOT NULL,          -- 1.5R target price
  t_2r              numeric     NOT NULL,          -- 2R target price
  t_3r              numeric     NOT NULL,          -- 3R target price
  trigger_type      text        NOT NULL,          -- PIN | ENGULF
  efficiency_ratio  numeric,
  in_window         boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (symbol, trade_date)
);

-- 3. Outcome — 1:1 with a signal, filled in live as price develops.
CREATE TABLE IF NOT EXISTS pdh_pdl.outcomes (
  signal_id     bigint PRIMARY KEY REFERENCES pdh_pdl.signals(id) ON DELETE CASCADE,
  hit_1p5_ts    timestamptz,
  hit_2r_ts     timestamptz,
  hit_3r_ts     timestamptz,
  hit_sl_ts     timestamptz,
  final_result  text,                             -- SL | T3R | EOD | OPEN
  exit_px       numeric,
  r_multiple    numeric,
  mfe_r         numeric,                           -- max favourable excursion (R)
  mae_r         numeric,                           -- max adverse excursion (R)
  closed_ts     timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 4. Audit of what was actually pushed to Telegram (dedupe / idempotency).
CREATE TABLE IF NOT EXISTS pdh_pdl.alerts (
  id          bigserial PRIMARY KEY,
  signal_id   bigint REFERENCES pdh_pdl.signals(id) ON DELETE SET NULL,
  symbol      text,
  alert_type  text        NOT NULL,               -- ARMED | SETUP | T1.5R | T2R | T3R | SL | EOD
  chat_id     text,
  text        text,
  sent_ok     boolean,
  sent_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pdhpdl_signals_date ON pdh_pdl.signals (trade_date);
CREATE INDEX IF NOT EXISTS idx_pdhpdl_armed_date   ON pdh_pdl.armed (trade_date);
