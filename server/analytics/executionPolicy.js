/**
 * server/analytics/executionPolicy.js
 * Global circuit breakers for trade execution.
 * Persists daily counters in data/execution_state.json.
 */
"use strict";

const fs   = require("fs");
const path = require("path");

const STATE_FILE = path.join(__dirname, "..", "..", "data", "execution_state.json");

function getConfig() {
  return {
    tradingEnabled:       process.env.TRADING_ENABLED === "true",
    autoApprovePaper:     process.env.AUTO_APPROVE_PAPER === "true",
    maxTradesPerDay:      parseInt(process.env.MAX_TRADES_PER_DAY      || "3",   10),
    maxNotionalGBPPerDay: parseFloat(process.env.MAX_NOTIONAL_GBP_PER_DAY || "250"),
    maxOpenPositions:     parseInt(process.env.MAX_OPEN_POSITIONS       || "5",   10),
    maxSingleTickerPct:   parseFloat(process.env.MAX_SINGLE_TICKER_EXPOSURE_PCT || "20"),
  };
}

function todayUTC() { return new Date().toISOString().slice(0, 10); }

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return raw.date === todayUTC() ? raw : null;
  } catch (_) { return null; }
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (_) {}
}

function getOrInitState() {
  return loadState() || { date: todayUTC(), tradesPlaced: 0, notionalGBP: 0, tickers: {} };
}

/**
 * Check if an execution is allowed by policy.
 * @param {{ ticker?, notionalGBP?, openPositions?, portfolioGBP? }} params
 * @returns {{ allowed: boolean, reasons: string[] }}
 */
function checkPolicy(params = {}) {
  const cfg    = getConfig();
  const state  = getOrInitState();
  const reasons = [];

  if (!cfg.tradingEnabled) {
    reasons.push("TRADING_ENABLED is not 'true' — all execution disabled by default. Set TRADING_ENABLED=true to enable.");
  }

  if (state.tradesPlaced >= cfg.maxTradesPerDay) {
    reasons.push(`Daily trade limit: ${state.tradesPlaced}/${cfg.maxTradesPerDay} trades placed today.`);
  }

  const projectedNotional = state.notionalGBP + (params.notionalGBP || 0);
  if (projectedNotional > cfg.maxNotionalGBPPerDay) {
    reasons.push(`Daily notional cap: \u00a3${state.notionalGBP.toFixed(0)} used + \u00a3${(params.notionalGBP || 0).toFixed(0)} projected > \u00a3${cfg.maxNotionalGBPPerDay} cap.`);
  }

  if ((params.openPositions || 0) >= cfg.maxOpenPositions) {
    reasons.push(`Open position limit: ${params.openPositions}/${cfg.maxOpenPositions} positions open.`);
  }

  if (params.ticker && params.notionalGBP && params.portfolioGBP) {
    const tickerNotional = (state.tickers[params.ticker] || 0) + params.notionalGBP;
    const tickerPct      = tickerNotional / params.portfolioGBP * 100;
    if (tickerPct > cfg.maxSingleTickerPct) {
      reasons.push(`Single ticker cap: ${params.ticker} at ${tickerPct.toFixed(1)}% > ${cfg.maxSingleTickerPct}% max.`);
    }
  }

  return { allowed: reasons.length === 0, reasons };
}

function recordTrade(ticker, notionalGBP) {
  const state = getOrInitState();
  state.tradesPlaced += 1;
  state.notionalGBP  += (notionalGBP || 0);
  state.tickers[ticker] = (state.tickers[ticker] || 0) + (notionalGBP || 0);
  saveState(state);
}

function getState() { return getOrInitState(); }

module.exports = { checkPolicy, recordTrade, getState, getConfig };
