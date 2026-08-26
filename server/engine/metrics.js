/**
 * server/engine/metrics.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Performance and risk metrics for an equity curve + trade list.
 * Pure computation, no API calls — ported from the trading-strategy-backtester
 * skill's metrics.py (Sharpe, Sortino, Calmar, drawdown, VaR/CVaR, trade stats).
 *
 * calculateAllMetrics({ equityCurve, trades, initialCapital, startDate, endDate })
 *   → { totalReturn, cagr, sharpe, sortino, calmar, maxDrawdown,
 *       maxDrawdownDuration, volatility, var95, cvar95, ulcerIndex, ...tradeStats }
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const TRADING_DAYS_PER_YEAR = 252;

function dailyReturns(equityCurve) {
  const out = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1];
    if (prev !== 0) out.push((equityCurve[i] - prev) / prev);
  }
  return out;
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function totalReturn(initial, final) {
  return initial !== 0 ? ((final - initial) / initial) * 100 : 0;
}

function cagr(initial, final, years) {
  if (years <= 0 || initial <= 0) return 0;
  return (Math.pow(final / initial, 1 / years) - 1) * 100;
}

function sharpeRatio(returns, riskFreeRate = 0.02) {
  const sd = stdev(returns);
  if (returns.length < 2 || sd === 0) return 0;
  const annualReturn = mean(returns) * TRADING_DAYS_PER_YEAR;
  const annualVol = sd * Math.sqrt(TRADING_DAYS_PER_YEAR);
  return (annualReturn - riskFreeRate) / annualVol;
}

function sortinoRatio(returns, riskFreeRate = 0.02) {
  if (returns.length < 2) return 0;
  const downside = returns.filter(r => r < 0);
  const downsideStd = stdev(downside);
  if (downside.length === 0 || downsideStd === 0) {
    return mean(returns) > 0 ? Infinity : 0;
  }
  const annualReturn = mean(returns) * TRADING_DAYS_PER_YEAR;
  const annualDownsideVol = downsideStd * Math.sqrt(TRADING_DAYS_PER_YEAR);
  return (annualReturn - riskFreeRate) / annualDownsideVol;
}

function maxDrawdown(equityCurve) {
  if (equityCurve.length < 2) return { maxDrawdown: 0, maxDrawdownDuration: 0 };

  let rollingMax = equityCurve[0];
  let maxDD = 0;
  const inDrawdown = [];

  for (const v of equityCurve) {
    rollingMax = Math.max(rollingMax, v);
    const dd = ((v - rollingMax) / rollingMax) * 100;
    maxDD = Math.min(maxDD, dd);
    inDrawdown.push(dd < 0);
  }

  let maxDuration = 0, current = 0;
  for (const flag of inDrawdown) {
    if (flag) { current++; maxDuration = Math.max(maxDuration, current); }
    else current = 0;
  }

  return { maxDrawdown: maxDD, maxDrawdownDuration: maxDuration };
}

function calmarRatio(cagrVal, maxDD) {
  return maxDD === 0 ? 0 : cagrVal / Math.abs(maxDD);
}

function percentile(arr, p) {
  if (arr.length < 1) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function valueAtRisk(returns, confidence = 0.95) {
  if (returns.length < 10) return 0;
  return percentile(returns, (1 - confidence) * 100);
}

function conditionalVaR(returns, confidence = 0.95) {
  const v = valueAtRisk(returns, confidence);
  const tail = returns.filter(r => r <= v);
  return tail.length ? mean(tail) : v;
}

function volatility(returns) {
  return stdev(returns) * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100;
}

function ulcerIndex(equityCurve) {
  if (equityCurve.length < 2) return 0;
  let rollingMax = equityCurve[0];
  const sqDD = [];
  for (const v of equityCurve) {
    rollingMax = Math.max(rollingMax, v);
    const dd = ((v - rollingMax) / rollingMax) * 100;
    sqDD.push(dd * dd);
  }
  return Math.sqrt(mean(sqDD));
}

function tradeStats(trades) {
  if (!trades.length) {
    return {
      totalTrades: 0, winRate: 0, profitFactor: 0,
      avgWin: 0, avgLoss: 0, expectancy: 0,
      maxConsecutiveWins: 0, maxConsecutiveLosses: 0,
    };
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);

  const winRate = (wins.length / trades.length) * 100;
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : Infinity;

  const avgWin = wins.length ? mean(wins.map(t => t.pnl)) : 0;
  const avgLoss = losses.length ? mean(losses.map(t => t.pnl)) : 0;

  const expectancy = (winRate / 100) * avgWin - (1 - winRate / 100) * Math.abs(avgLoss);

  let maxConsecWins = 0, maxConsecLosses = 0, curWins = 0, curLosses = 0;
  for (const t of trades) {
    if (t.pnl > 0) { curWins++; curLosses = 0; maxConsecWins = Math.max(maxConsecWins, curWins); }
    else { curLosses++; curWins = 0; maxConsecLosses = Math.max(maxConsecLosses, curLosses); }
  }

  return {
    totalTrades: trades.length,
    winRate, profitFactor, avgWin, avgLoss, expectancy,
    maxConsecutiveWins: maxConsecWins,
    maxConsecutiveLosses: maxConsecLosses,
  };
}

/**
 * @param {object} input
 * @param {number[]} input.equityCurve  — portfolio value over time
 * @param {{pnl:number}[]} [input.trades] — completed trades
 * @param {Date} input.startDate
 * @param {Date} input.endDate
 */
function calculateAllMetrics({ equityCurve, trades = [], startDate, endDate }) {
  const initial = equityCurve[0];
  const final = equityCurve[equityCurve.length - 1];
  const returns = dailyReturns(equityCurve);
  const years = (endDate - startDate) / (1000 * 60 * 60 * 24 * 365.25);

  const { maxDrawdown: maxDD, maxDrawdownDuration } = maxDrawdown(equityCurve);
  const cagrVal = cagr(initial, final, years);

  return {
    totalReturn: totalReturn(initial, final),
    cagr: cagrVal,
    sharpe: sharpeRatio(returns),
    sortino: sortinoRatio(returns),
    calmar: calmarRatio(cagrVal, maxDD),
    maxDrawdown: maxDD,
    maxDrawdownDuration,
    volatility: volatility(returns),
    var95: valueAtRisk(returns, 0.95) * 100,
    cvar95: conditionalVaR(returns, 0.95) * 100,
    ulcerIndex: ulcerIndex(equityCurve),
    ...tradeStats(trades),
  };
}

module.exports = {
  calculateAllMetrics,
  sharpeRatio,
  sortinoRatio,
  maxDrawdown,
  calmarRatio,
  valueAtRisk,
  conditionalVaR,
  volatility,
  ulcerIndex,
  tradeStats,
};
