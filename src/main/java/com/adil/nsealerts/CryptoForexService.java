package com.adil.nsealerts;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;

/**
 * Backs the dashboard's "Crypto/Forex" tab -- ALL trades (open and closed) from
 * BOTH crypto/forex strategies, UNIONed and tagged with a "strategy" field so
 * the frontend can filter between them:
 *   - Ichimoku BTC/XAU MTF scanner (ichimoku-btc-xau-strategy/live, schema
 *     ichimoku_btcxau.*).
 *   - Inside Candle Sweep+Break scanner (inside-candle-strategy/live, schema
 *     inside_candle.*, added 2026-08-25 -- same Node-writes-Postgres pattern,
 *     no criteria/warning_fired columns since that strategy has no trend
 *     filter/early-exit concept, so those come back NULL for its rows).
 * Both are Node services streaming Pi42 and writing straight to this same
 * shared Postgres instance. Same "Node service writes Postgres, this Java
 * app reads it for the dashboard" pattern as SwingSignalService/RsMomentumService.
 *
 * Excludes ABANDONED rows -- those are bookkeeping artifacts from restart-
 * duplicate-signal bugs (see each strategy's README "Restart resilience"),
 * not real trade outcomes, so showing them here would misrepresent the trade
 * history rather than inform it.
 *
 * Every row gets a direction-aware P&L%: OPEN rows compute it against a LIVE
 * current price fetched from Pi42's public (unauthenticated) ticker24Hr
 * endpoint (same "attach fresh, don't trust the stored snapshot" pattern as
 * the Swing tab's live-price attach, DashboardDataController#swing); closed
 * rows (TARGET/SL/WARNING_EXIT) use the already-final stored exit price --
 * no network call needed since that number never changes again. Only a
 * handful of symbols are ever OPEN at once across both strategies, so no
 * caching layer -- a synchronous per-request round-trip is fine at this
 * volume, and a failed fetch just skips that OPEN row's live fields rather
 * than failing the tab.
 */
@Component
public class CryptoForexService {

    private final JdbcTemplate jdbcTemplate;
    private final HttpClient httpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
    private final ObjectMapper mapper = new ObjectMapper();

    public CryptoForexService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public List<Map<String, Object>> allTrades() {
        List<Map<String, Object>> rows = jdbcTemplate.queryForList(
                "SELECT 'Ichimoku' AS \"strategy\", s.symbol, s.direction, " +
                        "       to_char(s.entry_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') AS \"entryTs\", " +
                        "       s.entry_px AS \"entryPx\", s.stop_px AS \"stopPx\", s.target_px AS \"targetPx\", " +
                        "       s.r_value AS \"rValue\", s.criteria::text AS \"criteria\", " +
                        "       o.warning_fired AS \"warningFired\", o.final_result AS \"status\", " +
                        "       o.exit_px AS \"exitPx\", o.r_multiple AS \"rMultiple\", " +
                        "       to_char(o.closed_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') AS \"closedTs\" " +
                        "FROM ichimoku_btcxau.signals s " +
                        "JOIN ichimoku_btcxau.outcomes o ON o.signal_id = s.id " +
                        "WHERE o.final_result != 'ABANDONED' " +
                        "UNION ALL " +
                        "SELECT 'Inside Candle' AS \"strategy\", s.symbol, s.direction, " +
                        "       to_char(s.entry_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') AS \"entryTs\", " +
                        "       s.entry_px AS \"entryPx\", s.stop_px AS \"stopPx\", s.target_px AS \"targetPx\", " +
                        "       s.r_value AS \"rValue\", NULL::text AS \"criteria\", " +
                        "       NULL::boolean AS \"warningFired\", o.final_result AS \"status\", " +
                        "       o.exit_px AS \"exitPx\", o.r_multiple AS \"rMultiple\", " +
                        "       to_char(o.closed_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') AS \"closedTs\" " +
                        "FROM inside_candle.signals s " +
                        "JOIN inside_candle.outcomes o ON o.signal_id = s.id " +
                        "WHERE o.final_result != 'ABANDONED' " +
                        "ORDER BY (\"status\" = 'OPEN') DESC, COALESCE(\"closedTs\", \"entryTs\") DESC");
        for (Map<String, Object> row : rows) {
            attachPnlPct(row);
        }
        return rows;
    }

    private void attachPnlPct(Map<String, Object> row) {
        Object symbolO = row.get("symbol"), entryO = row.get("entryPx"), directionO = row.get("direction");
        if (!(symbolO instanceof String symbol) || !(entryO instanceof Number entryN) || !(directionO instanceof String direction)) return;
        double entry = entryN.doubleValue();
        if (entry <= 0) return;

        boolean open = "OPEN".equals(row.get("status"));
        Double refPrice;
        if (open) {
            refPrice = fetchLastPrice(symbol);
            if (refPrice != null) row.put("currentPrice", refPrice);
        } else {
            Object exitO = row.get("exitPx");
            refPrice = exitO instanceof Number exitN ? exitN.doubleValue() : null;
        }
        if (refPrice == null) return;

        double pct = "LONG".equals(direction) ? (refPrice - entry) / entry * 100.0 : (entry - refPrice) / entry * 100.0;
        row.put("pnlPct", Math.round(pct * 100.0) / 100.0); // 2 dp
    }

    /** Last traded price ("c") from Pi42's public GET /v1/market/ticker24Hr/{symbol} -- no auth needed. */
    private Double fetchLastPrice(String symbol) {
        try {
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create("https://api.pi42.com/v1/market/ticker24Hr/" + symbol))
                    .timeout(Duration.ofSeconds(3))
                    .GET().build();
            HttpResponse<String> resp = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
            if (resp.statusCode() != 200) return null;
            JsonNode c = mapper.readTree(resp.body()).path("data").path("c");
            return c.isMissingNode() ? null : c.asDouble();
        } catch (Exception e) {
            return null; // network hiccup -- the tab still works, just without this row's live %
        }
    }
}
