'use strict';

const fs = require('fs');
const path = require('path');
const { precompute, checkSignal } = require('./confluence');
const { simulatePositionalTrade } = require('./simulate_positional');

const CACHE_PATH = path.join(__dirname, 'mtf_candle_cache.json');
const OUT_PATH = path.join(__dirname, 'signals_found.json');
const SECTOR_MAP_PATH = path.join(__dirname, 'sector_map.json');
const SECTOR_CACHE_PATH = path.join(__dirname, 'sector_candle_cache.json');

function main() {
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  const sectorMap = JSON.parse(fs.readFileSync(SECTOR_MAP_PATH, 'utf8'));
  const sectorCandles = JSON.parse(fs.readFileSync(SECTOR_CACHE_PATH, 'utf8'));
  const sectorPrecomputed = {};
  for (const [name, candles] of Object.entries(sectorCandles)) sectorPrecomputed[name] = precompute(candles);

  const allSignals = [];
  const checkTally = {};
  let unmappedSymbols = 0;

  for (const [symbol, tf] of Object.entries(cache)) {
    if (!tf.day || tf.day.length < 100) continue;
    const dailyP = precompute(tf.day);
    const weeklyP = precompute(tf.week);
    const monthlyP = precompute(tf.month);
    const sectorName = sectorMap[symbol];
    const sectorMonthly = sectorName ? sectorPrecomputed[sectorName] : null;
    if (!sectorName) unmappedSymbols++;

    for (let i = 60; i < tf.day.length; i++) {
      const result = checkSignal(dailyP, weeklyP, monthlyP, i, sectorMonthly);
      for (const [k, v] of Object.entries(result.checks || {})) {
        if (typeof v === 'boolean') {
          checkTally[k] = checkTally[k] || { true: 0, false: 0 };
          checkTally[k][v ? 'true' : 'false']++;
        }
      }
      if (result.fires) {
        const trade = simulatePositionalTrade(tf.day, i, result.stopLoss, result.target);
        allSignals.push({
          symbol,
          sector: sectorName || null,
          dayIndex: i,
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
  }

  console.log(`Scanned ${Object.keys(cache).length} symbols (${unmappedSymbols} without a sector classification, pass-through).\n`);
  console.log('--- Individual check pass rates (aggregate across all symbols/days) ---');
  for (const [k, v] of Object.entries(checkTally)) {
    const total = v.true + v.false;
    console.log(`  ${k.padEnd(20)} true=${v.true} / ${total} (${((v.true / total) * 100).toFixed(2)}%)`);
  }

  console.log(`\nTotal signals fired: ${allSignals.length}`);
  for (const s of allSignals) {
    const t = s.trade;
    console.log(
      `  ${s.symbol.padEnd(12)} ${(s.sector || 'unmapped').padEnd(18)} ${s.date}  signal=${s.signalPrice.toFixed(2)}  stop=${s.stopLoss.toFixed(2)}  target=${s.target.toFixed(2)}(${s.targetSource})  zoneScore=${s.zoneScore}` +
        (t ? `  -> ${t.action} pnl=${t.pnlPct.toFixed(2)}% holdDays=${t.holdDays}` : '  -> NO TRADE (insufficient forward data)')
    );
  }

  const withTrades = allSignals.filter((s) => s.trade);
  if (withTrades.length > 0) {
    const wins = withTrades.filter((s) => s.trade.pnlPct > 0).length;
    const avgPnl = withTrades.reduce((sum, s) => sum + s.trade.pnlPct, 0) / withTrades.length;
    const byAction = {};
    for (const s of withTrades) byAction[s.trade.action] = (byAction[s.trade.action] || 0) + 1;
    console.log('\n--- Positional backtest summary ---');
    console.log(`Trades with resolved outcome: ${withTrades.length}`);
    console.log(`Win rate: ${((wins / withTrades.length) * 100).toFixed(1)}%`);
    console.log(`Avg P&L per trade: ${avgPnl.toFixed(2)}%`);
    console.log(`Avg hold days: ${(withTrades.reduce((s, x) => s + x.trade.holdDays, 0) / withTrades.length).toFixed(1)}`);
    console.log(`Exit reasons: ${JSON.stringify(byAction)}`);
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(allSignals, null, 1));
  console.log(`\nSignals written to ${OUT_PATH}`);
}

main();
