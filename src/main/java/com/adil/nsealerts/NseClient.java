package com.adil.nsealerts;

import com.rometools.rome.feed.synd.SyndEntry;
import com.rometools.rome.feed.synd.SyndFeed;
import com.rometools.rome.io.SyndFeedInput;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestTemplate;

import java.io.StringReader;
import java.net.CookieManager;
import java.net.CookiePolicy;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.*;

/**
 * Fetches NSE data:
 *  - Announcements: public RSS feed (no session/proxy needed)
 *  - Circulars: NSE JSON API, accessed via a session-cookie approach
 *    (visits the NSE homepage first to obtain cookies, then hits the API).
 *    Falls back to a scraping proxy if proxy.base-url is configured.
 */
@Component
public class NseClient {
    private static final Logger logger = LoggerFactory.getLogger(NseClient.class);

    private static final String ANNOUNCEMENTS_RSS_URL =
            "https://nsearchives.nseindia.com/content/RSS/Online_announcements.xml";
    private static final String CIRCULARS_URL =
            "https://www.nseindia.com/api/circulars?dept=members";
    private static final String NSE_HOME_URL = "https://www.nseindia.com";

    private static final String USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

    @Value("${proxy.base-url:}")
    private String proxyBaseUrl;

    @Value("${proxy.auth-header:}")
    private String proxyAuthHeader;

    @Value("${proxy.auth-token:}")
    private String proxyAuthToken;

    // Used only for announcements RSS and proxy fallback
    private final RestTemplate restTemplate = new RestTemplate();

    // Java 11 HttpClient with automatic cookie management for NSE session
    private final CookieManager cookieManager;
    private final HttpClient httpClient;
    private volatile boolean sessionInitialized = false;

    public NseClient() {
        this.cookieManager = new CookieManager();
        this.cookieManager.setCookiePolicy(CookiePolicy.ACCEPT_ALL);
        this.httpClient = HttpClient.newBuilder()
                .cookieHandler(cookieManager)
                .connectTimeout(Duration.ofSeconds(15))
                .followRedirects(HttpClient.Redirect.NORMAL)
                .build();
    }

    // -------------------------------------------------------------------------
    // Announcements — public RSS feed, no session needed
    // -------------------------------------------------------------------------

    public List<SyndEntry> fetchAnnouncements() {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.set("User-Agent", USER_AGENT);
            headers.set("Accept", "application/rss+xml, application/xml, text/xml, */*");
            headers.set("Accept-Language", "en-US,en;q=0.9");
            headers.set("Connection", "keep-alive");

            ResponseEntity<String> response = restTemplate.exchange(
                    ANNOUNCEMENTS_RSS_URL, HttpMethod.GET,
                    new HttpEntity<>(headers), String.class);

            String body = response.getBody();
            if (body == null || body.isBlank()) {
                logger.warn("NSE RSS feed returned empty response");
                return Collections.emptyList();
            }

            // Strip BOM or leading whitespace before the XML declaration
            int xmlStart = body.indexOf('<');
            if (xmlStart > 0) body = body.substring(xmlStart);

            SyndFeedInput input = new SyndFeedInput();
            SyndFeed feed = input.build(new StringReader(body));
            logger.info("Fetched RSS feed with {} entries", feed.getEntries().size());
            return new ArrayList<>(feed.getEntries());

        } catch (Exception e) {
            logger.error("Error fetching announcements RSS", e);
            return Collections.emptyList();
        }
    }

    // -------------------------------------------------------------------------
    // Circulars — session-based (or proxy if configured)
    // -------------------------------------------------------------------------

    public String fetchCirculars() {
        if (!proxyBaseUrl.isBlank()) {
            // Proxy explicitly configured — use it
            return fetchJsonApiViaProxy(CIRCULARS_URL);
        }
        return fetchCircularsWithSession();
    }

    private String fetchCircularsWithSession() {
        try {
            if (!sessionInitialized) {
                initNseSession();
            }

            String body = doCircularsRequest();
            if (body != null) return body;

            // Session may have expired — re-init and retry once
            logger.warn("Circulars empty on first try; re-initialising session and retrying");
            sessionInitialized = false;
            initNseSession();
            return doCircularsRequest();

        } catch (Exception e) {
            logger.error("Error fetching circulars via session", e);
            return null;
        }
    }

    private String doCircularsRequest() throws Exception {
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(CIRCULARS_URL))
                .timeout(Duration.ofSeconds(20))
                .header("User-Agent", USER_AGENT)
                .header("Accept", "application/json, text/plain, */*")
                .header("Accept-Language", "en-US,en;q=0.9")
                .header("Referer", "https://www.nseindia.com/regulations/circulars")
                .header("X-Requested-With", "XMLHttpRequest")
                .GET()
                .build();

        HttpResponse<String> response =
                httpClient.send(request, HttpResponse.BodyHandlers.ofString());

        int status = response.statusCode();
        logger.info("Circulars API responded with status {}", status);

        if (status == 200) {
            String body = response.body();
            if (body != null && !body.isBlank()) {
                return body;
            }
            logger.warn("Circulars API returned 200 but empty body");
        } else {
            logger.warn("Circulars API returned non-200 status {}", status);
        }
        return null;
    }

    /**
     * Visits the NSE homepage to establish a valid session.
     * NSE sets cookies (nsit, nseappid, etc.) on the first visit that are
     * required for subsequent API calls to succeed.
     */
    private void initNseSession() {
        try {
            logger.info("Initialising NSE session (visiting homepage to obtain cookies)...");
            HttpRequest homeRequest = HttpRequest.newBuilder()
                    .uri(URI.create(NSE_HOME_URL))
                    .timeout(Duration.ofSeconds(20))
                    .header("User-Agent", USER_AGENT)
                    .header("Accept",
                            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
                    .header("Accept-Language", "en-US,en;q=0.9")
                    .GET()
                    .build();

            HttpResponse<String> response =
                    httpClient.send(homeRequest, HttpResponse.BodyHandlers.ofString());
            logger.info("NSE homepage responded with status {} — session cookies obtained",
                    response.statusCode());

            // Brief pause to mimic real browser behaviour before hitting the API
            Thread.sleep(1500);
            sessionInitialized = true;

        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
        } catch (Exception e) {
            logger.warn("Failed to initialise NSE session: {}", e.getMessage());
        }
    }

    // -------------------------------------------------------------------------
    // Proxy fallback (used only when proxy.base-url is set in application.yml)
    // -------------------------------------------------------------------------

    private String fetchJsonApiViaProxy(String url) {
        String target = proxyBaseUrl + url;
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.set("User-Agent", USER_AGENT);
            headers.set("Accept", "application/json, text/plain, */*");
            headers.set("Accept-Language", "en-US,en;q=0.9");
            if (!proxyAuthHeader.isBlank() && !proxyAuthToken.isBlank()) {
                headers.set(proxyAuthHeader, proxyAuthToken);
            }
            ResponseEntity<String> resp = restTemplate.exchange(
                    target, HttpMethod.GET, new HttpEntity<>(headers), String.class);
            String body = resp.getBody();
            if (body == null || body.isBlank()) {
                logger.warn("Proxy returned empty response for {}", url);
                return null;
            }
            return body;
        } catch (HttpStatusCodeException e) {
            logger.warn("Proxy request failed for {}: {}", url, e.getStatusCode());
            return null;
        } catch (Exception e) {
            logger.error("Proxy request error for {}", url, e);
            return null;
        }
    }
}
