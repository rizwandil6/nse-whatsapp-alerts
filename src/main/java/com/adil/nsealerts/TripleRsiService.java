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
 */
@Component
public class TripleRsiService {

    private final JdbcTemplate jdbcTemplate;

    public TripleRsiService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    /** Open positions only, most recent entry first. */
    public List<Map<String, Object>> openPositions() {
        return jdbcTemplate.queryForList(
                "SELECT symbol, " +
                        "       to_char(entry_date, 'YYYY-MM-DD') AS \"entryDate\", " +
                        "       entry_price AS \"entryPx\", stop_price AS \"stopPx\", " +
                        "       bars_held AS \"barsHeld\", min_hold_satisfied AS \"minHoldSatisfied\", " +
                        "       return_pct AS \"pnlPct\", last_price AS \"lastPrice\", " +
                        "       to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') AS \"updatedAt\" " +
                        "FROM triple_rsi.positions " +
                        "WHERE status = 'open' " +
                        "ORDER BY entry_date DESC, symbol");
    }
}
