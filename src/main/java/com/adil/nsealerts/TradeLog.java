package com.adil.nsealerts;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.FileWriter;
import java.io.IOException;
import java.io.PrintWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;

/**
 * Append-only CSV trade log for both live and shadow trades.
 *
 * This exists because trade history was previously only in-memory (activeTrade,
 * consecutiveStops) and only ever reached a human as a Telegram message — there was
 * no way to go back and actually measure win rate, average P&L, or which exit reason
 * dominates. Every entry/partial-exit/exit event from UpstoxTradeService now flows
 * through here so the strategy can be evaluated from real data instead of vibes.
 *
 * CAVEAT: on Railway (or anywhere without a persistent volume attached) this file
 * does NOT survive a redeploy — same limitation the in-memory dedup set already had.
 * Fine for accumulating a session's worth of data to eyeball; if you want history
 * across redeploys, point tradelog.path at a mounted volume or swap this for a
 * database. Either way, tail this file (or its Railway-log echo, see logging below)
 * periodically and keep a copy — don't let redeploys silently erase it.
 */
@Component
public class TradeLog {
    private static final Logger log = LoggerFactory.getLogger(TradeLog.class);
    private static final String HEADER =
            "timestamp,mode,event,symbol,instrument_key,rating,price,qty,gain_pct,reason";

    @Value("${tradelog.path:trades.csv}")
    private String path;

    /**
     * instrumentKey is included so entry rows can feed directly into
     * backtest/run.js's signals.csv format (symbol,instrument_key,entry_iso,rating)
     * without a manual lookup step — filter this file to event=entry rows and rename
     * the timestamp column to entry_iso.
     */
    public void logEntry(boolean shadow, String symbol, String instrumentKey, int rating,
                          double price, int qty, String note) {
        write(shadow, "entry", symbol, instrumentKey, String.valueOf(rating), fmt(price), String.valueOf(qty), "", note);
    }

    public void logPartialExit(boolean shadow, String symbol, double price, double gainPct) {
        write(shadow, "partial_exit", symbol, "", "", fmt(price), "", fmt(gainPct), "");
    }

    public void logExit(boolean shadow, String symbol, String reason, double price, double gainPct) {
        write(shadow, "exit", symbol, "", "", fmt(price), "", fmt(gainPct), reason);
    }

    private void write(boolean shadow, String event, String symbol, String instrumentKey, String rating,
                        String price, String qty, String gainPct, String reason) {
        String line = csv(Instant.now().toString(), shadow ? "shadow" : "live", event,
                symbol, instrumentKey, rating, price, qty, gainPct, reason);
        // Always echo to the application log too — on platforms without a persistent
        // volume, Railway's own log retention is the only durable copy of this data.
        log.info("[TradeLog] {}", line);
        append(line);
    }

    private synchronized void append(String line) {
        try {
            Path p = Path.of(path);
            boolean isNew = !Files.exists(p);
            try (PrintWriter out = new PrintWriter(new FileWriter(path, true))) {
                if (isNew) out.println(HEADER);
                out.println(line);
            }
        } catch (IOException e) {
            log.warn("[TradeLog] Failed to write to {}: {}", path, e.getMessage());
        }
    }

    private String csv(String... fields) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < fields.length; i++) {
            if (i > 0) sb.append(',');
            String v = fields[i] == null ? "" : fields[i];
            if (v.contains(",") || v.contains("\"")) {
                v = "\"" + v.replace("\"", "\"\"") + "\"";
            }
            sb.append(v);
        }
        return sb.toString();
    }

    private String fmt(double v) {
        return String.format("%.4f", v);
    }
}
