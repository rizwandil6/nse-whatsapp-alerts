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
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Backs the 5 dashboard tabs. Two tabs (market news, announcements) read
 * from this same service's own AlertLogService; the other three read a
 * SIBLING Railway service's alert log from GitHub, since rs-momentum-strategy-
 * live, multibagger-screener, and darvasbox-live each persist their own state
 * to their own branch/path and there's no shared filesystem or database
 * between services. Cross-branch reads are cached briefly (60s) so opening
 * the dashboard or switching tabs repeatedly doesn't hammer the GitHub API.
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
        return reversedArray(node);
    }

    @GetMapping(value = "/api/dashboard/multibagger", produces = MediaType.APPLICATION_JSON_VALUE)
    public List<JsonNode> multibagger() {
        // Same fix, same date -- multibagger-screener/git_state.js.
        JsonNode node = cachedRead("multibagger", "data/multibagger-log", "multibagger-screener/forward_performance_log.json");
        return reversedArray(node);
    }

    @GetMapping(value = "/api/dashboard/darvasbox-today", produces = MediaType.APPLICATION_JSON_VALUE)
    public List<JsonNode> darvasboxToday() {
        JsonNode node = cachedRead("darvasbox", "data/darvasbox-paper-trade-log", "renko-8-indicators/live/darvasbox_paper_trade_log.json");
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
