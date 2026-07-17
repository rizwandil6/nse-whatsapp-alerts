package com.adil.nsealerts;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.event.EventListener;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestTemplate;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;

/**
 * Keeps TradeLog's trades.csv durable across Railway redeploys by syncing it
 * with GitHub — same "single daily commit via the Contents API" pattern
 * already used by multibagger-screener/git_state.js and the other Node
 * strategies in this repo (the git binary isn't present in most buildpack
 * images, so this uses GitHub's REST API directly instead of shelling out).
 *
 * This exists because trades.csv previously lived only on Railway's
 * ephemeral container disk (see TradeLog's own caveat) — a redeploy silently
 * erased the day's trade history, which is exactly what happened checking
 * 2026-07-16's market-hours activity: the container that ran through market
 * close was replaced at 19:38 IST and its trades.csv (and stdout log window)
 * were both gone.
 *
 * Pulls the latest committed trades.csv down on startup (so a redeploy
 * resumes from history instead of an empty file), then pushes once a day
 * after market close — NOT per-trade, since every push here is a real git
 * commit on main and (per this project's established rule) redeploys every
 * other Railway service in the repo, including their in-memory state.
 */
@Component
public class TradeLogGitSync {
    private static final Logger logger = LoggerFactory.getLogger(TradeLogGitSync.class);

    private static final String REPO_OWNER = "rizwandil6";
    private static final String REPO_NAME = "nse-whatsapp-alerts";
    private static final String BRANCH = "main";
    private static final String GITHUB_API = "https://api.github.com";

    @Value("${tradelog.path:trades.csv}")
    private String localPath;

    @Value("${github.token:}")
    private String githubToken;

    private final RestTemplate restTemplate = new RestTemplate();
    private final ObjectMapper mapper = new ObjectMapper();

    @EventListener(ApplicationReadyEvent.class)
    public void syncFromRemoteOnStartup() {
        if (githubToken == null || githubToken.isBlank()) {
            logger.warn("[TradeLogGitSync] GITHUB_TOKEN not set — trades.csv will not sync from or push to GitHub, local-only this session.");
            return;
        }
        try {
            JsonNode remote = getRemoteFile();
            if (remote == null) {
                logger.info("[TradeLogGitSync] No trades.csv committed yet — starting with a fresh local file.");
                return;
            }
            String content = new String(Base64.getMimeDecoder().decode(remote.get("content").asText()), StandardCharsets.UTF_8);
            Files.writeString(Path.of(localPath), content);
            logger.info("[TradeLogGitSync] Synced trades.csv from GitHub ({} bytes).", content.length());
        } catch (Exception e) {
            logger.error("[TradeLogGitSync] Startup sync failed — proceeding with local file as-is: {}", e.getMessage(), e);
        }
    }

    /**
     * 15:35 IST, weekdays — 5 minutes after market close, matching the other
     * daily-batch strategies in this repo. Only pushes if the file actually
     * changed since the last commit.
     */
    @Scheduled(cron = "0 35 15 * * MON-FRI", zone = "Asia/Kolkata")
    public void pushDaily() {
        if (githubToken == null || githubToken.isBlank()) {
            logger.warn("[TradeLogGitSync] GITHUB_TOKEN not set — skipping daily trades.csv push.");
            return;
        }
        if (!Files.exists(Path.of(localPath))) {
            logger.info("[TradeLogGitSync] No trades.csv on disk yet — nothing to push.");
            return;
        }
        try {
            String localContent = Files.readString(Path.of(localPath));
            JsonNode remote = getRemoteFile();
            if (remote != null) {
                String remoteContent = new String(Base64.getMimeDecoder().decode(remote.get("content").asText()), StandardCharsets.UTF_8);
                if (remoteContent.equals(localContent)) {
                    logger.info("[TradeLogGitSync] trades.csv unchanged since last push — nothing to commit.");
                    return;
                }
            }
            putRemoteFile(localContent, remote == null ? null : remote.get("sha").asText());
            logger.info("[TradeLogGitSync] Pushed trades.csv to GitHub ({} bytes).", localContent.length());
        } catch (Exception e) {
            logger.error("[TradeLogGitSync] Daily push failed: {}", e.getMessage(), e);
        }
    }

    private JsonNode getRemoteFile() throws Exception {
        String url = GITHUB_API + "/repos/" + REPO_OWNER + "/" + REPO_NAME + "/contents/" + localPath + "?ref=" + BRANCH;
        HttpHeaders headers = authHeaders();
        try {
            var response = restTemplate.exchange(url, HttpMethod.GET, new HttpEntity<>(headers), String.class);
            return mapper.readTree(response.getBody());
        } catch (HttpClientErrorException e) {
            if (HttpStatus.NOT_FOUND.equals(e.getStatusCode())) return null;
            throw e;
        }
    }

    private void putRemoteFile(String content, String sha) throws Exception {
        String url = GITHUB_API + "/repos/" + REPO_OWNER + "/" + REPO_NAME + "/contents/" + localPath;
        String dateLabel = LocalDate.now(ZoneId.of("Asia/Kolkata")).toString();

        Map<String, Object> body = new HashMap<>();
        body.put("message", "Trade log update (" + dateLabel + ")");
        body.put("content", Base64.getEncoder().encodeToString(content.getBytes(StandardCharsets.UTF_8)));
        body.put("branch", BRANCH);
        if (sha != null) body.put("sha", sha);

        HttpHeaders headers = authHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        restTemplate.exchange(url, HttpMethod.PUT, new HttpEntity<>(body, headers), String.class);
    }

    private HttpHeaders authHeaders() {
        HttpHeaders headers = new HttpHeaders();
        headers.set("Authorization", "Bearer " + githubToken);
        headers.set("Accept", "application/vnd.github+json");
        headers.set("X-GitHub-Api-Version", "2022-11-28");
        headers.set("User-Agent", "nse-whatsapp-alerts-tradelog-sync");
        return headers;
    }
}
