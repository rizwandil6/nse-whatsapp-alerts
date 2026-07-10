package com.adil.nsealerts;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class TradeRulesTest {

    private static final TradeRules.Params DEFAULT = new TradeRules.Params(
            2.0,   // targetPct
            1.5,   // stopLossPct
            1.0,   // trailPct
            45);   // timeExitMinutes

    @Test
    void holdsWhenNothingTriggered() {
        var d = TradeRules.decide(DEFAULT, 0.5, 0.5, false, 5);
        assertEquals(TradeRules.Action.HOLD, d.action());
    }

    @Test
    void timeExitWinsEvenIfInProfit() {
        var d = TradeRules.decide(DEFAULT, 5.0, 5.0, false, 45);
        assertEquals(TradeRules.Action.TIME_EXIT, d.action());
    }

    @Test
    void hardStopTriggersAtThreshold() {
        var d = TradeRules.decide(DEFAULT, -1.5, 0.2, false, 10);
        assertEquals(TradeRules.Action.HARD_STOP, d.action());
    }

    @Test
    void hardStopBeatsPartialExitWhenBothWouldApply() {
        // Can't both be true in practice (gain can't be <=-1.5 and >=2.0 at once),
        // but time exit must win over hard stop's own priority — verified separately.
        var d = TradeRules.decide(DEFAULT, -1.5, 2.0, false, 10);
        assertEquals(TradeRules.Action.HARD_STOP, d.action());
    }

    @Test
    void partialExitTriggersAtTargetAndOnlyOnce() {
        var first = TradeRules.decide(DEFAULT, 2.0, 2.0, false, 10);
        assertEquals(TradeRules.Action.PARTIAL_EXIT, first.action());

        // once partialExitDone=true, hitting target again should NOT re-fire partial exit
        var second = TradeRules.decide(DEFAULT, 2.0, 2.0, true, 11);
        assertEquals(TradeRules.Action.HOLD, second.action());
    }

    @Test
    void trailingStopOnlyArmsAfterPartialExit() {
        // maxGain 3%, now back to 1.9% (a 1.1% pullback) but partial exit not done yet -> HOLD
        var notArmed = TradeRules.decide(DEFAULT, 1.9, 3.0, false, 12);
        assertEquals(TradeRules.Action.HOLD, notArmed.action());

        // same prices, but partial exit already done -> trail stop fires
        var armed = TradeRules.decide(DEFAULT, 1.9, 3.0, true, 12);
        assertEquals(TradeRules.Action.TRAIL_STOP, armed.action());
    }

    @Test
    void trailingStopDoesNotFireBeforePullbackReachesTrailPct() {
        // maxGain 3%, now 2.2% -> only a 0.8% pullback, less than trailPct(1.0) -> HOLD
        var d = TradeRules.decide(DEFAULT, 2.2, 3.0, true, 12);
        assertEquals(TradeRules.Action.HOLD, d.action());
    }

    @Test
    void trailingStopNotArmedUntilMaxGainReachesTrailPct() {
        // partial exit done at +2%, but price never ran past +1% peak beyond that
        // (maxGainPct just barely below trailPct threshold) -> should not arm
        var d = TradeRules.decide(DEFAULT, -0.5, 0.9, true, 12);
        assertEquals(TradeRules.Action.HOLD, d.action());
    }
}
