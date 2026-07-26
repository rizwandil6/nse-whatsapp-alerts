"""
Round-trip transaction cost model, sourced directly from Upstox's own
published intraday equity charges (upstox.com/brokerage-charges/, rates
current Oct 2024 - Feb 2026): brokerage min Rs20 or 0.1% of turnover
(whichever is lower) per executed leg, STT 0.025% (sell leg only), NSE
exchange transaction charge 0.00297% (both legs), SEBI turnover fee
Rs10/crore = 0.0001% (both legs), stamp duty 0.003% (buy leg only), 18%
GST on (brokerage + exchange + SEBI). IPFT (investor protection fund)
charges are not broken out separately by Upstox's page and are not
modeled here -- negligible relative to the other components.

Note the brokerage rate (0.1%) is notably higher than the 0.03% commonly
quoted for some other discount brokers -- both hit the same Rs20/leg cap
eventually, but Upstox's cap kicks in at a much lower turnover (~Rs20,000
vs ~Rs66,700), so smaller trades pay more brokerage here than a naive
0.03%-based estimate would suggest.

This engine trades both directions -- LONG buys to open and sells to
close; SHORT sells to open and buys to cover. Which leg is "buy" vs "sell"
is assigned accordingly so STT/stamp (which are leg-specific) land on the
correct side either way.
"""


def cost_rupees(entry_price: float, exit_price: float, qty: float, direction: str) -> float:
    if direction == "LONG":
        buy_value = qty * entry_price
        sell_value = qty * exit_price
    else:  # SHORT: sell first, buy back to cover
        sell_value = qty * entry_price
        buy_value = qty * exit_price

    brokerage = min(20.0, buy_value * 0.001) + min(20.0, sell_value * 0.001)
    stt = sell_value * 0.00025
    exch = (buy_value + sell_value) * 0.0000297
    sebi = (buy_value + sell_value) * 0.000001
    stamp = buy_value * 0.00003
    gst = 0.18 * (brokerage + exch + sebi)
    return brokerage + stt + exch + sebi + stamp + gst
