package com.adil.nsealerts;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.zip.GZIPInputStream;

/**
 * Upstox intraday trade execution service.
 *
 * Strategy (confirmed via backtest on June 2026 data, 44 intraday trades):
 *   - Entry:          market buy immediately after AI rating ≥ 7
 *   - Partial exit:   sell 50% at +2% target
 *   - Trailing stop:  remaining 50% exits when (peak - current) ≥ 1%
 *   - Hard stop:      sell all remaining at -1.5% from entry
 *   - Time exit:      square off remaining at 45 min
 *   - NIFTY gate:     skip if NIFTY is down > 0.5% vs previous close
 *   - Circuit breaker:pause after 2 consecutive stop-losses
 *   - One trade at a time (AtomicReference guard)
 *
 * Requires Railway env var:
 *   UPSTOX_ACCESS_TOKEN  — refreshed daily before market open
 *   UPSTOX_ENABLED=true  — enable live trading
 */
@Service
public class UpstoxTradeService {

    private static final Logger log = LoggerFactory.getLogger(UpstoxTradeService.class);

    // ─── Config (application.yml → upstox: section) ───────────────────────────
    @Value("${upstox.access-token:}")          private String  accessToken;
    @Value("${upstox.enabled:false}")           private boolean enabled;
    @Value("${upstox.capital-per-trade:5000}")  private double  capitalPerTrade;
    @Value("${upstox.nifty-gate-pct:0.5}")     private double  niftyGatePct;
    @Value("${upstox.stop-loss-pct:1.5}")       private double  stopLossPct;
    @Value("${upstox.target-pct:2.0}")          private double  targetPct;
    @Value("${upstox.trail-pct:1.0}")           private double  trailPct;
    @Value("${upstox.time-exit-minutes:45}")    private int     timeExitMinutes;
    @Value("${upstox.circuit-breaker-limit:2}") private int     circuitBreakerLimit;

    private final TelegramSender telegram;
    private final ObjectMapper   mapper = new ObjectMapper();

    /** NSE trading symbol (upper-case) → Upstox instrument key, e.g. "NSE_EQ|INE040A01034" */
    private final Map<String, String>          instrumentMap    = new ConcurrentHashMap<>();
    private final AtomicReference<ActiveTrade> activeTrade      = new AtomicReference<>();
    private final AtomicInteger                consecutiveStops = new AtomicInteger(0);

    private static final ZoneId    IST              = ZoneId.of("Asia/Kolkata");
    private static final LocalTime MARKET_OPEN      = LocalTime.of(9, 15);
    private static final LocalTime MARKET_CLOSE     = LocalTime.of(15, 30);
    private static final String    BASE_URL         = "https://api.upstox.com/v2";
    private static final String    INSTRUMENTS_URL  =
            "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";
    private static final String    NIFTY_KEY        = "NSE_INDEX|Nifty 50";

    public UpstoxTradeService(TelegramSender telegram) {
        this.telegram = telegram;
    }

    // ─── Startup: load NSE instruments into memory ────────────────────────────

    @PostConstruct
    void loadInstruments() {
        if (!enabled) {
            log.info("[Upstox] Disabled (upstox.enabled=false) — skipping instrument load");
            return;
        }
        Thread t = new Thread(() -> {
            try {
                log.info("[Upstox] Loading instruments from Upstox CDN...");
                HttpURLConnection conn = (HttpURLConnection) new URL(INSTRUMENTS_URL).openConnection();
                conn.setConnectTimeout(20_000);
                conn.setReadTimeout(60_000);
                // Stream one object at a time — avoids loading 150MB+ JSON tree into heap
                int count = 0;
                try (InputStream raw = conn.getInputStream();
                     GZIPInputStream gz = new GZIPInputStream(raw);
                     JsonParser parser = mapper.getFactory().createParser(gz)) {

                    if (parser.nextToken() != JsonToken.START_ARRAY) {
                        log.warn("[Upstox] Instruments response is not a JSON array");
                        return;
                    }
                    while (parser.nextToken() == JsonToken.START_OBJECT) {
                        JsonNode item = mapper.readTree(parser); // reads ONE object, not the whole array
                        if ("NSE_EQ".equals(item.path("segment").asText(""))
                                && "EQ".equals(item.path("instrument_type").asText(""))) {
                            String sym = item.path("trading_symbol").asText("").toUpperCase();
                            String key = item.path("instrument_key").asText("");
                            if (!sym.isBlank() && !key.isBlank()) {
                                instrumentMap.put(sym, key);
                                count++;
                            }
                        }
                    }
                }
                log.info("[Upstox] Loaded {} NSE EQ instruments", count);
            } catch (Exception e) {
                log.error("[Upstox] Failed to load instruments: {}", e.getMessage());
            }
        }, "upstox-instrument-loader");
        t.setDaemon(true);
        t.start();
    }

