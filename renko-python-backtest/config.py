"""
Top-level configuration for the Renko backtesting engine. Everything a user
would plausibly want to change lives here, not buried in the modules.
"""

import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# --- Input paths -----------------------------------------------------------
HOLDINGS_PATH = os.path.join(BASE_DIR, "holdings.csv")   # column: symbol
DATA_DIR = os.path.join(BASE_DIR, "data")                # data/{symbol}.csv
OUTPUT_DIR = os.path.join(BASE_DIR, "output")

# --- Renko brick construction -----------------------------------------------
BRICK_PCTS = [0.15, 0.20, 0.25, 0.30]  # percent, e.g. 0.15 = 0.15%

# 'dynamic' (default): brick threshold recomputed each brick as
#   pct * last_brick_close, so brick size scales with price as it moves.
# 'fixed': brick size computed ONCE from the first candle's close and held
#   constant for the whole series (matches the earlier JS renko.js engine).
FIXED_VS_DYNAMIC_PCT = "dynamic"

# 'close' (default): bricks built from candle close only (no wicks) -- the
#   standard simplification used everywhere else in this project.
# 'hl': also use candle high/low to allow a brick to form off an intracandle
#   extreme, not just the close. See renko.py's docstring for the ambiguity
#   this introduces (which of high/low happened first within the candle is
#   unknown from OHLC data) and how it's resolved -- flagged for review.
USE_CLOSE_OR_HL = "close"

# --- Entry / exit rules ------------------------------------------------------
ENTRY_CONFIRM_N_VALUES = [1, 2, 3]   # consecutive same-direction confirm bricks required to enter
SL_REJECTION_N_VALUES = [1, 2, 3]    # consecutive opposite-direction bricks (before +1 brick profit) => SL exit
                                       # see signals.py docstring: this interaction with the base
                                       # "exit on 1 reversal brick" rule is an explicit interpretation,
                                       # flagged for correction.

# --- Combo grid --------------------------------------------------------------
# 4 brick sizes x 3 entry-confirm x 3 SL-rejection = 36 combos, built in
# backtest.py from the lists above. Keep the count of "top" combos to
# highlight configurable here rather than hardcoded in report.py.
TOP_N_COMBOS = 9

# --- Report size cap ----------------------------------------------------------
# trade_ledger.csv always has every trade, full stop -- this cap is ONLY about
# what gets embedded as inline JSON in results.html. With real holdings data
# (tens of thousands of bars/symbol) the finest brick sizes can produce
# hundreds of thousands of trades; embedding all of them made a 349 MB HTML
# file in testing -- not practically shareable, and slow/heavy for a browser
# to parse. Rows are kept from the highest-ranked combos first (by net P&L)
# until this cap is hit, so the report stays useful for the combos anyone
# actually cares about; the full data for every combo is always in the CSV.
MAX_LEDGER_ROWS_IN_REPORT = 60000

# --- Walk-forward validation ---------------------------------------------------
# The main combo_summary.csv / results.html rank all 36 combos on the FULL
# dataset -- that's in-sample optimization, the exact setup that finds noise
# that looks like edge. Walk-forward validation is a separate, additional
# check: split every counted trade (post entry_date filter) at ONE global
# calendar cutoff -- everything before it is "train" (used to rank combos,
# exactly like the main report), everything on/after is "test" (used only to
# see whether that same combo's edge held up on data it wasn't picked with).
# See walkforward.py's docstring for why the cutoff is a single portfolio-wide
# date rather than a per-symbol fraction.
WALK_FORWARD_ENABLED = True
WALK_FORWARD_TRAIN_FRACTION = 0.7  # 70% of the calendar span (by entry_time) is train, 30% is test

# --- Brick export (manual/chart verification) -----------------------------------
# Writes output/bricks/{symbol}.csv (one file per symbol, all brick_pcts in one
# file) with every brick this engine built: timestamp, open, close, high, low,
# direction. Lets you overlay the engine's exact brick boundaries on a real
# 5-min candlestick chart instead of trying to recreate this engine's specific
# dynamic-percentage Renko algorithm in a third-party charting tool, which
# won't match brick-for-brick (see bricks_export.py's docstring).
EXPORT_BRICKS = True

# --- Misc ---------------------------------------------------------------------
# No forced end-of-day square-off is applied -- not requested, and consistent
# with "no fixed price stoploss, the reversal brick is the exit": positions
# can span multiple days until a genuine reversal (or rejection-SL) fires.
# Any position still open at the end of a symbol's data is closed at the
# last available price with exit_reason='END_OF_DATA' purely so metrics
# aren't skewed by leaving trades unresolved -- this is a reporting
# convenience, not a trading rule.
FORCE_CLOSE_AT_END_OF_DATA = True
