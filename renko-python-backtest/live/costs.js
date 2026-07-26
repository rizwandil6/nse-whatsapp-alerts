'use strict';

/**
 * Direct JS port of ../costs.py::cost_rupees -- Upstox's own published
 * intraday equity charges (upstox.com/brokerage-charges/): brokerage min
 * Rs20 or 0.1% of turnover (whichever lower) per executed leg, STT 0.025%
 * (sell leg only), NSE exchange transaction charge 0.00297% (both legs),
 * SEBI turnover fee Rs10/crore = 0.0001% (both legs), stamp duty 0.003%
 * (buy leg only), 18% GST on (brokerage + exchange + SEBI). IPFT charges
 * not broken out separately by Upstox's page, not modeled (negligible).
 */

function costRupees(entryPrice, exitPrice, qty, direction) {
  let buyValue, sellValue;
  if (direction === 'LONG') {
    buyValue = qty * entryPrice;
    sellValue = qty * exitPrice;
  } else {
    // SHORT: sell first, buy back to cover
    sellValue = qty * entryPrice;
    buyValue = qty * exitPrice;
  }

  const brokerage = Math.min(20, buyValue * 0.001) + Math.min(20, sellValue * 0.001);
  const stt = sellValue * 0.00025;
  const exch = (buyValue + sellValue) * 0.0000297;
  const sebi = (buyValue + sellValue) * 0.000001;
  const stamp = buyValue * 0.00003;
  const gst = 0.18 * (brokerage + exch + sebi);
  return brokerage + stt + exch + sebi + stamp + gst;
}

module.exports = { costRupees };
