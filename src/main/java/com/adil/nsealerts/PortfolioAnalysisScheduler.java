package com.adil.nsealerts;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.LocalDate;
import java.util.List;

/**
 * Fires every day at 08:00 IST (NSE opens 09:15), well before DailyBulletinScheduler's
 * 07:30 bulletin's own downstream reads would want fresh data. For every DISTINCT ticker
 * across every browser's portfolio.tickers (deduped -- a ticker held by 10 browsers is
 * analyzed once, not 10 times), calls the separate trading-agents-service (Python,
 * TauricResearch/TradingAgents wrapped in a FastAPI /analyze endpoint -- see
 * trading-agents-service/main.py) and fans the one result back out to every
 * (browser_id, ticker) pair holding it.
 *
 * Same "AI is best-effort, never blocks the pipeline" convention as
 * PromptRatingService.judgeQuarterlyTrend: one bad ticker (analysis-service timeout,
 * data-provider gap, etc.) is logged and skipped, not allowed to sink the whole run.
 */
@Component
public class PortfolioAnalysisScheduler {

    private static final Logger logger = LoggerFactory.getLogger(PortfolioAnalysisScheduler.class);
    // Multi-minute LLM pipeline per ticker on a single external service -- no benefit to
    // parallelizing against it, and it keeps the analysis-service's own load predictable.
    private static final Duration REQUEST_TIMEOUT = Duration.ofMinutes(10);

    private final PortfolioService portfolioService;
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final HttpClient httpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

    @Value("${portfolio.analysis-service-url:}")
    private String analysisServiceUrl;

    @Value("${portfolio.analysis-service-token:}")
    private String analysisServiceToken;

    public PortfolioAnalysisScheduler(PortfolioService portfolioService) {
        this.portfolioService = portfolioService;
    }

    @Scheduled(cron = "0 0 8 * * *", zone = "Asia/Kolkata")
    public void runDailyAnalysis() {
        if (analysisServiceUrl == null || analysisServiceUrl.isBlank()) {
            logger.info("[PortfolioAnalysis] Skipped -- portfolio.analysis-service-url not configured");
            return;
        }
        List<String> tickers = portfolioService.distinctTickers();
        logger.info("[PortfolioAnalysis] Triggered at 08:00 IST for {} distinct ticker(s)", tickers.size());
        LocalDate today = LocalDate.now();

        for (String ticker : tickers) {
            try {
                AnalysisResultPayload result = callAnalysisService(ticker, today);
                for (String browserId : portfolioService.browsersHolding(ticker)) {
                    portfolioService.upsertAnalysis(browserId, ticker, today, result.decision(), result.reasoning());
                }
            } catch (Exception e) {
                logger.warn("[PortfolioAnalysis] Analysis failed for {}: {}", ticker, e.getMessage());
            }
        }
    }

    private record AnalysisResultPayload(String decision, String reasoning) {}

    // Poll interval while waiting for a job to finish -- not a fixed sleep before the
    // whole call, just the gap between status checks once the job is queued.
    private static final Duration POLL_INTERVAL = Duration.ofSeconds(15);

    /**
     * POST /analyze returns a job_id immediately; the actual multi-minute TradingAgents
     * run happens server-side and is polled via GET /analyze/{job_id} -- NOT a single
     * synchronous request. Confirmed live (2026-08-30): Railway's edge proxy cuts a
     * long-held synchronous request before a real run finishes (502), even though the
     * backend was still working -- this poll loop is the fix, not a nice-to-have.
     */
    private AnalysisResultPayload callAnalysisService(String ticker, LocalDate date) throws Exception {
        var body = objectMapper.createObjectNode();
        body.put("ticker", ticker);
        body.put("date", date.toString());

        HttpRequest startRequest = HttpRequest.newBuilder()
                .uri(URI.create(analysisServiceUrl.replaceAll("/+$", "") + "/analyze"))
                .timeout(Duration.ofSeconds(30))
                .header("Content-Type", "application/json")
                .header("X-API-Token", analysisServiceToken)
                .POST(HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8))
                .build();

        HttpResponse<String> startResponse = httpClient.send(startRequest, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (startResponse.statusCode() != 200) {
            throw new RuntimeException("analysis-service /analyze returned " + startResponse.statusCode() + ": " + startResponse.body());
        }
        String jobId = objectMapper.readTree(startResponse.body()).path("job_id").asText();
        if (jobId.isBlank()) {
            throw new RuntimeException("analysis-service /analyze response had no job_id: " + startResponse.body());
        }

        URI statusUri = URI.create(analysisServiceUrl.replaceAll("/+$", "") + "/analyze/" + jobId);
        long deadline = System.currentTimeMillis() + REQUEST_TIMEOUT.toMillis();
        while (System.currentTimeMillis() < deadline) {
            Thread.sleep(POLL_INTERVAL.toMillis());

            HttpRequest statusRequest = HttpRequest.newBuilder()
                    .uri(statusUri)
                    .timeout(Duration.ofSeconds(30))
                    .header("X-API-Token", analysisServiceToken)
                    .GET()
                    .build();
            HttpResponse<String> statusResponse = httpClient.send(statusRequest, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (statusResponse.statusCode() != 200) {
                throw new RuntimeException("analysis-service /analyze/" + jobId + " returned " + statusResponse.statusCode() + ": " + statusResponse.body());
            }
            JsonNode node = objectMapper.readTree(statusResponse.body());
            String jobStatus = node.path("status").asText();
            if ("done".equals(jobStatus)) {
                JsonNode decisionNode = node.path("decision");
                // TradingAgents' propagate() return shape isn't a fixed contract on our side --
                // store it as plain text either way. A structured decision (object) commonly
                // carries an "action"/"reasoning"-ish field; fall back to the raw JSON text
                // for `decision` and leave `reasoning` null rather than guessing at field names.
                String decisionText = decisionNode.isTextual() ? decisionNode.asText() : decisionNode.toString();
                return new AnalysisResultPayload(decisionText, null);
            }
            if ("error".equals(jobStatus)) {
                throw new RuntimeException("analysis-service job failed: " + node.path("error").asText());
            }
            // else "running" -- keep polling
        }
        throw new RuntimeException("analysis-service job for " + ticker + " did not finish within " + REQUEST_TIMEOUT);
    }
}
