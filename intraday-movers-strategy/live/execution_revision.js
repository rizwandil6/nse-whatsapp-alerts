'use strict';

/**
 * Revises theoretical ORB entry/exit levels against the freshest real
 * price available, instead of alerting a level that may already be stale
 * by dispatch time on a fast mover. Built after a real incident (ITI,
 * 2026-07-16): the alerted OR-boundary entry (287.40) was already far
 * behind actual price by the time the alert sent.
 *
 * NOTE: since the Bollinger-Bands-strategy upgrade, orb_engine.js no
 * longer produces a fixed target at all — exits are dynamic (band-hugging
 * or stop), so there is nothing to revise for "target" anymore. This
 * module now only revises entry and stop.
 *
 * Pulled into its own module (not left inline in streamer.js) so it's
 * safely unit-testable without requiring streamer.js itself, which has
 * no require.main guard and would immediately open a live Upstox
 * connection if required directly.
 */

const MAX_STOP_PCT = 0.02;

/**
 * `event`: the ENTRY event from orb_engine.js (direction, entry, stop —
 * both theoretical/OR-boundary-based). `tickBuilder`: the TickBarBuilder
 * for this symbol (or null/undefined), used for getLivePrice().
 *
 * Stop: keeps the structural level (opposite side of the OR) IF it's
 * still within the strategy's own validated 2% max-stop-cap from the
 * real entry — reusing the exact same risk rule the backtest was tuned
 * against, just correctly applied to the real price. Falls back to a
 * plain 2%-from-entry stop if the structural level has drifted too far
 * to use safely.
 */
function reviseEntryForLiveExecution(event, tickBuilder) {
  const livePrice = tickBuilder && typeof tickBuilder.getLivePrice === 'function' ? tickBuilder.getLivePrice() : null;
  const livePriceAvailable = livePrice != null;
  const realEntry = livePriceAvailable ? livePrice : event.entry;
  const { direction, stop: structuralStop } = event;

  let revisedStop;
  let usedFallbackStop;
  if (direction === 'LONG') {
    const structuralStopPct = (realEntry - structuralStop) / realEntry;
    usedFallbackStop = !(structuralStopPct > 0 && structuralStopPct <= MAX_STOP_PCT);
    revisedStop = usedFallbackStop ? realEntry * (1 - MAX_STOP_PCT) : structuralStop;
  } else {
    const structuralStopPct = (structuralStop - realEntry) / realEntry;
    usedFallbackStop = !(structuralStopPct > 0 && structuralStopPct <= MAX_STOP_PCT);
    revisedStop = usedFallbackStop ? realEntry * (1 + MAX_STOP_PCT) : structuralStop;
  }
  const driftPct =
    direction === 'LONG' ? ((realEntry - event.entry) / event.entry) * 100 : ((event.entry - realEntry) / event.entry) * 100;

  return {
    theoreticalEntry: event.entry,
    entry: realEntry,
    stop: revisedStop,
    driftPct,
    usedFallbackStop,
    livePriceAvailable,
  };
}

/** Symmetric revision for exits: real fill price at detection time, P&L against the entry actually alerted (not the tracker's internal theoretical entry). */
function reviseExitForLiveExecution(event, tickBuilder, openPosition) {
  const livePrice = tickBuilder && typeof tickBuilder.getLivePrice === 'function' ? tickBuilder.getLivePrice() : null;
  const realExit = livePrice != null ? livePrice : event.exitPrice;
  const entry = openPosition ? openPosition.entry : event.entry;
  const pnlPct = event.direction === 'LONG' ? ((realExit - entry) / entry) * 100 : ((entry - realExit) / entry) * 100;
  return { exitPrice: realExit, entry, pnlPct };
}

module.exports = { reviseEntryForLiveExecution, reviseExitForLiveExecution, MAX_STOP_PCT };
