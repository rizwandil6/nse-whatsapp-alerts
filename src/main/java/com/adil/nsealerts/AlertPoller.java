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
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

@Component
public class AlertPoller {
    private static final Logger logger = LoggerFactory.getLogger(AlertPoller.class);

    private List<String> watchlist;
    private List<String> circularKeywords;
    private List<String> announcementKeywords;
    private List<String> alertOnlyKeywords;
    private List<String> ignoredKeywords;

    private final NseClient nseClient;
    private final TelegramSender telegramSender;
    private final FundamentalScreener fundamentalScreener;
    private final PromptRatingService promptRatingService;
    private final PdfExtractor pdfExtractor;
    private final ScreenerCheckService screenerCheckService;
    private final UpstoxTradeService upstoxTradeService;
    private final AlertLogService alertLogService;
    private final QuarterlyResultsService quarterlyResultsService;
    private final boolean screeningEnabled;
    private final boolean ignoreSme;
    private final double tradeRatingThreshold;
    private final double alertOnlyRatingThreshold;

    /** Symbols listed on NSE main board (loaded from EQUITY_L.csv at startup). Null = unavailable, don't filter. */
    private volatile Set<String> mainBoardSymbols = null;
    private static final String EQUITY_LIST_URL =
            "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv";
    /** Extracts the NSE symbol from a PDF link, e.g. .../TEXRAIL_24062026...pdf → TEXRAIL */
    private static final Pattern SYMBOL_FROM_LINK = Pattern.compile("/([A-Z0-9&%-]+)_\\d{12,14}_");
    private final ObjectMapper mapper = new ObjectMapper();

    // Dedup set — seeded at startup to suppress re-alerts on redeploy; new entries only thereafter
    private final Set<String> seenIds = new HashSet<>();

    public AlertPoller(NseClient nseClient,
                       TelegramSender telegramSender,
                       FundamentalScreener fundamentalScreener,
                       PromptRatingService promptRatingService,
                       PdfExtractor pdfExtractor,
                       ScreenerCheckService screenerCheckService,
                       UpstoxTradeService upstoxTradeService,
                       AlertLogService alertLogService,
                       QuarterlyResultsService quarterlyResultsService,
                       org.springframework.core.env.Environment env) {
        this.nseClient = nseClient;
        this.telegramSender = telegramSender;
        this.fundamentalScreener = fundamentalScreener;
        this.promptRatingService = promptRatingService;
        this.pdfExtractor = pdfExtractor;
        this.screenerCheckService = screenerCheckService;
        this.upstoxTradeService = upstoxTradeService;
        this.alertLogService = alertLogService;
        this.quarterlyResultsService = quarterlyResultsService;
        this.screeningEnabled = Boolean.parseBoolean(env.getProperty("screening.enabled", "true"));
        this.ignoreSme = Boolean.parseBoolean(env.getProperty("nse.ignore-sme", "true"));
        // Backtest on real Apr-Jul 2026 NSE data (272 announcements) showed rating 5-6
        // performs statistically indistinguishable from 7-8 (54.7% vs 52.6% win rate,
        // +0.27% vs +0.33% avg P&L) while roughly 2.5x-ing trade count — the <5 bucket
        // is the real cutoff that matters (-0.39% avg, 40% win rate). Lowered default
        // from 7 to 5 accordingly; still overridable via env without a redeploy.
        this.tradeRatingThreshold = Double.parseDouble(env.getProperty("nse.trade-rating-threshold", "5.0"));
        this.alertOnlyRatingThreshold = Double.parseDouble(env.getProperty("nse.alert-only-rating-threshold", "8.0"));

        // env.getProperty("nse.watchlist", String[].class) does NOT reliably bind a
        // YAML sequence in this Spring Boot setup -- confirmed live: this loaded as
        // an empty list even with 22 real entries in application.yml (the comma-string
        // fallback below never helps either, since a YAML list isn't a comma string
        // property either). Pre-existing bug, silent since nothing ever depended on
        // watchlist actually being non-empty until the alert-only rating gate today.
        // Switched to the same indexed-property pattern already used successfully for
        // announcementKeywords/alertOnlyKeywords below.
        List<String> watchList = new ArrayList<>();
        int watchIdx = 0; String w;
        while ((w = env.getProperty("nse.watchlist[" + watchIdx + "]")) != null) {
            watchList.add(w); watchIdx++;
        }
        if (watchList.isEmpty()) {
            String watchStr = env.getProperty("nse.watchlist");
            if (watchStr != null && !watchStr.isBlank()) {
                for (String s : watchStr.split(",")) watchList.add(s.trim());
            }
        }
        this.watchlist = watchList;
        logger.info("[AlertPoller] Loaded watchlist: {}", this.watchlist);

        String[] circulars = env.getProperty("nse.circular-keywords", String[].class);
        if (circulars == null) {
            String s = env.getProperty("nse.circular-keywords");
            if (s != null && !s.isEmpty()) {
                circulars = s.split(",");
                for (int i = 0; i < circulars.length; i++) circulars[i] = circulars[i].trim();
            }
        }
        this.circularKeywords = circulars == null ? java.util.Collections.emptyList() : java.util.Arrays.asList(circulars);

        List<String> annKeywords = new ArrayList<>();
        int idx = 0; String kw;
        while ((kw = env.getProperty("nse.announcement-keywords[" + idx + "]")) != null) {
            annKeywords.add(kw); idx++;
        }
        this.announcementKeywords = annKeywords;

        // Alert-only categories (e.g. "Outcome of Board Meeting", which is how NSE
        // actually files results announcements -- see application.yml comment): sent
        // to Telegram like any other announcement, but never reach the AI rating or
        // Upstox trade pipeline below, since that prompt is built around order/contract
        // sizing and doesn't apply here.
        List<String> alertOnly = new ArrayList<>();
        int alertOnlyIdx = 0;
        while ((kw = env.getProperty("nse.alert-only-keywords[" + alertOnlyIdx + "]")) != null) {
            alertOnly.add(kw); alertOnlyIdx++;
        }
        this.alertOnlyKeywords = alertOnly;

        List<String> ignored = new ArrayList<>();
        int ignoreIdx = 0;
        while ((kw = env.getProperty("nse.ignore-keywords[" + ignoreIdx + "]")) != null) {
            ignored.add(kw); ignoreIdx++;
        }
        this.ignoredKeywords = ignored;

        logger.info("[AlertPoller] Announcement keywords: {}", this.announcementKeywords);
        logger.info("[AlertPoller] Alert-only keywords: {}", this.alertOnlyKeywords);
    }

