'use strict';

/**
 * Applies the same realistic intraday MIS cost model used elsewhere in this
 * project (Zerodha-representative schedule), sized to the user's stated
 * Rs 50,000 capital, to whichever trades file is passed as an argument.
 */

const fs = require('fs');
const path = require('path');

const CAPITAL = 50000;
const BROKERAGE_RATE = 0.0003;
const BROKERAGE_CAP = 20;
const STT_RATE = 0.00025;
const EXCHANGE_TXN_RATE = 0.0000297;
const SEBI_RATE = 0.000001;
const STAMP_DUTY_RATE = 0.00003;
const GST_RATE = 0.18;

function costPct(entry, exit, direction) {
  const qty = CAPITAL / entry;
  const entryValue = qty * entry;
  const exitValue = qty * exit;
  const buyValue = direction === 'LONG' ? entryValue : exitValue;
  const sellValue = direction === 'LONG' ? exitValue : entryValue;
  const brokerage = Math.min(BROKERAGE_CAP, buyValue * BROKERAGE_RATE) + Math.min(BROKERAGE_CAP, sellValue * BROKERAGE_RATE);
  const stt = sellValue * STT_RATE;
  const exch = (buyValue + sellValue) * EXCHANGE_TXN_RATE;
  const sebi = (buyValue + sellValue) * SEBI_RATE;
  const stamp = buyValue * STAMP_DUTY_RATE;
  const gst = GST_RATE * (brokerage + exch + sebi);
  return ((brokerage + stt + exch + sebi + stamp + gst) / CAPITAL) * 100;
}

function summarize(list, label) {
  if (!list.length) {
    console.log(`${label}: no trades`);
    return;
  }
  const wins = list.filter((t) => t.netPnlPct > 0).length;
  const grossAvg = list.reduce((s, t) => s + t.pnlPct, 0) / list.length;
  const netAvg = list.reduce((s, t) => s + t.netPnlPct, 0) / list.length;
  console.log(
    `${label}: n=${list.length}  netWin=${((wins / list.length) * 100).toFixed(1)}%  grossAvg=${grossAvg >= 0 ? '+' : ''}${grossAvg.toFixed(3)}%  netAvg=${netAvg >= 0 ? '+' : ''}${netAvg.toFixed(3)}%`
  );
}

const file = process.argv[2] || 'trades_orb.json';
const trades = JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
for (const t of trades) {
  t.costPct = costPct(t.entry, t.exitPrice, t.direction);
  t.netPnlPct = t.pnlPct - t.costPct;
}
summarize(trades, 'ALL');
summarize(trades.filter((t) => t.direction === 'LONG'), 'LONG only');
summarize(trades.filter((t) => t.direction === 'SHORT'), 'SHORT only');
