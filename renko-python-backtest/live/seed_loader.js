'use strict';

/**
 * Parses live/seed_data/{symbol}.csv (a copy of ../data/{symbol}.csv) into
 * candle closes for the one-time historical seed of each symbol's
 * DynamicRenkoBuilder state. Applies the SAME +5:30 IST correction as
 * ../main.py::make_data_loader -- the raw CSV datetime column is
 * UTC-naive (confirmed: a trading day's rows span 03:45-09:55, exactly
 * NSE's 09:15-15:30 IST session shifted back 5:30, an artifact of the
 * original Upstox JSON -> CSV conversion earlier in this project).
 */

const fs = require('fs');
const path = require('path');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const SEED_DATA_DIR = path.join(__dirname, 'seed_data');

function parseCsvTimestampToIstMs(dtStr) {
  const utcMs = Date.parse(dtStr.replace(' ', 'T') + 'Z');
  return utcMs + IST_OFFSET_MS;
}

/** Returns [{close, timestampMs}, ...] sorted ascending, or [] if no seed file exists for this symbol. */
function loadSeedCandles(symbol) {
  const csvPath = path.join(SEED_DATA_DIR, `${symbol}.csv`);
  if (!fs.existsSync(csvPath)) return [];

  const text = fs.readFileSync(csvPath, 'utf8').trim();
  const lines = text.split('\n');
  const header = lines[0].split(',');
  const closeIdx = header.indexOf('close');
  const dtIdx = header.indexOf('datetime');

  const candles = lines.slice(1).map((line) => {
    const cells = line.split(',');
    return {
      timestampMs: parseCsvTimestampToIstMs(cells[dtIdx]),
      close: parseFloat(cells[closeIdx]),
    };
  });
  candles.sort((a, b) => a.timestampMs - b.timestampMs);
  return candles;
}

module.exports = { loadSeedCandles, parseCsvTimestampToIstMs };