    @PostConstruct
    void loadMainBoardSymbols() {
        if (!ignoreSme) return;
        Thread loader = new Thread(() -> {
            try {
                String csv = new RestTemplate().getForObject(EQUITY_LIST_URL, String.class);
                if (csv == null || csv.isBlank()) return;
                Set<String> symbols = new HashSet<>();
                for (String line : csv.split("\\r?\\n")) {
                    if (!line.isBlank()) symbols.add(line.split(",")[0].trim().toUpperCase(Locale.ROOT));
                }
                mainBoardSymbols = symbols;
                logger.info("[SME filter] Loaded {} main-board symbols", symbols.size());
            } catch (Exception e) {
                logger.warn("[SME filter] Could not load EQUITY_L.csv: {}", e.getMessage());
            }
        }, "equity-list-loader");
        loader.setDaemon(true);
        loader.start();
    }

    /**
     * Silently pre-populate seenIds with whatever is currently on the RSS feed.
     * Runs synchronously before any @Scheduled method fires, so a redeploy (e.g. to
     * refresh the Upstox token) never re-sends announcements that were already alerted.
     */
    @PostConstruct
    void seedSeenIds() {
        try {
            List<SyndEntry> entries = nseClient.fetchAnnouncements();
            if (entries == null) return;
            for (SyndEntry entry : entries) {
                String link = entry.getLink() != null ? entry.getLink() : "";
                String id   = link.isEmpty()
                        ? (entry.getTitle() + ":" + entry.getPublishedDate())
                        : link;
                seenIds.add(id);
            }
            logger.info("[AlertPoller] Seeded {} existing RSS entries — no alerts sent", seenIds.size());
        } catch (Exception e) {
            logger.warn("[AlertPoller] Seed failed ({}); first poll may re-send recent entries", e.getMessage());
        }
    }

    private static final ZoneId    IST          = ZoneId.of("Asia/Kolkata");
    private static final LocalTime MARKET_OPEN  = LocalTime.of(9, 15);
    private static final LocalTime MARKET_CLOSE = LocalTime.of(15, 30);

    /** During market hours: poll every 7 s. Outside: throttle to every 2 min. */
    private volatile long lastNonMarketPollMs = 0;

    @Scheduled(fixedDelay = 7000)
    public void scheduledPoll() {
        ZonedDateTime now = ZonedDateTime.now(IST);
        DayOfWeek day     = now.getDayOfWeek();
        LocalTime time    = now.toLocalTime();
        boolean isMarket  = day != DayOfWeek.SATURDAY && day != DayOfWeek.SUNDAY
                && !time.isBefore(MARKET_OPEN) && !time.isAfter(MARKET_CLOSE);
        if (!isMarket) {
            long nowMs = System.currentTimeMillis();
            if (nowMs - lastNonMarketPollMs < 120_000) return;
            lastNonMarketPollMs = nowMs;
        }
        poll();
    }

