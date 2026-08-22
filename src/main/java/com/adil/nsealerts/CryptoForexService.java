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
 * Backs the dashboard's "Crypto/Forex" tab -- currently-open positions from the
 * Ichimoku BTC/XAU MTF scanner (ichimoku-btc-xau-strategy/live, a Node service
 * streaming Pi42 and writing straight to this same shared Postgres instance's
 * ichimoku_btcxau.* schema). Same "Node service writes Postgres, this Java app
 * reads it for the dashboard" pattern as SwingSignalService/RsMomentumService.
 *
 * Scoped to OPEN positions only (per the tab's purpose) -- closed history
 * (TARGET/SL/WARNING_EXIT) isn't surfaced here; query ichimoku_btcxau.signals/
 * outcomes directly if that's ever needed.
 *
 * Each open row is enriched with a LIVE current price and direction-aware
 * unrealized %, fetched straight from Pi42's public (unauthenticated)
 * ticker24Hr endpoint -- same "attach fresh, don't trust the stored snapshot"
 * pattern as the Swing tab's live-price attach (DashboardDataController#swing).
 * Only 2 symbols max at a time (BTCUSDT/XAUUSDT), so no caching layer -- a
 * synchronous per-request round-trip is fine at this volume, and a failed
 * fetch just skips that field rather than failing the whole tab.
 */
@Component
public class CryptoForexService {

    private final JdbcTemplate jdbcTemplate;
    private final HttpClient httpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
    private final ObjectMapper mapper = new ObjectMapper();

    public CryptoForexService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public List<Map<String, Object>> openPositions() {
        List<Map<String, Object>> rows = jdbcTemplate.queryForList(
                "SELECT s.symbol, s.direction, " +
                        "       to_char(s.entry_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') AS \"entryTs\", " +
                        "       s.entry_px AS \"entryPx\", s.stop_px AS \"stopPx\", s.target_px AS \"targetPx\", " +
                        "       s.r_value AS \"rValue\", s.criteria::text AS \"criteria\", " +
                        "       o.warning_fired AS \"warningFired\" " +
                        "FROM ichimoku_btcxau.signals s " +
                        "JOIN ichimoku_btcxau.outcomes o ON o.signal_id = s.id " +
                        "WHERE o.final_result = 'OPEN' " +
                        "ORDER BY s.entry_ts DESC");
        for (Map<String, Object> row : rows) {
            attachLivePnl(row);
        }
        return rows;
    }

    private void attachLivePnl(Map<String, Object> row) {
        Object symbolO = row.get("symbol"), entryO = row.get("entryPx"), directionO = row.get("direction");
        if (!(symbolO instanceof String symbol) || !(entryO instanceof Number entryN) || !(directionO instanceof String direction)) return;
        Double last = fetchLastPrice(symbol);
        if (last == null) return;
        double entry = entryN.doubleValue();
        if (entry <= 0) return;
        double pct = "LONG".equals(direction) ? (last - entry) / entry * 100.0 : (entry - last) / entry * 100.0;
        row.put("currentPrice", last);
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
