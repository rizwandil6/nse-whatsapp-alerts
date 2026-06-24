package com.adil.nsealerts;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import jakarta.annotation.PostConstruct;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Service
public class TelegramSender {
    private static final Logger logger = LoggerFactory.getLogger(TelegramSender.class);
    private static final int TELEGRAM_MAX_LENGTH = 4096;
    private static final String API_URL = "https://api.telegram.org/bot%s/sendMessage";

    @Value("${telegram.bot-token:}")
    private String botToken;

    private final Environment env;
    private final RestTemplate restTemplate = new RestTemplate();

    public TelegramSender(Environment env) {
        this.env = env;
    }

    @PostConstruct
    void logConfiguration() {
        List<String> chatIds = loadChatIds();
        logger.info("Telegram config loaded: botTokenSet={}, chatIds={}",
                botToken != null && !botToken.isBlank(),
                chatIds.size());
    }

    public void send(String text) {
        List<String> chatIds = loadChatIds();
        if (chatIds.isEmpty()) {
            logger.warn("No Telegram chat IDs configured; skipping send");
            return;
        }
        if (botToken == null || botToken.isBlank()) {
            logger.warn("Telegram bot token not configured; skipping send");
            return;
        }

        List<String> chunks = splitMessage(text);
        for (String chatId : chatIds) {
            for (String chunk : chunks) {
                sendChunk(chatId, chunk);
            }
        }
    }

    private void sendChunk(String chatId, String text) {
        String url = String.format(API_URL, botToken);

        Map<String, String> payload = new HashMap<>();
        payload.put("chat_id", chatId);
        payload.put("text", text);

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<Map<String, String>> request = new HttpEntity<>(payload, headers);

        try {
            restTemplate.postForObject(url, request, String.class);
            logger.info("Sent Telegram message to chat {}", chatId);
        } catch (Exception e) {
            logger.error("Failed to send Telegram message to chat {}: {}", chatId, e.getMessage(), e);
        }
    }

    private List<String> loadChatIds() {
        List<String> ids = new ArrayList<>();
        int index = 0;
        String id;
        while ((id = env.getProperty("telegram.chat-ids[" + index + "]")) != null) {
            String trimmed = id.trim();
            if (!trimmed.isEmpty()) {
                ids.add(trimmed);
            }
            index++;
        }
        return ids;
    }

    /**
     * Splits a message into chunks of at most TELEGRAM_MAX_LENGTH characters,
     * breaking on newlines where possible.
     */
    private List<String> splitMessage(String text) {
        List<String> chunks = new ArrayList<>();
        if (text == null || text.isEmpty()) {
            return chunks;
        }
        while (text.length() > TELEGRAM_MAX_LENGTH) {
            int splitAt = text.lastIndexOf('\n', TELEGRAM_MAX_LENGTH);
            if (splitAt <= 0) {
                splitAt = TELEGRAM_MAX_LENGTH;
            }
            chunks.add(text.substring(0, splitAt));
            text = text.substring(splitAt).stripLeading();
        }
        if (!text.isEmpty()) {
            chunks.add(text);
        }
        return chunks;
    }
}
