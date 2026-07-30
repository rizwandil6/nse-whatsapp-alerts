-- Quarterly results log, scoped Postgres addon (2026-07-30) -- see
-- application.yml's datasource comment for why this is the one log that
-- moved off the GitHub-JSON-branch pattern the rest of the project uses.
--
-- (symbol, quarter_label) is UNIQUE: an announcement can get reprocessed
-- (retry, redeploy replay) and this must be idempotent -- an upsert on that
-- key, not an append -- unlike the JSON logs elsewhere in this project,
-- which have had real duplicate-row incidents from exactly this kind of
-- replay (see rs-momentum-strategy's/darvasbox's own trade-log duplicate
-- fixes). revenue is never negative so only net profit needs a swing type
-- (a company can flip between a loss and a profit; revenue can't go
-- negative the same way) -- a swing type is set instead of a misleading/
-- undefined % whenever the sign of net profit differs between the two
-- quarters being compared.
--
-- Both a year-over-year (same quarter, prior year) AND a quarter-over-
-- quarter (immediately preceding quarter) comparison are stored -- added
-- 2026-07-30 after reviewing WAAREEENER's real Jun 2026 filing: YoY alone
-- read as unambiguous growth (+79% revenue, +15% profit) while QoQ showed
-- both metrics actually declined from Mar 2026 (-6.5%, -20.8%) -- a real
-- signal the YoY-only view would have hidden.
CREATE TABLE IF NOT EXISTS quarterly_results (
    id                     BIGSERIAL PRIMARY KEY,
    symbol                 TEXT NOT NULL,
    company_name           TEXT,
    quarter_label          TEXT NOT NULL,      -- e.g. "Mar 2026", exactly as shown on Screener.in
    quarter_end_date       DATE,               -- from Screener's own data-date-key; NULL if unparseable
    revenue_cr             NUMERIC,
    net_profit_cr          NUMERIC,
    revenue_yoy_cr         NUMERIC,            -- same quarter_label, prior year -- NULL if not found on the page
    net_profit_yoy_cr      NUMERIC,
    revenue_yoy_pct        NUMERIC,            -- NULL when revenue_yoy_cr is NULL (no prior-year data)
    net_profit_yoy_pct     NUMERIC,            -- NULL when net_profit_yoy_cr is NULL OR profit_yoy_swing_type is set
    profit_yoy_swing_type  TEXT,               -- 'LOSS_TO_PROFIT' | 'PROFIT_TO_LOSS' | NULL for a normal same-sign comparison
    revenue_qoq_cr         NUMERIC,            -- immediately preceding quarter -- NULL if the series has a gap there
    net_profit_qoq_cr      NUMERIC,
    revenue_qoq_pct        NUMERIC,
    net_profit_qoq_pct     NUMERIC,
    profit_qoq_swing_type  TEXT,
    announcement_category  TEXT,               -- NSE category the triggering announcement was filed under
    announcement_date      TIMESTAMPTZ NOT NULL,
    source_link            TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT quarterly_results_symbol_quarter_uniq UNIQUE (symbol, quarter_label)
);

-- Non-destructive, idempotent migration for a table created before the QoQ
-- columns/rename existed (spring.sql.init.mode=always re-runs this file
-- every startup, so this must never fail on an already-migrated table, and
-- must never drop/lose anything).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'quarterly_results' AND column_name = 'profit_swing_type') THEN
        ALTER TABLE quarterly_results RENAME COLUMN profit_swing_type TO profit_yoy_swing_type;
    END IF;
END $$;

ALTER TABLE quarterly_results ADD COLUMN IF NOT EXISTS revenue_qoq_cr NUMERIC;
ALTER TABLE quarterly_results ADD COLUMN IF NOT EXISTS net_profit_qoq_cr NUMERIC;
ALTER TABLE quarterly_results ADD COLUMN IF NOT EXISTS revenue_qoq_pct NUMERIC;
ALTER TABLE quarterly_results ADD COLUMN IF NOT EXISTS net_profit_qoq_pct NUMERIC;
ALTER TABLE quarterly_results ADD COLUMN IF NOT EXISTS profit_qoq_swing_type TEXT;

