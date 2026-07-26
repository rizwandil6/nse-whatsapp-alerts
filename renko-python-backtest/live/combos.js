'use strict';

/**
 * Reproduces ../backtest.py::generate_combos's exact ordering (brick_pct
 * outer loop, entry_confirm_n middle, sl_rejection_n inner, combo_id
 * starting at 1) so comboId 1-36 here matches the Python engine's
 * combo_id column exactly -- required for verify_parity.js to diff
 * against output/trade_ledger.csv, and for eventKey()/trade logs to mean
 * the same thing as the backtest's own combo_summary.csv.
 */

const BRICK_PCTS = [0.15, 0.20, 0.25, 0.30];
const ENTRY_CONFIRM_N_VALUES = [1, 2, 3];
const SL_REJECTION_N_VALUES = [1, 2, 3];

function generateCombos() {
  const combos = [];
  let comboId = 1;
  for (const brickPct of BRICK_PCTS) {
    for (const entryConfirmN of ENTRY_CONFIRM_N_VALUES) {
      for (const slRejectionN of SL_REJECTION_N_VALUES) {
        combos.push({ comboId, brickPct, entryConfirmN, slRejectionN });
        comboId += 1;
      }
    }
  }
  return combos;
}

const COMBOS = generateCombos();

/** Combos grouped by brick_pct, mirroring backtest.py's combos_by_brick -- one DynamicRenkoBuilder built per group, reused across its 9 combos. */
const COMBOS_BY_BRICK_PCT = {};
for (const c of COMBOS) {
  (COMBOS_BY_BRICK_PCT[c.brickPct] = COMBOS_BY_BRICK_PCT[c.brickPct] || []).push(c);
}

/**
 * The one combo Telegram alerts fire for -- resolved by field-match, not a
 * hardcoded id, so changing which combo is "the winner" is a one-line edit
 * here instead of hunting down a magic number elsewhere.
 */
const WINNING_COMBO_FIELDS = { brickPct: 0.15, entryConfirmN: 1, slRejectionN: 1 };
const WINNING_COMBO = COMBOS.find(
  (c) => c.brickPct === WINNING_COMBO_FIELDS.brickPct
    && c.entryConfirmN === WINNING_COMBO_FIELDS.entryConfirmN
    && c.slRejectionN === WINNING_COMBO_FIELDS.slRejectionN
);
if (!WINNING_COMBO) throw new Error('WINNING_COMBO_FIELDS did not match any generated combo -- check combos.js');
const WINNING_COMBO_ID = WINNING_COMBO.comboId;

module.exports = { BRICK_PCTS, generateCombos, COMBOS, COMBOS_BY_BRICK_PCT, WINNING_COMBO_ID, WINNING_COMBO_FIELDS };
