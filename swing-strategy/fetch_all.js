'use strict';

const fs = require('fs');
const path = require('path');

const TOKEN_PATH = '/private/tmp/claude-501/-Users-adilrizwan-Downloads/fef5c952-3a52-453b-aac2-05d44213f064/scratchpad/.secrets/upstox_token.txt';
const SYMBOLS_PATH = path.join(__dirname, 'symbols.json');
const CACHE_PATH = path.join(__dirname, 'mtf_candle_cache.json');

const TOKEN = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
const symbolMap = JSON.parse(fs.readFileSync(SYMBOLS_PATH, 'utf8'));
const UPSTOX_BASE = 'https://api.upstox.com/v2';

// Confirmed empirically: day works >=5yr, week works >=5yr, month caps at 10yr (11yr fails)
const RANGES = {
  day: { from: '2021-07-10', to: '2026-07-09' },
  week: { from: '2021-07-10', to: '2026-07-09' },
  month: { from: '2016-07-10', to: '2026-07-09' },
};

async function fetchCandles(instrumentKey, interval, from, to) {
  const url = `${UPSTOX_BASE}/historical-candle/${encodeURIComponent(instrumentKey)}/${interval}/${to}/${from}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${instrumentKey}/${interval}`);
  const body = await res.json();
  const raw = body?.data?.candles || [];
  return raw
    .map((c) => ({ timestampMs: new Date(c[0]).getTime(), open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

async function main() {
  let cache = {};
  if (fs.existsSync(CACHE_PATH)) cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));

  let count = 0;
  for (const [symbol, instrumentKey] of Object.entries(symbolMap)) {
    if (cache[symbol] && cache[symbol].day && cache[symbol].week && cache[symbol].month) {
      count++;
      continue;
    }
    try {
      console.log(`Fetching ${symbol} (${instrumentKey})...`);
      const day = await fetchCandles(instrumentKey, 'day', RANGES.day.from, RANGES.day.to);
      const week = await fetchCandles(instrumentKey, 'week', RANGES.week.from, RANGES.week.to);
      const month = await fetchCandles(instrumentKey, 'month', RANGES.month.from, RANGES.month.to);
      cache[symbol] = { day, week, month };
      fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
      count++;
      console.log(`  -> day=${day.length} week=${week.length} month=${month.length}  (${count}/${Object.keys(symbolMap).length})`);
    } catch (e) {
      console.warn(`  FAILED ${symbol}: ${e.message}`);
    }
  }
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
  console.log(`Done. ${Object.keys(cache).length} symbols cached.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
