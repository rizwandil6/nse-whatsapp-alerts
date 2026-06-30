package com.adil.nsealerts;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.rometools.rome.feed.synd.SyndEntry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.env.Environment;
import org.springframework.http.*;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;
// HTTP_CLIENT (java.net.http) used for Yahoo Finance requests (avoids RestTemplate double-encoding of ^ and =)

import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.*;

@Service
public class MarketBulletinService {

    private static final Logger logger = LoggerFactory.getLogger(MarketBulletinService.class);

    private static final String YAHOO_URL =
            "https://query1.finance.yahoo.com/v8/finance/chart/%s?interval=%s&range=%s";
    private static final String USER_AGENT = "Mozilla/5.0";

    private final TelegramSender telegramSender;
    private final NseClient nseClient;
    private final RestTemplate restTemplate = new RestTemplate();
    private final ObjectMapper mapper = new ObjectMapper();
    private final List<String> watchlist;
    private final String anthropicApiKey;

    public MarketBulletinService(TelegramSender telegramSender,
                                  NseClient nseClient,
                                  Environment env) {
        this.telegramSender = telegramSender;
        this.nseClient = nseClient;
        this.anthropicApiKey = env.getProperty("anthropic.api-key", "");

        List<String> wl = new ArrayList<>();
        int i = 0;
        String sym;
        while ((sym = env.getProperty("bulletin.watchlist[" + i + "]")) != null) {
            wl.add(sym.trim());
            i++;
        }
        this.watchlist = wl;
        logger.info("[Bulletin] Loaded {} watchlist symbols", wl.size());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Entry point
    // ─────────────────────────────────────────────────────────────────────────

    public void buildAndSend() {
        logger.info("[Bulletin] Building daily market bulletin...");
        try {
            List<SyndEntry> rssEntries = nseClient.fetchAnnouncements();
            String fiiJson = nseClient.fetchFiiDii();

            StringBuilder sb = new StringBuilder();

            // Header
            sb.append("Daily Market Bulletin\n");
            sb.append("Date: ").append(LocalDate.now()).append("\n");
            sb.append("---\n\n");

            // US Markets
            sb.append("US Markets (Latest Close)\n");
            sb.append(indexLine("Dow Jones",  "^DJI")).append("\n");
            sb.append(indexLine("S&P 500",    "^GSPC")).append("\n");
            sb.append(indexLine("Nasdaq",     "^IXIC")).append("\n\n");

            // Asian Markets
            sb.append("Asian Markets\n");
            sb.append(indexLine("Nikkei 225 (JP)",  "^N225")).append("\n");
            sb.append(indexLine("Hang Seng (HK)",   "^HSI")).append("\n");
            sb.append(indexLine("Shanghai (CN)",     "000001.SS")).append("\n");
            sb.append(indexLine("KOSPI (KR)",        "^KS11")).append("\n");
            sb.append(indexLine("Straits Times (SG)","^STI")).append("\n\n");

            // GIFT Nifty proxy
            sb.append("GIFT Nifty (Nifty 50 proxy)\n");
            sb.append(indexLine("Nifty 50", "^NSEI")).append("\n\n");

            // Commodities & FX
            sb.append("Commodities & Currency\n");
            sb.append(indexLine("Brent Crude ($/bbl)", "BZ=F")).append("\n");
            sb.append(indexLine("USDINR",               "USDINR=X")).append("\n\n");

            // FII/DII
            sb.append("FII / DII Activity (Previous Day)\n");
            sb.append(parseFiiDii(fiiJson)).append("\n\n");

            // Market Bias (Claude)
            String rawData = sb.toString();
            sb.append("Market Bias\n");
            sb.append(generateMarketBias(rawData)).append("\n\n");

            // Watchlist
            sb.append("---\nWatchlist Updates\n\n");
            for (String symbol : watchlist) {
                sb.append("  ").append(symbol).append(": ")
                  .append(buildOneLiner(symbol, rssEntries)).append("\n");
            }

            telegramSender.send(sb.toString());
            logger.info("[Bulletin] Sent successfully");

        } catch (Exception e) {
            logger.error("[Bulletin] Failed to build/send bulletin", e);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Index / quote fetch
    // ─────────────────────────────────────────────────────────────────────────

    private static final java.net.http.HttpClient HTTP_CLIENT = java.net.http.HttpClient.newBuilder()
            .connectTimeout(java.time.Duration.ofSeconds(15))
            .followRedirects(java.net.http.HttpClient.Redirect.NORMAL)
            .build();

    private String indexLine(String label, String symbol) {
        try {
            String enc    = symbol.replace("^", "%5E").replace("=", "%3D");
            String rawUrl = String.format(YAHOO_URL, enc, "1d", "5d");

            java.net.http.HttpRequest req = java.net.http.HttpRequest.newBuilder()
                    .uri(java.net.URI.create(rawUrl))
                    .timeout(java.time.Duration.ofSeconds(15))
                    .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")
                    .header("Accept", "application/json, text/plain, */*")
                    .header("Accept-Language", "en-US,en;q=0.9")
                    .header("Referer", "https://finance.yahoo.com/")
                    .GET().build();

            java.net.http.HttpResponse<String> resp =
                    HTTP_CLIENT.send(req, java.net.http.HttpResponse.BodyHandlers.ofString());

            JsonNode meta = mapper.readTree(resp.body())
                    .path("chart").path("result").get(0).path("meta");

            double price     = meta.path("regularMarketPrice").asDouble();
            double changePct = meta.path("regularMarketChangePercent").asDouble();
            String sign      = changePct >= 0 ? "+" : "";
            return String.format("  %s: %.2f (%s%.2f%%)", label, price, sign, changePct);

        } catch (Exception e) {
            logger.warn("[Bulletin] Index fetch failed for {} ({}): {}", label, symbol, e.getMessage());
            return "• " + label + ": N/A";
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Watchlist one-liner
    // ─────────────────────────────────────────────────────────────────────────

    private String buildOneLiner(String nseSymbol, List<SyndEntry> rssEntries) {
        List<String> parts = new ArrayList<>();

        try {
            String enc = (nseSymbol + ".NS");
            java.net.http.HttpRequest req = java.net.http.HttpRequest.newBuilder()
                    .uri(java.net.URI.create(String.format(YAHOO_URL, enc, "1wk", "1y")))
                    .timeout(java.time.Duration.ofSeconds(15))
                    .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")
                    .header("Accept", "application/json, text/plain, */*")
                    .header("Accept-Language", "en-US,en;q=0.9")
                    .header("Referer", "https://finance.yahoo.com/")
                    .GET().build();
            java.net.http.HttpResponse<String> resp =
                    HTTP_CLIENT.send(req, java.net.http.HttpResponse.BodyHandlers.ofString());

            JsonNode root   = mapper.readTree(resp.body())
                    .path("chart").path("result").get(0);
            JsonNode meta   = root.path("meta");
            JsonNode closes = root.path("indicators").path("quote").get(0).path("close");

            List<Double> closeList = new ArrayList<>();
            for (JsonNode c : closes) {
                if (!c.isNull()) closeList.add(c.asDouble());
            }

            if (!closeList.isEmpty()) {
                double currentPrice = closeList.get(closeList.size() - 1);

                // Weekly trend: price vs 20W SMA
                if (closeList.size() >= 20) {
                    double sma20 = closeList.subList(closeList.size() - 20, closeList.size())
                            .stream().mapToDouble(d -> d).average().orElse(0);
                    if      (currentPrice > sma20 * 1.02) parts.add("📈 Uptrend (W)");
                    else if (currentPrice < sma20 * 0.98) parts.add("📉 Downtrend (W)");
                    else                                   parts.add("➡️ Sideways (W)");
                }

                // 52W high proximity
                double high52w = meta.path("fiftyTwoWeekHigh").asDouble();
                if (high52w > 0) {
                    double distPct = (high52w - currentPrice) / high52w * 100.0;
                    if      (distPct <= 3)  parts.add(String.format("🚀 Near 52W high (%.1f%% away)", distPct));
                    else if (distPct <= 10) parts.add(String.format("%.1f%% from 52W high", distPct));
                }

                // Weekly RSI(14)
                if (closeList.size() >= 15) {
                    double rsi = calculateRsi(closeList, 14);
                    if      (rsi >= 70) parts.add(String.format("⚠️ RSI %.0f Overbought", rsi));
                    else if (rsi <= 30) parts.add(String.format("⚠️ RSI %.0f Oversold", rsi));
                    else                parts.add(String.format("RSI %.0f", rsi));
                }
            }

        } catch (Exception e) {
            logger.debug("[Bulletin] Yahoo weekly data unavailable for {}: {}", nseSymbol, e.getMessage());
        }

        // Recent NSE news in last 7 days
        String news = recentNews(nseSymbol, rssEntries);
        if (news != null) parts.add("📢 " + news);

        return parts.isEmpty() ? "No data" : String.join(" · ", parts);
    }

    private String recentNews(String symbol, List<SyndEntry> entries) {
        if (entries == null) return null;
        Instant cutoff = Instant.now().minus(7, ChronoUnit.DAYS);
        return entries.stream()
                .filter(e -> {
                    if (e.getPublishedDate() != null
                            && e.getPublishedDate().toInstant().isBefore(cutoff)) return false;
                    String text = ((e.getTitle() != null ? e.getTitle() : "") + " "
                            + (e.getDescription() != null ? e.getDescription().getValue() : ""))
                            .toUpperCase();
                    return text.contains(symbol.toUpperCase());
                })
                .map(e -> truncate(e.getTitle(), 55))
                .findFirst()
                .orElse(null);
    }

    private String truncate(String s, int max) {
        if (s == null) return "";
        return s.length() <= max ? s : s.substring(0, max - 1) + "…";
    }

    // ─────────────────────────────────────────────────────────────────────────
    // RSI (Wilder's method)
    // ─────────────────────────────────────────────────────────────────────────

    private double calculateRsi(List<Double> closes, int period) {
        double avgGain = 0, avgLoss = 0;
        int start = closes.size() - period - 1;
        for (int i = start; i < closes.size() - 1; i++) {
            double change = closes.get(i + 1) - closes.get(i);
            if (change > 0) avgGain += change;
            else            avgLoss += Math.abs(change);
        }
        avgGain /= period;
        avgLoss /= period;
        if (avgLoss == 0) return 100;
        return 100 - (100 / (1 + avgGain / avgLoss));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FII/DII parser
    // ─────────────────────────────────────────────────────────────────────────

    private String parseFiiDii(String json) {
        if (json == null || json.isBlank()) return "• Data unavailable";
        try {
            JsonNode root = mapper.readTree(json);
            JsonNode arr  = root.isArray() ? root : root.path("data");

            double fiiNet = Double.NaN, diiNet = Double.NaN;

            for (JsonNode item : arr) {
                String cat = item.path("category").asText(
                             item.path("clientType").asText("")).toUpperCase();
                double net = item.path("netPurchases").asDouble(
                             item.path("NET_PURCHASES").asDouble(
                             item.path("net").asDouble(Double.NaN)));

                if (cat.contains("FII") || cat.contains("FPI") || cat.contains("FOREIGN"))
                    fiiNet = net;
                if (cat.contains("DII") || cat.contains("DOMESTIC"))
                    diiNet = net;
            }

            String fiiLine = Double.isNaN(fiiNet) ? "• FII: N/A"
                    : String.format("• FII: %s ₹%.0f Cr",
                        fiiNet >= 0 ? "🟢 Net Buyers" : "🔴 Net Sellers", Math.abs(fiiNet));
            String diiLine = Double.isNaN(diiNet) ? "• DII: N/A"
                    : String.format("• DII: %s ₹%.0f Cr",
                        diiNet >= 0 ? "🟢 Net Buyers" : "🔴 Net Sellers", Math.abs(diiNet));

            return fiiLine + "\n" + diiLine;

        } catch (Exception e) {
            logger.warn("[Bulletin] FII/DII parse failed: {}", e.getMessage());
            return "• FII/DII: Parse error";
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Market Bias via Claude (Anthropic API)
    // ─────────────────────────────────────────────────────────────────────────

    private String generateMarketBias(String marketData) {
        if (anthropicApiKey == null || anthropicApiKey.isBlank()) {
            return "Bias: N/A — set anthropic.api-key in application.yml";
        }
        try {
            String prompt =
                "You are a concise Indian equity market analyst. Based on this pre-market data:\n\n"
                + marketData
                + "\nProvide your market bias for Indian equities today in plain text only."
                + " No markdown, no bold, no bullet symbols, no asterisks.\n"
                + "Line 1: Bias: Moderately Bullish / Bearish / Neutral (with emoji 🟢/🔴/🟡)\n"
                + "Line 2-4: Drivers: 2-3 short lines prefixed with -\n"
                + "Line 5-6: Risks: 1-2 short lines prefixed with -\n"
                + "Max 80 words. Be direct and specific.";

            Map<String, Object> body = new LinkedHashMap<>();
            body.put("model", "claude-haiku-4-5-20251001");
            body.put("max_tokens", 300);
            body.put("messages", List.of(Map.of("role", "user", "content", prompt)));

            java.net.http.HttpRequest req = java.net.http.HttpRequest.newBuilder()
                    .uri(java.net.URI.create("https://api.anthropic.com/v1/messages"))
                    .timeout(java.time.Duration.ofSeconds(20))
                    .header("x-api-key", anthropicApiKey)
                    .header("anthropic-version", "2023-06-01")
                    .header("Content-Type", "application/json")
                    .POST(java.net.http.HttpRequest.BodyPublishers.ofString(
                            mapper.writeValueAsString(body)))
                    .build();

            java.net.http.HttpResponse<String> resp = HTTP_CLIENT.send(
                    req, java.net.http.HttpResponse.BodyHandlers.ofString());

            return mapper.readTree(resp.body())
                    .path("content").get(0).path("text").asText("N/A");

        } catch (Exception e) {
            logger.warn("[Bulletin] Claude bias call failed: {}", e.getMessage());
            return "Bias: Generation failed — check anthropic.api-key";
        }
    }
}
