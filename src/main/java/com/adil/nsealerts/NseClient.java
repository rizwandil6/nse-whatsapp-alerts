package com.adil.nsealerts;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

import java.util.*;

/**
 * Talks to NSE's JSON endpoints. NSE blocks plain requests without a prior
 * browser-like session, so we first hit the homepage to collect cookies,
 * then reuse them on the API calls.
 *
 * If NSE keeps blocking you (401/403), set proxy.base-url in application.yml
 * to a scraping proxy (e.g. ScraperAPI/ScrapingBee) and this client will
 * route requests through it instead.
 */
@Component
public class NseClient {

    private static final String HOME_URL = "https://www.nseindia.com";
    private static final String ANNOUNCEMENTS_URL = "https://www.nseindia.com/api/corporate-announcements?index=equities";
    private static final String CIRCULARS_URL = "https://www.nseindia.com/api/circulars?dept=members";

    @Value("${proxy.base-url:}")
    private String proxyBaseUrl;

    private final RestTemplate restTemplate = new RestTemplate();
    private String cookies = null;

    private HttpHeaders baseHeaders() {
        HttpHeaders headers = new HttpHeaders();
        headers.set("User-Agent",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36");
        headers.set("Accept", "application/json, text/plain, */*");
        if (cookies != null) {
            headers.set("Cookie", cookies);
        }
        return headers;
    }

    private void refreshSession() {
        try {
            HttpHeaders headers = baseHeaders();
            ResponseEntity<String> resp = restTemplate.exchange(
                    HOME_URL, HttpMethod.GET, new HttpEntity<>(headers), String.class);
            List<String> setCookies = resp.getHeaders().get(HttpHeaders.SET_COOKIE);
            if (setCookies != null) {
                cookies = String.join("; ", setCookies.stream()
                        .map(c -> c.split(";", 2)[0]).toList());
            }
        } catch (Exception e) {
            System.err.println("Failed to refresh NSE session: " + e.getMessage());
        }
    }

    private String fetch(String url) {
        String target = proxyBaseUrl.isBlank() ? url : proxyBaseUrl + url;
        try {
            ResponseEntity<String> resp = restTemplate.exchange(
                    target, HttpMethod.GET, new HttpEntity<>(baseHeaders()), String.class);
            return resp.getBody();
        } catch (Exception e) {
            // Likely session expired - refresh once and retry
            refreshSession();
            try {
                ResponseEntity<String> resp = restTemplate.exchange(
                        target, HttpMethod.GET, new HttpEntity<>(baseHeaders()), String.class);
                return resp.getBody();
            } catch (Exception e2) {
                System.err.println("NSE fetch failed for " + url + ": " + e2.getMessage());
                return null;
            }
        }
    }

    public String fetchAnnouncements() {
        if (cookies == null) refreshSession();
        return fetch(ANNOUNCEMENTS_URL);
    }

    public String fetchCirculars() {
        if (cookies == null) refreshSession();
        return fetch(CIRCULARS_URL);
    }
}
