package com.adil.nsealerts;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.rometools.rome.feed.synd.SyndCategory;
import com.rometools.rome.feed.synd.SyndEntry;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

import java.time.DayOfWeek;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

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
    private final PdfExtractor pdfExtractor;
    private final boolean screeningEnabled;
    private final boolean ignoreSme;

    /** Symbols listed on NSE main board (loaded from EQUITY_L.csv at startup). Null = unavailable, don't filter. */
    private volatile Set<String> mainBoardSymbols = null;
    private static final String EQUITY_LIST_URL =
            "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv";
    /** Extracts the NSE symbol from a PDF link, e.g. .../TEXRAIL_24062026...pdf → TEXRAIL */
    private static final Pattern SYMBOL_FROM_LINK = Pattern.compile("/([A-Z0-9&%-]+)_\\d{12,14}_");
    private final ObjectMapper mapper = new ObjectMapper();

    // Simple in-memory dedup. Restarts will re-alert once - acceptable for v1.
    private final Set<String> seenIds = new HashSet<>();

    public AlertPoller(NseClient nseClient,
                       TelegramSender telegramSender,
                       FundamentalScreener fundamentalScreener,
                       PromptRatingService promptRatingService,
                       PdfExtractor pdfExtractor,
                       org.springframework.core.env.Environment env) {
        this.nseClient = nseClient;
        this.telegramSender = telegramSender;
        this.fundamentalScreener = fundamentalScreener;
        this.promptRatingService = promptRatingService;
        this.pdfExtractor = pdfExtractor;
        String screeningFlag = env.getProperty("screening.enabled", "true");
        this.screeningEnabled = Boolean.parseBoolean(screeningFlag);
        this.ignoreSme = Boolean.parseBoolean(env.getProperty("nse.ignore-sme", "true"));

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

    @PostConstruct
    void loadMainBoardSymbols() {
        if (!ignoreSme) {
            return;
        }
        // Run in background so it does not block application startup
        Thread loader = new Thread(() -> {
            try {
                RestTemplate rt = new RestTemplate();
                String csv = rt.getForObject(EQUITY_LIST_URL, String.class);
                if (csv == null || csv.isBlank()) {
                    logger.warn("[SME filter] EQUITY_L.csv returned empty; SME filtering by symbol disabled");
                    return;
                }
                Set<String> symbols = new HashSet<>();
                String[] lines = csv.split("\\r?\\n");
                for (int i = 1; i < lines.length; i++) {
                    String line = lines[i].trim();
                    if (!line.isEmpty()) {
                        symbols.add(line.split(",")[0].trim().toUpperCase(Locale.ROOT));
                    }
                }
                mainBoardSymbols = symbols;
                logger.info("[SME filter] Loaded {} main-board symbols from EQUITY_L.csv", symbols.size());
            } catch (Exception e) {
                logger.warn("[SME filter] Could not load EQUITY_L.csv ({}); SME filtering by symbol disabled", e.getMessage());
            }
        }, "equity-list-loader");
        loader.setDaemon(true);
        loader.start();
    }

    private static final ZoneId IST = ZoneId.of("Asia/Kolkata");
    private static final LocalTime MARKET_OPEN  = LocalTime.of(9, 15);
    private static final LocalTime MARKET_CLOSE = LocalTime.of(15, 30);
    private static final long MARKET_HOURS_DELAY_MS    = 2  * 60 * 1000L; // 2 min
    private static final long OFF_MARKET_DELAY_MS      = 5  * 60 * 1000L; // 5 min

    @Scheduled(fixedDelay = 120000) // 2 minutes
    public void scheduledPoll() {
        poll();
    }

    private boolean isMarketHours() {
        ZonedDateTime now = ZonedDateTime.now(IST);
        DayOfWeek day = now.getDayOfWeek();
        if (day == DayOfWeek.SATURDAY || day == DayOfWeek.SUNDAY) {
            return false;
        }
        LocalTime time = now.toLocalTime();
        return !time.isBefore(MARKET_OPEN) && !time.isAfter(MARKET_CLOSE);
    }

    public void poll() {
        logger.info("Polling NSE [market hours={}]", isMarketHours());
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

                if (ignoreSme && isSmeAnnouncement(entry, title, description)) {
                    logger.debug("Skipping SME/Emerge announcement: {}", title);
                    continue;
                }

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

    /**
     * Detects NSE Emerge (SME) announcements.
     *
     * Strategy (in order of reliability):
     * 1. Symbol extracted from the PDF link compared against the main-board EQUITY_L.csv list.
     *    If the symbol is NOT in the main-board list it is SME/Emerge → filter it out.
     * 2. RSS category tags containing "EMERGE" or "SME".
     * 3. Text markers in title / description as a last resort.
     */
    private boolean isSmeAnnouncement(SyndEntry entry, String title, String description) {
        // 1. Symbol-based check (most reliable)
        String link = entry.getLink() != null ? entry.getLink().toUpperCase(Locale.ROOT) : "";
        if (!link.isEmpty()) {
            Matcher m = SYMBOL_FROM_LINK.matcher(link);
            if (m.find()) {
                String symbol = m.group(1);
                // If symbol itself ends with SME or contains SME marker — definitely SME
                if (symbol.endsWith("SME") || symbol.contains("-SME") || symbol.contains("SME-")) {
                    logger.info("[SME filter] Dropping SME symbol by name: {}", symbol);
                    return true;
                }
                // If main-board list loaded, check against it
                if (mainBoardSymbols != null) {
                    if (!mainBoardSymbols.contains(symbol)) {
                        logger.info("[SME filter] Dropping symbol not on main board: {}", symbol);
                        return true;
                    }
                    return false; // confirmed main-board stock — not SME
                }
            }
        }

        // 2. RSS category tags
        if (entry.getCategories() != null) {
            for (SyndCategory cat : entry.getCategories()) {
                if (cat.getName() != null) {
                    String name = cat.getName().toUpperCase(Locale.ROOT);
                    if (name.contains("EMERGE") || name.contains("SME")) {
                        return true;
                    }
                }
            }
        }

        // 3. Text markers in title / description
        String haystack = (title + " " + description).toUpperCase(Locale.ROOT);
        return haystack.contains("NSE EMERGE")
                || haystack.contains("NSE SME")
                || haystack.contains("EMERGE PLATFORM")
                || haystack.contains("SME PLATFORM");
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
        // Extract PDF text for richer OpenAI analysis
        String pdfText = pdfExtractor.extractText(context.link());
        String documentText = pdfText != null && !pdfText.isBlank() ? pdfText : context.subject();

        AnalysisResult analysisResult = promptRatingService.analyze(
                context.companyName(),
                context.subject(),
                context.link(),
                documentText);

        StringBuilder builder = new StringBuilder();

        // Use Company Snapshot format from PromptRatingService if available,
        // otherwise build it from the analysis fields + context (e.g. when OpenAI truncates whatsapp_message)
        if (analysisResult != null && analysisResult.getWhatsappMessage() != null && !analysisResult.getWhatsappMessage().isBlank()) {
            builder.append(analysisResult.getWhatsappMessage()).append("\n\n");
        } else {
            double rating = analysisResult != null ? analysisResult.getRating() : 5.0;
            String verdict = analysisResult != null ? analysisResult.getQuickVerdict() : "Watchlist";
            String orderValue = (analysisResult != null && analysisResult.getOrderSizeCrores() != null)
                    ? String.format("INR %.2f Cr", analysisResult.getOrderSizeCrores())
                    : "Unknown";
            String scannerEmoji = rating >= 9 ? "🟢" : rating >= 5 ? "🟡" : "🔴";
            String scannerDecision = rating >= 9 ? "Research Immediately" : rating >= 5 ? "Watchlist" : "Ignore";

            builder.append("Company Snapshot\n");
            builder.append("👉 ").append(context.companyName()).append("\n\n");
            builder.append("Quick Verdict\n");
            builder.append("Rating ").append(String.format("%.1f", rating)).append("/10 - ").append(verdict).append("\n\n");
            builder.append("Order Details\n");
            builder.append("Order Value: ").append(orderValue).append("\n");
            builder.append("Source: ").append(context.link()).append("\n\n");
            builder.append("Overall Rating\n");
            builder.append(String.format("%.1f", rating)).append("/10\n\n");
            builder.append("Scanner Decision\n");
            builder.append(scannerEmoji).append(" ").append(scannerDecision).append("\n\n");
        }

        // Append new fundamental analysis if screening is enabled
        if (screeningEnabled) {
            FundamentalResult result = fundamentalScreener.analyze(context.companyName());

            if (result != null && result.isAvailable()) {

                builder.append("\n--- FUNDAMENTAL ANALYSIS ---\n\n");
                builder.append("FUNDAMENTAL ANALYSIS\n");
                if (result.getCurrentPrice() != null) {
                    builder.append("CMP: ₹").append(formatDouble(result.getCurrentPrice())).append("\n");
                }
                builder.append("Market Cap: ")
                        .append(formatDouble(result.getMarketCapCr()))
                        .append(" Cr — ")
                        .append(nullSafe(result.getMarketCapCategory()))
                        .append("\n");

                builder.append("PE Ratio: ")
                        .append(formatDouble(result.getTrailingPe()))
                        .append(" — ")
                        .append(nullSafe(result.getPeRating()));
                if (result.getPeComparison() != null && !result.getPeComparison().isBlank()) {
                    builder.append(" (").append(result.getPeComparison()).append(")");
                }
                builder.append("\n");

                builder.append("ROCE: ")
                        .append(formatPercent(result.getRocePercent()))
                        .append("% — ")
                        .append(nullSafe(result.getRoceRating()))
                        .append("\n\n");

                builder.append("DEBT ANALYSIS\n");
                builder.append("Debt vs MCap: ").append(nullSafe(result.getDebtVsMarketCapRating())).append("\n");
                builder.append("Debt vs Reserve: ").append(nullSafe(result.getDebtVsReserveRating())).append("\n");
                builder.append("Debt/Assets: ")
                        .append(formatPercent(result.getDebtToAssetsPercent()))
                        .append("% ")
                        .append(nullSafe(result.getDebtToAssetsRating()))
                        .append("\n\n");

                builder.append("LAST 3 QUARTERS\n");
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

                builder.append("EPS: ").append(formatDouble(result.getTrailingEps())).append("\n");
                builder.append("Book Value ratio: ").append(nullSafe(result.getBookValueRating())).append("\n");
                builder.append("Promoter Holding: ")
                        .append(formatPercent(result.getPromoterHoldingPercent()))
                        .append("% ")
                        .append(nullSafe(result.getPromoterHoldingRating()))
                        .append("\n\n");

                builder.append("TECHNICAL\n");
                builder.append("200 EMA: ").append(nullSafe(result.getEma200Rating())).append("\n");
                builder.append("RSI: ").append(nullSafe(result.getRsiRating())).append("\n");
                builder.append("Breakout: ").append(nullSafe(result.getBreakoutRating())).append("\n");

                builder.append("\nDEMAND ZONE\n");
                if (result.getDemandZoneLow() != null) {
                    builder.append("Zone: ₹").append(String.format("%.2f", result.getDemandZoneLow()))
                           .append(" – ₹").append(String.format("%.2f", result.getDemandZoneHigh())).append("\n");
                    builder.append("Distance: ").append(String.format("%.1f", result.getDemandZoneDistancePct())).append("% from current price\n");
                    builder.append("Strength: ").append(nullSafe(result.getDemandZoneStrength())).append("\n");
                    builder.append("Signal: ").append(nullSafe(result.getDemandZoneSignal())).append("\n");
                } else {
                    builder.append("Not detected\n");
                }

                builder.append("\nCOMPOUNDED SALES GROWTH\n");
                builder.append("10Y: ").append(formatPercent(result.getSalesGrowth10Y())).append("% — ").append(salesGrowthLabel(result.getSalesGrowth10Y())).append("\n");
                builder.append("5Y:  ").append(formatPercent(result.getSalesGrowth5Y())).append("% — ").append(salesGrowthLabel(result.getSalesGrowth5Y())).append("\n");
                builder.append("3Y:  ").append(formatPercent(result.getSalesGrowth3Y())).append("% — ").append(salesGrowthLabel(result.getSalesGrowth3Y())).append("\n");
                builder.append("TTM: ").append(formatPercent(result.getSalesGrowthTtm())).append("% — ").append(salesGrowthLabel(result.getSalesGrowthTtm())).append("\n");
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

    private String salesGrowthLabel(Double pct) {
        if (pct == null) return "N/A";
        if (pct >= 30) return "Exceptional";
        if (pct >= 20) return "Excellent";
        if (pct >= 15) return "Very Strong";
        if (pct >= 10) return "Good";
        if (pct >= 5)  return "Decent";
        return "Slow";
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