    public void poll() {
        logger.info("Polling NSE");
        checkAnnouncements();
        checkCirculars();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Announcements
    // ─────────────────────────────────────────────────────────────────────────

    private void checkAnnouncements() {
        checkAnnouncementsFromRss();
    }

    private void checkAnnouncementsFromRss() {
        List<SyndEntry> entries = nseClient.fetchAnnouncements();
        if (entries == null || entries.isEmpty()) return;

        logger.info("[Announcements] Fetched {} entries from RSS", entries.size());

        for (SyndEntry entry : entries) {
            try {
                String title       = entry.getTitle() != null ? entry.getTitle() : "";
                String description = entry.getDescription() != null ? entry.getDescription().getValue() : "";
                String link        = entry.getLink() != null ? entry.getLink() : "";

                if (ignoreSme && isSmeAnnouncement(entry, title, description)) {
                    logger.info("[SME filter] Skipping announcement: {}", title);
                    continue;
                }

                String id = link.isEmpty() ? (title + ":" + entry.getPublishedDate()) : link;

                boolean excluded = title.contains("(Sub-para 4-Para B)")
                        || description.contains("(Sub-para 4-Para B)")
                        || containsAnyIgnoreKeyword(title, description);

                String combinedText = (title + " " + description).toLowerCase();
                boolean matches = !excluded && (announcementKeywords.isEmpty()
                        || announcementKeywords.stream()
                                .anyMatch(k -> combinedText.contains(k.toLowerCase())));
                boolean alertOnlyMatch = !excluded && !matches
                        && alertOnlyKeywords.stream()
                                .anyMatch(k -> combinedText.contains(k.toLowerCase()));
                // NSE files dividend declarations and their record dates as their OWN
                // dedicated SUBJECT categories -- "Dividend" / "Record Date" -- separate
                // from "Outcome of Board Meeting" (confirmed live 2026-08-03: Great Eastern
                // Shipping filed all three as three separate announcements the same
                // evening). Matched on the literal "subject: ..." suffix RSS already
                // appends to description, not a bare "dividend" keyword -- a bare match
                // would also fire on narrative mentions of a PRIOR dividend inside an
                // unrelated results PDF (confirmed on GlaxoSmithKline's Jun 2026 filing:
                // "...includes Rs. 1800 lakhs on account of dividend received from..."),
                // which isn't a new declaration at all. Record Date is further required to
                // also mention "dividend" since that category also covers AGM/bonus/rights
                // record dates unrelated to a payout.
                boolean isDividendDeclared = !excluded && combinedText.contains("subject: dividend");
                boolean isDividendRecordDate = !excluded && combinedText.contains("subject: record date")
                        && combinedText.contains("dividend");
                boolean dividendMatch = isDividendDeclared || isDividendRecordDate;

                if (matches && seenIds.add(id)) {
                    String pubTime = entry.getPublishedDate() != null
                            ? new java.text.SimpleDateFormat("dd-MMM-yyyy HH:mm:ss").format(entry.getPublishedDate())
                            : "";
                    AnnouncementContext ctx = extractAnnouncementContext(title, description, link, pubTime);
                    logger.info("New announcement: {}", title);
                    // Kick off instrument resolution + an LTP fetch immediately — well
                    // before the PDF-fetch/AI-rating chain below decides whether this
                    // even qualifies to trade. Cheap to call speculatively for every
                    // matched announcement; see UpstoxTradeService.prefetchQuote().
                    upstoxTradeService.prefetchQuote(ctx.symbol(), ctx.companyName());
                    String message = buildAnnouncementMessage(ctx);
                    logger.info("[MSG] {}", message);
                    telegramSender.send(message);
                    alertLogService.logAnnouncement(ctx.symbol(), ctx.companyName(), ctx.subject(), "TRADE_SIGNAL", message);
                } else if (alertOnlyMatch && seenIds.add(id)) {
                    String pubTime = entry.getPublishedDate() != null
                            ? new java.text.SimpleDateFormat("dd-MMM-yyyy HH:mm:ss").format(entry.getPublishedDate())
                            : "";
                    AnnouncementContext ctx = extractAnnouncementContext(title, description, link, pubTime);
                    logger.info("New alert-only announcement: {}", title);
                    handleAlertOnlyAnnouncement(ctx);
                } else if (dividendMatch && seenIds.add(id)) {
                    String pubTime = entry.getPublishedDate() != null
                            ? new java.text.SimpleDateFormat("dd-MMM-yyyy HH:mm:ss").format(entry.getPublishedDate())
                            : "";
                    AnnouncementContext ctx = extractAnnouncementContext(title, description, link, pubTime);
                    logger.info("New dividend announcement: {}", title);
                    handleDividendAnnouncement(ctx, isDividendRecordDate);
                }
            } catch (Exception e) {
                logger.error("Error processing announcement entry", e);
            }
        }
    }

    /**
     * For alert-only categories (see nse.alert-only-keywords): fetches the filed PDF
     * and asks the AI for Positives/Concerns/Overall Assessment on the results
     * themselves -- deliberately no fundamentals (Screener.in) or technicals
     * section, and no order/contract trade pipeline (that rating prompt doesn't
     * apply to results).
     *
     * Send gate: watchlist symbols (nse.watchlist) always send, regardless of
     * rating -- these are the stocks actually being tracked, every board-meeting
     * outcome matters. Everything else (300+ other NSE stocks that also file
     * "Outcome of Board Meeting") only sends if the AI rating clears
     * nse.alert-only-rating-threshold (default 8) -- otherwise this category
     * would fire dozens of times a day for stocks nobody asked about.
     *
     * EXCEPTION (2026-07-30): when the filing specifically looks like a
     * quarterly results announcement (RESULTS_KEYWORDS), the rating fallback
     * is dropped entirely -- Telegram only fires for watchlist holdings. Every
     * company's results still get scraped (Screener.in) and persisted to
     * Postgres either way, since the Quarterly Results dashboard tab is meant
     * to cover the whole market, not just your holdings -- only the Telegram
     * alert itself is holdings-only.
     */
    // "Outcome of Board Meeting" covers far more than results (buybacks, dividends,
    // appointments, mergers...) -- gate the Screener.in quarterly fetch on the
    // filed document actually reading like a results filing, both so the
    // quarterly_results table doesn't fill with irrelevant board-meeting outcomes
    // and so this doesn't add MORE Screener.in load on top of what already runs
    // for the TRADE_SIGNAL path (see today's whole rate-limiting investigation).
    private static final List<String> RESULTS_KEYWORDS = java.util.Arrays.asList(
            "financial results", "quarterly results", "results for the quarter",
            "unaudited financial results", "audited financial results", "quarter ended");

    private void handleAlertOnlyAnnouncement(AnnouncementContext ctx) {
        boolean isWatchlisted = watchlist.stream().anyMatch(w -> matchesWatchlistSymbol(w, ctx.symbol()));

        String pdfText = pdfExtractor.extractText(ctx.link());
        String documentText = pdfText != null && !pdfText.isBlank() ? pdfText : ctx.subject();

        // Computed unconditionally (not just under screeningEnabled) since it also
        // drives the Telegram send-gate below, independent of whether the Screener.in
        // fetch itself ran.
        String lower = (ctx.subject() + " " + documentText).toLowerCase();
        boolean looksLikeResults = RESULTS_KEYWORDS.stream().anyMatch(lower::contains);

        if (screeningEnabled && looksLikeResults) {
            try {
                FundamentalResult fr = fundamentalScreener.analyze(ctx.companyName());
                java.time.OffsetDateTime announcementDate = ctx.broadcastTimeMs() > 0
                        ? java.time.Instant.ofEpochMilli(ctx.broadcastTimeMs()).atOffset(java.time.ZoneOffset.UTC)
                        : java.time.OffsetDateTime.now(java.time.ZoneOffset.UTC);
                // Stored for EVERY company that files results, regardless of watchlist --
                // the Quarterly Results dashboard tab is meant to cover the whole market,
                // not just your holdings. Only the TELEGRAM alert below is holdings-only.
                // The AI judgment attached to this row is computed separately inside
                // QuarterlyResultsService from the YoY/QoQ NUMBERS, not this PDF --
                // see PromptRatingService.judgeQuarterlyTrend's docstring for why.
                //
                // Uses fr.getSymbol() (Screener.in's own resolved ticker), NOT
                // ctx.symbol() -- confirmed live, 2026-07-30: ctx.symbol() comes from
                // NSE's archive PDF filename ("/corporate/{code}_..."), and filers
                // routinely name that file with something that ISN'T the real ticker
                // (RadhaWestlife_...pdf for WESTLIFE, 532783_...pdf -- a BSE scrip code
                // -- for LTFOODS, Pooja_...pdf for M&M). Same root cause already
                // documented for SUZLON1 above, just a different symptom (an
                // unrelated word/code instead of a numeric suffix) -- that fix only
                // covers the watchlist-matching fallback, not this primary path.
                // fr.getSymbol() is set from a real Screener.in company-name search,
                // reliable whenever fr.isAvailable() (verified against these exact
                // 3 companies before applying this fix).
                String resolvedSymbol = fr.getSymbol() != null && !fr.getSymbol().isBlank() ? fr.getSymbol() : ctx.symbol();
                quarterlyResultsService.recordIfAvailable(resolvedSymbol, ctx.companyName(), fr,
                        "Outcome of Board Meeting", announcementDate, ctx.link());
            } catch (Exception e) {
                logger.warn("[QuarterlyResults] fetch/record failed for {}: {}", ctx.companyName(), e.getMessage());
            }
        }

        PromptRatingService.BoardMeetingAnalysis analysis =
                promptRatingService.analyzeBoardMeetingPdf(ctx.companyName(), ctx.subject(), documentText);

        boolean clearsRatingBar = analysis.rating() != null && analysis.rating() >= alertOnlyRatingThreshold;
        // Results specifically: alert ONLY on holdings (nse.watchlist) -- the AI-rating
        // fallback that lets other high-rated alert-only categories (dividends,
        // buybacks, etc.) through for non-watchlist stocks deliberately does NOT apply
        // here, since results are stored for every company in Postgres/the dashboard
        // tab regardless -- Telegram is reserved for what you actually hold.
        boolean suppressed = looksLikeResults ? !isWatchlisted : (!isWatchlisted && !clearsRatingBar);
        if (suppressed) {
            logger.info("[AlertOnly] Suppressed ({}, not on watchlist{}): {}",
                    looksLikeResults ? "results" : "rating " + analysis.rating() + " < " + alertOnlyRatingThreshold,
                    looksLikeResults ? "" : " and rating too low", ctx.companyName());
            return;
        }

        StringBuilder sb = new StringBuilder();
        sb.append("📄 *").append(ctx.companyName()).append("* — ").append(ctx.subject()).append("\n");
        if (ctx.broadcastTime() != null && !ctx.broadcastTime().isBlank()) {
            sb.append("Broadcast: ").append(ctx.broadcastTime()).append("\n");
        }
        sb.append("\n");

        if (analysis.message() != null && !analysis.message().isBlank()) {
            sb.append(analysis.message()).append("\n\n");
        } else if (!isWatchlisted) {
            // Non-watchlist stock with no usable analysis -- can't confirm it clears the
            // rating bar, so don't send (matches the suppression path above).
            logger.info("[AlertOnly] Suppressed (not on watchlist, analysis unavailable): {}", ctx.companyName());
            return;
        }

        sb.append("Source: ").append(ctx.link());
        String message = sb.toString();
        telegramSender.send(message, "Markdown");
        alertLogService.logAnnouncement(ctx.symbol(), ctx.companyName(), ctx.subject(), "ALERT_ONLY", message);
    }

    // "Rs. 14.40" or "Rs.14.40" -- confirmed against Great Eastern Shipping's real
    // 2026-08-03 filing: "declared Interim Dividend of Rs. 14.40 per equity share."
    // Also matches Final/Special dividend phrasing (only the "Dividend of Rs. X per
    // equity share" tail is required, not the qualifier word before "Dividend").
    private static final Pattern DIVIDEND_AMOUNT_PATTERN = Pattern.compile(
            "Dividend\\s+of\\s+Rs\\.?\\s*([\\d,]+(?:\\.\\d+)?)\\s*per\\s+equity\\s+share", Pattern.CASE_INSENSITIVE);
    // "Record date for the purpose of Dividend is 07-Aug-2026." -- same real filing.
    private static final Pattern DIVIDEND_RECORD_DATE_PATTERN = Pattern.compile(
            "Record\\s+date\\s+for\\s+the\\s+purpose\\s+of\\s+Dividend\\s+is\\s+(\\d{1,2}-[A-Za-z]{3}-\\d{4})",
            Pattern.CASE_INSENSITIVE);

    /**
     * Dividend declarations and their record dates arrive from NSE as two SEPARATE
     * announcements (confirmed live 2026-08-03, Great Eastern Shipping filed them
     * ~2 minutes apart), not one combined filing -- so this sends a distinct alert
     * per announcement rather than trying to correlate the two into one message,
     * which would need persistent cross-announcement state and could get stuck
     * half-complete if the other half never arrives (or arrived days earlier/later,
     * e.g. a record date set well after the declaration). No PDF fetch, no AI
     * rating, no Screener/trade pipeline -- NSE's own one-line description already
     * has the number this alert needs.
     *
     * Watchlist-only, same noise-avoidance philosophy as handleAlertOnlyAnnouncement,
     * simpler here since there's no AI rating to fall back on for non-watchlist
     * stocks -- dividends fire for 100+ stocks some evenings.
     */
    private void handleDividendAnnouncement(AnnouncementContext ctx, boolean isRecordDate) {
        boolean isWatchlisted = watchlist.stream().anyMatch(w -> matchesWatchlistSymbol(w, ctx.symbol()));
        if (!isWatchlisted) {
            logger.info("[Dividend] Suppressed (not on watchlist): {}", ctx.companyName());
            return;
        }

        StringBuilder sb = new StringBuilder();
        sb.append("💰 *DIVIDEND ALERT* — ").append(ctx.companyName()).append("\n");
        if (isRecordDate) {
            Matcher m = DIVIDEND_RECORD_DATE_PATTERN.matcher(ctx.subject());
            if (m.find()) {
                sb.append("Record Date: ").append(m.group(1)).append("\n");
            } else {
                logger.warn("[Dividend] Record-date phrasing didn't match the expected pattern for {}: {}",
                        ctx.companyName(), ctx.subject());
                sb.append(ctx.subject()).append("\n");
            }
        } else {
            Matcher m = DIVIDEND_AMOUNT_PATTERN.matcher(ctx.subject());
            if (m.find()) {
                sb.append("Amount: Rs. ").append(m.group(1)).append(" per equity share\n");
            } else {
                logger.warn("[Dividend] Amount phrasing didn't match the expected pattern for {}: {}",
                        ctx.companyName(), ctx.subject());
                sb.append(ctx.subject()).append("\n");
            }
        }
        if (ctx.broadcastTime() != null && !ctx.broadcastTime().isBlank()) {
            sb.append("Broadcast: ").append(ctx.broadcastTime()).append("\n");
        }
        sb.append("Source: ").append(ctx.link());

        String message = sb.toString();
        telegramSender.send(message, "Markdown");
        alertLogService.logAnnouncement(ctx.symbol(), ctx.companyName(), ctx.subject(), "DIVIDEND_ALERT", message);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Build announcement message — clean, no markdown tables
    // ─────────────────────────────────────────────────────────────────────────

    private String buildAnnouncementMessage(AnnouncementContext ctx) {
        String pdfText     = pdfExtractor.extractText(ctx.link());
        String documentText = pdfText != null && !pdfText.isBlank() ? pdfText : ctx.subject();

        // Kick off the fundamentals/market-cap fetch in parallel with the AI rating call
        // instead of after it — the AI call already takes 1-3s, so this piggybacks on that
        // latency instead of adding to it, and the same result is reused below instead of
        // scraping Screener.in twice for the same symbol.
        CompletableFuture<FundamentalResult> fundamentalsFuture = screeningEnabled
                ? CompletableFuture.supplyAsync(() -> fundamentalScreener.analyze(ctx.companyName()))
                : CompletableFuture.completedFuture(null);

        AnalysisResult result = promptRatingService.analyze(
                ctx.companyName(), ctx.subject(), ctx.link(), documentText);

        // Fire the trade IMMEDIATELY on the raw AI rating — do NOT wait on the
        // fundamentals/market-cap fetch here. That's a Screener.in scrape that can
        // take several seconds, and every second here is a second of price movement
        // that's already happened before the order goes out. The market-cap
        // adjustment below still runs and still affects the alert message/logging,
        // just not entry timing. Symbol resolution for known NSE-archive-vs-ticker
        // mismatches (e.g. IONEXCHANGE vs IONEXCHANG) is now handled via
        // UpstoxTradeService's manual alias map instead of waiting on a Screener
        // lookup for the correct symbol — see MANUAL_SYMBOL_ALIASES.
        if (result != null && result.getRating() >= tradeRatingThreshold) {
            upstoxTradeService.executeIfEligible(ctx.symbol(), (int) Math.round(result.getRating()), ctx.broadcastTimeMs());
        }

        FundamentalResult fr = null;
        try {
            fr = fundamentalsFuture.get(8, TimeUnit.SECONDS);
        } catch (Exception e) {
            logger.warn("[Fundamentals] fetch for {} did not complete in time: {}", ctx.companyName(), e.getMessage());
        }

        AnalysisResult displayResult = adjustRatingForMarketCapImpact(result, fr);

        StringBuilder sb = new StringBuilder();

        // Broadcast time header
        if (ctx.broadcastTime() != null && !ctx.broadcastTime().isBlank()) {
            sb.append("Broadcast: ").append(ctx.broadcastTime()).append("\n");
        }

        // AI analysis block (company name, rating, order summary, verdict, source, scanner)
        if (displayResult != null && displayResult.getWhatsappMessage() != null && !displayResult.getWhatsappMessage().isBlank()) {
            sb.append(displayResult.getWhatsappMessage()).append("\n");
        } else {
            // Fallback header if AI unavailable
            sb.append(ctx.companyName()).append("\n");
            sb.append("Source: ").append(ctx.link()).append("\n");
        }

        // Fundamental analysis (existing screener) — reuses the fr fetched above
        if (screeningEnabled) {
            if (fr != null && fr.isAvailable()) {
                sb.append("\n--- FUNDAMENTAL ANALYSIS ---\n\n");
                appendFundamentals(sb, fr);
            } else if (fr != null && fr.getUnavailableMessage() != null) {
                sb.append("\n").append(fr.getUnavailableMessage()).append("\n");
            }
        }

        // 13-criteria check from Screener.in
        String check13 = screenerCheckService.check(ctx.symbol(), ctx.companyName());
        if (check13 != null && !check13.isBlank()) {
            sb.append(check13);
        }

        return sb.toString();
    }

    /**
     * Order-value-as-%-of-market-cap proxy for expected price impact: the same order
     * size that barely dents a large cap's revenue-weighted rating can move a small
     * cap's price sharply, which is closer to what actually gets traded intraday.
     * Deliberately simple, unvalidated heuristic — tune or replace once TradeLog /
     * shadow-mode data shows whether it actually helps (see TradeLog.java).
     */
    private AnalysisResult adjustRatingForMarketCapImpact(AnalysisResult result, FundamentalResult fr) {
        if (result == null || fr == null || !fr.isAvailable()) return result;
        Double marketCapCr = fr.getMarketCapCr();
        Double orderSizeCr = result.getOrderSizeCrores();
        if (marketCapCr == null || marketCapCr <= 0 || orderSizeCr == null) return result;

        double ratioPct = orderSizeCr / marketCapCr * 100.0;
        double rating = result.getRating();
        double adjusted = rating;
        if (ratioPct >= 10.0)      adjusted = Math.min(10.0, rating + 2.0);
        else if (ratioPct >= 3.0)  adjusted = Math.min(10.0, rating + 1.0);
        else if (ratioPct < 0.05)  adjusted = Math.max(1.0, rating - 1.0);

        if (adjusted == rating) return result;

        logger.info("[Rating] {} adjusted {} -> {} (order/mcap ratio {}%)",
                fr.getSymbol(), rating, adjusted, String.format("%.2f", ratioPct));
        return new AnalysisResult(adjusted, result.getOrderSizeCrores(), result.getQuickVerdict(),
                result.getSummary(), result.getImpactLevel(), result.getWhatsappMessage());
    }

    private void appendFundamentals(StringBuilder sb, FundamentalResult r) {
        sb.append("FUNDAMENTAL ANALYSIS\n");
        if (r.getCurrentPrice() != null)
            sb.append("CMP: ₹").append(fmt(r.getCurrentPrice())).append("\n");
        sb.append("Market Cap: ").append(fmt(r.getMarketCapCr())).append(" Cr — ")
          .append(safe(r.getMarketCapCategory())).append("\n");
        sb.append("PE Ratio: ").append(fmt(r.getTrailingPe())).append(" — ")
          .append(safe(r.getPeRating()));
        if (r.getPeComparison() != null && !r.getPeComparison().isBlank())
            sb.append(" (").append(r.getPeComparison()).append(")");
        sb.append("\n");
        sb.append("ROCE: ").append(fmtPct(r.getRocePercent())).append("% — ")
          .append(safe(r.getRoceRating())).append("\n\n");

        sb.append("DEBT ANALYSIS\n");
        sb.append("Debt vs MCap: ").append(safe(r.getDebtVsMarketCapRating())).append("\n");
        sb.append("Debt vs Reserve: ").append(safe(r.getDebtVsReserveRating())).append("\n");
        sb.append("Debt/Assets: ").append(fmtPct(r.getDebtToAssetsPercent())).append("% ")
          .append(safe(r.getDebtToAssetsRating())).append("\n\n");

        sb.append("LAST 3 QUARTERS\n");
        sb.append("Revenue: ").append(fmtSeries(r.getQuarterlyRevenueCr())).append(" Cr ")
          .append(safe(r.getQuarterlyRevenueTrend())).append("\n");
        sb.append("Net Profit: ").append(fmtSeries(r.getQuarterlyNetProfitCr())).append(" Cr ")
          .append(safe(r.getQuarterlyNetProfitTrend())).append("\n\n");

        sb.append("EPS: ").append(fmt(r.getTrailingEps())).append("\n");
        sb.append("Book Value ratio: ").append(safe(r.getBookValueRating())).append("\n");
        sb.append("Promoter Holding: ").append(fmtPct(r.getPromoterHoldingPercent())).append("% ")
          .append(safe(r.getPromoterHoldingRating())).append("\n\n");

        sb.append("TECHNICAL\n");
        sb.append("200 EMA: ").append(safe(r.getEma200Rating())).append("\n");
        sb.append("RSI: ").append(safe(r.getRsiRating())).append("\n");
        sb.append("Breakout: ").append(safe(r.getBreakoutRating())).append("\n");

        sb.append("\nDEMAND ZONE\n");
        if (r.getDemandZoneLow() != null) {
            sb.append("Zone: ₹").append(String.format("%.2f", r.getDemandZoneLow()))
              .append(" – ₹").append(String.format("%.2f", r.getDemandZoneHigh())).append("\n");
            sb.append("Distance: ").append(String.format("%.1f", r.getDemandZoneDistancePct()))
              .append("% from current price\n");
            sb.append("Strength: ").append(safe(r.getDemandZoneStrength())).append("\n");
            sb.append("Signal: ").append(safe(r.getDemandZoneSignal())).append("\n");
        } else {
            sb.append("Not detected\n");
        }

        sb.append("\nCOMPOUNDED SALES GROWTH\n");
        sb.append("10Y: ").append(fmtPct(r.getSalesGrowth10Y())).append("% — ").append(growthLabel(r.getSalesGrowth10Y())).append("\n");
        sb.append("5Y:  ").append(fmtPct(r.getSalesGrowth5Y())).append("% — ").append(growthLabel(r.getSalesGrowth5Y())).append("\n");
        sb.append("3Y:  ").append(fmtPct(r.getSalesGrowth3Y())).append("% — ").append(growthLabel(r.getSalesGrowth3Y())).append("\n");
        sb.append("TTM: ").append(fmtPct(r.getSalesGrowthTtm())).append("% — ").append(growthLabel(r.getSalesGrowthTtm())).append("\n");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Circulars
    // ─────────────────────────────────────────────────────────────────────────

    private void checkCirculars() {
        String json = nseClient.fetchCirculars();
        if (json == null) return;
        try {
            JsonNode root = mapper.readTree(json);
            JsonNode list = root.has("data") ? root.get("data") : root;
            for (JsonNode item : list) {
                String subject = textOf(item, "sub", "subject", "circNo");
                String id      = textOf(item, "circNo", "subject");
                boolean matches = circularKeywords.stream()
                        .anyMatch(k -> subject.toLowerCase().contains(k.toLowerCase()));
                if (matches && !containsAnyIgnoreKeyword(subject, "") && seenIds.add(id)) {
                    telegramSender.send("NSE Circular: " + subject);
                    alertLogService.logAnnouncement("", "", subject, "CIRCULAR", "NSE Circular: " + subject);
                }
            }
        } catch (Exception e) {
            logger.error("Error parsing circulars", e);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SME filter
    // ─────────────────────────────────────────────────────────────────────────

    private boolean isSmeAnnouncement(SyndEntry entry, String title, String description) {
        String link = entry.getLink() != null ? entry.getLink().toUpperCase(Locale.ROOT) : "";
        if (!link.isEmpty()) {
            Matcher m = SYMBOL_FROM_LINK.matcher(link);
            if (m.find()) {
                String symbol = m.group(1);
                if (symbol.endsWith("SME") || symbol.contains("-SME")) return true;
                if (mainBoardSymbols != null) return !mainBoardSymbols.contains(symbol);
            }
        }
        if (entry.getCategories() != null) {
            for (SyndCategory cat : entry.getCategories()) {
                if (cat.getName() != null) {
                    String name = cat.getName().toUpperCase(Locale.ROOT);
                    if (name.contains("EMERGE") || name.contains("SME")) return true;
                }
            }
        }
        String haystack = (title + " " + description).toUpperCase(Locale.ROOT);
        return haystack.contains("NSE EMERGE") || haystack.contains("NSE SME")
                || haystack.contains("EMERGE PLATFORM") || haystack.contains("SME PLATFORM");
    }

    private boolean containsAnyIgnoreKeyword(String title, String description) {
        String haystack = (title + " " + description).toLowerCase();
        return ignoredKeywords.stream()
                .filter(Objects::nonNull).map(String::trim).filter(s -> !s.isEmpty())
                .map(String::toLowerCase).anyMatch(haystack::contains);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Context extraction
    // ─────────────────────────────────────────────────────────────────────────

    private AnnouncementContext extractAnnouncementContext(String title, String description, String link, String broadcastTime) {
        String cleanTitle   = title == null ? "" : title.trim();
        String companyName  = extractCompanyName(cleanTitle);
        String subject      = extractSubject(cleanTitle, description);

        // 1. Best source: NSE archive PDF links encode the symbol AND timestamp directly.
        //    Pattern: /corporate/ENIL_04072026104335_filename.pdf
        //             symbol = ENIL, timestamp = 04072026104335 (DDMMyyyyHHmmss)
        String symbol = "";
        if (link != null && !link.isBlank()) {
            Matcher lm = Pattern.compile("/corporate/([A-Z0-9&%]+)_(\\d{14})_", Pattern.CASE_INSENSITIVE).matcher(link);
            if (lm.find()) {
                symbol = lm.group(1).toUpperCase(Locale.ROOT);
                if (broadcastTime == null || broadcastTime.isBlank()) {
                    try {
                        LocalDateTime dt = LocalDateTime.parse(lm.group(2),
                                DateTimeFormatter.ofPattern("ddMMyyyyHHmmss"));
                        broadcastTime = dt.format(DateTimeFormatter.ofPattern("dd-MMM-yyyy HH:mm:ss"));
                    } catch (Exception ignored) {}
                }
            }
        }
        // 2. Fallback: watchlist scan across title + description + company name
        if (symbol.isBlank()) symbol = extractSymbol(cleanTitle, description, companyName);
        // 3. Last resort: company name itself (best-effort for Screener lookup)
        if (symbol.isBlank()) symbol = companyName.isBlank() ? "NSE" : companyName;

        return new AnnouncementContext(
                companyName.isBlank() ? cleanTitle : companyName,
                symbol, subject.isBlank() ? cleanTitle : subject, link, broadcastTime,
                parseBroadcastTimeMs(broadcastTime));
    }

    private String extractCompanyName(String title) {
        return splitTitle(title)[0].trim();
    }

    private String extractSubject(String title, String description) {
        String part = splitTitle(title)[1];
        return part.isBlank() ? (description == null ? "" : description.trim()) : part;
    }

    private String extractSymbol(String title, String description, String companyName) {
        String haystack = (title + " " + description + " " + companyName).toUpperCase(Locale.ROOT);
        for (String item : watchlist) {
            if (item == null || item.isBlank()) continue;
            String candidate = item.trim().toUpperCase(Locale.ROOT);
            if (containsWholeWord(haystack, candidate)) return candidate;
        }
        return companyName == null ? "" : companyName.trim().toUpperCase(Locale.ROOT);
    }

    private String[] splitTitle(String title) {
        if (title == null || title.isBlank()) return new String[]{"", ""};
        for (String sep : new String[]{" - ", " : ", " | ", " – ", " — "}) {
            int i = title.indexOf(sep);
            if (i > 0 && i < title.length() - sep.length())
                return new String[]{title.substring(0, i).trim(), title.substring(i + sep.length()).trim()};
        }
        return new String[]{title.trim(), ""};
    }

    private boolean containsWholeWord(String text, String term) {
        return Pattern.compile("(?i)(?<![A-Z0-9])" + Pattern.quote(term) + "(?![A-Z0-9])").matcher(text).find();
    }

    /**
     * Real incident, 2026-07-28: SUZLON's quarterly results ("Outcome of Board
     * Meeting", alert-only category) never sent, despite SUZLON being on
     * nse.watchlist. Root cause: the symbol is extracted from the NSE archive
     * PDF filename (extractAnnouncementContext's SYMBOL_FROM_LINK-style regex),
     * and NSE consistently files Suzlon's PDFs under the internal code
     * "SUZLON1" (trailing digit), not the plain ticker "SUZLON" -- confirmed
     * against the actual announcements log, where every past Suzlon entry was
     * already stored as "SUZLON1". A plain equalsIgnoreCase watchlist check
     * silently failed on that extra digit and fell through to the AI-rating
     * gate instead, which this particular filing didn't clear.
     *
     * Fix: also match when the extracted symbol is the watchlist entry plus a
     * purely-numeric suffix (handles this NSE filer-code quirk generically,
     * not just for SUZLON specifically, without loosening the match enough to
     * confuse genuinely different symbols that happen to share a prefix).
     */
    private boolean matchesWatchlistSymbol(String watchlistEntry, String extractedSymbol) {
        if (watchlistEntry == null || extractedSymbol == null) return false;
        if (watchlistEntry.equalsIgnoreCase(extractedSymbol)) return true;
        String w = watchlistEntry.toUpperCase(Locale.ROOT);
        String s = extractedSymbol.toUpperCase(Locale.ROOT);
        if (s.length() > w.length() && s.startsWith(w)) {
            String suffix = s.substring(w.length());
            return suffix.chars().allMatch(Character::isDigit);
        }
        return false;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Formatting helpers
    // ─────────────────────────────────────────────────────────────────────────

    private String fmt(Double v)    { return v == null ? "N/A" : String.format(Locale.US, "%.2f", v); }
    private String fmtPct(Double v) { return v == null ? "N/A" : String.format(Locale.US, "%.2f", v); }
    private String safe(String v)   { return v == null || v.isBlank() ? "N/A" : v; }

    private String fmtSeries(List<Double> values) {
        if (values == null || values.isEmpty()) return "N/A";
        List<String> parts = new ArrayList<>();
        for (Double v : values) parts.add(fmt(v));
        return String.join(" → ", parts);
    }

    private String growthLabel(Double pct) {
        if (pct == null) return "N/A";
        if (pct >= 30) return "Exceptional";
        if (pct >= 20) return "Excellent";
        if (pct >= 15) return "Very Strong";
        if (pct >= 10) return "Good";
        if (pct >= 5)  return "Decent";
        return "Slow";
    }

    private String textOf(JsonNode node, String... fields) {
        for (String f : fields)
            if (node.has(f) && !node.get(f).isNull()) return node.get(f).asText();
        return "";
    }

    private static final DateTimeFormatter BROADCAST_TIME_FORMAT =
            DateTimeFormatter.ofPattern("dd-MMM-yyyy HH:mm:ss", Locale.ENGLISH);

    /** Epoch millis for the "dd-MMM-yyyy HH:mm:ss" broadcast time string, interpreted as IST. 0 if unparseable. */
    private long parseBroadcastTimeMs(String broadcastTime) {
        if (broadcastTime == null || broadcastTime.isBlank()) return 0L;
        try {
            LocalDateTime dt = LocalDateTime.parse(broadcastTime, BROADCAST_TIME_FORMAT);
            return dt.atZone(IST).toInstant().toEpochMilli();
        } catch (Exception e) {
            return 0L;
        }
    }

    private record AnnouncementContext(String companyName, String symbol, String subject, String link,
                                        String broadcastTime, long broadcastTimeMs) {}
}
