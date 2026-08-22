package com.adil.nsealerts;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

/**
 * Backs the dashboard's "Crypto/Forex" tab -- currently-open positions from the
 * Ichimoku BTC/XAU MTF scanner (ichimoku-btc-xau-strategy/live, a Node service
 * streaming Pi42 and writing straight to this same shared Postgres instance's
 * ichimoku_btcxau.* schema). Same "Node service writes Postgres, this Java app
 * reads it for the dashboard" pattern as SwingSignalService/RsMomentumService.
 *
 * Scoped to OPEN positions only (per the tab's purpose) -- closed history
 * (TARGET/SL/WARNING_EXIT) isn't surfaced here; query ichimoku_btcxau.signals/
 * outcomes directly if that's ever needed.
 */
@Component
public class CryptoForexService {

    private final JdbcTemplate jdbcTemplate;

    public CryptoForexService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public List<Map<String, Object>> openPositions() {
        return jdbcTemplate.queryForList(
                "SELECT s.symbol, s.direction, " +
                        "       to_char(s.entry_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') AS \"entryTs\", " +
                        "       s.entry_px AS \"entryPx\", s.stop_px AS \"stopPx\", s.target_px AS \"targetPx\", " +
                        "       s.r_value AS \"rValue\", s.criteria::text AS \"criteria\", " +
                        "       o.warning_fired AS \"warningFired\" " +
                        "FROM ichimoku_btcxau.signals s " +
                        "JOIN ichimoku_btcxau.outcomes o ON o.signal_id = s.id " +
                        "WHERE o.final_result = 'OPEN' " +
                        "ORDER BY s.entry_ts DESC");
    }
}
