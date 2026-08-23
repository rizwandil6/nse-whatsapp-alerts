package com.adil.nsealerts;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

/**
 * Reads darvas_classic.symbol_state -- one row per symbol, upserted in place by the
 * separate darvas-classic-strategy/live Node service (runner.js) on its daily 17:00 IST
 * Cron Job run. Same "Node service writes Postgres, this Java app reads it for the
 * dashboard" pattern as SwingSignalService. state_json carries a full snapshot (open
 * position legs + trailing stop, last closed trade) so the dashboard doesn't need to
 * re-derive anything from the raw trade_events log.
 */
@Component
public class DarvasClassicService {

    private final JdbcTemplate jdbcTemplate;

    public DarvasClassicService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    /** Open positions first (newest entry first), then symbols with only closed history, newest first. */
    public List<Map<String, Object>> all() {
        return jdbcTemplate.queryForList(
                "SELECT symbol, state_json::text AS \"stateJson\", " +
                        "       to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') AS \"updatedAt\" " +
                        "FROM darvas_classic.symbol_state " +
                        "WHERE (state_json->>'openLegCount')::int > 0 OR (state_json->>'closedCount')::int > 0 " +
                        "ORDER BY ((state_json->>'openLegCount')::int > 0) DESC, updated_at DESC");
    }
}
