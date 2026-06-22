package com.adil.nsealerts;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.rometools.rome.feed.synd.SyndEntry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.*;

@Component
public class AlertPoller {
    private static final Logger logger = LoggerFactory.getLogger(AlertPoller.class);

    private List<String> watchlist;

    private List<String> circularKeywords;
    private List<String> announcementKeywords;
    private List<String> ignoredKeywords;

    private final NseClient nseClient;
    private final WhatsAppSender whatsAppSender;
    private final DocumentFetcher documentFetcher;
    private final PromptRatingService promptRatingService;
    private final ObjectMapper mapper = new ObjectMapper();

    // Simple in-memory dedup. Restarts will re-alert once - acceptable for v1.
    private final Set<String> seenIds = new HashSet<>();

    public AlertPoller(NseClient nseClient,
                       WhatsAppSender whatsAppSender,
                       DocumentFetcher documentFetcher,
                       PromptRatingService promptRatingService,
                       org.springframework.core.env.Environment env) {
        this.nseClient = nseClient;
        this.whatsAppSender = whatsAppSender;
        this.documentFetcher = documentFetcher;
        this.promptRatingService = promptRatingService;

        // Try multiple ways to load the watchlist from YAML
        String[] watch = env.getProperty("nse.watchlist", String[].class);
        if (watch == null) {
            // Try with comma-separated list fallback
            String watchStr = env.getProperty("nse.watchlist");
            if (watchStr != null && !watchStr.isEmpty()) {
                watch = watchStr.split(",");
                for (int i = 0; i < watch.length; i++) {
                    watch[i] = watch[i].trim();
                }
            }
        }
        this.watchlist = watch == null ? java.util.Collections.emptyList() : java.util.Arrays.asList(watch);
        logger.info("[AlertPoller] Loaded watchlist: {}", this.watchlist);

        String[] circulars = env.getProperty("nse.circular-keywords", String[].class);
        if (circulars == null) {
            String circularStr = env.getProperty("nse.circular-keywords");
            if (circularStr != null && !circularStr.isEmpty()) {
                circulars = circularStr.split(",");
                for (int i = 0; i < circulars.length; i++) {
                    circulars[i] = circulars[i].trim();
                }
            }
        }
        this.circularKeywords = circulars == null ? java.util.Collections.emptyList() : java.util.Arrays.asList(circulars);
        logger.info("[AlertPoller] Loaded circular keywords: {}", this.circularKeywords);

        // Load announcement keywords using indexed property access for YAML lists
        List<String> annKeywords = new ArrayList<>();
        int idx = 0;
        String keyword;
        while ((keyword = env.getProperty("nse.announcement-keywords[" + idx + "]")) != null) {
            annKeywords.add(keyword);
            idx++;
        }
        this.announcementKeywords = annKeywords.isEmpty() ? java.util.Collections.emptyList() : annKeywords;
        logger.info("[AlertPoller] Loaded announcement keywords: {}", this.announcementKeywords);

        List<String> ignored = new ArrayList<>();
        int ignoreIdx = 0;
        while ((keyword = env.getProperty("nse.ignore-keywords[" + ignoreIdx + "]")) != null) {
            ignored.add(keyword);
            ignoreIdx++;
        }
        this.ignoredKeywords = ignored.isEmpty() ? java.util.Collections.emptyList() : ignored;
        logger.info("[AlertPoller] Loaded ignored keywords: {}", this.ignoredKeywords);
    }

    @Scheduled(fixedDelayString = "${nse.poll-interval-ms}")
    public void poll() {
        // System.out.println("Poll tick: checking announcements and circulars");
        checkAnnouncements();
        checkCirculars();
    }

