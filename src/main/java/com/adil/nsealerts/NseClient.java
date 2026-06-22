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
import java.util.*;

/**
 * Fetches NSE announcements from a public RSS feed (no cookie/session handling needed).
 * Circulars still use the JSON API and may require proxy handling if NSE blocks bot requests.
 */
@Component
public class NseClient {
    private static final Logger logger = LoggerFactory.getLogger(NseClient.class);
    private static final String ANNOUNCEMENTS_RSS_URL = "https://nsearchives.nseindia.com/content/RSS/Online_announcements.xml";
    private static final String CIRCULARS_URL = "https://www.nseindia.com/api/circulars?dept=members";

    @Value("${proxy.base-url:}")
    private String proxyBaseUrl;

    @Value("${proxy.auth-header:}")
    private String proxyAuthHeader;

    @Value("${proxy.auth-token:}")
    private String proxyAuthToken;

    private final RestTemplate restTemplate = new RestTemplate();

    /**
     * Fetches NSE announcements from the public RSS feed.
     * Returns a list of SyndEntry objects with title, description, link, and publishedDate.
     */
    public List<SyndEntry> fetchAnnouncements() {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.set("User-Agent",
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36");
            headers.set("Accept", "application/rss+xml, application/xml, text/xml, */*");
            headers.set("Accept-Language", "en-US,en;q=0.9");
            headers.set("Connection", "keep-alive");

            ResponseEntity<String> response = restTemplate.exchange(
                    ANNOUNCEMENTS_RSS_URL, HttpMethod.GET, new HttpEntity<>(headers), String.class);

            String body = response.getBody();
            if (body == null || body.isBlank()) {
                logger.warn("NSE RSS feed returned empty response");
                return Collections.emptyList();
            }

            // Strip BOM or leading whitespace/junk before the XML declaration
            int xmlStart = body.indexOf('<');
            if (xmlStart > 0) {
                body = body.substring(xmlStart);
            }

            SyndFeedInput input = new SyndFeedInput();
            SyndFeed feed = input.build(new StringReader(body));
            logger.info("Fetched RSS feed with {} entries", feed.getEntries().size());
            return new ArrayList<>(feed.getEntries());
        } catch (Exception e) {
            logger.error("Error fetching announcements RSS", e);
            return Collections.emptyList();
        }
    }

    /**
     * Fetches NSE circulars from the JSON API.
     * TODO: Replace with RSS feed when NSE publishes a circulars RSS feed.
     * For now, this still uses the JSON API with optional proxy support for bot-protection bypass.
     */
    public String fetchCirculars() {
        return fetchJsonApi(CIRCULARS_URL);
    }

    private String fetchJsonApi(String url) {
        String target = proxyBaseUrl.isBlank() ? url : proxyBaseUrl + url;
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.set("User-Agent",
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36");
            headers.set("Accept", "application/json, text/plain, */*");
            headers.set("Accept-Language", "en-US,en;q=0.9");
            headers.set("Accept-Encoding", "gzip, deflate");
            headers.set("Connection", "keep-alive");
            if (!proxyAuthHeader.isBlank() && !proxyAuthToken.isBlank()) {
                headers.set(proxyAuthHeader, proxyAuthToken);
            }
            ResponseEntity<String> resp = restTemplate.exchange(
                    target, HttpMethod.GET, new HttpEntity<>(headers), String.class);
            String body = resp.getBody();
            if (body == null || body.trim().isEmpty()) {
                logger.warn("NSE JSON API returned empty response for {}", url);
                return null;
            }
            return body;
        } catch (HttpStatusCodeException e) {
            logger.warn("NSE JSON API failed for {}: {}", url, e.getStatusCode());
            return null;
        } catch (Exception e) {
            logger.error("NSE JSON API error for {}", url, e);
            return null;
        }
    }
}
