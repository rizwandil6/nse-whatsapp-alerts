package com.adil.nsealerts;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Backs the 5 dashboard tabs. Two tabs (market news, announcements) read
 * from this same service's own AlertLogService; the other three read a
 * SIBLING Railway service's alert log from GitHub, since rs-momentum-strategy-
 * live, multibagger-screener, and the DarvasBox shadow-trade service each
 * persist their own state to their own branch/path and there's no shared
 * filesystem or database between services. Cross-branch reads are cached
 * briefly (60s) so opening the dashboard or switching tabs repeatedly
 * doesn't hammer the GitHub API.
 */
@RestController
public class DashboardDataController {

    private final AlertLogService alertLogService;
    private final GithubJsonStore githubJsonStore;
    private final Map<String, CacheEntry> cache = new ConcurrentHashMap<>();
    private static final long CACHE_TTL_MS = 60_000;

    public DashboardDataController(AlertLogService alertLogService, GithubJsonStore githubJsonStore) {
        this.alertLogService = alertLogService;
        this.githubJsonStore = githubJsonStore;
    }

    @GetMapping(value = "/api/dashboard/market-news", produces = MediaType.APPLICATION_JSON_VALUE)
    public List<ObjectNode> marketNews() {
        List<ObjectNode> list = new ArrayList<>(alertLogService.getMarketNews());
        list.sort(Comparator.comparing((ObjectNode n) -> n.path("timestamp").asText("")).reversed());
        return list;
    }

    @GetMapping(value = "/api/dashboard/announcements", produces = MediaType.APPLICATION_JSON_VALUE)
    public List<ObjectNode> announcements() {
        List<ObjectNode> list = new ArrayList<>(alertLogService.getAnnouncements());
        list.sort(Comparator.comparing((ObjectNode n) -> n.path("timestamp").asText("")).reversed());
        return list;
    }

    @GetMapping(value = "/api/dashboard/rs-momentum", produces = MediaType.APPLICATION_JSON_VALUE)
    public List<JsonNode> rsMomentum() {
        // rs-momentum-strategy-live moved its state push off `main` onto this
        // dedicated branch 2026-07-23 (was redeploying every Railway service
        // on every daily run) -- see git_state.js.
        JsonNode node = cachedRead("rs-momentum", "data/rs-momentum-log", "rs-momentum-strategy/live/rs_momentum_log.json");
        List<JsonNode> events = reversedArray(node);
        // "How did it do after we alerted it" (2026-07-28) -- a per-symbol
        // rollup computed daily by server.js/forward_performance.js, same
        // branch/commit as the log above. Attached onto every event for that
        // symbol (not just its most recent) since it's a live "as of today"
        // figure, not tied to any specific past event.
        JsonNode perf = cachedRead("rs-momentum-perf", "data/rs-momentum-log", "rs-momentum-strategy/live/rs_momentum_forward_performance.json");
        attachForwardPerformance(events, perf, "returnSinceEntry");
        return events;
    }

    @GetMapping(value = "/api/dashboard/multibagger", produces = MediaType.APPLICATION_JSON_VALUE)
    public List<JsonNode> multibagger() {
        // Same fix, same date -- multibagger-screener/git_state.js.
        JsonNode node = cachedRead("multibagger", "data/multibagger-log", "multibagger-screener/forward_performance_log.json");
        List<JsonNode> events = reversedArray(node);
        // Same addition as rsMomentum() above, sourced from
        // multibagger-screener/forward_performance.js's daily computation.
        JsonNode perf = cachedRead("multibagger-perf", "data/multibagger-log", "multibagger-screener/forward_performance_summary.json");
        attachForwardPerformance(events, perf, "returnSinceQualification");
        return events;
    }

    /** Merges a per-symbol forward-performance summary row (currentPrice + the named return field, as "returnSinceAlert") onto every event belonging to that symbol. */
    private void attachForwardPerformance(List<JsonNode> events, JsonNode perfArray, String returnFieldName) {
        if (perfArray == null || !perfArray.isArray()) return;
        Map<String, JsonNode> bySymbol = new HashMap<>();
        for (JsonNode row : perfArray) {
            bySymbol.put(row.path("symbol").asText(""), row);
        }
        for (JsonNode event : events) {
            if (!(event instanceof ObjectNode obj)) continue;
            JsonNode perf = bySymbol.get(obj.path("symbol").asText(""));
            if (perf == null) continue;
            if (perf.has("currentPrice") && !perf.get("currentPrice").isNull()) obj.set("currentPrice", perf.get("currentPrice"));
            if (perf.has(returnFieldName) && !perf.get(returnFieldName).isNull()) obj.set("returnSinceAlert", perf.get(returnFieldName));
        }
    }

    @GetMapping(value = "/api/dashboard/darvasbox-today", produces = MediaType.APPLICATION_JSON_VALUE)
    public List<JsonNode> darvasboxToday() {
        // DarvasBox SHADOW trade (renko-8-indicators/live-darvasbox-shadow/) --
        // 0.25% brick, flat 1% stop, LTP-confirmed entries/exits, both directions.
        // The old Renko N/K-grid forward test (renko-python-backtest/live/) was
        // stopped 2026-07-27 in favor of this; this tab replaces that one.
        // Restricted to TODAY (IST) like the original pre-Renko DarvasBox tab
        // was -- this service resets its own tracker state daily (unlike the
        // Renko forward test's continuous multi-day brick/run state), so
        // "today" is the natural scope here.
        JsonNode node = cachedRead("darvasbox", "data/darvasbox-shadow-0.25pct-1pctSL-trade-log", "renko-8-indicators/live-darvasbox-shadow/darvasbox_shadow_trade_log.json");
        String today = LocalDate.now(ZoneId.of("Asia/Kolkata")).toString();
        List<JsonNode> all = reversedArray(node);
        List<JsonNode> todayOnly = new ArrayList<>();
        DateTimeFormatter fmt = DateTimeFormatter.ISO_LOCAL_DATE;
        for (JsonNode t : all) {
            long ms = t.path("entryTimestampMs").isMissingNode() || t.path("entryTimestampMs").asLong(0) == 0
                    ? t.path("timestampMs").asLong(0)
                    : t.path("entryTimestampMs").asLong(0);
            if (ms == 0) continue;
            String date = java.time.Instant.ofEpochMilli(ms).atZone(ZoneId.of("Asia/Kolkata")).format(fmt);
            if (today.equals(date)) todayOnly.add(t);
        }
        return todayOnly;
    }

    private List<JsonNode> reversedArray(JsonNode node) {
        List<JsonNode> list = new ArrayList<>();
        if (node != null && node.isArray()) {
            for (JsonNode n : node) list.add(n);
        }
        java.util.Collections.reverse(list); // logs are appended chronologically -- newest last -> newest first
        return list;
    }

    private JsonNode cachedRead(String key, String branch, String path) {
        CacheEntry entry = cache.get(key);
        long now = System.currentTimeMillis();
        if (entry != null && now - entry.fetchedAt < CACHE_TTL_MS) return entry.data;
        JsonNode fresh = githubJsonStore.readJson(branch, path);
        cache.put(key, new CacheEntry(fresh, now));
        return fresh;
    }

    private record CacheEntry(JsonNode data, long fetchedAt) {}
}
