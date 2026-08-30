package com.adil.nsealerts;

import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Portfolio tab endpoints. browserId is an anonymous UUID the frontend
 * generates and stores in localStorage on first visit -- see index.html --
 * not an authenticated identity. There is deliberately no login here.
 */
@RestController
@RequestMapping("/api/dashboard/portfolio")
public class PortfolioController {

    // NSE/BSE tickers: uppercase letters/digits, '&', '-', '.' (e.g. "M&M", "J&KBANK").
    private static final Pattern TICKER_PATTERN = Pattern.compile("^[A-Z0-9&.\\-]{1,20}$");
    // Client-generated UUID (crypto.randomUUID()) -- just bounding length/charset, not validating format strictly.
    private static final Pattern BROWSER_ID_PATTERN = Pattern.compile("^[A-Za-z0-9-]{8,64}$");

    private final PortfolioService portfolioService;

    public PortfolioController(PortfolioService portfolioService) {
        this.portfolioService = portfolioService;
    }

    public record TickerRequest(String browserId, String ticker) {}

    @PostMapping("/tickers")
    public ResponseEntity<?> addTicker(@RequestBody TickerRequest req) {
        String browserId = validateBrowserId(req.browserId());
        String ticker = validateTicker(req.ticker());
        if (browserId == null || ticker == null) {
            return ResponseEntity.badRequest().body(Map.of("error", "invalid browserId or ticker"));
        }
        try {
            portfolioService.addTicker(browserId, ticker);
        } catch (IllegalStateException e) {
            return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("error", e.getMessage()));
        }
        return ResponseEntity.ok(Map.of("status", "ok"));
    }

    @DeleteMapping("/tickers")
    public ResponseEntity<?> removeTicker(@RequestBody TickerRequest req) {
        String browserId = validateBrowserId(req.browserId());
        String ticker = validateTicker(req.ticker());
        if (browserId == null || ticker == null) {
            return ResponseEntity.badRequest().body(Map.of("error", "invalid browserId or ticker"));
        }
        portfolioService.removeTicker(browserId, ticker);
        return ResponseEntity.ok(Map.of("status", "ok"));
    }

    @GetMapping(value = "/analysis", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> analysis(@RequestParam("browserId") String browserId) {
        String validBrowserId = validateBrowserId(browserId);
        if (validBrowserId == null) {
            return ResponseEntity.badRequest().body(Map.of("error", "invalid browserId"));
        }
        List<Map<String, Object>> rows = portfolioService.analysisFor(validBrowserId);
        return ResponseEntity.ok(rows);
    }

    private String validateBrowserId(String browserId) {
        if (browserId == null || !BROWSER_ID_PATTERN.matcher(browserId).matches()) return null;
        return browserId;
    }

    private String validateTicker(String ticker) {
        if (ticker == null) return null;
        String upper = ticker.trim().toUpperCase();
        if (!TICKER_PATTERN.matcher(upper).matches()) return null;
        return upper;
    }
}
