'use strict';

/**
 * Backtest the confluence strategy (UNCHANGED rules) across the full
 * 353-stock halal universe, for comparison against the 178-stock baseline
 * (26 trades, 57.7% win, +3.64% avg P&L) before deciding whether to widen
 * the live deployment. New stocks have no sector classification yet (see
 * sector_map.json) so they pass through the sector-strength check
 * unfiltered, same as the ~20 unmapped stocks in the original 178.
 */

const fs = require('fs');
const path = require('path');
const { precompute, checkSignal } = require('./confluence');
const { simulatePositionalTrade } = require('./simulate_positional');

const CACHE_PATH = path.join(__dirname, 'mtf_candle_cache.json');
const SECTOR_MAP_PATH = path.join(__dirname, 'sector_map.json');
const SECTOR_CACHE_PATH = path.join(__dirname, 'sector_candle_cache.json');
const SYMBOLS_353_PATH = path.join(__dirname, '..', 'ema-scalp-strategy', 'symbols.json');
const OUT_PATH = path.join(__dirname, 'signals_found_353.json');

function main() {
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  const symbols353 = JSON.parse(fs.readFileSync(SYMBOLS_353_PATH, 'utf8'));
  const sectorMap = JSON.parse(fs.readFileSync(SECTOR_MAP_PATH, 'utf8'));
  const sectorCandles = JSON.parse(fs.readFileSync(SECTOR_CACHE_PATH, 'utf8'));
  const sectorPrecomputed = {};
  for (const [name, candles] of Object.entries(sectorCandles)) sectorPrecomputed[name] = precompute(candles);

  const original178 = JSON.parse(fs.readFileSync(path.join(__dirname, 'symbols_178_backup_before_353.json'), 'utf8'));

  const allSignals = [];
  let scanned = 0;

  for (const symbol of Object.keys(symbols353)) {
    const tf = cache[symbol];
    if (!tf || !tf.day || tf.day.length < 100) continue;
    scanned++;
    const dailyP = precompute(tf.day);
    const weeklyP = precompute(tf.week);
    const monthlyP = precompute(tf.month);
    const sectorName = sectorMap[symbol];
    const sectorMonthly = sectorName ? sectorPrecomputed[sectorName] : null;

    for (let i = 60; i < tf.day.length; i++) {
      const result = checkSignal(dailyP, weeklyP, monthlyP, i, sectorMonthly);
      if (!result.fires) continue;
      const trade = simulatePositionalTrade(tf.day, i, result.stopLoss, result.target);
      allSignals.push({
        symbol,
        sector: sectorName || null,
        isNewStock: !original178[symbol],
        date: new Date(tf.day[i].timestampMs).toISOString().slice(0, 10),
        signalPrice: result.entryPrice,
        stopLoss: result.stopLoss,
        target: result.target,
        targetSource: result.targetSource,
        zoneScore: result.zone?.score?.total,
        zoneFreshness: result.zone?.score?.freshness,
        zoneStrength: result.zone?.score?.strength,
        zoneTimeAtBase: result.zone?.score?.timeAtBase,
        zoneBaseCount: result.zone?.baseCount,
        rsiDaily: result.checks?.rsiValues?.daily,
        rsiWeekly: result.checks?.rsiValues?.weekly,
        rsiMonthly: result.checks?.rsiValues?.monthly,
        recentGoldenCross: result.checks?.recentGoldenCross,
        sectorApplicable: result.checks?.sectorApplicable,
        trade,
      });
    }
  }

  console.log(`Scanned ${scanned}/${Object.keys(symbols353).length} symbols (rest missing cache data).\n`);

  function summarize(list, label) {
    const withTrades = list.filter((s) => s.trade);
    if (!withTrades.length) { console.log(`${label}: no trades`); return; }
    const wins = withTrades.filter((s) => s.trade.pnlPct > 0).length;
    const avg = withTrades.reduce((s, x) => s + x.trade.pnlPct, 0) / withTrades.length;
    const avgHold = withTrades.reduce((s, x) => s + x.trade.holdDays, 0) / withTrades.length;
    console.log(`${label}: n=${withTrades.length}  win=${((wins / withTrades.length) * 100).toFixed(1)}%  avgPnL=${avg >= 0 ? '+' : ''}${avg.toFixed(3)}%  avgHold=${avgHold.toFixed(1)}d`);
  }

  summarize(allSignals, 'Full 353-stock universe');
  summarize(allSignals.filter((s) => !s.isNewStock), '  -> original 176 (overlap w/ old 178, minus 2 dropped)');
  summarize(allSignals.filter((s) => s.isNewStock), '  -> newly added 177 stocks');

  fs.writeFileSync(OUT_PATH, JSON.stringify(allSignals, null, 1));
  console.log(`\nSignals written to ${OUT_PATH}`);
}

main();
