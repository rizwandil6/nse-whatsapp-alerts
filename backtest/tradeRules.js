'use strict';

/**
 * Mirrors TradeRules.java's decide() exactly (same thresholds, same check order:
 * time exit, then hard stop, then partial exit, then trailing stop). Keep the two
 * in sync by hand when either changes — there is no automated cross-language check.
 * See src/main/java/com/adil/nsealerts/UpstoxTradeService.java for how the Java
 * side wires this into live trading and shadow-mode simulation.
 */

const Action = Object.freeze({
  HOLD: 'HOLD',
  PARTIAL_EXIT: 'PARTIAL_EXIT',
  TRAIL_STOP: 'TRAIL_STOP',
  HARD_STOP: 'HARD_STOP',
  TIME_EXIT: 'TIME_EXIT',
});

/**
 * @param {{targetPct:number, stopLossPct:number, trailPct:number, timeExitMinutes:number}} params
 * @param {number} gainPct         (price - entryPrice) / entryPrice * 100, at this tick
 * @param {number} maxGainPct      highest gainPct observed since entry, INCLUDING this tick
 * @param {boolean} partialExitDone whether the target-based partial exit has already fired
 * @param {number} ageMinutes      whole minutes elapsed since entry
 */
function decide(params, gainPct, maxGainPct, partialExitDone, ageMinutes) {
  const { targetPct, stopLossPct, trailPct, timeExitMinutes } = params;

  if (ageMinutes >= timeExitMinutes) {
    return { action: Action.TIME_EXIT, reason: `Time exit (${timeExitMinutes} min)` };
  }
  if (gainPct <= -stopLossPct) {
    return { action: Action.HARD_STOP, reason: `Stop-loss (${gainPct.toFixed(2)}%)` };
  }
  if (!partialExitDone && gainPct >= targetPct) {
    return { action: Action.PARTIAL_EXIT, reason: `Partial exit at target (+${gainPct.toFixed(2)}%)` };
  }
  if (partialExitDone && maxGainPct >= trailPct) {
    const trailTrigger = maxGainPct - trailPct;
    if (gainPct <= trailTrigger) {
      return {
        action: Action.TRAIL_STOP,
        reason: `Trail stop (peak:+${maxGainPct.toFixed(2)}% -> now:+${gainPct.toFixed(2)}%)`,
      };
    }
  }
  return { action: Action.HOLD, reason: '' };
}

module.exports = { Action, decide };