    // ─── Entry point called by AlertPoller after rating ≥ 7 ──────────────────

    public void executeIfEligible(String nseSymbol, int rating) {
        if (!enabled) return;

        if (accessToken == null || accessToken.isBlank()) {
            log.warn("[Upstox] No UPSTOX_ACCESS_TOKEN set — cannot trade {}", nseSymbol);
            return;
        }
        if (!isMarketHours()) {
            log.info("[Upstox] {} skipped — outside market hours", nseSymbol);
            return;
        }

        ActiveTrade existing = activeTrade.get();
        if (existing != null) {
            log.info("[Upstox] {} skipped — already in position: {}", nseSymbol, existing.symbol);
            return;
        }

        int stops = consecutiveStops.get();
        if (stops >= circuitBreakerLimit) {
            log.warn("[Upstox] Circuit breaker active ({} consecutive stops) — skipping {}", stops, nseSymbol);
            telegram.send("⚠️ Upstox circuit breaker: paused after " + stops
                    + " consecutive stop-losses. Reset UPSTOX_ENABLED or restart to resume.");
            return;
        }

        if (!niftyGateOk()) {
            log.info("[Upstox] {} skipped — NIFTY gate (down > {}%)", nseSymbol, niftyGatePct);
            return;
        }

        String instrumentKey = instrumentMap.get(nseSymbol.toUpperCase());
        if (instrumentKey == null) {
            // NSE archive symbol may differ from Upstox trading symbol — try search fallback
            instrumentKey = searchInstrumentKey(nseSymbol);
            if (instrumentKey == null) {
                log.warn("[Upstox] Symbol '{}' not in instruments or search — skipping", nseSymbol);
                return;
            }
        }

        Double ltp = getLtp(instrumentKey);
        if (ltp == null || ltp <= 0) {
            log.warn("[Upstox] Could not fetch LTP for {} ({})", nseSymbol, instrumentKey);
            return;
        }

        int qty = (int) Math.floor(capitalPerTrade / ltp);
        if (qty < 1) {
            log.warn("[Upstox] Qty=0 for {} @₹{} — capital ₹{} too low for one lot",
                    nseSymbol, ltp, capitalPerTrade);
            return;
        }

        String orderId = placeOrder(instrumentKey, qty, "BUY");
        if (orderId == null) {
            log.error("[Upstox] BUY order failed for {} — check token/margin", nseSymbol);
            return;
        }

        ActiveTrade trade = new ActiveTrade(nseSymbol, instrumentKey, ltp, qty, orderId);
        activeTrade.set(trade);

        log.info("[Upstox] BUY {} qty={} entry~₹{} orderId={}", nseSymbol, qty, ltp, orderId);
        telegram.send(String.format(
                "🟢 TRADE ENTRY: %s%nQty: %d @~₹%.2f%nRating: %d/10%nTarget: +%.1f%% (50%%) | Stop: -%.1f%% (full)",
                nseSymbol, qty, ltp, rating, targetPct, stopLossPct));
    }

    // ─── Position monitor — runs every 3 s while a trade is active ────────────

