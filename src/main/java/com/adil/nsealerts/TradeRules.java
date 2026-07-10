package com.adil.nsealerts;

/**
 * Pure exit-rule decision logic. No I/O, no Spring — a function of trade state,
 * current price, and elapsed time only.
 *
 * Used by both UpstoxTradeService (real orders) and ShadowTradeService /
 * the backtest simulator (paper positions), so the rules that decide when
 * money moves and the rules used to evaluate the strategy can never drift
 * apart from each other.
 *
 * Check order matters and mirrors the original inline logic in
 * UpstoxTradeService.monitorPosition(): time exit first (always wins),
 * then hard stop, then partial exit, then trailing stop.
 */
public final class TradeRules {

    private TradeRules() {}

    public enum Action { HOLD, PARTIAL_EXIT, TRAIL_STOP, HARD_STOP, TIME_EXIT }

    public record Params(
            double targetPct,
            double stopLossPct,
            double trailPct,
            int timeExitMinutes) {}

    public record Decision(Action action, String reason) {
        static Decision hold() { return new Decision(Action.HOLD, ""); }
    }

    /**
     * @param gainPct         (ltp - entryPrice) / entryPrice * 100, at this tick
     * @param maxGainPct      highest gainPct observed since entry, INCLUDING this tick
     * @param partialExitDone whether the target-based partial exit has already fired
     * @param ageMinutes      whole minutes elapsed since entry
     */
    public static Decision decide(Params p, double gainPct, double maxGainPct,
                                   boolean partialExitDone, long ageMinutes) {
        if (ageMinutes >= p.timeExitMinutes()) {
            return new Decision(Action.TIME_EXIT,
                    String.format("Time exit (%d min)", p.timeExitMinutes()));
        }
        if (gainPct <= -p.stopLossPct()) {
            return new Decision(Action.HARD_STOP,
                    String.format("Stop-loss (%.2f%%)", gainPct));
        }
        if (!partialExitDone && gainPct >= p.targetPct()) {
            return new Decision(Action.PARTIAL_EXIT,
                    String.format("Partial exit at target (+%.2f%%)", gainPct));
        }
        if (partialExitDone && maxGainPct >= p.trailPct()) {
            double trailTrigger = maxGainPct - p.trailPct();
            if (gainPct <= trailTrigger) {
                return new Decision(Action.TRAIL_STOP,
                        String.format("Trail stop (peak:+%.2f%% -> now:+%.2f%%)", maxGainPct, gainPct));
            }
        }
        return Decision.hold();
    }
}
