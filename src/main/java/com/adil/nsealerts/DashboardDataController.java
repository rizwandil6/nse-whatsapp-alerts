package com.adil.nsealerts;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
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
    private final QuarterlyResultsService quarterlyResultsService;
    private final RsRankLookupService rsRankLookupService;
    private final RsMomentumService rsMomentumService;
    private final SwingSignalService swingSignalService;
    private final SwingLivePriceService swingLivePriceService;
    private final Map<String, CacheEntry> cache = new ConcurrentHashMap<>();
    private static final long CACHE_TTL_MS = 60_000;

    public DashboardDataController(AlertLogService alertLogService, GithubJsonStore githubJsonStore,
                                    QuarterlyResultsService quarterlyResultsService,
                                    RsRankLookupService rsRankLookupService,
                                    RsMomentumService rsMomentumService,
                                    SwingSignalService swingSignalService,
                                    SwingLivePriceService swingLivePriceService) {
        this.alertLogService = alertLogService;
        this.githubJsonStore = githubJsonStore;
        this.quarterlyResultsService = quarterlyResultsService;
        this.rsRankLookupService = rsRankLookupService;
        this.rsMomentumService = rsMomentumService;
        this.swingSignalService = swingSignalService;
        this.swingLivePriceService = swingLivePriceService;
    }

    // Swing Strategy tab -- reads swing.signals from Postgres (written by the
    // swing-strategy/live Node service), then attaches a LIVE last price to each
    // OPEN position so `since alert %` tracks the current price instead of the
    // frozen 19:00 snapshot. Same "attach fresh, don't trust the stored snapshot"
    // pattern as RS Rank below. Live prices are cached 60s in SwingLivePriceService,
    // and only fetched during NSE cash-market hours (see isMarketHours) -- outside
    // that window rows simply keep their stored snapshot instead of paying for an
    // Upstox round-trip that can't return anything fresher. Closed rows keep their
    // realized %, pending rows have no entry to price.
    //
    // Also attaches `todayPct` -- the day's move only, distinct from `sinceAlertPct`
    // (the whole-position return). Baseline is the stored `lastPrice` snapshot: the
    // Node runner writes it as "most recent close seen" once per day (19:00 IST,
    // after that day's close), so during the NEXT trading day it's exactly
    // yesterday's close -- the correct denominator for today's move. Must be read
    // before it's overwritten below with the live price.
    //
    // `actionToday` flags rows a trader needs to look at today without scanning the
    // whole list: a brand-new pending signal (plan tomorrow's entry), a +2R half-book,
    // or a full exit -- all detected by comparing the row's date fields to the current
    // "signal day" (see effectiveSignalDate). NOT calendar-day midnight: the Node
    // runner only refreshes signals once daily at 19:00 IST, so a badge set today
    // must keep showing through the rest of tonight and stay live until that next
    // 19:00 run -- not vanish the instant the clock crosses into a new calendar date.
    @GetMapping(value = "/api/dashboard/swing", produces = MediaType.APPLICATION_JSON_VALUE)
    public List<Map<String, Object>> swing() {
        List<Map<String, Object>> rows = swingSignalService.all();
        String today = effectiveSignalDate().toString();
        List<String> openSymbols = new ArrayList<>();
        for (Map<String, Object> r : rows) {
            if ("open".equals(r.get("status")) && r.get("symbol") != null) openSymbols.add(r.get("symbol").toString());
            boolean actionToday = today.equals(r.get("halfDate")) || today.equals(r.get("exitDate"))
                    || ("pending".equals(r.get("status")) && today.equals(r.get("signalDate")));
            r.put("actionToday", actionToday);
            // Same lookup used by the Quarterly Results card -- current rank, not the
            // rank as of signal date. Unlike Quarterly Results, coverage here is
            // effectively the full swing universe (swing-strategy/live/symbols.json
            // is kept identical to rs-momentum-strategy's own universe) -- a null
            // means insufficient price history (e.g. a recent IPO), not exclusion.
            // See RsRankLookupService's own doc comment.
            if (r.get("symbol") != null) {
                Double rank = rsRankLookupService.rankFor(r.get("symbol").toString());
                if (rank != null) r.put("rsRank", rank);
            }
        }
        if (!openSymbols.isEmpty() && isMarketHours()) {
            Map<String, Double> live = swingLivePriceService.pricesFor(openSymbols);
            for (Map<String, Object> r : rows) {
                if (!"open".equals(r.get("status"))) continue;
                Object symO = r.get("symbol"), entO = r.get("entryPx");
                if (symO == null || !(entO instanceof Number)) continue;
                Double lp = live.get(symO.toString());
                if (lp == null) continue;
                double entry = ((Number) entO).doubleValue();
                if (entry <= 0) continue;
                Object prevCloseO = r.get("lastPrice");
                if (prevCloseO instanceof Number prevClose && prevClose.doubleValue() > 0) {
                    r.put("todayPct", Math.round(((lp - prevClose.doubleValue()) / prevClose.doubleValue()) * 1000.0) / 10.0);
                }
                r.put("lastPrice", lp);
                r.put("sinceAlertPct", Math.round(((lp - entry) / entry) * 1000.0) / 10.0); // 1 dp
            }
        }
        return rows;
    }

    // The Node runner stamps signalDate/halfDate/exitDate with the calendar date of
    // its once-daily 19:00 IST run, and those values don't change again until the
    // NEXT run. So the "signal day" these dates should be compared against isn't
    // midnight-to-midnight -- it's 19:00-to-19:00: before 19:00 IST, the most recent
    // run (and therefore "today's" action) was still stamped with YESTERDAY's date;
    // only at/after 19:00 does a fresh run stamp today's date.
    private LocalDate effectiveSignalDate() {
        ZonedDateTime now = ZonedDateTime.now(ZoneId.of("Asia/Kolkata"));
        LocalDate date = now.toLocalDate();
        if (now.toLocalTime().isBefore(LocalTime.of(19, 0))) date = date.minusDays(1);
        return date;
    }

    // NSE cash session: 09:15-15:30 IST, Mon-Fri. Live-price the Swing tab's open
    // positions only inside that window -- outside it Upstox's intraday-candle feed
    // has nothing fresher to give us, so skip the network round-trip and let rows
    // keep their stored (19:00 runner) snapshot.
    private boolean isMarketHours() {
        ZonedDateTime now = ZonedDateTime.now(ZoneId.of("Asia/Kolkata"));
        if (now.getDayOfWeek() == DayOfWeek.SATURDAY || now.getDayOfWeek() == DayOfWeek.SUNDAY) return false;
        LocalTime t = now.toLocalTime();
        return !t.isBefore(LocalTime.of(9, 15)) && !t.isAfter(LocalTime.of(15, 30));
    }

    // Unlike the other 4 tabs, this reads straight from Postgres (this same
    // service) instead of a cross-branch GitHub read -- no cache needed, it's
    // already a fast local query.
    @GetMapping(value = "/api/dashboard/quarterly-results", produces = MediaType.APPLICATION_JSON_VALUE)
    public List<Map<String, Object>> quarterlyResults() {
        List<Map<String, Object>> results = quarterlyResultsService.recentResults(200);
        // RS Rank is attached LIVE here, always overwriting whatever was
        // persisted at announcement-processing time -- unlike revenue/profit/
        // margin/EPS (fixed historical facts about a specific quarter), RS
        // Rank is a day-to-day-changing attribute of the STOCK, not the
        // filing. Storing it once at record time created a real race: any
        // announcement processed before that day's RS-momentum batch run
        // (20:00-20:30 IST) got a permanently frozen null, confirmed live on
        // AWL 2026-07-30 (announced 11:47 UTC, that day's rank snapshot
        // didn't exist until ~11:55 UTC). Same "attach fresh, don't trust the
        // stored snapshot" pattern as attachForwardPerformance below.
        for (Map<String, Object> row : results) {
            Object symbol = row.get("symbol");
            if (symbol != null) row.put("rsRank", rsRankLookupService.rankFor(symbol.toString()));
        }
        return results;
    }

    // Companies whose results PDF/data COULDN'T be parsed -- previously these left no trace
    // anywhere, indistinguishable from "NSE just hasn't announced it yet". See
    // QuarterlyResultsService.recordFailure/clearFailures.
    @GetMapping(value = "/api/dashboard/quarterly-results-failures", produces = MediaType.APPLICATION_JSON_VALUE)
    public List<Map<String, Object>> quarterlyResultsFailures() {
        return quarterlyResultsService.recentFailures(200);
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

    // Reads rs_momentum_status (Postgres) instead of the old append-only
    // rs_momentum_log.json cross-branch read -- one row per symbol, upserted in place
    // by rs-momentum-strategy-live on every status change, so the same stock no longer
    // piles up duplicate rows across daily runs. See RsMomentumService.
    @GetMapping(value = "/api/dashboard/rs-momentum", produces = MediaType.APPLICATION_JSON_VALUE)
    public List<Map<String, Object>> rsMomentum() {
        List<Map<String, Object>> statuses = rsMomentumService.all();
        // "How did it do after we alerted it" (2026-07-28) -- a per-symbol rollup still
        // computed daily by server.js/forward_performance.js and pushed to the same
        // GitHub branch as before; only the log itself moved off GitHub, not this file.
        JsonNode perf = cachedRead("rs-momentum-perf", "data/rs-momentum-log", "rs-momentum-strategy/live/rs_momentum_forward_performance.json");
        attachForwardPerformanceToMaps(statuses, perf, "returnSinceEntry");
        return statuses;
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

    /** Same merge as attachForwardPerformance, for the rs-momentum-status Map rows (Postgres)
     * instead of JsonNode events (GitHub JSON logs) -- kept separate rather than converting
     * Maps to ObjectNode just to share one method. */
    private void attachForwardPerformanceToMaps(List<Map<String, Object>> rows, JsonNode perfArray, String returnFieldName) {
        if (perfArray == null || !perfArray.isArray()) return;
        Map<String, JsonNode> bySymbol = new HashMap<>();
        for (JsonNode row : perfArray) {
            bySymbol.put(row.path("symbol").asText(""), row);
        }
        for (Map<String, Object> row : rows) {
            JsonNode perf = bySymbol.get(String.valueOf(row.get("symbol")));
            if (perf == null) continue;
            if (perf.has("currentPrice") && !perf.get("currentPrice").isNull()) row.put("currentPrice", perf.get("currentPrice").asDouble());
            if (perf.has(returnFieldName) && !perf.get(returnFieldName).isNull()) row.put("returnSinceAlert", perf.get(returnFieldName).asDouble());
        }
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
