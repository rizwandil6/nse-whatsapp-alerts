package com.adil.nsealerts;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.rometools.rome.feed.synd.SyndEntry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;

@Component
public class AlertPoller {
    private static final Logger logger = LoggerFactory.getLogger(AlertPoller.class);

    private List<String> watchlist;
    private List<String> circularKeywords;
    private List<String> announcementKeywords;
    private List<String> ignoredKeywords;

    private final NseClient nseClient;
    private final TelegramSender telegramSender;
    private final FundamentalScreener fundamentalScreener;
    private final PromptRatingService promptRatingService;
    private final boolean screeningEnabled;
    private final ObjectMapper mapper = new ObjectMapper();

    // Simple in-memory dedup. Restarts will re-alert once - acceptable for v1.
    private final Set<String> seenIds = new HashSet<>();

    public AlertPoller(NseClient nseClient,
                       TelegramSender telegramSender,
                       FundamentalScreener fundamentalScreener,
                       PromptRatingService promptRatingService,
                       org.springframework.core.env.Environment env) {
        this.nseClient = nseClient;
        this.telegramSender = telegramSender;
        this.fundamentalScreener = fundamentalScreener;
        this.promptRatingService = promptRatingService;
        String screeningFlag = env.getProperty("screening.enabled", "true");
        this.screeningEnabled = Boolean.parseBoolean(screeningFlag);

        String[] watch = env.getProperty("nse.watchlist", String[].class);
        if (watch == null) {
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
        checkAnnouncements();
        checkCirculars();
    }

    private void checkAnnouncements() {
        List<SyndEntry> entries = nseClient.fetchAnnouncements();
        if (entries == null || entries.isEmpty()) {
            return;
        }

        for (SyndEntry entry : entries) {
            try {
                String title = entry.getTitle() != null ? entry.getTitle() : "";
                String description = entry.getDescription() != null ? entry.getDescription().getValue() : "";
                String link = entry.getLink() != null ? entry.getLink() : "";

                String id = link.isEmpty() ? (title + ":" + entry.getPublishedDate()) : link;

                boolean excluded = title.contains("(Sub-para 4-Para B)") || description.contains("(Sub-para 4-Para B)")
                        || containsAnyIgnoreKeyword(title, description);

                boolean matches = !excluded && (announcementKeywords.isEmpty() ||
                        announcementKeywords.stream()
                                .anyMatch(k -> description.toLowerCase().contains(k.toLowerCase())));

                if (matches && seenIds.add(id)) {
                    logger.info("✓ New announcement: {}", title);
                    AnnouncementContext context = extractAnnouncementContext(title, description, link);
                    String message = screeningEnabled
                            ? buildAnnouncementMessage(context)
                            : buildPlainAnnouncementMessage(context);
                    logger.info("  → {}", message);
                    telegramSender.send(message);
                }
            } catch (Exception e) {
                logger.error("Error processing announcement entry; continuing to next item", e);
            }
        }
    }

    private void checkCirculars() {
        String json = nseClient.fetchCirculars();
        if (json == null) {
            return;
        }
        try {
            JsonNode root = mapper.readTree(json);
            JsonNode list = root.has("data") ? root.get("data") : root;
            for (JsonNode item : list) {
                String subject = textOf(item, "sub", "subject", "circNo");
                String id = textOf(item, "circNo", "subject");

                boolean matches = circularKeywords.stream()
                        .anyMatch(k -> subject.toLowerCase().contains(k.toLowerCase()));

                if (matches && !containsAnyIgnoreKeyword(subject, "") && seenIds.add(id)) {
                    telegramSender.send("NSE Circular: " + subject);
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

    private String buildAnnouncementMessage(AnnouncementContext context) {
        // Get old format analysis from PromptRatingService
        AnalysisResult analysisResult = promptRatingService.analyze(
                context.companyName(),
                context.subject(),
                context.link(),
                context.subject());

        StringBuilder builder = new StringBuilder();

        // Start with old format message if available
        if (analysisResult != null && analysisResult.getWhatsappMessage() != null && !analysisResult.getWhatsappMessage().isBlank()) {
            builder.append(analysisResult.getWhatsappMessage()).append("\n\n");
        } else {
            // Fallback: basic announcement format
            builder.append("📢 NSE ANNOUNCEMENT\n");
            builder.append("🏢 ").append(context.companyName()).append("\n");
            builder.append("📋 ").append(context.subject()).append("\n");
            builder.append("🔗 ").append(context.link()).append("\n\n");
        }

        // Append new fundamental analysis if screening is enabled
        if (screeningEnabled) {
            FundamentalResult result = fundamentalScreener.analyze(context.companyName());

            if (result != null && result.isAvailable()) {

                builder.append("\n--- FUNDAMENTAL ANALYSIS ---\n\n");
                builder.append("📊 FUNDAMENTAL ANALYSIS\n");
                builder.append("💰 Market Cap: ")
                        .append(formatDouble(result.getMarketCapCr()))
                        .append(" Cr — ")
                        .append(nullSafe(result.getMarketCapCategory()))
                        .append("\n");

                builder.append("📈 PE Ratio: ")
                        .append(formatDouble(result.getTrailingPe()))
                        .append(" — ")
                        .append(nullSafe(result.getPeRating()));
                if (result.getPeComparison() != null && !result.getPeComparison().isBlank()) {
                    builder.append(" (").append(result.getPeComparison()).append(")");
                }
                builder.append("\n");

                builder.append("💼 ROCE: ")
                        .append(formatPercent(result.getRocePercent()))
                        .append("% — ")
                        .append(nullSafe(result.getRoceRating()))
                        .append("\n\n");

                builder.append("💳 DEBT ANALYSIS\n");
                builder.append("Debt vs MCap: ").append(nullSafe(result.getDebtVsMarketCapRating())).append("\n");
                builder.append("Debt vs Reserve: ").append(nullSafe(result.getDebtVsReserveRating())).append("\n");
                builder.append("Debt/Assets: ")
                        .append(formatPercent(result.getDebtToAssetsPercent()))
                        .append("% ")
                        .append(nullSafe(result.getDebtToAssetsRating()))
                        .append("\n\n");

                builder.append("📅 LAST 3 QUARTERS\n");
                builder.append("Revenue: ")
                        .append(formatQuarterSeries(result.getQuarterlyRevenueCr()))
                        .append(" Cr ")
                        .append(nullSafe(result.getQuarterlyRevenueTrend()))
                        .append("\n");
                builder.append("Net Profit: ")
                        .append(formatQuarterSeries(result.getQuarterlyNetProfitCr()))
                        .append(" Cr ")
                        .append(nullSafe(result.getQuarterlyNetProfitTrend()))
                        .append("\n\n");

                builder.append("👤 EPS: ").append(formatDouble(result.getTrailingEps())).append("\n");
                builder.append("📚 Book Value ratio: ").append(nullSafe(result.getBookValueRating())).append("\n");
                builder.append("🏦 Promoter Holding: ")
                        .append(formatPercent(result.getPromoterHoldingPercent()))
                        .append("% ")
                        .append(nullSafe(result.getPromoterHoldingRating()))
                        .append("\n\n");

                builder.append("📉 TECHNICAL\n");
                builder.append("200 EMA: ").append(nullSafe(result.getEma200Rating())).append("\n");
                builder.append("RSI: ").append(nullSafe(result.getRsiRating())).append("\n");
                builder.append("Breakout: ").append(nullSafe(result.getBreakoutRating())).append("\n");
            } else if (result != null && result.getUnavailableMessage() != null && !result.getUnavailableMessage().isBlank()) {
                builder.append(result.getUnavailableMessage()).append("\n");
            }
        }
        return builder.toString();
    }

    private String buildPlainAnnouncementMessage(AnnouncementContext context) {
        StringBuilder builder = new StringBuilder();
        builder.append("📢 NSE ANNOUNCEMENT\n");
        builder.append("🏢 ").append(context.companyName()).append(" (").append(context.symbol()).append(")\n");
        builder.append("📋 ").append(context.subject()).append("\n\n");
        builder.append("🔗 ").append(context.link());
        return builder.toString();
    }

    private AnnouncementContext extractAnnouncementContext(String title, String description, String link) {
        String cleanTitle = title == null ? "" : title.trim();
        String companyName = extractCompanyName(cleanTitle);
        String subject = extractSubject(cleanTitle, description);
        String symbol = extractSymbol(cleanTitle, description, companyName);
        if (symbol.isBlank()) {
            symbol = companyName.isBlank() ? "NSE" : companyName;
        }
        return new AnnouncementContext(companyName.isBlank() ? cleanTitle : companyName,
                symbol,
                subject.isBlank() ? cleanTitle : subject,
                link);
    }

    private String extractCompanyName(String title) {
        String[] parts = splitAnnouncementTitle(title);
        return parts[0] == null ? "" : parts[0].trim();
    }

    private String extractSubject(String title, String description) {
        String[] parts = splitAnnouncementTitle(title);
        if (parts[1] != null && !parts[1].isBlank()) {
            return parts[1].trim();
        }
        return description == null ? "" : description.trim();
    }

    private String extractSymbol(String title, String description, String companyName) {
        String haystack = (title + " " + description + " " + companyName).toUpperCase(Locale.ROOT);
        for (String item : watchlist) {
            if (item == null || item.isBlank()) {
                continue;
            }
            String candidate = item.trim().toUpperCase(Locale.ROOT);
            if (containsWholeWord(haystack, candidate)) {
                return candidate;
            }
        }

        String fallback = companyName == null ? "" : companyName.trim().toUpperCase(Locale.ROOT);
        if (fallback.isBlank()) {
            return "";
        }
        return fallback;
    }

    private String[] splitAnnouncementTitle(String title) {
        if (title == null || title.isBlank()) {
            return new String[]{"", ""};
        }
        String[] separators = {" - ", " : ", " | ", " – ", " — "};
        for (String separator : separators) {
            int index = title.indexOf(separator);
            if (index > 0 && index < title.length() - separator.length()) {
                return new String[]{title.substring(0, index).trim(), title.substring(index + separator.length()).trim()};
            }
        }
        return new String[]{title.trim(), ""};
    }

    private boolean containsWholeWord(String text, String term) {
        String pattern = "(?i)(?<![A-Z0-9])" + java.util.regex.Pattern.quote(term) + "(?![A-Z0-9])";
        return java.util.regex.Pattern.compile(pattern).matcher(text).find();
    }

    private String formatQuarterSeries(List<Double> values) {
        if (values == null || values.isEmpty()) {
            return "N/A";
        }
        List<String> formatted = new ArrayList<>();
        for (Double value : values) {
            formatted.add(formatDouble(value));
        }
        return String.join(" → ", formatted);
    }

    private String formatDouble(Double value) {
        if (value == null) {
            return "N/A";
        }
        return String.format(Locale.US, "%.2f", value);
    }

    private String formatPercent(Double value) {
        if (value == null) {
            return "N/A";
        }
        return String.format(Locale.US, "%.2f", value);
    }

    private String nullSafe(String value) {
        return value == null || value.isBlank() ? "N/A" : value;
    }

    private String textOf(JsonNode node, String... fields) {
        for (String f : fields) {
            if (node.has(f) && !node.get(f).isNull()) {
                return node.get(f).asText();
            }
        }
        return "";
    }

    private record AnnouncementContext(String companyName, String symbol, String subject, String link) {
    }
}