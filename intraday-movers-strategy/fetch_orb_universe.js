'use strict';

/**
 * Fetches 1-minute intraday candles for the moderate-volatility ORB
 * candidate universe (stocks whose trailing 40-day average day-range falls
 * in 1.5%-3%, computed from swing-strategy's existing daily cache — avoids
 * the small-cap volatility trap that killed the "biggest mover" idea).
 * ~3 months, chunked into <=30-day windows (Upstox's 1minute interval cap).
 */

const fs = require('fs');
const path = require('path');

const TOKEN_PATH = '/private/tmp/claude-501/-Users-adilrizwan-Downloads/fef5c952-3a52-453b-aac2-05d44213f064/scratchpad/.secrets/upstox_token.txt';
const TOKEN = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
const CACHE_PATH = path.join(__dirname, 'intraday_1min_cache.json');
const UPSTOX_BASE = 'https://api.upstox.com/v2';

const cache = require('../swing-strategy/mtf_candle_cache.json');
const symbols353 = require('../ema-scalp-strategy/symbols.json');

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function buildBand() {
  const results = [];
  for (const symbol of Object.keys(symbols353)) {
    const tf = cache[symbol];
    if (!tf || !tf.day || tf.day.length < 40) continue;
    const recent = tf.day.slice(-40);
    const ranges = recent.map((c) => ((c.high - c.low) / c.open) * 100);
    const avgRange = ranges.reduce((s, v) => s + v, 0) / ranges.length;
    if (avgRange >= 1.5 && avgRange < 3) results.push(symbol);
  }
  return results;
}

async function fetchCandles(instrumentKey, from, to) {
  const url = `${UPSTOX_BASE}/historical-candle/${encodeURIComponent(instrumentKey)}/1minute/${to}/${from}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const raw = body?.data?.candles || [];
  return raw
    .map((c) => ({ timestampMs: new Date(c[0]).getTime(), open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const band = buildBand();
  console.log(`ORB candidate universe: ${band.length} stocks (1.5%-3% avg daily range).`);

  const to = new Date();
  const chunkStarts = [];
  for (let daysAgo = 90; daysAgo > 0; daysAgo -= 29) {
    const from = new Date();
    from.setDate(from.getDate() - daysAgo);
    const chunkTo = new Date();
    chunkTo.setDate(chunkTo.getDate() - Math.max(0, daysAgo - 29));
    chunkStarts.push({ from: isoDate(from), to: isoDate(chunkTo) });
  }

  let out = {};
  if (fs.existsSync(CACHE_PATH)) out = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));

  let count = 0;
  for (const symbol of band) {
    if (out[symbol]) { count++; continue; }
    try {
      const instrumentKey = symbols353[symbol];
      let all = [];
      for (const { from, to } of chunkStarts) {
        const candles = await fetchCandles(instrumentKey, from, to);
        all = all.concat(candles);
        await sleep(150);
      }
      all.sort((a, b) => a.timestampMs - b.timestampMs);
      out[symbol] = all;
      count++;
      if (count % 15 === 0) {
        fs.writeFileSync(CACHE_PATH, JSON.stringify(out));
        console.log(`  ...${count}/${band.length} fetched, checkpointed.`);
      }
    } catch (e) {
      console.warn(`  FAILED ${symbol}: ${e.message}`);
    }
  }
  fs.writeFileSync(CACHE_PATH, JSON.stringify(out));
  console.log(`Done. ${Object.keys(out).length}/${band.length} stocks cached.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
