'use strict';

/**
 * One-off: import the vault forward-ledger's currently-OPEN rows into
 * swing.signals, so the dashboard shows the existing open positions immediately
 * (entry-price continuity) before the stateless runner's first live recompute
 * takes over as the source of truth. Local-only helper — the CSV lives in the
 * user's vault, not the repo. Safe to re-run (upsert on symbol+signal_date).
 *
 *   LEDGER_CSV=/path/to/confluence-forward-ledger.csv node seed_from_ledger.js
 */

const fs = require('fs');
const { SwingDB } = require('./swing_db');

const CSV = process.env.LEDGER_CSV ||
  '/Users/adilrizwan/Downloads/second brain/wiki/journal/confluence-forward-ledger.csv';

function parseCsv(text) {
  const [head, ...lines] = text.trim().split('\n');
  const cols = head.split(',');
  return lines.filter(Boolean).map((line) => {
    const vals = line.split(',');
    const o = {};
    cols.forEach((c, i) => { o[c.trim()] = (vals[i] || '').trim(); });
    return o;
  });
}

async function main() {
  if (!fs.existsSync(CSV)) { console.error('ledger CSV not found:', CSV); process.exit(1); }
  const rows = parseCsv(fs.readFileSync(CSV, 'utf8')).filter((r) => r.status === 'open');
  const db = new SwingDB();
  await db.init();
  let n = 0;
  for (const r of rows) {
    const entry = Number(r.entry), stop = Number(r.stop);
    const R = entry - stop;
    await db.upsertSignal({
      symbol: r.symbol, signalDate: r.signal_date, status: 'open',
      entryDate: r.entry_date || null, entryPx: entry, stopPx: stop,
      rPerShare: R, riskPct: entry ? Number(((R / entry) * 100).toFixed(1)) : null,
      target1Px: Number((entry + 2 * R).toFixed(2)), exitDate: null, exitPx: null, rNet: null,
      sinceAlertPct: null, lastPrice: null,
      rsiGatePass: r.rsi_gate_pass === 'True' || r.rsi_gate_pass === 'true',
      rules: { seeded: true, note: 'imported from vault forward-ledger; rule detail fills on next runner pass' },
    });
    n++;
  }
  console.log(`seeded ${n} open positions into swing.signals`);
  await db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