    @Scheduled(fixedDelay = 3000)
    public void monitorPosition() {
        ActiveTrade trade = activeTrade.get();
        if (trade == null) return;

        try {
            Double ltp = getLtp(trade.instrumentKey);
            if (ltp == null) return;

            double gainPct = (ltp - trade.entryPrice) / trade.entryPrice * 100.0;
            trade.maxGainPct = Math.max(trade.maxGainPct, gainPct);

            // 1. Time exit — always square off before market close
            long ageMin = (System.currentTimeMillis() - trade.entryTimeMs) / 60_000L;
            if (ageMin >= timeExitMinutes) {
                exit(trade, ltp, String.format("⏱ Time exit (%d min)", timeExitMinutes));
                return;
            }

            // 2. Hard stop — full position, any time
            if (gainPct <= -stopLossPct) {
                exit(trade, ltp, String.format("🔴 Stop-loss (%.2f%%)", gainPct));
                return;
            }

            // 3. Partial exit at target (+2%) — sell first half
            if (!trade.partialExitDone && gainPct >= targetPct) {
                int halfQty = trade.totalQty / 2;
                if (halfQty < 1) halfQty = 1; // edge case: qty=1 → sell all and close
                String oid = placeOrder(trade.instrumentKey, halfQty, "SELL");
                if (oid != null) {
                    trade.partialExitDone = true;
                    trade.remainingQty    = trade.totalQty - halfQty;
                    consecutiveStops.set(0); // reaching target resets circuit breaker
                    log.info("[Upstox] Partial exit {} qty={} @₹{} +{}%",
                            trade.symbol, halfQty, ltp, String.format("%.2f", gainPct));
                    telegram.send(String.format(
                            "🟡 PARTIAL EXIT: %s%nSold %d/%d @~₹%.2f (+%.2f%%)%nHolding %d with 1%% trailing stop",
                            trade.symbol, halfQty, trade.totalQty, ltp, gainPct, trade.remainingQty));
                    if (trade.remainingQty <= 0) {
                        activeTrade.set(null);
                    }
                }
                return;
            }

            // 4. Trailing stop on remaining qty (active only after partial exit)
            //    Triggers when price drops ≥ 1% below the session peak
            if (trade.partialExitDone && trade.maxGainPct >= trailPct) {
                double trailTrigger = trade.maxGainPct - trailPct;
                if (gainPct <= trailTrigger) {
                    exit(trade, ltp, String.format("📉 Trail stop (peak:+%.2f%% → now:+%.2f%%)",
                            trade.maxGainPct, gainPct));
                }
            }

        } catch (Exception e) {
            log.error("[Upstox] monitorPosition error for {}: {}", trade != null ? trade.symbol : "?", e.getMessage());
        }
    }

    // ─── Close the remaining position and notify ──────────────────────────────

    private void exit(ActiveTrade trade, double ltp, String reason) {
        activeTrade.set(null); // clear first to prevent double-sell races

        int qty = trade.remainingQty;
        if (qty <= 0) return;

        placeOrder(trade.instrumentKey, qty, "SELL");

        double gainPct = (ltp - trade.entryPrice) / trade.entryPrice * 100.0;
        double pnl     = qty * trade.entryPrice * gainPct / 100.0;

        // Circuit breaker: track consecutive unprofitable exits
        if (gainPct > 0) consecutiveStops.set(0);
        else             consecutiveStops.incrementAndGet();

        String emoji = gainPct >= 0 ? "✅" : "❌";
        log.info("[Upstox] EXIT {} qty={} @₹{} ({}) pnl=₹{}",
                trade.symbol, qty, ltp, reason, String.format("%.0f", pnl));
        telegram.send(String.format(
                "%s EXIT: %s%n%s%n@~₹%.2f (%+.2f%%)%nP&L on exit lot: ₹%+.0f",
                emoji, trade.symbol, reason, ltp, gainPct, pnl));
    }

    // ─── Upstox API helpers ───────────────────────────────────────────────────

    /** Returns false if NIFTY is down > niftyGatePct% vs yesterday's close. Fails open. */
    private boolean niftyGateOk() {
        try {
            String encoded = URLEncoder.encode(NIFTY_KEY, StandardCharsets.UTF_8);
            String json    = get(BASE_URL + "/market-quote/quotes?instrument_key=" + encoded);
            if (json == null) return true; // fail open if API unreachable
            // Response key uses ":" separator instead of "|"
            JsonNode nifty    = mapper.readTree(json).path("data").path("NSE_INDEX:Nifty 50");
            double   ltp      = nifty.path("last_price").asDouble(0);
            double   prevClose= nifty.path("ohlc").path("close").asDouble(0);
            if (ltp <= 0 || prevClose <= 0) return true;
            double changePct = (ltp - prevClose) / prevClose * 100.0;
            if (changePct <= -niftyGatePct) {
                log.info("[Upstox] NIFTY gate blocked: {}%", String.format("%.2f", changePct));
                return false;
            }
            return true;
        } catch (Exception e) {
            log.warn("[Upstox] NIFTY gate error (fail open): {}", e.getMessage());
            return true;
        }
    }

