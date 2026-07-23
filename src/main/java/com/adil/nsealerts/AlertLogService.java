package com.adil.nsealerts;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.event.EventListener;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Durable log of what NewsPoller and AlertPoller actually send to Telegram —
 * neither previously persisted anything beyond the SLF4J log line, so the
 * dashboard's Market News and Announcements tabs had nothing to read. Mirrors
 * the tracked-state pattern already used by rs-momentum-strategy-live and
 * multibagger-screener (append to an in-memory list, mirror to a local file,
 * sync to GitHub) but written to a DEDICATED branch (data/web-alerts-log),
 * not main -- this service still needs to push on every new alert for the
 * dashboard to feel live, and only a dedicated branch makes frequent pushes
 * safe (main pushes redeploy every other Railway service in the repo).
 */
@Component
public class AlertLogService {
    private static final Logger logger = LoggerFactory.getLogger(AlertLogService.class);
    private static final String DATA_BRANCH = "data/web-alerts-log";
    private static final String NEWS_LOG_PATH = "market_news_log.json";
    private static final String ANNOUNCEMENTS_LOG_PATH = "nse_announcements_log.json";
    private static final int MAX_ENTRIES = 500;

    private final GithubJsonStore store;
    private final ObjectMapper mapper = new ObjectMapper();

    private final List<ObjectNode> newsLog = Collections.synchronizedList(new ArrayList<>());
    private final List<ObjectNode> announcementsLog = Collections.synchronizedList(new ArrayList<>());

    public AlertLogService(GithubJsonStore store) {
        this.store = store;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void loadFromRemote() {
        loadInto(newsLog, NEWS_LOG_PATH, "market news");
        loadInto(announcementsLog, ANNOUNCEMENTS_LOG_PATH, "announcements");
    }

    private void loadInto(List<ObjectNode> target, String path, String label) {
        JsonNode remote = store.readJson(DATA_BRANCH, path);
        if (remote == null || !remote.isArray()) {
            logger.info("[AlertLogService] No existing {} log on {} — starting fresh.", label, DATA_BRANCH);
            return;
        }
        for (JsonNode n : remote) target.add((ObjectNode) n);
        logger.info("[AlertLogService] Loaded {} {} entries from {}.", target.size(), label, DATA_BRANCH);
    }

    public void logMarketNews(String title, String impact, String source, String publishedAt, int score) {
        ObjectNode entry = mapper.createObjectNode();
        entry.put("timestamp", nowIst());
        entry.put("title", title);
        entry.put("impact", impact);
        entry.put("source", source);
        entry.put("publishedAt", publishedAt);
        entry.put("score", score);
        append(newsLog, entry, NEWS_LOG_PATH, "market news");
    }

    public void logAnnouncement(String symbol, String companyName, String subject, String category, String message) {
        ObjectNode entry = mapper.createObjectNode();
        entry.put("timestamp", nowIst());
        entry.put("symbol", symbol);
        entry.put("companyName", companyName);
        entry.put("subject", subject);
        entry.put("category", category); // TRADE_SIGNAL | ALERT_ONLY | CIRCULAR
        entry.put("message", message);
        append(announcementsLog, entry, ANNOUNCEMENTS_LOG_PATH, "announcement");
    }

    private void append(List<ObjectNode> log, ObjectNode entry, String path, String label) {
        log.add(entry);
        while (log.size() > MAX_ENTRIES) log.remove(0);
        // Fire-and-forget, same convention as BulletinController's trigger endpoint --
        // avoids blocking the alert-sending flow on a GitHub round trip.
        new Thread(() -> pushToGithub(log, path, label)).start();
    }

    private void pushToGithub(List<ObjectNode> log, String path, String label) {
        try {
            ArrayNode arr = mapper.createArrayNode();
            List<ObjectNode> snapshot;
            synchronized (log) { snapshot = new ArrayList<>(log); }
            snapshot.forEach(arr::add);
            String content = mapper.writerWithDefaultPrettyPrinter().writeValueAsString(arr);
            String dateLabel = LocalDate.now(ZoneId.of("Asia/Kolkata")).toString();
            store.writeJson(DATA_BRANCH, path, content, "Dashboard " + label + " log update (" + dateLabel + ")");
        } catch (Exception e) {
            logger.warn("[AlertLogService] Push failed for {}: {}", path, e.getMessage());
        }
    }

    public List<ObjectNode> getMarketNews() {
        synchronized (newsLog) { return new ArrayList<>(newsLog); }
    }

    public List<ObjectNode> getAnnouncements() {
        synchronized (announcementsLog) { return new ArrayList<>(announcementsLog); }
    }

    private String nowIst() {
        return ZonedDateTime.now(ZoneId.of("Asia/Kolkata")).format(DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss"));
    }
}
