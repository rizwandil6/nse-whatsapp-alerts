'use strict';

/**
 * Offline correctness gate -- NOT part of the live streamer. Replays a
 * symbol's full historical data/{symbol}.csv through THIS repo's own
 * renko_engine.js + combo_signal_engine.js (the exact code the live
 * streamer uses, not a reimplementation) and diffs the resulting trades
 * against the Python engine's actual output/trade_ledger.csv, for every
 * comboId. Must pass before any live alert from this service is trusted --
 * this is the only thing that actually proves the JS port is faithful to
 * what was backtested and walk-forward validated; everything else is
 * architecture.
 *
 * Usage: node verify_parity.js [SYMBOL ...]   (defaults to a small spot-check set)
 */

const fs = require('fs');
const path = require('path');

const { DynamicRenkoBuilder } = require('./renko_engine');
const { ComboTracker } = require('./combo_signal_engine');
const { COMBOS, COMBOS_BY_BRICK_PCT } = require('./combos');

const REPO_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(REPO_ROOT, 'data');
const LEDGER_PATH = path.join(REPO_ROOT, 'output', 'trade_ledger.csv');
const HOLDINGS_PATH = path.join(REPO_ROOT, 'holdings.csv');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const EPS_PRICE = 1e-6;

function parseCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').trim();
  const lines = text.split('\n');
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i]; });
    return row;
  });
}

/** Same +5:30 correction as main.py::make_data_loader (data/{symbol}.csv datetimes are UTC-naive). */
function parseCsvTimestampToIstMs(dtStr) {
  const utcMs = Date.parse(dtStr.replace(' ', 'T') + 'Z');
  return utcMs + IST_OFFSET_MS;
}

