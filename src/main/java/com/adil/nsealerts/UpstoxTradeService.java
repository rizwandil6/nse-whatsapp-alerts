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
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.zip.GZIPInputStream;

/**
 * Upstox intraday trade execution service.
 *
 * Strategy (see TradeRules.java for the exact exit-decision logic, shared with
 * shadow-mode simulation so live and simulated trades can never drift apart):
 *   - Entry:          market buy immediately after AI rating ≥ 7
 *   - Partial exit:   sell 50% at +2% target
 *   - Trailing stop:  remaining 50% exits when (peak - current) ≥ 1%
 *   - Hard stop:      sell all remaining at -1.5% from entry
 *   - Time exit:      square off remaining at 45 min
 *   - NIFTY gate:     skip if NIFTY is down > 0.5% vs previous close
 *   - Circuit breaker:pause after 2 consecutive stop-losses
 *   - One LIVE trade at a time (AtomicReference guard). Shadow trades are NOT
 *     capital-constrained — every signal that can't go live still gets simulated
 *     concurrently, so the strategy's raw per-signal edge can be measured even
 *     while a real position is open, or while UPSTOX_ENABLED=false entirely.
 *
 * Pre-market signals (announcement rated before 09:15 IST) are queued and
 * retried at market open instead of being silently dropped — many order-win
 * disclosures are filed before the bell specifically because they move the
 * opening price, so trading hours alone was previously discarding some of the
 * highest-signal announcements.
 *
 * Requires Railway env var:
 *   UPSTOX_ACCESS_TOKEN  — refreshed daily before market open
 *   UPSTOX_ENABLED=true  — enable live trading (shadow-mode runs regardless,
 *                          see upstox.shadow-enabled)
 */
@Service
public class UpstoxTradeService {

    private static final Logger log = LoggerFactory.getLogger(UpstoxTradeService.class);

    // ─── Config (application.yml → upstox: section) ───────────────────────────
    @Value("${upstox.access-token:}")          private String  accessToken;
    @Value("${upstox.enabled:false}")           private boolean enabled;
    @Value("${upstox.shadow-enabled:true}")     private boolean shadowEnabled;
    @Value("${upstox.capital-per-trade:5000}")  private double  capitalPerTrade;
    @Value("${upstox.nifty-gate-pct:0.5}")     private double  niftyGatePct;
    @Value("${upstox.stop-loss-pct:1.5}")       private double  stopLossPct;
    @Value("${upstox.target-pct:2.0}")          private double  targetPct;
    @Value("${upstox.trail-pct:1.0}")           private double  trailPct;
    @Value("${upstox.time-exit-minutes:45}")    private int     timeExitMinutes;
    @Value("${upstox.circuit-breaker-limit:2}") private int     circuitBreakerLimit;

    private final TelegramSender telegram;
    private final TradeLog       tradeLog;
    private final ObjectMapper   mapper = new ObjectMapper();

    /** NSE trading symbol (upper-case) → Upstox instrument key, e.g. "NSE_EQ|INE040A01034" or "NSE_SM|INE..." */
    private final Map<String, String>          instrumentMap    = new ConcurrentHashMap<>();
    private final AtomicReference<ActiveTrade> activeTrade      = new AtomicReference<>();
    private final AtomicInteger                consecutiveStops = new AtomicInteger(0);

    /** Shadow (paper) positions — not capital-constrained, keyed by a unique id per signal. */
    private final Map<String, ActiveTrade> shadowTrades = new ConcurrentHashMap<>();

    /** Signals seen before market open, queued to retry exactly at 09:15 IST. */
    private final List<QueuedSignal> preMarketQueue = new CopyOnWriteArrayList<>();

    private record QueuedSignal(String symbol, int rating, long queuedAtMs) {}
    private record OrderFill(String status, double avgPrice, int filledQty) {}

