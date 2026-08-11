package com.adil.nsealerts;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Live last-traded prices for the Swing tab's OPEN positions, so `since alert %`
 * tracks the current price instead of the frozen 19:00 snapshot. Uses the PUBLIC
 * Upstox intraday-candle endpoint (no token) -- the newest 1-minute close ~= live
 * (about a minute delayed). Results are cached 60s so repeated dashboard loads /
 * tab switches don't hammer Upstox (~39 open symbols max). Never throws: on any
 * failure a symbol is simply omitted and the caller keeps the stored snapshot.
 *
 * The symbol -> instrument_key map is bundled from swing-symbols.json (a copy of
 * the runner's swing-strategy/live/symbols.json -- keep the two in sync if the
 * halal universe changes).
 */
@Component
public class SwingLivePriceService {

    private static final String BASE = "https://api.upstox.com/v2/historical-candle/intraday/";
    private static final long CACHE_TTL_MS = 60_000;

    private final Map<String, String> keyBySymbol = new HashMap<>();
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private final ObjectMapper mapper = new ObjectMapper();
    private final ExecutorService pool = Executors.newFixedThreadPool(8, r -> {
        Thread t = new Thread(r, "swing-live-price");
        t.setDaemon(true);
        return t;
    });

    private volatile Map<String, Double> cache = Collections.emptyMap();
    private volatile long cacheAt = 0;

    public SwingLivePriceService() {
        try {
            JsonNode node = mapper.readTree(new ClassPathResource("swing-symbols.json").getInputStream());
            node.fields().forEachRemaining(e -> keyBySymbol.put(e.getKey(), e.getValue().asText()));
        } catch (Exception e) {
            System.err.println("SwingLivePriceService: could not load swing-symbols.json -- live prices disabled: " + e.getMessage());
        }
    }

    /** Live last price per symbol (only those we could fetch). Cached 60s. Never throws. */
    public Map<String, Double> pricesFor(Collection<String> symbols) {
        long now = System.currentTimeMillis();
        Map<String, Double> cached = cache;
        if (now - cacheAt < CACHE_TTL_MS && cached.keySet().containsAll(symbols)) return cached;

        Map<String, Double> out = new ConcurrentHashMap<>(cached); // keep any still-useful entries
        List<Callable<Void>> tasks = new ArrayList<>();
        for (String sym : new HashSet<>(symbols)) {
            String key = keyBySymbol.get(sym);
            if (key == null) continue;
            tasks.add(() -> { Double p = fetchLast(key); if (p != null) out.put(sym, p); return null; });
        }
        try {
            pool.invokeAll(tasks, 8, TimeUnit.SECONDS);
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
        }
        cache = out;
        cacheAt = now;
        return out;
    }

    private Double fetchLast(String instrumentKey) {
        try {
            String url = BASE + URLEncoder.encode(instrumentKey, StandardCharsets.UTF_8) + "/1minute";
            HttpRequest req = HttpRequest.newBuilder(URI.create(url))
                    .header("Accept", "application/json")
                    .timeout(Duration.ofSeconds(6))
                    .GET().build();
            HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() != 200) return null;
            JsonNode candles = mapper.readTree(res.body()).path("data").path("candles");
            if (!candles.isArray() || candles.isEmpty()) return null;
            return candles.get(0).get(4).asDouble(); // newest-first; row = [ts, o, h, l, c, v, oi]
        } catch (Exception e) {
            return null;
        }
    }
}
