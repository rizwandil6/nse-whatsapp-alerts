package com.adil.nsealerts;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.HashSet;
import java.util.Set;

@Component
public class NewsPoller {
    private static final Logger logger = LoggerFactory.getLogger(NewsPoller.class);
    private final ObjectMapper mapper = new ObjectMapper();
    private final Set<String> seenUrls = new HashSet<>();

    @Value("${news.api-key:}")
    private String newsApiKey;

    @Value("${anthropic.api-key:}")
    private String anthropicApiKey;

    private final TelegramSender telegramSender;

    private static final HttpClient HTTP_CLIENT = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(15))
            .build();

    private static final String WATCHLIST_STOCKS =
            "CONCOR, HATHWAY, NHPC, JSWINFRA, JKIL, SUZLON, WAAREEENER, OLAELEC, " +
            "HINDCOPPER, MHRIL, RVNL, RAILTEL, GAIL, ADSL, ARE&M, NCC, STERTOOLS, " +
            "TEXRAIL, TITAGARH, MANINDS, SERVOTECH, IRCON";

    private static final String KNOWN_STOCKS =
            "RELIANCE, TCS, HDFCBANK, ICICIBANK, INFY, LT, WIPRO, BAJFINANCE, " +
            "MARUTI, TATAMOTORS, SUNPHARMA, ONGC, NTPC, POWERGRID, SBIN, AXISBANK, ITC";

    // Combined query — global macro + India specific (single request per poll)
    private static final String QUERY =
            "\"Federal Reserve\" OR \"FOMC\" OR \"CPI\" OR \"inflation data\" OR " +
            "\"trade war\" OR \"tariff\" OR \"OPEC\" OR \"crude oil\" OR " +
            "\"sanctions\" OR \"recession risk\" OR \"GDP data\" OR " +
            "\"RBI\" OR \"Reserve Bank of India\" OR \"SEBI\" OR " +
            "\"Indian rupee\" OR \"Nifty\" OR \"FII\" OR \"capital outflows\" OR " +
            "\"geopolitical risk\" OR \"military conflict\"";

    public NewsPoller(TelegramSender telegramSender) {
        this.telegramSender = telegramSender;
    }

    // Free-tier NewsAPI has ~24h delay on `from` filter — it always returns 0 results.
    // Strategy: fetch latest 30 articles per poll (sorted by publishedAt), deduplicate
    // via seenUrls. First poll seeds the set silently; subsequent polls alert on new ones.
    private volatile boolean newsSeedCompleted = false;

    @Scheduled(fixedDelay = 15 * 60 * 1000)  // every 15 minutes
    public void pollNews() {
        if (newsApiKey == null || newsApiKey.isBlank()) {
            logger.debug("[News] API key not configured — skipping");
            return;
        }

        try {
            String encodedQ = URLEncoder.encode(QUERY, StandardCharsets.UTF_8);
            String url = "https://newsapi.org/v2/everything"
                    + "?q=" + encodedQ
                    + "&language=en"
                    + "&sortBy=publishedAt"
                    + "&pageSize=30"
                    + "&apiKey=" + newsApiKey;

            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .timeout(Duration.ofSeconds(15))
                    .header("User-Agent", "NSEAlertsApp/1.0")
                    .GET()
                    .build();

            HttpResponse<String> response =
                    HTTP_CLIENT.send(request, HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() != 200) {
                logger.warn("[News] NewsAPI returned status {}: {}", response.statusCode(), response.body());
                return;
            }

            JsonNode root     = mapper.readTree(response.body());
            JsonNode articles = root.path("articles");
            logger.info("[News] Fetched {} articles (seed={})", articles.size(), !newsSeedCompleted);

            for (JsonNode article : articles) {
                String articleUrl   = article.path("url").asText("").trim();
                String title        = article.path("title").asText("").trim();
                String description  = article.path("description").asText("").trim();
                String source       = article.path("source").path("name").asText("Unknown");
                String publishedAt  = article.path("publishedAt").asText("");

                if (articleUrl.isBlank() || title.isBlank() || title.equals("[Removed]")) continue;
                if (seenUrls.contains(articleUrl)) continue;
                seenUrls.add(articleUrl);

                if (!newsSeedCompleted) continue;  // first poll: seed seenUrls silently

                analyzeAndAlert(title, description, source, articleUrl, publishedAt);
            }

            newsSeedCompleted = true;

        } catch (Exception e) {
            logger.error("[News] Poll failed: {}", e.getMessage());
        }
    }

    private void analyzeAndAlert(String title, String description,
                                  String source, String url, String publishedAt) {
        if (anthropicApiKey == null || anthropicApiKey.isBlank()) return;
        try {
            String prompt       = buildPrompt(title, description);
            String responseText = callAnthropic(prompt);
            if (responseText == null || responseText.isBlank()) return;

            // Strip markdown code block if present
            String json = responseText.trim();
            if (json.startsWith("```")) {
                int start = json.indexOf('\n') + 1;
                int end   = json.lastIndexOf("```");
                if (end > start) json = json.substring(start, end).trim();
            }

            JsonNode result = mapper.readTree(json);
            int score = result.path("impact_score").asInt(0);
            logger.info("[News] Scored {}/10: {}", score, title);

            if (score < 7) return;

            String message = buildMessage(result, title, source, url, publishedAt);
            telegramSender.send(message);
            logger.info("[News] Alert sent: {}", title);

        } catch (Exception e) {
            logger.warn("[News] Analysis failed for '{}': {}", title, e.getMessage());
        }
    }

    private String buildPrompt(String title, String description) {
        return "You are a market analyst for Indian equity markets.\n\n"
            + "Article Title: " + title + "\n"
            + "Article Description: " + (description.isBlank() ? "N/A" : description) + "\n\n"
            + "Watchlist Stocks: " + WATCHLIST_STOCKS + "\n"
            + "Well-Known Indian Stocks: " + KNOWN_STOCKS + "\n\n"
            + "Reply with ONLY a JSON object (no markdown, no code blocks):\n"
            + "{\n"
            + "  \"impact_score\": <1-10>,\n"
            + "  \"market_impact\": \"<2-3 plain text lines: overall Indian market direction, Nifty expectation, rupee impact>\",\n"
            + "  \"sectors_affected\": [\n"
            + "    {\"sector\": \"<name>\", \"direction\": \"<bullish|bearish|mixed>\", \"reason\": \"<one line>\"}\n"
            + "  ],\n"
            + "  \"stocks_affected\": [\n"
            + "    {\"symbol\": \"<NSE symbol>\", \"direction\": \"<bullish|bearish|mixed>\", \"reason\": \"<one line>\"}\n"
            + "  ]\n"
            + "}\n\n"
            + "Rules:\n"
            + "- impact_score: 1-4=minor/noise, 5-6=moderate, 7-8=significant, 9-10=major market mover\n"
            + "- Only include stocks DIRECTLY impacted, not speculative guesses\n"
            + "- sectors_affected: max 4 sectors\n"
            + "- stocks_affected: max 6 stocks (mix from watchlist and well-known)\n"
            + "- direction must be exactly: bullish, bearish, or mixed\n"
            + "- No markdown formatting in any text field";
    }

    private String callAnthropic(String prompt) throws Exception {
        var rootNode = mapper.createObjectNode();
        var messages = mapper.createArrayNode();
        var msg      = mapper.createObjectNode();
        msg.put("role", "user");
        msg.put("content", prompt);
        messages.add(msg);
        rootNode.put("model", "claude-haiku-4-5-20251001");
        rootNode.put("max_tokens", 600);
        rootNode.set("messages", messages);

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create("https://api.anthropic.com/v1/messages"))
                .header("Content-Type", "application/json")
                .header("x-api-key", anthropicApiKey)
                .header("anthropic-version", "2023-06-01")
                .POST(HttpRequest.BodyPublishers.ofString(rootNode.toString(), StandardCharsets.UTF_8))
                .build();

        HttpResponse<String> response =
                HTTP_CLIENT.send(request, HttpResponse.BodyHandlers.ofString());

        if (response.statusCode() != 200) {
            logger.warn("[News] Anthropic error {}", response.statusCode());
            return null;
        }
        return mapper.readTree(response.body()).at("/content/0/text").asText();
    }

    private String buildMessage(JsonNode result, String title, String source,
                                 String url, String publishedAt) {
        String timeStr;
        try {
            ZonedDateTime ist = Instant.parse(publishedAt)
                    .atZone(ZoneId.of("Asia/Kolkata"));
            timeStr = ist.format(DateTimeFormatter.ofPattern("dd-MMM-yyyy HH:mm")) + " IST";
        } catch (Exception e) {
            timeStr = publishedAt;
        }

        StringBuilder sb = new StringBuilder();
        sb.append("🚨 Market Alert — Breaking News\n");
        sb.append(timeStr).append("\n\n");
        sb.append(title).append("\n\n");

        String impact = result.path("market_impact").asText("");
        if (!impact.isBlank()) sb.append(impact).append("\n");

        // Sectors
        JsonNode sectors = result.path("sectors_affected");
        if (sectors.isArray() && sectors.size() > 0) {
            sb.append("\nSectors:\n");
            for (JsonNode s : sectors) {
                String dir  = s.path("direction").asText("");
                String icon = "bearish".equals(dir) ? "🔴" : "bullish".equals(dir) ? "🟢" : "🟡";
                sb.append(icon).append(" ").append(s.path("sector").asText())
                  .append(" — ").append(s.path("reason").asText()).append("\n");
            }
        }

        // Stocks
        JsonNode stocks = result.path("stocks_affected");
        if (stocks.isArray() && stocks.size() > 0) {
            sb.append("\nStocks:\n");
            for (JsonNode s : stocks) {
                String dir  = s.path("direction").asText("");
                String icon = "bearish".equals(dir) ? "🔴" : "bullish".equals(dir) ? "🟢" : "🟡";
                sb.append(icon).append(" ").append(s.path("symbol").asText())
                  .append(" — ").append(s.path("reason").asText()).append("\n");
            }
        }

        sb.append("\nSource: ").append(source).append("\n");
        sb.append("Link: ").append(url);
        return sb.toString();
    }
}