    private static final ZoneId    IST              = ZoneId.of("Asia/Kolkata");
    private static final LocalTime MARKET_OPEN      = LocalTime.of(9, 15);
    private static final LocalTime MARKET_CLOSE     = LocalTime.of(15, 30);
    private static final String    BASE_URL         = "https://api.upstox.com/v2";
    private static final String    INSTRUMENTS_URL  =
            "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";
    private static final String    NIFTY_KEY        = "NSE_INDEX|Nifty 50";

    public UpstoxTradeService(TelegramSender telegram, TradeLog tradeLog) {
        this.telegram = telegram;
        this.tradeLog = tradeLog;
    }

    // ─── Startup: load NSE instruments into memory ────────────────────────────

    @PostConstruct
    void loadInstruments() {
        if (!enabled && !shadowEnabled) {
            log.info("[Upstox] Disabled (upstox.enabled=false, upstox.shadow-enabled=false) — skipping instrument load");
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
                        String segment = item.path("segment").asText("");
                        // Include both regular equity (NSE_EQ) and SME/emerge stocks (NSE_SM)
                        if (("NSE_EQ".equals(segment) || "NSE_SM".equals(segment))
                                && "EQ".equals(item.path("instrument_type").asText(""))) {
                            String sym  = item.path("trading_symbol").asText("").toUpperCase();
                            String key  = item.path("instrument_key").asText("");
                            String name = item.path("name").asText("").toUpperCase();
                            if (!sym.isBlank() && !key.isBlank()) {
                                instrumentMap.put(sym, key);   // e.g. "SSEGL" → "NSE_SM|INE..."
                                // Also index by first word of company name so NSE archive
                                // symbols (e.g. "SATHLOKHAR") can match "SATHLOKHAR SYNERGYS..."
                                if (!name.isBlank()) {
                                    String firstWord = name.split("[^A-Z0-9]")[0];
                                    if (firstWord.length() >= 4)
                                        instrumentMap.putIfAbsent(firstWord, key);
                                }
                                count++;
                            }
                        }
                    }
                }
                log.info("[Upstox] Loaded {} NSE EQ + SME instruments", count);
            } catch (Exception e) {
                log.error("[Upstox] Failed to load instruments: {}", e.getMessage());
            }
        }, "upstox-instrument-loader");
        t.setDaemon(true);
        t.start();
    }

    // ─── Entry point called by AlertPoller after rating ≥ 7 ──────────────────

    public void executeIfEligible(String nseSymbol, int rating) {
        if (!enabled && !shadowEnabled) return;
        if (accessToken == null || accessToken.isBlank()) {
            log.warn("[Upstox] No UPSTOX_ACCESS_TOKEN set — cannot trade or shadow-simulate {}", nseSymbol);
            return;
        }

        ZonedDateTime now   = ZonedDateTime.now(IST);
        DayOfWeek     day   = now.getDayOfWeek();
        boolean       isWeekday = day != DayOfWeek.SATURDAY && day != DayOfWeek.SUNDAY;

        if (isWeekday && now.toLocalTime().isBefore(MARKET_OPEN)) {
            // Pre-market announcements are common (boards often approve/disclose before
            // the bell) and previously just got dropped here. Queue instead — fired by
            // fireQueuedPreMarketSignals() at 09:15 IST.
            preMarketQueue.add(new QueuedSignal(nseSymbol.toUpperCase(), rating, System.currentTimeMillis()));
            log.info("[Upstox] {} queued — pre-market signal (rating {}), will attempt at 09:15 open", nseSymbol, rating);
            return;
        }
        if (!isMarketHours()) {
            log.info("[Upstox] {} skipped — outside market hours (post-close or weekend)", nseSymbol);
            return;
        }

        attemptEntry(nseSymbol.toUpperCase(), rating);
    }

    /** Fires at 09:15:05 IST on weekdays — drains any signals queued before the open. */
    @Scheduled(cron = "5 15 9 * * MON-FRI", zone = "Asia/Kolkata")
    void fireQueuedPreMarketSignals() {
        if (preMarketQueue.isEmpty()) return;

        // Safety net: only fire signals actually queued "today", in case the process
        // was up across a weekend/holiday edge case with something stale left over.
        long todayStartMs = LocalDate.now(IST).atStartOfDay(IST).toInstant().toEpochMilli();
        List<QueuedSignal> toFire = new ArrayList<>();
        for (QueuedSignal q : preMarketQueue) {
            if (q.queuedAtMs() >= todayStartMs) toFire.add(q);
        }
        preMarketQueue.clear();

        log.info("[Upstox] Market open — firing {} queued pre-market signal(s)", toFire.size());
        for (QueuedSignal q : toFire) {
            attemptEntry(q.symbol(), q.rating());
        }
    }

    /**
     * Resolves the instrument + a reference LTP once, then either places a real order
     * (if all live-eligibility gates pass) or starts a shadow simulation (if not, or if
     * upstox.enabled=false entirely). The two are independent of each other — a decline
     * reason for live trading doesn't block shadow simulation and vice versa.
     */
    private void attemptEntry(String nseSymbol, int rating) {
        String instrumentKey = instrumentMap.get(nseSymbol);
        if (instrumentKey == null) {
            instrumentKey = searchInstrumentKey(nseSymbol);
        }
        if (instrumentKey == null) {
            log.warn("[Upstox] Symbol '{}' not in instruments or search — skipping (live+shadow)", nseSymbol);
            return;
        }

        Double ltp = getLtp(instrumentKey);
        if (ltp == null || ltp <= 0) {
            log.warn("[Upstox] Could not fetch LTP for {} ({}) — skipping (live+shadow)", nseSymbol, instrumentKey);
            return;
        }

        String declineReason = liveDeclineReason();
        if (declineReason == null) {
            placeLiveEntry(nseSymbol, instrumentKey, ltp, rating);
        } else {
            log.info("[Upstox] {} not live-eligible ({}) — shadow-simulating instead", nseSymbol, declineReason);
            if (shadowEnabled) startShadow(nseSymbol, instrumentKey, ltp, rating, declineReason);
        }
    }

    /** Returns null if live trading is currently eligible, otherwise a human-readable reason it isn't. */
    private String liveDeclineReason() {
        if (!enabled) return "UPSTOX_ENABLED=false";

        ActiveTrade existing = activeTrade.get();
        if (existing != null) return "already in position: " + existing.symbol;

        int stops = consecutiveStops.get();
        if (stops >= circuitBreakerLimit) {
            telegram.send("⚠️ Upstox circuit breaker: paused after " + stops
                    + " consecutive stop-losses. Reset UPSTOX_ENABLED or restart to resume.");
            return stops + " consecutive stop-losses (circuit breaker)";
        }

        if (!niftyGateOk()) return "NIFTY gate (down > " + niftyGatePct + "%)";

        return null;
    }

    private void placeLiveEntry(String nseSymbol, String instrumentKey, double refLtp, int rating) {
        int qty = (int) Math.floor(capitalPerTrade / refLtp);
        if (qty < 1) {
            log.warn("[Upstox] Qty=0 for {} @₹{} — capital ₹{} too low for one lot",
                    nseSymbol, refLtp, capitalPerTrade);
            return;
        }

        String orderId = placeOrder(instrumentKey, qty, "BUY");
        if (orderId == null) {
            log.error("[Upstox] BUY order failed for {} — check token/margin", nseSymbol);
            return;
        }

        // Confirm the order actually filled instead of trusting the pre-order LTP
        // snapshot as the entry price — a market order into a fast-moving stock can
        // fill meaningfully worse than that, and a rejected order must not be tracked
        // as an open position.
        OrderFill fill = waitForFill(orderId);
        if (fill == null || !"complete".equalsIgnoreCase(fill.status())) {
            log.error("[Upstox] BUY {} orderId={} did not confirm as filled (status={}) — not tracking a position",
                    nseSymbol, orderId, fill == null ? "unknown/timeout" : fill.status());
            telegram.send(String.format(
                    "⚠️ BUY order for %s (id=%s) did not confirm filled (status=%s) — check Upstox manually.",
                    nseSymbol, orderId, fill == null ? "unknown/timeout" : fill.status()));
            return;
        }

        double entryPrice = fill.avgPrice() > 0 ? fill.avgPrice() : refLtp;
        int    filledQty  = fill.filledQty() > 0 ? fill.filledQty() : qty;

        ActiveTrade trade = new ActiveTrade(nseSymbol, instrumentKey, entryPrice, filledQty, orderId);
        activeTrade.set(trade);

        log.info("[Upstox] BUY {} qty={} entry=₹{} (fill-confirmed) orderId={}",
                nseSymbol, filledQty, entryPrice, orderId);
        telegram.send(String.format(
                "🟢 TRADE ENTRY: %s%nQty: %d @₹%.2f%nRating: %d/10%nTarget: +%.1f%% (50%%) | Stop: -%.1f%% (full)",
                nseSymbol, filledQty, entryPrice, rating, targetPct, stopLossPct));
        tradeLog.logEntry(false, nseSymbol, instrumentKey, rating, entryPrice, filledQty, orderId);
    }

    private void startShadow(String symbol, String instrumentKey, double ltp, int rating, String declineReason) {
        String shadowId = symbol + "#" + System.currentTimeMillis();
        ActiveTrade shadow = new ActiveTrade(symbol, instrumentKey, ltp, 1, "shadow");
        shadowTrades.put(shadowId, shadow);
        tradeLog.logEntry(true, symbol, instrumentKey, rating, ltp, 1, declineReason);
    }

    // ─── Position monitors — run every 3 s ─────────────────────────────────────

    @Scheduled(fixedDelay = 3000)
    public void monitorPosition() {
        ActiveTrade trade = activeTrade.get();
        if (trade == null) return;

        try {
            Double ltp = getLtp(trade.instrumentKey);
            if (ltp == null) return;

            double gainPct = (ltp - trade.entryPrice) / trade.entryPrice * 100.0;
            trade.maxGainPct = Math.max(trade.maxGainPct, gainPct);
            long ageMin = (System.currentTimeMillis() - trade.entryTimeMs) / 60_000L;

            TradeRules.Decision decision = TradeRules.decide(ruleParams(), gainPct, trade.maxGainPct,
                    trade.partialExitDone, ageMin);

            switch (decision.action()) {
                case TIME_EXIT, HARD_STOP, TRAIL_STOP ->
                        exit(trade, ltp, emojiFor(decision.action()) + " " + decision.reason());
                case PARTIAL_EXIT -> doPartialExit(trade, ltp, gainPct);
                case HOLD -> { /* no-op */ }
            }
        } catch (Exception e) {
            log.error("[Upstox] monitorPosition error for {}: {}", trade.symbol, e.getMessage());
        }
    }

    /** Same exit rules, applied to unconstrained paper positions — no order placement, just logging. */
    @Scheduled(fixedDelay = 3000)
    public void monitorShadowPositions() {
        if (shadowTrades.isEmpty()) return;

        for (Map.Entry<String, ActiveTrade> entry : shadowTrades.entrySet()) {
            ActiveTrade trade = entry.getValue();
            try {
                Double ltp = getLtp(trade.instrumentKey);
                if (ltp == null) continue;

                double gainPct = (ltp - trade.entryPrice) / trade.entryPrice * 100.0;
                trade.maxGainPct = Math.max(trade.maxGainPct, gainPct);
                long ageMin = (System.currentTimeMillis() - trade.entryTimeMs) / 60_000L;

                TradeRules.Decision decision = TradeRules.decide(ruleParams(), gainPct, trade.maxGainPct,
                        trade.partialExitDone, ageMin);

                switch (decision.action()) {
                    case TIME_EXIT, HARD_STOP, TRAIL_STOP -> {
                        tradeLog.logExit(true, trade.symbol, decision.reason(), ltp, gainPct);
                        shadowTrades.remove(entry.getKey());
                    }
                    case PARTIAL_EXIT -> {
                        trade.partialExitDone = true;
                        tradeLog.logPartialExit(true, trade.symbol, ltp, gainPct);
                    }
                    case HOLD -> { /* no-op */ }
                }
            } catch (Exception e) {
                log.error("[Upstox] monitorShadowPositions error for {}: {}", trade.symbol, e.getMessage());
            }
        }
    }

    private TradeRules.Params ruleParams() {
        return new TradeRules.Params(targetPct, stopLossPct, trailPct, timeExitMinutes);
    }

    private String emojiFor(TradeRules.Action action) {
        return switch (action) {
            case TIME_EXIT -> "⏱";
            case HARD_STOP -> "🔴";
            case TRAIL_STOP -> "📉";
            default -> "";
        };
    }

    private void doPartialExit(ActiveTrade trade, double ltp, double gainPct) {
        int halfQty = trade.totalQty / 2;
        if (halfQty < 1) halfQty = 1; // edge case: qty=1 → sell all and close
        String oid = placeOrder(trade.instrumentKey, halfQty, "SELL");
        if (oid == null) return;

        trade.partialExitDone = true;
        trade.remainingQty    = trade.totalQty - halfQty;
        consecutiveStops.set(0); // reaching target resets circuit breaker

        log.info("[Upstox] Partial exit {} qty={} @₹{} +{}%",
                trade.symbol, halfQty, ltp, String.format("%.2f", gainPct));
        telegram.send(String.format(
                "🟡 PARTIAL EXIT: %s%nSold %d/%d @~₹%.2f (+%.2f%%)%nHolding %d with 1%% trailing stop",
                trade.symbol, halfQty, trade.totalQty, ltp, gainPct, trade.remainingQty));
        tradeLog.logPartialExit(false, trade.symbol, ltp, gainPct);

        if (trade.remainingQty <= 0) {
            activeTrade.set(null);
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
        tradeLog.logExit(false, trade.symbol, reason, ltp, gainPct);
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
        String encoded;
        try {
            encoded = URLEncoder.encode(instrumentKey, StandardCharsets.UTF_8);
        } catch (Exception e) {
            log.warn("[Upstox] getLtp encode error: {}", e.getMessage());
            return null;
        }

        // Attempt 1 — fast LTP endpoint
        Double ltp = fetchLtpEndpoint(encoded, null);
        if (ltp != null) return ltp;

        // Attempt 2 — retry after 300ms (covers transient quote gaps)
        try { Thread.sleep(300); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); return null; }
        ltp = fetchLtpEndpoint(encoded, null);
        if (ltp != null) return ltp;

        // Attempt 3 — fallback to full quotes endpoint
        ltp = fetchQuotesEndpoint(encoded, null);
        if (ltp != null) {
            log.info("[Upstox] LTP for {} resolved via quotes fallback: {}", instrumentKey, ltp);
        } else {
            log.warn("[Upstox] Could not fetch LTP for {} after ltp×2 + quotes fallback", instrumentKey);
        }
        return ltp;
    }

    private Double fetchLtpEndpoint(String encodedKey, String ignoredKey) {
        try {
            String json = get(BASE_URL + "/market-quote/ltp?instrument_key=" + encodedKey);
            if (json == null) return null;
            // Upstox keys the response by trading symbol ("NSE_EQ:SOLEX"), NOT by ISIN.
            // Never do instrumentKey.replace("|",":") — just take the first entry in data.
            return firstLastPrice(mapper.readTree(json).path("data"));
        } catch (Exception e) {
            log.warn("[Upstox] fetchLtpEndpoint error: {}", e.getMessage());
            return null;
        }
    }

    private Double fetchQuotesEndpoint(String encodedKey, String ignoredKey) {
        try {
            String json = get(BASE_URL + "/market-quote/quotes?instrument_key=" + encodedKey);
            if (json == null) return null;
            return firstLastPrice(mapper.readTree(json).path("data"));
        } catch (Exception e) {
            log.warn("[Upstox] fetchQuotesEndpoint error: {}", e.getMessage());
            return null;
        }
    }

    /**
     * Extracts last_price from the first entry in an Upstox "data" node.
     * Upstox keys the response by trading symbol ("NSE_EQ:SOLEX"), not by the
     * instrument_key ISIN we used in the request — so we must not hard-code the key.
     */
    private Double firstLastPrice(JsonNode data) {
        if (data == null || data.isMissingNode() || !data.fields().hasNext()) return null;
        double ltp = data.fields().next().getValue().path("last_price").asDouble(0);
        return ltp > 0 ? ltp : null;
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

    /**
     * Polls GET /v2/order/details up to ~4s (8 x 500ms) for a terminal status
     * (complete/rejected/cancelled) after placing an order, so callers use the
     * actual fill price/qty instead of trusting a pre-order LTP snapshot.
     * Returns null if no terminal status was reached in time — caller must treat
     * that as "unconfirmed", not as a silent success.
     */
    private OrderFill waitForFill(String orderId) {
        for (int i = 0; i < 8; i++) {
            try {
                String json = get(BASE_URL + "/order/details?order_id="
                        + URLEncoder.encode(orderId, StandardCharsets.UTF_8));
                if (json != null) {
                    JsonNode data   = mapper.readTree(json).path("data");
                    String   status = data.path("status").asText("");
                    if ("complete".equalsIgnoreCase(status)
                            || "rejected".equalsIgnoreCase(status)
                            || "cancelled".equalsIgnoreCase(status)) {
                        return new OrderFill(status, data.path("average_price").asDouble(0),
                                data.path("filled_quantity").asInt(0));
                    }
                }
            } catch (Exception e) {
                log.warn("[Upstox] waitForFill({}) error: {}", orderId, e.getMessage());
            }
            try { Thread.sleep(500); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); break; }
        }
        log.warn("[Upstox] waitForFill({}) — no terminal status after retries", orderId);
        return null;
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
     * Upstox v2 has no instrument search API endpoint.
     * Instead, loadInstruments() indexes both the trading symbol AND the first word of
     * the company name so NSE archive symbols (e.g. "SATHLOKHAR") can match the
     * Upstox trading symbol (e.g. "SSEGL") via the company name field.
     * If still not found, log a clear message so the operator knows to check the mapping.
     */
    private String searchInstrumentKey(String query) {
        log.warn("[Upstox] '{}' not in instrument map (NSE archive symbol ≠ Upstox trading symbol). " +
                 "Company name index also missed — add manual alias if needed.", query);
        return null;
    }

    /** True if current IST time is a weekday between 09:15 and 15:30. */
    private boolean isMarketHours() {
        ZonedDateTime now = ZonedDateTime.now(IST);
        DayOfWeek day     = now.getDayOfWeek();
        LocalTime time    = now.toLocalTime();
        return day != DayOfWeek.SATURDAY && day != DayOfWeek.SUNDAY
                && !time.isBefore(MARKET_OPEN) && !time.isAfter(MARKET_CLOSE);
    }

    // ─── Active trade state (used for both live and shadow positions) ─────────

    static class ActiveTrade {
        final String  symbol;
        final String  instrumentKey;
        final double  entryPrice;   // live: fill-confirmed avg price. shadow: LTP at signal time.
        final int     totalQty;
        final String  buyOrderId;   // live: real Upstox order id. shadow: "shadow".
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
