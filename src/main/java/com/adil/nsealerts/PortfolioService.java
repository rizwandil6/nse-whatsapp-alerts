package com.adil.nsealerts;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;

/**
 * Backs the Portfolio tab. portfolio.tickers holds each browser's watchlist
 * (browser_id is an anonymous UUID generated client-side, see index.html --
 * no login, no user table). portfolio.analysis holds the latest
 * TradingAgents decision per (browser_id, ticker, analysis_date), written by
 * PortfolioAnalysisScheduler's 08:00 IST daily run. Same JdbcTemplate + raw
 * SQL style as SwingSignalService/QuarterlyResultsService -- no JPA anywhere
 * in this codebase.
 */
@Component
public class PortfolioService {

    private static final int MAX_TICKERS_PER_PORTFOLIO = 20;

    private final JdbcTemplate jdbcTemplate;

    public PortfolioService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public void addTicker(String browserId, String ticker) {
        Integer count = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM portfolio.tickers WHERE browser_id = ?",
                Integer.class, browserId);
        if (count != null && count >= MAX_TICKERS_PER_PORTFOLIO) {
            throw new IllegalStateException("Portfolio limit reached (" + MAX_TICKERS_PER_PORTFOLIO + " tickers)");
        }
        jdbcTemplate.update(
                "INSERT INTO portfolio.tickers (browser_id, ticker) VALUES (?, ?) " +
                        "ON CONFLICT (browser_id, ticker) DO NOTHING",
                browserId, ticker);
    }

    public void removeTicker(String browserId, String ticker) {
        jdbcTemplate.update(
                "DELETE FROM portfolio.tickers WHERE browser_id = ? AND ticker = ?",
                browserId, ticker);
    }

    /** Tickers in this browser's portfolio, each with its latest analysis row (if any). */
    public List<Map<String, Object>> analysisFor(String browserId) {
        return jdbcTemplate.queryForList(
                "SELECT t.ticker, " +
                        "       to_char(a.analysis_date, 'YYYY-MM-DD') AS \"analysisDate\", " +
                        "       a.decision, a.reasoning " +
                        "FROM portfolio.tickers t " +
                        "LEFT JOIN LATERAL ( " +
                        "  SELECT analysis_date, decision, reasoning FROM portfolio.analysis " +
                        "  WHERE browser_id = t.browser_id AND ticker = t.ticker " +
                        "  ORDER BY analysis_date DESC LIMIT 1 " +
                        ") a ON true " +
                        "WHERE t.browser_id = ? " +
                        "ORDER BY t.added_at",
                browserId);
    }

    /** Every distinct ticker held by any browser -- what the nightly job needs to analyze, deduped. */
    public List<String> distinctTickers() {
        return jdbcTemplate.queryForList("SELECT DISTINCT ticker FROM portfolio.tickers", String.class);
    }

    /** This browser's tickers with no analysis row for today yet -- what the "Run analysis" button needs. */
    public List<String> pendingTickersFor(String browserId) {
        return jdbcTemplate.queryForList(
                "SELECT t.ticker FROM portfolio.tickers t " +
                        "WHERE t.browser_id = ? AND NOT EXISTS ( " +
                        "  SELECT 1 FROM portfolio.analysis a " +
                        "  WHERE a.browser_id = t.browser_id AND a.ticker = t.ticker AND a.analysis_date = CURRENT_DATE" +
                        ")",
                String.class, browserId);
    }

    /** Every browser_id currently holding this ticker -- the nightly job fans one analysis result out to all of them. */
    public List<String> browsersHolding(String ticker) {
        return jdbcTemplate.queryForList(
                "SELECT browser_id FROM portfolio.tickers WHERE ticker = ?", String.class, ticker);
    }

    public void upsertAnalysis(String browserId, String ticker, LocalDate analysisDate, String decision, String reasoning) {
        jdbcTemplate.update(
                "INSERT INTO portfolio.analysis (browser_id, ticker, analysis_date, decision, reasoning) " +
                        "VALUES (?, ?, ?, ?, ?) " +
                        "ON CONFLICT (browser_id, ticker, analysis_date) DO UPDATE SET " +
                        "  decision = EXCLUDED.decision, reasoning = EXCLUDED.reasoning, updated_at = now()",
                browserId, ticker, analysisDate, decision, reasoning);
    }
}
