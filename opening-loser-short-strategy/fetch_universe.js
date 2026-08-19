'use strict';

/**
 * Fetches ~90 days of 1-minute candles for the opening-loser-short-scalp
 * universe (F&O-eligible ∩ halal-352), chunked into <=30-day windows
 * (Upstox's 1minute interval cap). Independent of every other strategy's
 * cache in this repo — new universe, new file.
 */

const fs = require('fs');
const path = require('path');

const TOKEN_PATH = path.join(__dirname, '../.secrets/upstox_token.txt');
const TOKEN = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
const CACHE_PATH = path.join(__dirname, 'intraday_1min_cache.json');
const UPSTOX_BASE = 'https://api.upstox.com/v2';

const symbols = require('./symbols.json');

function isoDate(d) {
  return d.toISOString().slice(0, 10);
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
  const names = Object.keys(symbols);
  console.log(`Universe: ${names.length} stocks.`);

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
  for (const symbol of names) {
    if (out[symbol]) { count++; continue; }
    try {
      const instrumentKey = symbols[symbol];
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
        console.log(`  ...${count}/${names.length} fetched, checkpointed.`);
      }
    } catch (e) {
      console.warn(`  FAILED ${symbol}: ${e.message}`);
    }
  }
  fs.writeFileSync(CACHE_PATH, JSON.stringify(out));
  console.log(`Done. ${Object.keys(out).length}/${names.length} stocks cached.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
