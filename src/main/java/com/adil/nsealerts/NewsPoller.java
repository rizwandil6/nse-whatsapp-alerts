package com.adil.nsealerts;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import java.io.ByteArrayInputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

@Component
public class NewsPoller {
    private static final Logger logger = LoggerFactory.getLogger(NewsPoller.class);
    private final ObjectMapper mapper = new ObjectMapper();
    private final Set<String> seenUrls = new HashSet<>();
    private volatile boolean newsSeedCompleted = false;

    @Value("${anthropic.api-key:}")
    private String anthropicApiKey;

    private final TelegramSender telegramSender;
    private final AlertLogService alertLogService;

    private static final HttpClient HTTP_CLIENT = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(15))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    // Real-time RSS feeds — articles appear within 2-5 min of publication, no API key needed
    // BS blocks (403), Moneycontrol redirects to login (302 → HTML).
    // Using feeds confirmed to serve valid XML:
    private static final String[] RSS_FEEDS = {
        "https://www.thehindubusinessline.com/markets/?service=rss",        // Hindu BusinessLine Markets
        "https://www.thehindubusinessline.com/economy/?service=rss",        // Hindu BusinessLine Economy
        "https://www.thehindu.com/business/Economy/?service=rss",           // The Hindu Business/Economy
        "https://economictimes.indiatimes.com/rssfeedstopstories.cms",      // ET Top Stories (less aggressive block)
    };

    private static final String WATCHLIST_STOCKS =
            "CONCOR, HATHWAY, NHPC, JSWINFRA, JKIL, SUZLON, WAAREEENER, OLAELEC, " +
            "HINDCOPPER, MHRIL, RVNL, RAILTEL, GAIL, ADSL, ARE&M, NCC, STERTOOLS, " +
            "TEXRAIL, TITAGARH, MANINDS, SERVOTECH, IRCON";

    private static final String KNOWN_STOCKS =
            "RELIANCE, TCS, HDFCBANK, ICICIBANK, INFY, LT, WIPRO, BAJFINANCE, " +
            "MARUTI, TATAMOTORS, SUNPHARMA, ONGC, NTPC, POWERGRID, SBIN, AXISBANK, ITC";

    // RSS pub-date formats
    private static final DateTimeFormatter RFC_822 =
            DateTimeFormatter.ofPattern("EEE, dd MMM yyyy HH:mm:ss Z", Locale.ENGLISH);
    private static final DateTimeFormatter RFC_822_NO_DOW =
            DateTimeFormatter.ofPattern("dd MMM yyyy HH:mm:ss Z", Locale.ENGLISH);

    public NewsPoller(TelegramSender telegramSender, AlertLogService alertLogService) {
        this.telegramSender = telegramSender;
        this.alertLogService = alertLogService;
    }

    record NewsItem(String title, String description, String url, String source, String publishedAt) {}

    @Scheduled(fixedDelay = 15 * 60 * 1000)
    public void pollNews() {
        if (anthropicApiKey == null || anthropicApiKey.isBlank()) {
            logger.debug("[News] Anthropic key not configured — skipping");
            return;
        }

        List<NewsItem> newItems = new ArrayList<>();

        for (String feedUrl : RSS_FEEDS) {
            try {
                List<NewsItem> items = fetchRss(feedUrl);
                for (NewsItem item : items) {
                    if (seenUrls.contains(item.url())) continue;
                    seenUrls.add(item.url());
                    newItems.add(item);
                }
            } catch (Exception e) {
                logger.warn("[News] Failed to fetch {}: {}", feedUrl, e.getMessage());
            }
        }

        logger.info("[News] {} new articles across all feeds (seed={})", newItems.size(), !newsSeedCompleted);

        if (!newsSeedCompleted) {
            newsSeedCompleted = true;
            logger.info("[News] Seed complete — {} articles cached silently", newItems.size());
            return;
        }

        for (NewsItem item : newItems) {
            analyzeAndAlert(item);
        }
    }

    private List<NewsItem> fetchRss(String feedUrl) throws Exception {
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(feedUrl))
                .timeout(Duration.ofSeconds(15))
                .header("User-Agent", "NSEAlertsApp/1.0")
                .GET()
                .build();

        HttpResponse<String> response =
                HTTP_CLIENT.send(request, HttpResponse.BodyHandlers.ofString());

        if (response.statusCode() != 200) {
            throw new RuntimeException("HTTP " + response.statusCode());
        }

        // Guard: skip if response is HTML (blocked/redirected) rather than XML
        String body = response.body();
        String trimmed = body.stripLeading();
        if (trimmed.startsWith("<!DOCTYPE html") || trimmed.startsWith("<html")) {
            throw new RuntimeException("Feed returned HTML instead of XML (likely blocked)");
        }
        if (!trimmed.startsWith("<?xml") && !trimmed.startsWith("<rss") && !trimmed.startsWith("<feed")) {
            throw new RuntimeException("Unexpected response format (not XML/RSS)");
        }

        // Derive source name from URL
        String source = feedUrl.contains("moneycontrol")      ? "Moneycontrol"
                      : feedUrl.contains("business-standard")  ? "Business Standard"
                      : feedUrl.contains("thehindubusinessline") ? "BusinessLine"
                      : feedUrl.contains("economictimes")      ? "Economic Times"
                      : feedUrl.contains("reuters")            ? "Reuters"
                      : feedUrl;

        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", false);
        factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
        factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
        DocumentBuilder builder = factory.newDocumentBuilder();

        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        Document doc = builder.parse(new ByteArrayInputStream(bytes));
        doc.getDocumentElement().normalize();

        NodeList items = doc.getElementsByTagName("item");
        List<NewsItem> result = new ArrayList<>();

        for (int i = 0; i < items.getLength(); i++) {
            Element el = (Element) items.item(i);
            String title       = text(el, "title");
            String link        = text(el, "link");
            String description = text(el, "description");
            String pubDate     = text(el, "pubDate");
            String guid        = text(el, "guid");

            String url = link.isBlank() ? guid : link;
            if (url.isBlank() || title.isBlank() || title.equals("[Removed]")) continue;

            // Normalise pubDate to IST string
            String publishedAt = parseRssDate(pubDate);

            result.add(new NewsItem(title, description, url, source, publishedAt));
        }
        return result;
    }

    private String text(Element el, String tag) {
        NodeList nl = el.getElementsByTagName(tag);
        if (nl.getLength() == 0) return "";
        return nl.item(0).getTextContent().trim();
    }

    private String parseRssDate(String raw) {
        if (raw == null || raw.isBlank()) return "";
        try {
            ZonedDateTime zdt = ZonedDateTime.parse(raw.trim(), RFC_822);
            return zdt.withZoneSameInstant(ZoneId.of("Asia/Kolkata"))
                      .format(DateTimeFormatter.ofPattern("dd-MMM-yyyy HH:mm")) + " IST";
        } catch (DateTimeParseException e1) {
            try {
                ZonedDateTime zdt = ZonedDateTime.parse(raw.trim(), RFC_822_NO_DOW);
                return zdt.withZoneSameInstant(ZoneId.of("Asia/Kolkata"))
                          .format(DateTimeFormatter.ofPattern("dd-MMM-yyyy HH:mm")) + " IST";
            } catch (Exception e2) {
                return raw;
            }
        }
    }

    private void analyzeAndAlert(NewsItem item) {
        try {
            String prompt       = buildPrompt(item.title(), item.description());
            String responseText = callAnthropic(prompt);
            if (responseText == null || responseText.isBlank()) return;

            String json = responseText.trim();
            if (json.startsWith("```")) {
                int start = json.indexOf('\n') + 1;
                int end   = json.lastIndexOf("```");
                if (end > start) json = json.substring(start, end).trim();
            }

            JsonNode result = mapper.readTree(json);
            int score = result.path("impact_score").asInt(0);
            logger.info("[News] Scored {}/10: {}", score, item.title());

            if (score < 7) return;

            String message = buildMessage(result, item);
            telegramSender.send(message);
            alertLogService.logMarketNews(item.title(), result.path("market_impact").asText(""), item.source(), item.publishedAt(), score);
            logger.info("[News] Alert sent: {}", item.title());

        } catch (Exception e) {
            logger.warn("[News] Analysis failed for '{}': {}", item.title(), e.getMessage());
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

    private String buildMessage(JsonNode result, NewsItem item) {
        StringBuilder sb = new StringBuilder();
        sb.append("🚨 Market Alert — Breaking News\n");
        sb.append(item.publishedAt().isBlank() ? "" : item.publishedAt() + "\n");
        sb.append("\n").append(item.title()).append("\n\n");

        String impact = result.path("market_impact").asText("");
        if (!impact.isBlank()) sb.append(impact).append("\n");

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

        sb.append("\nSource: ").append(item.source()).append("\n");
        sb.append("Link: ").append(item.url());
        return sb.toString();
    }
}