    /**
     * Fetch last traded price for an instrument key.
     * Strategy:
     *   1. Try /market-quote/ltp (fast, lightweight)
     *   2. If data gap (returns 0), wait 300ms and retry once — covers brief quote gaps
     *      during rapid price moves (as seen with SOLEX spike)
     *   3. If still null, fall back to /market-quote/quotes (heavier but more reliable)
     * Returns null only if all three attempts fail.
     */
    private Double getLtp(String instrumentKey) {
        String dataKey = instrumentKey.replace("|", ":");
        String encoded;
        try {
            encoded = URLEncoder.encode(instrumentKey, StandardCharsets.UTF_8);
        } catch (Exception e) {
            log.warn("[Upstox] getLtp encode error: {}", e.getMessage());
            return null;
        }

        // Attempt 1 — fast LTP endpoint
        Double ltp = fetchLtpEndpoint(encoded, dataKey);
        if (ltp != null) return ltp;

        // Attempt 2 — retry after 300ms (brief quote data gap)
        try { Thread.sleep(300); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); return null; }
        ltp = fetchLtpEndpoint(encoded, dataKey);
        if (ltp != null) return ltp;

        // Attempt 3 — fallback to full quotes endpoint (more reliable, includes OHLC)
        ltp = fetchQuotesEndpoint(encoded, dataKey);
        if (ltp != null) {
            log.info("[Upstox] LTP for {} resolved via quotes fallback: {}", instrumentKey, ltp);
        } else {
            log.warn("[Upstox] Could not fetch LTP for {} after ltp×2 + quotes fallback", instrumentKey);
        }
        return ltp;
    }

    private Double fetchLtpEndpoint(String encodedKey, String dataKey) {
        try {
            String json = get(BASE_URL + "/market-quote/ltp?instrument_key=" + encodedKey);
            if (json == null) return null;
            double ltp = mapper.readTree(json).path("data").path(dataKey)
                               .path("last_price").asDouble(0);
            return ltp > 0 ? ltp : null;
        } catch (Exception e) {
            log.warn("[Upstox] fetchLtpEndpoint error: {}", e.getMessage());
            return null;
        }
    }

    private Double fetchQuotesEndpoint(String encodedKey, String dataKey) {
        try {
            String json = get(BASE_URL + "/market-quote/quotes?instrument_key=" + encodedKey);
            if (json == null) return null;
            double ltp = mapper.readTree(json).path("data").path(dataKey)
                               .path("last_price").asDouble(0);
            return ltp > 0 ? ltp : null;
        } catch (Exception e) {
            log.warn("[Upstox] fetchQuotesEndpoint error: {}", e.getMessage());
            return null;
        }
    }

    /** Place a market order. Returns orderId on success, null on failure. */
    private String placeOrder(String instrumentKey, int qty, String txnType) {
        try {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("quantity",           qty);
            body.put("product",            "I");          // I = Intraday (MIS)
            body.put("validity",           "DAY");
            body.put("price",              0);
            body.put("tag",                "NSE_ALERTS");
            body.put("instrument_token",   instrumentKey); // same value as instrument_key
            body.put("order_type",         "MARKET");
            body.put("transaction_type",   txnType);       // "BUY" or "SELL"
            body.put("disclosed_quantity", 0);
            body.put("trigger_price",      0);
            body.put("is_amo",             false);

            String json    = post(BASE_URL + "/order/place", mapper.writeValueAsString(body));
            if (json == null) return null;
            String orderId = mapper.readTree(json).path("data").path("order_id").asText(null);
            log.info("[Upstox] {} {} qty={} → orderId={}", txnType, instrumentKey, qty, orderId);
            return orderId;
        } catch (Exception e) {
            log.error("[Upstox] placeOrder {} {} qty={} error: {}", txnType, instrumentKey, qty, e.getMessage());
            return null;
        }
    }

    /** HTTP GET with Bearer auth. Returns response body string, or null on non-200. */
    private String get(String urlStr) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
        conn.setRequestProperty("Authorization", "Bearer " + accessToken);
        conn.setRequestProperty("Accept",        "application/json");
        conn.setConnectTimeout(5_000);
        conn.setReadTimeout(5_000);
        int code = conn.getResponseCode();
        if (code != 200) {
            log.warn("[Upstox] GET {} → HTTP {}", urlStr, code);
            return null;
        }
        try (InputStream is = conn.getInputStream()) {
            return new String(is.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    /** HTTP POST with Bearer auth and JSON body. Returns response body, or null on error. */
    private String post(String urlStr, String bodyJson) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
        conn.setRequestMethod("POST");
        conn.setRequestProperty("Authorization", "Bearer " + accessToken);
        conn.setRequestProperty("Content-Type",  "application/json");
        conn.setRequestProperty("Accept",        "application/json");
        conn.setConnectTimeout(5_000);
        conn.setReadTimeout(5_000);
        conn.setDoOutput(true);
        conn.getOutputStream().write(bodyJson.getBytes(StandardCharsets.UTF_8));
        int code = conn.getResponseCode();
        if (code < 200 || code >= 300) {
            log.warn("[Upstox] POST {} → HTTP {}", urlStr, code);
            return null;
        }
        try (InputStream is = conn.getInputStream()) {
            return new String(is.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    /**
     * Fallback when the NSE archive symbol (from PDF link) doesn't match the Upstox trading symbol.
     * Calls Upstox instrument search and returns the first NSE_EQ match, caching it in instrumentMap.
     */
    private String searchInstrumentKey(String query) {
        try {
            String encoded = URLEncoder.encode(query, StandardCharsets.UTF_8);
            String json = get(BASE_URL + "/market-quote/search?q=" + encoded + "&asset_type=shares");
            if (json == null) return null;
            JsonNode dataArr = mapper.readTree(json).path("data");
            for (JsonNode item : dataArr) {
                if ("NSE_EQ".equals(item.path("segment").asText(""))) {
                    String key = item.path("instrument_key").asText("");
                    String sym = item.path("trading_symbol").asText("");
                    if (!key.isBlank()) {
                        // Cache so subsequent polls for same symbol skip the search
                        instrumentMap.put(query.toUpperCase(), key);
                        if (!sym.isBlank()) instrumentMap.put(sym.toUpperCase(), key);
                        log.info("[Upstox] Resolved '{}' → {} ({}) via search", query, sym, key);
                        return key;
                    }
                }
            }
            return null;
        } catch (Exception e) {
            log.warn("[Upstox] searchInstrumentKey('{}') error: {}", query, e.getMessage());
            return null;
        }
    }

    /** True if current IST time is a weekday between 09:15 and 15:30. */
    private boolean isMarketHours() {
        ZonedDateTime now = ZonedDateTime.now(IST);
        DayOfWeek day     = now.getDayOfWeek();
        LocalTime time    = now.toLocalTime();
        return day != DayOfWeek.SATURDAY && day != DayOfWeek.SUNDAY
                && !time.isBefore(MARKET_OPEN) && !time.isAfter(MARKET_CLOSE);
    }

    // ─── Active trade state ───────────────────────────────────────────────────

    static class ActiveTrade {
        final String  symbol;
        final String  instrumentKey;
        final double  entryPrice;   // LTP at order time (market order → estimate)
        final int     totalQty;
        final String  buyOrderId;
        final long    entryTimeMs   = System.currentTimeMillis();

        volatile int     remainingQty;
        volatile double  maxGainPct    = 0;    // highest gain% seen since entry
        volatile boolean partialExitDone = false;

        ActiveTrade(String symbol, String instrumentKey, double entryPrice, int qty, String buyOrderId) {
            this.symbol        = symbol;
            this.instrumentKey = instrumentKey;
            this.entryPrice    = entryPrice;
            this.totalQty      = qty;
            this.remainingQty  = qty;
            this.buyOrderId    = buyOrderId;
        }
    }
}
