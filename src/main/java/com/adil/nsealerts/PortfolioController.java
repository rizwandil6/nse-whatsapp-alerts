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
    private final PortfolioAnalysisScheduler portfolioAnalysisScheduler;

    public PortfolioController(PortfolioService portfolioService, PortfolioAnalysisScheduler portfolioAnalysisScheduler) {
        this.portfolioService = portfolioService;
        this.portfolioAnalysisScheduler = portfolioAnalysisScheduler;
    }

    // Ops/testing escape hatch -- re-runs the FULL 08:00 IST job (every distinct ticker
    // across every browser) on demand. Same fire-and-forget-on-a-background-thread
    // pattern as BulletinController's /trigger-bulletin.
    @GetMapping(value = "/trigger-analysis", produces = MediaType.TEXT_PLAIN_VALUE)
    public String triggerAnalysis() {
        new Thread(portfolioAnalysisScheduler::runDailyAnalysis).start();
        return "Portfolio analysis triggered -- check /api/dashboard/portfolio/analysis in a few minutes.";
    }

    public record AnalyzePendingRequest(String browserId) {}

    // Backs the Portfolio tab's "Run analysis" button -- only this browser's tickers
    // with no analysis row for today, not a re-run of the whole distinct-ticker set
    // (avoids re-analyzing stocks that already have today's result, and avoids one
    // browser's click re-triggering everyone else's already-fresh tickers). Still fans
    // each result out to every OTHER browser holding the same pending ticker -- see
    // PortfolioAnalysisScheduler#analyzeTickers -- so this doubles as free coverage for
    // anyone else's matching pending ticker, not just the caller's.
    @PostMapping("/analyze-pending")
    public ResponseEntity<?> analyzePending(@RequestBody AnalyzePendingRequest req) {
        String browserId = validateBrowserId(req.browserId());
        if (browserId == null) {
            return ResponseEntity.badRequest().body(Map.of("error", "invalid browserId"));
        }
        List<String> pending = portfolioService.pendingTickersFor(browserId);
        if (!pending.isEmpty()) {
            new Thread(() -> portfolioAnalysisScheduler.analyzeTickers(pending)).start();
        }
        return ResponseEntity.ok(Map.of("status", "ok", "count", pending.size()));
    }

    // Per-card "Refresh" button -- force a fresh analysis for ONE ticker today, regardless
    // of whether it already has a result for today (unlike /analyze-pending, which skips
    // anything already analyzed). Needed because a ticker's existing row can predate a
    // change to what gets captured (e.g. reasoning text added 2026-08-30 -- older rows
    // have decision but reasoning=null, and won't be picked up again until tomorrow's
    // cron without this). Same fan-out-to-every-holder + in-flight-dedup behavior as
    // every other analyzeTickers() caller.
    @PostMapping("/analyze-ticker")
    public ResponseEntity<?> analyzeTicker(@RequestBody TickerRequest req) {
        String browserId = validateBrowserId(req.browserId());
        String ticker = validateTicker(req.ticker());
        if (browserId == null || ticker == null) {
            return ResponseEntity.badRequest().body(Map.of("error", "invalid browserId or ticker"));
        }
        if (!portfolioService.isInPortfolio(browserId, ticker)) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "ticker not in this portfolio"));
        }
        new Thread(() -> portfolioAnalysisScheduler.analyzeTickers(List.of(ticker))).start();
        return ResponseEntity.ok(Map.of("status", "ok"));
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
