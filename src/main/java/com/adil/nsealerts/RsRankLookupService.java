package com.adil.nsealerts;

import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.stereotype.Component;

/**
 * Looks up a symbol's current RS Rank for the Quarterly Results dashboard
 * card, sourced from rs-momentum-strategy/live's daily full-universe
 * snapshot (rs_today_ranks.json on the data/rs-momentum-log branch, added
 * 2026-07-30 specifically for this lookup -- that service previously only
 * ever persisted symbols that crossed its RS>=80/<50 alert thresholds,
 * discarding the rest of the day's cross-sectional ranking).
 *
 * Coverage is inherently partial: only the ~300 stocks in that service's own
 * universe (rs-momentum-strategy/live/symbols.json) have a rank at all --
 * most NSE-listed companies filing quarterly results are NOT in that
 * universe, and rankFor() returns null for them. Computing a rank for an
 * out-of-universe symbol isn't a cheap lookup -- it requires re-ranking the
 * WHOLE universe's price history cross-sectionally (see today_ranks.js),
 * which is deliberately NOT done here on a per-card basis.
 *
 * "Today's" rank is also only as fresh as that service's own daily (not
 * intraday) cadence -- one run, 20:00-20:30 IST after market close.
 */
@Component
public class RsRankLookupService {
    private static final String BRANCH = "data/rs-momentum-log";
    private static final String REPO_PATH = "rs-momentum-strategy/live/rs_today_ranks.json";
    // Longer than the dashboard's own 60s tab-data cache -- this is read once
    // per quarterly-result announcement processed (potentially many per poll
    // cycle), and the underlying data only changes once a day, so there's no
    // benefit to re-fetching from GitHub anywhere near that often.
    private static final long CACHE_TTL_MS = 10 * 60 * 1000;

    private final GithubJsonStore githubJsonStore;
    private volatile JsonNode cached;
    private volatile long cachedAt = 0;

    public RsRankLookupService(GithubJsonStore githubJsonStore) {
        this.githubJsonStore = githubJsonStore;
    }

    /** Returns the symbol's current RS Rank (0-100), or null if it's not in the RS Momentum universe or the snapshot is unavailable. */
    public Double rankFor(String symbol) {
        JsonNode node = cachedSnapshot();
        if (node == null) return null;
        JsonNode entry = node.get(symbol);
        if (entry == null || !entry.has("rank") || entry.get("rank").isNull()) return null;
        return entry.get("rank").asDouble();
    }

    private JsonNode cachedSnapshot() {
        long now = System.currentTimeMillis();
        if (cached != null && now - cachedAt < CACHE_TTL_MS) return cached;
        JsonNode fresh = githubJsonStore.readJson(BRANCH, REPO_PATH);
        cached = fresh;
        cachedAt = now;
        return fresh;
    }
}
