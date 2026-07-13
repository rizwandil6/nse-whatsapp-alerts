'use strict';

/**
 * Fetches the full NSE equity universe from Upstox's public instrument
 * master (same source the existing Java UpstoxTradeService uses). Filters
 * to real operating companies only, using ISIN prefix — verified directly
 * against the actual instrument list, not guessed:
 *   INE = real operating company equity (2,052 as of this build)
 *   INF = mutual fund / ETF products issued by AMCs (328) — excluded
 *   IN9 = a single DVR (differential voting rights) share class — excluded
 *         for simplicity, not worth special-casing one instrument
 *
 * An earlier attempt used a name-based regex (matching "ETF" in the
 * symbol/name) and produced a false positive — "JETFREIGHT" (a real
 * logistics company) got wrongly excluded because its name contains the
 * substring "ETF". ISIN prefix has no such false-positive risk.
 */

const fs = require('fs');
const path = require('path');

const INSTRUMENT_MASTER_URL = 'https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz';
const OUT_PATH = path.join(__dirname, 'nse_universe.json');

async function main() {
  const zlib = require('zlib');
  const res = await fetch(INSTRUMENT_MASTER_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching instrument master`);
  const gzBuffer = Buffer.from(await res.arrayBuffer());
  const jsonBuffer = zlib.gunzipSync(gzBuffer);
  const data = JSON.parse(jsonBuffer.toString('utf8'));

  const nseEq = data.filter((d) => d.exchange === 'NSE' && d.instrument_type === 'EQ' && d.segment === 'NSE_EQ');
  const realEquities = nseEq.filter((d) => d.isin.startsWith('INE'));

  const universe = {};
  for (const d of realEquities) universe[d.trading_symbol] = d.instrument_key;

  fs.writeFileSync(OUT_PATH, JSON.stringify(universe, null, 1));
  console.log(`Fetched ${nseEq.length} NSE_EQ instruments, ${realEquities.length} real equities (INE prefix).`);
  console.log(`Written ${OUT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
