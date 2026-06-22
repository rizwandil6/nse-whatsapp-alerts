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

    private final NseClient nseClient;
    private final WhatsAppSender whatsAppSender;
    private final DocumentFetcher documentFetcher;
    private final PromptRatingService promptRatingService;
    private final ObjectMapper mapper = new ObjectMapper();

    private final org.springframework.core.env.Environment env;

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
        this.env = env;

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
    }

    @Scheduled(fixedDelayString = "${nse.poll-interval-ms}")
    public void poll() {
        // System.out.println("Poll tick: checking announcements and circulars");
        checkAnnouncements();
       // checkCirculars();
    }

    private void checkAnnouncements() {
        List<SyndEntry> entries = nseClient.fetchAnnouncements();
        if (entries == null || entries.isEmpty()) {
            return;
        }
        
        try {
            // System.out.println("Checking " + entries.size() + " announcements");
            for (SyndEntry entry : entries) {
                String title = entry.getTitle() != null ? entry.getTitle() : "";
                String description = entry.getDescription() != null ? entry.getDescription().getValue() : "";
                String link = entry.getLink() != null ? entry.getLink() : "";
                
                // Create a unique ID based on the entry link/guid
                String id = link.isEmpty() ? (title + ":" + entry.getPublishedDate()) : link;

                // Exclude subjects with unwanted sub-para text
                boolean excluded = title.contains("(Sub-para 4-Para B)") || description.contains("(Sub-para 4-Para B)");

                // Check if description matches announcement keywords
                boolean matches = !excluded && (announcementKeywords.isEmpty() || 
                        announcementKeywords.stream()
                        .anyMatch(k -> description.toLowerCase().contains(k.toLowerCase())));

                if (matches && seenIds.add(id)) {
                    logger.info("✓ New announcement: {}", title);
                    String documentText = documentFetcher.fetchText(link);
                    AnalysisResult result = promptRatingService.analyze(title, description, link, documentText);
                    String orderSizeText = result.getOrderSizeCrores() != null ? result.getOrderSizeCrores() + " Cr" : "unknown";
                    String message = String.format("Stock: %s | Rating: %.1f/10 | Verdict: %s | Order Size: %s", title, result.getRating(), result.getQuickVerdict(), orderSizeText);
                    logger.info("  → {}", message);
                    whatsAppSender.send(message);
                } else if (!matches) {
                    // System.out.println("  (Filtered out: " + title + ")");
                }
            }
        } catch (Exception e) {
            logger.error("Error processing announcements", e);
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

                if (/*matches && */seenIds.add(id)) {
                    whatsAppSender.send("NSE Circular: " + subject);
                }
            }
        } catch (Exception e) {
            logger.error("Error parsing circulars", e);
        }
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
