'use strict';

/**
 * Measures (does NOT revise) the gap between the official brick price and
 * the freshest real tick price at the moment an event is about to dispatch.
 * Unlike the sibling ORB strategy's execution_revision.js (which actually
 * substitutes the live price into the alerted/traded entry), this project
 * deliberately keeps the official entry/exit locked to the confirmed
 * 5-min-close brick price -- that's what stays exact parity with the
 * validated Python backtest. This module only ANSWERS "how far off would a
 * real fill have been right now", attached to the event as extra fields for
 * logging/analysis, so slippage becomes a measured number instead of a
 * one-off anecdote (e.g. the NCC/CONCOR gap-open observations on
 * 2026-07-27 that prompted this).
 *
 * Pulled into its own module for the same reason as execution_revision.js:
 * unit-testable without pulling in streamer.js's live-connecting side effects.
 */

function measureSlippage(event, tickBuilder) {
  const livePrice = tickBuilder && typeof tickBuilder.getLivePrice === 'function' ? tickBuilder.getLivePrice() : null;
  if (livePrice == null) {
    return { livePriceAtDispatch: null, slippagePct: null, slippagePoints: null };
  }
  const brickPrice = event.type === 'ENTRY' ? event.entry : event.exitPrice;
  const slippagePoints = livePrice - brickPrice; // signed: positive = live price above the recorded brick price
  const slippagePct = (slippagePoints / brickPrice) * 100;
  return { livePriceAtDispatch: livePrice, slippagePct, slippagePoints };
}

module.exports = { measureSlippage };