    private void checkAnnouncements() {
        List<SyndEntry> entries = nseClient.fetchAnnouncements();
        if (entries == null || entries.isEmpty()) {
            return;
        }

        // System.out.println("Checking " + entries.size() + " announcements");
        for (SyndEntry entry : entries) {
            try {
                String title = entry.getTitle() != null ? entry.getTitle() : "";
                String description = entry.getDescription() != null ? entry.getDescription().getValue() : "";
                String link = entry.getLink() != null ? entry.getLink() : "";

                // Create a unique ID based on the entry link/guid
                String id = link.isEmpty() ? (title + ":" + entry.getPublishedDate()) : link;

                // Exclude subjects with unwanted sub-para text
                boolean excluded = title.contains("(Sub-para 4-Para B)") || description.contains("(Sub-para 4-Para B)")
                    || containsAnyIgnoreKeyword(title, description);

                // Check if description matches announcement keywords
                boolean matches = !excluded && (announcementKeywords.isEmpty() ||
                        announcementKeywords.stream()
                                .anyMatch(k -> description.toLowerCase().contains(k.toLowerCase())));

                if (matches && seenIds.add(id)) {
                    logger.info("✓ New announcement: {}", title);
                    String documentText = documentFetcher.fetchText(link);
                    AnalysisResult result = promptRatingService.analyze(title, description, link, documentText);
                    String message = buildAnnouncementWhatsAppMessage(title, result, link);
                    logger.info("  → {}", message);
                    whatsAppSender.send(message);
                } else if (!matches) {
                    // System.out.println("  (Filtered out: " + title + ")");
                }
            } catch (Exception e) {
                logger.error("Error processing announcement entry; continuing to next item", e);
            }
        }
    }

    private void checkCirculars() {
        String json = nseClient.fetchCirculars();
        if (json == null) return;
        try {
            JsonNode root = mapper.readTree(json);
            JsonNode list = root.has("data") ? root.get("data") : root;
            for (JsonNode item : list) {
                String subject = textOf(item, "sub", "subject", "circNo");
                String id = textOf(item, "circNo", "subject");

                boolean matches = circularKeywords.stream()
                    .anyMatch(k -> subject.toLowerCase().contains(k.toLowerCase()));

                if (matches && !containsAnyIgnoreKeyword(subject, "") && seenIds.add(id)) {
                    whatsAppSender.send("NSE Circular: " + subject);
                }
            }
        } catch (Exception e) {
            logger.error("Error parsing circulars", e);
        }
    }

    private boolean containsAnyIgnoreKeyword(String title, String description) {
        String haystack = (title + " " + description).toLowerCase();
        return ignoredKeywords.stream()
                .filter(Objects::nonNull)
                .map(String::trim)
                .filter(value -> !value.isEmpty())
                .map(String::toLowerCase)
                .anyMatch(haystack::contains);
    }

    private String buildAnnouncementWhatsAppMessage(String title, AnalysisResult result, String link) {
        if (result.getWhatsappMessage() != null && !result.getWhatsappMessage().isBlank()) {
            return result.getWhatsappMessage();
        }

        String orderValue = result.getOrderSizeCrores() != null ? String.format("%.2f Cr", result.getOrderSizeCrores()) : "Unknown";
        String scannerDecision = result.getRating() >= 8.0 ? "🟢 Research Immediately"
                : result.getRating() >= 5.0 ? "🟡 Watchlist" : "🔴 Ignore";
        String finalVerdict = result.getSummary() != null && !result.getSummary().isBlank()
                ? result.getSummary()
                : result.getQuickVerdict();

        StringBuilder builder = new StringBuilder();
        builder.append("Company Snapshot\n");
        builder.append("👉 ").append(title).append("\n\n");

        builder.append("Quick Verdict\n");
        builder.append("Rating ").append(String.format("%.1f/10", result.getRating())).append(" - ")
                .append(result.getQuickVerdict()).append("\n\n");

        builder.append("Order Details\n");
        builder.append("Order Value: ").append(orderValue).append("\n");
        builder.append("Source: ").append(link).append("\n\n");

        builder.append("Overall Rating\n");
        builder.append(String.format("%.1f/10", result.getRating())).append("\n\n");

        builder.append("Scanner Decision\n");
        builder.append(scannerDecision);

        return builder.toString();
    }

    private String textOf(JsonNode node, String... fields) {
        for (String f : fields) {
            if (node.has(f) && !node.get(f).isNull()) {
                return node.get(f).asText();
            }
        }
        return "";
    }
}
