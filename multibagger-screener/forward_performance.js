'use strict';

/**
 * Forward-performance report — the real validation for this screen, since
 * a historical backtest isn't practical here (Screener.in doesn't expose
 * historical ratio snapshots). Reads the permanent append-only log
 * (`forward_performance_log.json`, every QUALIFIED/LOST event, never
 * deleted — unlike `tracked_multibaggers.json`, which drops a symbol once
 * it loses qualification), fetches a FRESH current price for every symbol
 * that ever appeared (via Screener.in, reusing fetchFundamentals — a small
 * set of stocks, not the full universe, so this is cheap), and reports the
 * real price return since each one was first flagged.
 *
 * Run manually: `node forward_performance.js` (needs SCREENER_USERNAME/
 * SCREENER_PASSWORD env vars, or local .secrets/ files for testing).
 */

const fs = require('fs');
const path = require('path');
const { loginToScreener, fetchFundamentals } = require('./fundamental_screener');

const LOG_PATH = path.join(__dirname, 'forward_performance_log.json');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Collapses the raw event log into one summary row per symbol (its most recent qualification episode). */
function summarizeLog(log) {
  const bySymbol = {};
  for (const entry of log) {
    if (!bySymbol[entry.symbol]) bySymbol[entry.symbol] = [];
    bySymbol[entry.symbol].push(entry);
  }
  const summaries = [];
  for (const [symbol, events] of Object.entries(bySymbol)) {
    events.sort((a, b) => a.date.localeCompare(b.date));
    const lastQualified = [...events].reverse().find((e) => e.type === 'QUALIFIED');
    if (!lastQualified) continue;
    const lostAfter = events.find((e) => e.type === 'LOST' && e.date >= lastQualified.date);
    summaries.push({
      symbol,
      qualifiedDate: lastQualified.date,
      priceAtQualification: lastQualified.price,
      status: lostAfter ? 'lost' : 'still_qualifying',
      lostDate: lostAfter ? lostAfter.date : null,
      priceAtLoss: lostAfter ? lostAfter.price : null,
    });
  }
  return summaries;
}

async function main() {
  if (!fs.existsSync(LOG_PATH)) {
    console.log('No forward_performance_log.json yet — no stock has been flagged as a candidate so far.');
    return;
  }
  const log = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
  const summaries = summarizeLog(log);
  if (summaries.length === 0) {
    console.log('Log exists but has no qualification events yet.');
    return;
  }

  const username = process.env.SCREENER_USERNAME || fs.readFileSync(path.join(__dirname, '..', '.secrets', 'screener_username.txt'), 'utf8').trim();
  const password = process.env.SCREENER_PASSWORD || fs.readFileSync(path.join(__dirname, '..', '.secrets', 'screener_password.txt'), 'utf8').trim();
  const cookies = await loginToScreener(username, password);

  console.log(`Fetching current prices for ${summaries.length} ever-flagged stock(s)...\n`);
  const rows = [];
  for (const s of summaries) {
    let currentPrice = null;
    try {
      const fresh = await fetchFundamentals(s.symbol, cookies);
      currentPrice = fresh?.currentPrice ?? null;
    } catch (e) {
      console.warn(`  Could not fetch current price for ${s.symbol}: ${e.message}`);
    }
    await sleep(300);

    const returnSinceQualification =
      currentPrice != null && s.priceAtQualification ? ((currentPrice - s.priceAtQualification) / s.priceAtQualification) * 100 : null;
    const returnWhileQualifying =
      s.status === 'lost' && s.priceAtLoss != null && s.priceAtQualification
        ? ((s.priceAtLoss - s.priceAtQualification) / s.priceAtQualification) * 100
        : null;

    rows.push({ ...s, currentPrice, returnSinceQualification, returnWhileQualifying });
  }

  console.log('\n=== Forward Performance Report ===\n');
  for (const r of rows) {
    const sign = (v) => (v >= 0 ? '+' : '');
    console.log(`${r.symbol}`);
    console.log(`  Qualified: ${r.qualifiedDate} @ Rs ${r.priceAtQualification}`);
    if (r.status === 'still_qualifying') {
      console.log(`  Status: still qualifying`);
      console.log(`  Current price: Rs ${r.currentPrice ?? 'n/a'}  |  Return since qualification: ${r.returnSinceQualification != null ? sign(r.returnSinceQualification) + r.returnSinceQualification.toFixed(1) + '%' : 'n/a'}`);
    } else {
      console.log(`  Status: lost qualification on ${r.lostDate} @ Rs ${r.priceAtLoss}`);
      console.log(`  Return while qualifying: ${r.returnWhileQualifying != null ? sign(r.returnWhileQualifying) + r.returnWhileQualifying.toFixed(1) + '%' : 'n/a'}`);
      console.log(`  Current price: Rs ${r.currentPrice ?? 'n/a'}  |  Return since original qualification (incl. after loss): ${r.returnSinceQualification != null ? sign(r.returnSinceQualification) + r.returnSinceQualification.toFixed(1) + '%' : 'n/a'}`);
    }
    console.log('');
  }

  const withReturns = rows.filter((r) => r.returnSinceQualification != null);
  if (withReturns.length > 0) {
    const avg = withReturns.reduce((s, r) => s + r.returnSinceQualification, 0) / withReturns.length;
    const positive = withReturns.filter((r) => r.returnSinceQualification > 0).length;
    console.log(`--- Summary: n=${withReturns.length}, avg return since qualification=${avg >= 0 ? '+' : ''}${avg.toFixed(1)}%, ${positive}/${withReturns.length} positive ---`);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { summarizeLog };