function formatIstMs(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function loadHoldings() {
  const rows = parseCsv(HOLDINGS_PATH);
  const entryDates = {};
  const qty = {};
  for (const r of rows) {
    if (r.entry_date) entryDates[r.symbol] = parseCsvTimestampToIstMs(r.entry_date + ' 00:00:00');
    if (r.qty) qty[r.symbol] = parseFloat(r.qty);
  }
  return { entryDates, qty };
}

/** Replays one symbol's full candle history through all 36 combos. Returns { [comboId]: trade[] }. */
function replaySymbol(symbol) {
  const csvPath = path.join(DATA_DIR, `${symbol}.csv`);
  const candles = parseCsv(csvPath).map((r) => ({
    timestampMs: parseCsvTimestampToIstMs(r.datetime),
    close: parseFloat(r.close),
  }));

  const buildersByPct = {};
  const trackersByCombo = {};
  const brickCountByPct = {};
  const entryBrickIndexByCombo = {}; // comboId -> brick-count-so-far (for that combo's brick_pct) at the moment it entered
  for (const brickPct of Object.keys(COMBOS_BY_BRICK_PCT)) {
    buildersByPct[brickPct] = new DynamicRenkoBuilder(parseFloat(brickPct));
    brickCountByPct[brickPct] = 0;
  }
  for (const c of COMBOS) {
    trackersByCombo[c.comboId] = new ComboTracker(c.comboId, c.entryConfirmN, c.slRejectionN);
  }

  const tradesByCombo = {};
  for (const c of COMBOS) tradesByCombo[c.comboId] = [];

  for (const candle of candles) {
    for (const brickPct of Object.keys(COMBOS_BY_BRICK_PCT)) {
      const builder = buildersByPct[brickPct];
      const newBricks = builder.pushCandleClose(candle.close, candle.timestampMs);
      for (const brick of newBricks) {
        brickCountByPct[brickPct] += 1;
        for (const combo of COMBOS_BY_BRICK_PCT[brickPct]) {
          const event = trackersByCombo[combo.comboId].onBrick(brick);
          if (event && event.type === 'ENTRY') entryBrickIndexByCombo[combo.comboId] = brickCountByPct[brickPct];
          if (event && event.type === 'EXIT') tradesByCombo[combo.comboId].push(event);
        }
      }
    }
  }

  // backtest.py's FORCE_CLOSE_AT_END_OF_DATA=True equivalent -- BUT note its exact
  // edge case: if entry happened on the very last brick of the whole series (no
  // subsequent brick exists to force-close against), backtest.py's simulate_combo_on_bricks
  // discards that trade entirely rather than recording a degenerate 0-bar close
  // (`if not force_close_at_end or n - 1 <= i: break` -- never reaches the recording
  // step). Replicated here via entryBrickIndexByCombo vs the final brick count.
  for (const brickPct of Object.keys(COMBOS_BY_BRICK_PCT)) {
    const builder = buildersByPct[brickPct];
    if (builder.lastBrickTimestampMs == null) continue;
    const totalBricks = brickCountByPct[brickPct];
    for (const combo of COMBOS_BY_BRICK_PCT[brickPct]) {
      const tracker = trackersByCombo[combo.comboId];
      if (!tracker.position) continue;
      if (entryBrickIndexByCombo[combo.comboId] >= totalBricks) continue; // entered on the last brick -- discard, matches Python
      const event = tracker._close(builder.lastClose, builder.lastBrickTimestampMs, 'END_OF_DATA');
      tradesByCombo[combo.comboId].push(event);
    }
  }

  return tradesByCombo;
}

function loadLedgerTrades(symbol) {
  const rows = parseCsv(LEDGER_PATH);
  const byCombo = {};
  for (const r of rows) {
    if (r.symbol !== symbol) continue;
    const comboId = parseInt(r.combo_id, 10);
    (byCombo[comboId] = byCombo[comboId] || []).push({
      direction: r.direction,
      entry: parseFloat(r.entry_price),
      exitPrice: parseFloat(r.exit_price),
      action: r.exit_reason,
      // trade_ledger.csv's entry_time/exit_time are ALREADY correct IST wall-clock
      // strings (main.py applies the +5:30 fix before the backtest runs) -- no
      // offset applied here, just parsed as-is for string comparison below.
      entryTimeStr: r.entry_time,
      exitTimeStr: r.exit_time,
    });
  }
  return byCombo;
}

function diffCombo(symbol, comboId, jsTrades, pyTrades, entryDateMs) {
  const jsFiltered = jsTrades.filter((t) => t.entryTimestampMs >= entryDateMs);
  if (jsFiltered.length !== pyTrades.length) {
    return `count mismatch: JS=${jsFiltered.length} PY=${pyTrades.length}`;
  }
  for (let i = 0; i < jsFiltered.length; i++) {
    const a = jsFiltered[i], b = pyTrades[i];
    const aEntryStr = formatIstMs(a.entryTimestampMs);
    const aExitStr = formatIstMs(a.exitTimestampMs);
    if (a.direction !== b.direction) return `row ${i}: direction ${a.direction} vs ${b.direction}`;
    if (Math.abs(a.entry - b.entry) > EPS_PRICE) return `row ${i}: entry ${a.entry} vs ${b.entry}`;
    if (Math.abs(a.exitPrice - b.exitPrice) > EPS_PRICE) return `row ${i}: exit ${a.exitPrice} vs ${b.exitPrice}`;
    if (a.action !== b.action) return `row ${i}: action ${a.action} vs ${b.action}`;
    if (aEntryStr !== b.entryTimeStr) return `row ${i}: entry_time ${aEntryStr} vs ${b.entryTimeStr}`;
    if (aExitStr !== b.exitTimeStr) return `row ${i}: exit_time ${aExitStr} vs ${b.exitTimeStr}`;
  }
  return null; // match
}

function verifySymbol(symbol, { entryDates }) {
  console.log(`\n=== ${symbol} ===`);
  const jsTradesByCombo = replaySymbol(symbol);
  const pyTradesByCombo = loadLedgerTrades(symbol);
  const entryDateMs = entryDates[symbol] != null ? entryDates[symbol] : -Infinity;

  let pass = 0, fail = 0;
  for (const combo of COMBOS) {
    const jsTrades = jsTradesByCombo[combo.comboId] || [];
    const pyTrades = pyTradesByCombo[combo.comboId] || [];
    const mismatch = diffCombo(symbol, combo.comboId, jsTrades, pyTrades, entryDateMs);
    if (mismatch) {
      fail++;
      console.log(`  combo ${combo.comboId} (brick ${combo.brickPct}%, N=${combo.entryConfirmN}, K=${combo.slRejectionN}): MISMATCH -- ${mismatch}`);
    } else {
      pass++;
    }
  }
  console.log(`  ${pass}/${pass + fail} combos matched trade-for-trade.`);
  return fail === 0;
}

function main() {
  const symbols = process.argv.slice(2);
  const targets = symbols.length ? symbols : ['RVNL', 'CONCOR', 'SUZLON'];
  const { entryDates, qty } = loadHoldings();
  let allPass = true;
  for (const symbol of targets) {
    const csvPath = path.join(DATA_DIR, `${symbol}.csv`);
    if (!fs.existsSync(csvPath)) {
      console.log(`\n=== ${symbol} ===\n  SKIPPED -- no data/${symbol}.csv`);
      continue;
    }
    const ok = verifySymbol(symbol, { entryDates, qty });
    allPass = allPass && ok;
  }
  console.log(allPass ? '\nALL PASS -- JS port matches the Python backtest trade-for-trade.' : '\nFAILURES FOUND -- do not trust live alerts until resolved.');
  process.exit(allPass ? 0 : 1);
}

main();
