package com.adil.nsealerts;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;

/**
 * Reads darvasbox.trade_events (written by the live-darvasbox-shadow Node
 * service, darvasbox_db.js) for the "Today's DarvasBox" dashboard tab.
 * Replaces the old GitHub-branch JSON read (data/darvasbox-shadow-0.25pct-1pctSL-trade-log),
 * which went stale 2026-08-11 when the writer moved to Postgres without the
 * dashboard reader being updated to match -- the tab silently showed nothing
 * for a week.
 *
 * Restricted to tracker='variant': the 'real' tracker's Telegram alerts have
 * been muted (DARVAS_TELEGRAM_ENABLED=false on the darvasbox-live Railway
 * service) since before this migration, so surfacing 'real' here would show
 * trades the user never sees alerted live. This tab should mirror what's
 * actually being alerted -- the variant only.
 */
@Component
public class DarvasboxLiveService {

    private final JdbcTemplate jdbcTemplate;
    private final ObjectMapper mapper = new ObjectMapper();

    public DarvasboxLiveService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    /** Today's (IST) variant ENTRY/EXIT events, newest first -- same order as the old GitHub-log reader. */
    public List<JsonNode> todaysVariantEvents() {
        String today = LocalDate.now(ZoneId.of("Asia/Kolkata")).toString();
        List<String> payloads = jdbcTemplate.queryForList(
                "SELECT payload::text FROM darvasbox.trade_events " +
                        "WHERE tracker = 'variant' AND trade_date = ?::date " +
                        "ORDER BY id DESC",
                String.class, today);
        List<JsonNode> out = new ArrayList<>();
        for (String p : payloads) {
            try {
                out.add(mapper.readTree(p));
            } catch (Exception ignored) {
                // malformed payload row -- skip rather than 500 the whole tab
            }
        }
        return out;
    }
}
