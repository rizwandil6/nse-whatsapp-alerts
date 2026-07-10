'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const TV_MCP_PATH = process.env.TRADINGVIEW_MCP_PATH || path.join(process.env.HOME || '', 'Downloads', 'tradingview-mcp');

function runTvCli(args) {
  const cliPath = path.join(TV_MCP_PATH, 'src', 'cli', 'index.js');
  const out = execFileSync('node', [cliPath, ...args], { encoding: 'utf8', timeout: 30000 });
  return JSON.parse(out);
}

/**
 * Fetches recent 1-minute OHLCV candles for a symbol from TradingView Desktop via
 * the tradingview-mcp CLI (CDP connection to a locally running TradingView Desktop
 * instance launched with --remote-debugging-port=9222).
 *
 * WHY THIS EXISTS ALONGSIDE upstoxCandles.js: Upstox's historical-candle API has a
 * next-day processing lag — confirmed empirically (2026-07-10: zero candles for
 * ADVAIT *and* RELIANCE on the same day, across three checks spanning market open
 * to well after close). TradingView Desktop streams and caches the live session as
 * it happens, so today's 1-minute bars are available in real time. Use this for
 * "did today's real alert actually work out" checks; use upstoxCandles.js for bulk
 * historical backtests spanning weeks/months (TradingView Desktop only holds
 * whatever's in its own live session cache, not an arbitrary deep archive).
 *
 * Requires: TradingView Desktop running locally with CDP enabled (see
 * tradingview-mcp's scripts/launch_tv_debug_*.sh) and TRADINGVIEW_MCP_PATH pointing
 * at a clone of https://github.com/tradesdontlie/tradingview-mcp (defaults to
 * ~/Downloads/tradingview-mcp).
 *
 * @param {string} symbol NSE trading symbol, e.g. "HFCL"
 * @param {number} count  how many recent 1-min bars to request (TradingView caps this; ~300-400 typical)
 * @returns {Array<{timestampMs:number, open:number, high:number, low:number, close:number}>} ascending by time
 */
function fetchTodayCandles(symbol, count = 400) {
  const status = runTvCli(['status']);
  if (!status.cdp_connected) {
    throw new Error(
      'TradingView Desktop is not connected via CDP (port 9222). Launch it with --remote-debugging-port=9222 first.'
    );
  }

  runTvCli(['symbol', symbol]);
  runTvCli(['timeframe', '1']);

  const data = runTvCli(['ohlcv', '--count', String(count)]);
  if (!data.success || !Array.isArray(data.bars)) {
    throw new Error(`Failed to fetch OHLCV for ${symbol}: ${JSON.stringify(data)}`);
  }

  return data.bars
    .map((b) => ({
      timestampMs: b.time * 1000,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }))
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

module.exports = { fetchTodayCandles };
