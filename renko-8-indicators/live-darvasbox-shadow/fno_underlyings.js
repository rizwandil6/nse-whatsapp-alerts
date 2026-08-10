'use strict';

/**
 * NSE F&O-eligible single-stock underlyings, used to decide which symbols
 * must respect the new (2026-08-03) Closing Auction Session cutoff instead
 * of the old blanket 15:30 close -- see FNO_CLOSE_MIN in bar_aggregator.js.
 *
 * Pulled from NSE's official market-lots list
 * (https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv) on 2026-08-10,
 * index futures (NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY) excluded since this
 * bot only trades single-stock cash equities. SEBI/NSE revises F&O
 * eligibility periodically (roughly quarterly) -- re-pull the CSV and
 * regenerate this file if a symbol's status looks stale.
 */

const FNO_UNDERLYINGS = new Set(require('./fno_underlyings.json'));

function isFno(symbol) {
  return FNO_UNDERLYINGS.has(symbol);
}

module.exports = { FNO_UNDERLYINGS, isFno };
