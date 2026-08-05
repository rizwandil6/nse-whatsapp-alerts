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

-- ---- variant support (pdhpdl-v2: min-R filter) --------------------------------
-- config_tag separates variants; r_pct is R as % of price; alerted = whether a
-- Telegram alert was sent (false when the min-R filter suppressed it, but the
-- trade is still logged + outcome-tracked so v1-vs-v2 is one clean dataset).
ALTER TABLE pdh_pdl.signals ADD COLUMN IF NOT EXISTS config_tag text NOT NULL DEFAULT 'pdhpdl-v1';
ALTER TABLE pdh_pdl.signals ADD COLUMN IF NOT EXISTS r_pct      numeric;
ALTER TABLE pdh_pdl.signals ADD COLUMN IF NOT EXISTS alerted    boolean NOT NULL DEFAULT true;
ALTER TABLE pdh_pdl.armed   ADD COLUMN IF NOT EXISTS config_tag text NOT NULL DEFAULT 'pdhpdl-v1';
CREATE INDEX IF NOT EXISTS idx_pdhpdl_signals_tag ON pdh_pdl.signals (config_tag);

-- ---- variant support (pdhpdl-v3: author's v2 spec) ----------------------------
-- signal_seq (1|2) lets v3 log up to 2 trades/day; gap_pct/range_atr are v3
-- diagnostics. The uniqueness must widen to allow the 2nd trade of the day.
ALTER TABLE pdh_pdl.signals ADD COLUMN IF NOT EXISTS signal_seq int NOT NULL DEFAULT 1;
ALTER TABLE pdh_pdl.signals ADD COLUMN IF NOT EXISTS gap_pct    numeric;
ALTER TABLE pdh_pdl.signals ADD COLUMN IF NOT EXISTS range_atr  numeric;
-- Widen uniqueness to (symbol, trade_date, config_tag, signal_seq) so v3 can log a
-- 2nd trade/day. Name-agnostic + idempotent: drop any legacy unique on the table,
-- then add ours if missing. (The old inline UNIQUE(symbol,trade_date) auto-named
-- constraint is dropped whatever its name.)
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'pdh_pdl.signals'::regclass AND contype = 'u' AND conname <> 'pdhpdl_signals_uq'
  LOOP
    EXECUTE 'ALTER TABLE pdh_pdl.signals DROP CONSTRAINT ' || quote_ident(c.conname);
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'pdh_pdl.signals'::regclass AND conname = 'pdhpdl_signals_uq'
  ) THEN
    ALTER TABLE pdh_pdl.signals ADD CONSTRAINT pdhpdl_signals_uq UNIQUE (symbol, trade_date, config_tag, signal_seq);
  END IF;
END $$;
