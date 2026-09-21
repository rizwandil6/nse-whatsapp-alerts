package com.adil.nsealerts;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

/**
 * Reads triple_rsi.positions -- one row per position (open or closed), written by
 * the separate triple-rsi-strategy/live Node service's daily 16:00 IST run (alert-only,
 * no orders placed -- see that service's README). The dashboard tab only shows open
 * positions; entry/exit alerting happens on Telegram, not here.
 *
 * Also left-joins portfolio.analysis for the fixed 'triple-rsi-auto' system browser_id
 * (see triple-rsi-strategy/live/db.js's syncPortfolioWatchlist, which keeps that
 * watchlist in sync with open positions right after each 16:00 IST run) -- so each
 * open position's latest TradingAgents decision/reasoning (produced by
 * PortfolioAnalysisScheduler's 08:00 IST run) shows up on this tab too, same data
 * the Portfolio tab itself reads via PortfolioService.analysisFor.
 */
@Component
public class TripleRsiService {

    private static final String PORTFOLIO_SYSTEM_BROWSER_ID = "triple-rsi-auto";

    private final JdbcTemplate jdbcTemplate;

    public TripleRsiService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    /** Open positions only, most recent entry first, with each symbol's latest TradingAgents take (if any). */
    public List<Map<String, Object>> openPositions() {
        return jdbcTemplate.queryForList(
                "SELECT p.symbol, " +
                        "       to_char(p.entry_date, 'YYYY-MM-DD') AS \"entryDate\", " +
                        "       p.entry_price AS \"entryPx\", p.stop_price AS \"stopPx\", " +
                        "       p.bars_held AS \"barsHeld\", p.min_hold_satisfied AS \"minHoldSatisfied\", " +
                        "       p.return_pct AS \"pnlPct\", p.last_price AS \"lastPrice\", " +
                        "       to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') AS \"updatedAt\", " +
                        "       to_char(a.analysis_date, 'YYYY-MM-DD') AS \"analysisDate\", " +
                        "       a.decision, a.reasoning " +
                        "FROM triple_rsi.positions p " +
                        "LEFT JOIN LATERAL ( " +
                        "  SELECT analysis_date, decision, reasoning FROM portfolio.analysis " +
                        "  WHERE browser_id = ? AND ticker = p.symbol " +
                        "  ORDER BY analysis_date DESC LIMIT 1 " +
                        ") a ON true " +
                        "WHERE p.status = 'open' " +
                        "ORDER BY p.entry_date DESC, p.symbol",
                PORTFOLIO_SYSTEM_BROWSER_ID);
    }
}
