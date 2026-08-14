package com.adil.nsealerts;

import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.stereotype.Component;

/**
 * Looks up a symbol's current RS Rank -- originally added for the Quarterly
 * Results dashboard card, also used by the Swing Strategy tab (2026-08-14) --
 * sourced from rs-momentum-strategy/live's daily full-universe snapshot
 * (rs_today_ranks.json on the data/rs-momentum-log branch, added 2026-07-30
 * specifically for this lookup -- that service previously only ever
 * persisted symbols that crossed its RS>=80/<50 alert thresholds, discarding
 * the rest of the day's cross-sectional ranking).
 *
 * Coverage depends on the CALLER's own universe vs. rs-momentum-strategy's
 * own universe (rs-momentum-strategy/live/symbols.json, 352 symbols as of
 * 2026-08-14):
 *   - Quarterly Results: coverage is inherently partial -- most NSE-listed
 *     companies filing results are simply not in that 352-symbol universe at
 *     all, and rankFor() returns null for them.
 *   - Swing Strategy: swing-strategy/live/symbols.json is now IDENTICAL to
 *     rs-momentum-strategy/live/symbols.json (kept in sync as of 2026-08-14)
 *     -- every swing symbol IS in the universe. The rare null here (~12/352
 *     as of this writing, e.g. GROWW/LENSKART/MEESHO -- recent IPOs) means
 *     that symbol doesn't yet have enough price history for the RS
 *     calculation itself, not that it's excluded from the universe.
 *
 * Computing a rank for a truly out-of-universe symbol isn't a cheap lookup
 * either way -- it requires re-ranking the WHOLE universe's price history
 * cross-sectionally (see today_ranks.js), which is deliberately NOT done
 * here on a per-card basis. If a future caller's universe diverges from
 * rs-momentum-strategy's again, this coverage note needs updating.
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
