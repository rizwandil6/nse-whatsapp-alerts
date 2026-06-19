package com.adil.nsealerts;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.*;

@Component
public class AlertPoller {

    @Value("${nse.watchlist}")
    private List<String> watchlist;

    @Value("${nse.circular-keywords}")
    private List<String> circularKeywords;

    private final NseClient nseClient;
    private final WhatsAppSender whatsAppSender;
    private final ObjectMapper mapper = new ObjectMapper();

    // Simple in-memory dedup. Restarts will re-alert once - acceptable for v1.
    private final Set<String> seenIds = new HashSet<>();

    public AlertPoller(NseClient nseClient, WhatsAppSender whatsAppSender) {
        this.nseClient = nseClient;
        this.whatsAppSender = whatsAppSender;
    }

    @Scheduled(fixedDelayString = "${nse.poll-interval-ms}")
    public void poll() {
        checkAnnouncements();
        checkCirculars();
    }

    private void checkAnnouncements() {
        String json = nseClient.fetchAnnouncements();
        if (json == null) return;
        try {
            JsonNode root = mapper.readTree(json);
            for (JsonNode item : root) {
                String symbol = textOf(item, "symbol");
                String subject = textOf(item, "desc", "subject", "attchmntText");
                String id = textOf(item, "an_dt", "seq_id") + "|" + symbol + "|" + subject;

                if (watchlist.contains(symbol) && seenIds.add(id)) {
                    whatsAppSender.send("NSE Announcement - " + symbol + ": " + subject);
                }
            }
        } catch (Exception e) {
            System.err.println("Error parsing announcements: " + e.getMessage());
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

                if (matches && seenIds.add(id)) {
                    whatsAppSender.send("NSE Circular: " + subject);
                }
            }
        } catch (Exception e) {
            System.err.println("Error parsing circulars: " + e.getMessage());
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
