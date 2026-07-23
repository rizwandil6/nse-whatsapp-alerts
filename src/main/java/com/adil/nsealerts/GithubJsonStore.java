package com.adil.nsealerts;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestTemplate;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;

/**
 * Generic GitHub Contents API client, reused two ways by the dashboard:
 *  - READS files from other services' branches (rs-momentum and multibagger
 *    push their state to `main`; DarvasBox pushes to its own dedicated
 *    branch) so the dashboard can show what those live services alerted,
 *    without needing a shared filesystem or database.
 *  - WRITES this service's own new alert logs (market news, announcements)
 *    to a DEDICATED branch, never `main` -- per this project's established
 *    rule, a push to `main` redeploys every Railway service in the repo, so
 *    a dashboard log write must never land there (same reasoning as
 *    orb-live-streamer's and darvasbox-live's dedicated data branches).
 *
 * Same "Contents API instead of the git binary" approach as TradeLogGitSync
 * (buildpack images generally don't ship git), generalized across branches.
 */
@Component
public class GithubJsonStore {
    private static final Logger logger = LoggerFactory.getLogger(GithubJsonStore.class);

    private static final String REPO_OWNER = "rizwandil6";
    private static final String REPO_NAME = "nse-whatsapp-alerts";
    private static final String GITHUB_API = "https://api.github.com";

    @Value("${github.token:}")
    private String githubToken;

    private final RestTemplate restTemplate = new RestTemplate();
    private final ObjectMapper mapper = new ObjectMapper();

    public boolean isConfigured() {
        return githubToken != null && !githubToken.isBlank();
    }

    /** Returns the parsed JSON content of repoPath on branch, or null if the file/branch doesn't exist. */
    public JsonNode readJson(String branch, String repoPath) {
        if (!isConfigured()) return null;
        try {
            JsonNode remote = getRemoteFile(branch, repoPath);
            if (remote == null) return null;
            String content = new String(Base64.getMimeDecoder().decode(remote.get("content").asText()), StandardCharsets.UTF_8);
            return mapper.readTree(content);
        } catch (Exception e) {
            logger.warn("[GithubJsonStore] Failed reading {}@{}: {}", repoPath, branch, e.getMessage());
            return null;
        }
    }

    /** Writes content as repoPath on the given (non-main) branch, creating the branch from main's current HEAD if needed. */
    public void writeJson(String branch, String repoPath, String content, String commitMessage) {
        if (!isConfigured()) return;
        try {
            ensureBranchExists(branch);
            JsonNode remote = getRemoteFile(branch, repoPath);
            String sha = remote == null ? null : remote.get("sha").asText();
            putRemoteFile(branch, repoPath, content, sha, commitMessage);
        } catch (Exception e) {
            logger.error("[GithubJsonStore] Failed writing {}@{}: {}", repoPath, branch, e.getMessage(), e);
        }
    }

    private void ensureBranchExists(String branch) throws Exception {
        String checkUrl = GITHUB_API + "/repos/" + REPO_OWNER + "/" + REPO_NAME + "/git/ref/heads/" + branch;
        try {
            restTemplate.exchange(checkUrl, HttpMethod.GET, new HttpEntity<>(authHeaders()), String.class);
            return; // exists
        } catch (HttpClientErrorException e) {
            if (!HttpStatus.NOT_FOUND.equals(e.getStatusCode())) throw e;
        }
        String mainRefUrl = GITHUB_API + "/repos/" + REPO_OWNER + "/" + REPO_NAME + "/git/ref/heads/main";
        var mainRefRes = restTemplate.exchange(mainRefUrl, HttpMethod.GET, new HttpEntity<>(authHeaders()), String.class);
        JsonNode mainRef = mapper.readTree(mainRefRes.getBody());
        String sha = mainRef.get("object").get("sha").asText();

        String createUrl = GITHUB_API + "/repos/" + REPO_OWNER + "/" + REPO_NAME + "/git/refs";
        Map<String, Object> body = new HashMap<>();
        body.put("ref", "refs/heads/" + branch);
        body.put("sha", sha);
        HttpHeaders headers = authHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        restTemplate.exchange(createUrl, HttpMethod.POST, new HttpEntity<>(body, headers), String.class);
        logger.info("[GithubJsonStore] Created branch {}", branch);
    }

    private JsonNode getRemoteFile(String branch, String repoPath) throws Exception {
        String url = GITHUB_API + "/repos/" + REPO_OWNER + "/" + REPO_NAME + "/contents/" + repoPath + "?ref=" + branch;
        try {
            var response = restTemplate.exchange(url, HttpMethod.GET, new HttpEntity<>(authHeaders()), String.class);
            return mapper.readTree(response.getBody());
        } catch (HttpClientErrorException e) {
            if (HttpStatus.NOT_FOUND.equals(e.getStatusCode())) return null;
            throw e;
        }
    }

    private void putRemoteFile(String branch, String repoPath, String content, String sha, String commitMessage) {
        String url = GITHUB_API + "/repos/" + REPO_OWNER + "/" + REPO_NAME + "/contents/" + repoPath;
        Map<String, Object> body = new HashMap<>();
        body.put("message", commitMessage);
        body.put("content", Base64.getEncoder().encodeToString(content.getBytes(StandardCharsets.UTF_8)));
        body.put("branch", branch);
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
        headers.set("User-Agent", "nse-whatsapp-alerts-dashboard");
        return headers;
    }
}
