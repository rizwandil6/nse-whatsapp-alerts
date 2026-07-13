'use strict';

/**
 * Rigorous per-trade condition audit. For each fired signal, recomputes and
 * records the actual state of every named rule condition (EMA trend, RSI,
 * BB/EMA cross, demand/supply zone) AT SIGNAL DAY, and separately re-checks
 * RSI/trend AT THE ACTUAL ENTRY DAY (signal+1, next-day open) to catch cases
 * where a condition drifted out of spec between signal and execution —
 * these would be logged as "fired by the book" but the book had already
 * changed by the time the trade was actually entered.
 */

const fs = require('fs');
const path = require('path');
const { precompute } = require('./confluence');
const { rsi } = require('./indicators');

const CACHE_PATH = path.join(__dirname, 'mtf_candle_cache.json');
const SECTOR_MAP_PATH = path.join(__dirname, 'sector_map.json');
const SIGNALS_PATH = path.join(__dirname, 'signals_found.json');
const OUT_PATH = path.join(__dirname, 'audit_report.json');

const RSI_MIN = 50;
const RSI_MAX = 75;

function main() {
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  const sectorMap = JSON.parse(fs.readFileSync(SECTOR_MAP_PATH, 'utf8'));
  const signals = JSON.parse(fs.readFileSync(SIGNALS_PATH, 'utf8'));

  // precompute daily series per symbol once
  const dailyBySymbol = {};
  for (const [symbol, tf] of Object.entries(cache)) {
    if (tf.day && tf.day.length >= 100) dailyBySymbol[symbol] = precompute(tf.day);
  }

  const audited = signals.map((sig, idx) => {
    const daily = dailyBySymbol[sig.symbol];
    const i = sig.dayIndex; // signal day index
    const entryIdx = i + 1; // actual entry day

    // EMA trend magnitude at signal day: 50 SMA slope over last 10 bars, as %
    const sma50Now = daily.sma50[i];
    const sma50Then = daily.sma50[i - 10];
    const sma50SlopePct = sma50Then ? ((sma50Now - sma50Then) / sma50Then) * 100 : null;

    // BB/EMA cross strength at signal day: how far above 20 SMA is the 9 EMA, as %
    const ema9 = daily.ema9[i];
    const sma20 = daily.sma20[i];
    const crossStrengthPct = sma20 ? ((ema9 - sma20) / sma20) * 100 : null;

    // Risk sizing
    const entryPrice = sig.trade.entryPrice;
    const riskPct = ((entryPrice - sig.stopLoss) / entryPrice) * 100;
    const entryGapFromSignalPct = ((entryPrice - sig.signalPrice) / sig.signalPrice) * 100;

    // Drift check: recompute RSI/trend AT THE ACTUAL ENTRY DAY, not just signal day
    let driftRsiOutOfBand = null;
    let driftTrendBroke = null;
    if (entryIdx < daily.candles.length) {
      const rsiAtEntry = daily.rsi14[entryIdx];
      driftRsiOutOfBand = rsiAtEntry != null && (rsiAtEntry < RSI_MIN || rsiAtEntry > RSI_MAX);
      const sma50AtEntry = daily.sma50[entryIdx];
      const sma50TenBack = daily.sma50[entryIdx - 10];
      driftTrendBroke = sma50AtEntry != null && sma50TenBack != null && sma50AtEntry < sma50TenBack;
    }

    const isWin = sig.trade.pnlPct > 0;
    const rMultiple = riskPct > 0 ? sig.trade.pnlPct / riskPct : null;

    return {
      id: `${sig.symbol}_${sig.date}`,
      symbol: sig.symbol,
      date: sig.date,
      sector: sig.sector,
      outcome: isWin ? 'WIN' : 'LOSS',
      action: sig.trade.action,
      pnlPct: sig.trade.pnlPct,
      riskPct,
      rMultiple,
      holdDays: sig.trade.holdDays,
      // EMA trend
      sma50SlopePct,
      recentGoldenCross: sig.recentGoldenCross,
      // RSI
      rsiDaily: sig.rsiDaily,
      rsiWeekly: sig.rsiWeekly,
      rsiMonthly: sig.rsiMonthly,
      rsiSpread: sig.rsiDaily != null && sig.rsiMonthly != null ? Math.abs(sig.rsiDaily - sig.rsiMonthly) : null,
      // BB / EMA cross
      crossStrengthPct,
      // Zone
      zoneScore: sig.zoneScore,
      zoneBaseCount: sig.zoneBaseCount,
      zoneFreshness: sig.zoneFreshness,
      zoneStrength: sig.zoneStrength,
      targetSource: sig.targetSource,
      // Rule-drift audit
      entryGapFromSignalPct,
      driftRsiOutOfBand,
      driftTrendBroke,
    };
  });

  fs.writeFileSync(OUT_PATH, JSON.stringify(audited, null, 1));
  console.log(`Audited ${audited.length} trades -> ${OUT_PATH}`);

  const wins = audited.filter((t) => t.outcome === 'WIN');
  const losses = audited.filter((t) => t.outcome === 'LOSS');
  console.log(`Wins: ${wins.length}, Losses: ${losses.length}`);

  const driftCases = audited.filter((t) => t.driftRsiOutOfBand || t.driftTrendBroke);
  console.log(`\nRule-drift cases (condition true at signal, false by actual entry): ${driftCases.length}`);
  driftCases.forEach((t) => {
    console.log(
      `  ${t.id.padEnd(20)} ${t.outcome.padEnd(5)} rMult=${t.rMultiple?.toFixed(2)}` +
        (t.driftRsiOutOfBand ? ' [RSI drifted out of band by entry]' : '') +
        (t.driftTrendBroke ? ' [50-SMA trend broke by entry]' : '')
    );
  });
}

main();
