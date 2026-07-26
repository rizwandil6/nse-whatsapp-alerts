"""
Entry / exit signal logic, independent of the brick-construction and
backtest-loop mechanics.

Entry: N consecutive same-direction CONFIRMED bricks from a flat state.
  LONG  after N consecutive up bricks.
  SHORT after N consecutive down bricks.

Exit: two rules that interact --
  1. Base rule: once the trade has reached "+1 brick profit", exit on the
     very next opposite-direction brick (no fixed price stoploss -- the
     reversal brick IS the exit).
  2. Rejection-based stoploss: BEFORE the trade reaches "+1 brick profit",
     give it room -- exit as SL only after K consecutive opposite-direction
     confirmed bricks (sl_rejection_n).

FLAGGED AMBIGUITY / interpretation, per the request to flag rather than
silently guess:

  (a) How rules 1 and 2 relate. The spec states both "exit after 1 confirm
      opposite brick" (base) and "if K consecutive opposite bricks form
      before +1 brick profit, exit as SL" as if they were two separate,
      simultaneous rules -- taken completely literally that's
      contradictory (the base rule would fire on brick 1, before K could
      ever be reached, for any K > 1). The interpretation implemented here
      reconciles them the way that makes both rules meaningful: the fast
      "exit on 1 reversal brick" rule applies ONLY ONCE THE TRADE IS
      ALREADY PROFITABLE (take profit fast, don't wait for confirmation);
      BEFORE profitability, the trade gets up to sl_rejection_n consecutive
      opposite bricks of room before being cut as a rejection SL. Under
      this reading, sl_rejection_n=1 collapses to "exit on the very first
      opposite brick regardless of profit status", which is a useful
      sanity-check case within the grid. REVIEW THIS -- it is a judgment
      call, not a certainty, and the alternative (rejection-SL only,
      profitable trades ride forever until a rejection also fires) is
      easy to swap in below if that is closer to what was meant.

  (b) What "+1 brick profit" means. Implemented as: at least one further
      CONFIRMED same-direction (continuation) brick has formed after the
      entry brick. This sidesteps a real ambiguity under dynamic brick
      sizing (config.FIXED_VS_DYNAMIC_PCT='dynamic'), where "1 brick" of
      price distance changes brick-to-brick -- counting bricks rather than
      re-deriving a price distance is the more literal, less ambiguous
      reading of "brick profit".
"""

from dataclasses import dataclass
from typing import List, Literal, Optional

from renko import Brick

Direction = Literal["LONG", "SHORT"]


def detect_entry(bricks: List[Brick], i: int, entry_confirm_n: int) -> Optional[Direction]:
    """
    True if bricks[i] is the N-th consecutive same-direction brick ending
    exactly at index i (i.e. this brick is what completes the confirmation
    window). Returns None if there aren't enough prior bricks, or the last
    N bricks aren't all the same direction.
    """
    if i - entry_confirm_n + 1 < 0:
        return None
    window = bricks[i - entry_confirm_n + 1 : i + 1]
    directions = {b.direction for b in window}
    if len(directions) != 1:
        return None
    d = window[0].direction
    return "LONG" if d == 1 else "SHORT"


@dataclass
class ExitResult:
    exit_brick_index: int
    exit_price: float
    exit_reason: str  # 'REVERSAL_EXIT' | 'SL_REJECTION' | 'END_OF_DATA'
    bricks_held: int


def simulate_exit(
    bricks: List[Brick],
    entry_brick_index: int,
    direction: Direction,
    sl_rejection_n: int,
) -> Optional[ExitResult]:
    """
    Walks forward from the entry brick looking for an exit per the rules
    documented above. Returns None if no exit is found before the data
    runs out (caller decides whether to force-close at end of data).
    """
    want_dir = 1 if direction == "LONG" else -1
    reached_profit = False
    consecutive_opposite = 0

    for j in range(entry_brick_index + 1, len(bricks)):
        b = bricks[j]
        if b.direction == want_dir:
            consecutive_opposite = 0
            if not reached_profit:
                reached_profit = True  # first continuation brick after entry = "+1 brick profit"
            continue

        # opposite-direction brick
        if reached_profit:
            return ExitResult(
                exit_brick_index=j,
                exit_price=b.close,
                exit_reason="REVERSAL_EXIT",
                bricks_held=j - entry_brick_index,
            )
        consecutive_opposite += 1
        if consecutive_opposite >= sl_rejection_n:
            return ExitResult(
                exit_brick_index=j,
                exit_price=b.close,
                exit_reason="SL_REJECTION",
                bricks_held=j - entry_brick_index,
            )

    return None
