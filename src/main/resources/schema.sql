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
    ai_judgment            TEXT,               -- one-line AI verdict (PromptRatingService's overall_label), e.g.
                                                -- "Positive with some margin pressure" -- same AI call already
                                                -- made for the Telegram alert, not a separate one
    announcement_category  TEXT,               -- NSE category the triggering announcement was filed under
    announcement_date      TIMESTAMPTZ NOT NULL,
    source_link            TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT quarterly_results_symbol_quarter_uniq UNIQUE (symbol, quarter_label)
);

-- The profit_swing_type -> profit_yoy_swing_type rename was a one-time,
-- already-completed migration (applied directly, 2026-07-30, before this file
-- was ever deployed) -- NOT left here as a DO $$ ... $$ block. Spring Boot's
-- built-in schema.sql runner (spring.sql.init.mode=always) uses its own naive
-- semicolon-based statement splitter, which does NOT understand Postgres's
-- dollar-quoting and breaks a DO block apart mid-statement -- confirmed live:
-- it crashed the whole app on startup ("Unterminated dollar quote"), even
-- though the identical SQL ran perfectly via psycopg2 (which just sends the
-- file as one execute() call, no statement splitting at all). Lesson: always
-- verify schema.sql through Spring's OWN initializer, not just a direct
-- driver, before trusting it deploys cleanly.
ALTER TABLE quarterly_results ADD COLUMN IF NOT EXISTS revenue_qoq_cr NUMERIC;
ALTER TABLE quarterly_results ADD COLUMN IF NOT EXISTS net_profit_qoq_cr NUMERIC;
ALTER TABLE quarterly_results ADD COLUMN IF NOT EXISTS revenue_qoq_pct NUMERIC;
ALTER TABLE quarterly_results ADD COLUMN IF NOT EXISTS net_profit_qoq_pct NUMERIC;
ALTER TABLE quarterly_results ADD COLUMN IF NOT EXISTS profit_qoq_swing_type TEXT;
ALTER TABLE quarterly_results ADD COLUMN IF NOT EXISTS ai_judgment TEXT;

-- Margin/EPS/verdict/RS Rank (added 2026-07-30, see QuarterlyResultsService's
-- verdictAndReasons()): operating margin's YoY/QoQ comparisons are stored as
-- PERCENTAGE-POINT differences (current_pct - base_pct), not a relative %
-- change -- comparing two already-percentage figures with the revenue/
-- profit relative-% formula would produce a meaningless "percent of a
-- percent". EPS keeps the same relative-%-with-abs(base)-denominator
-- convention as revenue/profit, since EPS in Rs is a plain figure, not
-- itself a percentage. rs_rank is nullable: only ~300 stocks (the RS
-- Momentum universe) have one at all -- see RsRankLookupService.
ALTER TABLE quarterly_results ADD COLUMN IF NOT EXISTS operating_margin_pct NUMERIC;
ALTER TABLE quarterly_results ADD COLUMN IF NOT EXISTS operating_margin_yoy_pp NUMERIC;
ALTER TABLE quarterly_results ADD COLUMN IF NOT EXISTS operating_margin_qoq_pp NUMERIC;
ALTER TABLE quarterly_results ADD COLUMN IF NOT EXISTS eps NUMERIC;
ALTER TABLE quarterly_results ADD COLUMN IF NOT EXISTS eps_yoy_pct NUMERIC;
ALTER TABLE quarterly_results ADD COLUMN IF NOT EXISTS eps_qoq_pct NUMERIC;
ALTER TABLE quarterly_results ADD COLUMN IF NOT EXISTS verdict TEXT; -- 'RIGHT' | 'MIXED' | 'WRONG'
ALTER TABLE quarterly_results ADD COLUMN IF NOT EXISTS rs_rank NUMERIC;

-- EBITDA (added 2026-07-31): Screener's "Operating Profit" row (Sales -
-- Expenses, with Depreciation/Interest deducted SEPARATELY afterward to
-- reach Profit before tax) is the retail-investor convention for EBITDA --
-- verified against a real fetched page (THERMAX) before building this,
-- same discipline as every other field here. Swing-type-aware like net
-- profit (not revenue), since EBITDA can also flip sign, unlike revenue.
ALTER TABLE quarterly_results ADD COLUMN IF NOT EXISTS ebitda_cr NUMERIC;
ALTER TABLE quarterly_results ADD COLUMN IF NOT EXISTS ebitda_yoy_cr NUMERIC;
ALTER TABLE quarterly_results ADD COLUMN IF NOT EXISTS ebitda_yoy_pct NUMERIC;
ALTER TABLE quarterly_results ADD COLUMN IF NOT EXISTS ebitda_yoy_swing_type TEXT;
ALTER TABLE quarterly_results ADD COLUMN IF NOT EXISTS ebitda_qoq_cr NUMERIC;
ALTER TABLE quarterly_results ADD COLUMN IF NOT EXISTS ebitda_qoq_pct NUMERIC;
ALTER TABLE quarterly_results ADD COLUMN IF NOT EXISTS ebitda_qoq_swing_type TEXT;

-- Dividend info (2026-08-03): many companies declare a dividend in the SAME
-- "Outcome of Board Meeting" filing as the quarter's results -- confirmed on
-- several real Jun 2026 filings. Scanned from the filed PDF regardless of
-- whether the financial figures themselves came from Screener.in or the PDF
-- fallback (ResultsPdfParser.scanForDividend), since Screener doesn't carry
-- dividend data at all. NULL (not 0) when no dividend was declared this
-- quarter, or when a real declaration exists but couldn't be confidently
-- extracted -- never fabricated.
ALTER TABLE quarterly_results ADD COLUMN IF NOT EXISTS dividend_amount NUMERIC;
ALTER TABLE quarterly_results ADD COLUMN IF NOT EXISTS dividend_record_date DATE;

