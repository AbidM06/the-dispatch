/**
 * server/engine/tradingStrategies.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Technical signal generators + a simple long-only backtest runner, operating
 * on daily close-price series (e.g. from polygon.getHistory()). Ported from
 * the trading-strategy-backtester skill's strategies.py / backtest.py.
 *
 * Each strategy's generateSignal(closes, i, params) inspects closes[0..i] and
 * returns { entry, exit, direction } for bar i.
 *
 * runStrategyBacktest({ closes, dates, strategy, params, initialCapital,
 *                        commission, slippage })
 *   → { equityCurve, trades, dates }
 *     — feed equityCurve/trades straight into metrics.calculateAllMetrics()
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

function sma(closes, period, i) {
  if (i + 1 < period) return null;
  let sum = 0;
  for (let k = i - period + 1; k <= i; k++) sum += closes[k];
  return sum / period;
}

function ema(closes, period, i) {
  // Compute EMA iteratively from the start of the series up to i.
  if (i + 1 < period) return null;
  const k = 2 / (period + 1);
  let prev = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let idx = period; idx <= i; idx++) {
    prev = closes[idx] * k + prev * (1 - k);
  }
  return prev;
}

function rsi(closes, period, i) {
  if (i + 1 < period + 1) return null;
  let gainSum = 0, lossSum = 0;
  for (let k = i - period + 1; k <= i; k++) {
    const delta = closes[k] - closes[k - 1];
    if (delta > 0) gainSum += delta;
    else lossSum += -delta;
  }
  const avgGain = gainSum / period;
  const avgLoss = lossSum / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function stdevSlice(closes, period, i, meanVal) {
  let sumSq = 0;
  for (let k = i - period + 1; k <= i; k++) sumSq += (closes[k] - meanVal) ** 2;
  return Math.sqrt(sumSq / period);
}

const STRATEGIES = {
  sma_crossover: {
    minBars: (p) => (p.slow_period ?? 50) + 1,
    generateSignal(closes, i, p) {
      const fast = p.fast_period ?? 20, slow = p.slow_period ?? 50;
      const currFast = sma(closes, fast, i), prevFast = sma(closes, fast, i - 1);
      const currSlow = sma(closes, slow, i), prevSlow = sma(closes, slow, i - 1);
      if (currFast == null || prevFast == null || currSlow == null || prevSlow == null) return {};
      if (prevFast <= prevSlow && currFast > currSlow) return { entry: true, direction: "long" };
      if (prevFast >= prevSlow && currFast < currSlow) return { exit: true };
      return {};
    },
  },

  ema_crossover: {
    minBars: (p) => (p.slow_period ?? 26) + 1,
    generateSignal(closes, i, p) {
      const fast = p.fast_period ?? 12, slow = p.slow_period ?? 26;
      const currFast = ema(closes, fast, i), prevFast = ema(closes, fast, i - 1);
      const currSlow = ema(closes, slow, i), prevSlow = ema(closes, slow, i - 1);
      if (currFast == null || prevFast == null || currSlow == null || prevSlow == null) return {};
      if (prevFast <= prevSlow && currFast > currSlow) return { entry: true, direction: "long" };
      if (prevFast >= prevSlow && currFast < currSlow) return { exit: true };
      return {};
    },
  },

  rsi_reversal: {
    minBars: (p) => (p.period ?? 14) + 2,
    generateSignal(closes, i, p) {
      const period = p.period ?? 14, oversold = p.oversold ?? 30, overbought = p.overbought ?? 70;
      const curr = rsi(closes, period, i), prev = rsi(closes, period, i - 1);
      if (curr == null || prev == null) return {};
      if (prev <= oversold && curr > oversold) return { entry: true, exit: true, direction: "long" };
      if (prev >= overbought && curr < overbought) return { exit: true };
      return {};
    },
  },

  macd: {
    minBars: (p) => (p.slow ?? 26) + (p.signal ?? 9),
    generateSignal(closes, i, p) {
      const fast = p.fast ?? 12, slow = p.slow ?? 26, signalP = p.signal ?? 9;
      // MACD line at i and i-1; signal line is EMA of MACD line.
      const macdAt = (idx) => {
        const f = ema(closes, fast, idx), s = ema(closes, slow, idx);
        return (f == null || s == null) ? null : f - s;
      };
      const minIdx = slow - 1;
      if (i - signalP + 1 < minIdx) return {};
      const macdSeries = [];
      for (let idx = minIdx; idx <= i; idx++) {
        const v = macdAt(idx);
        if (v == null) return {};
        macdSeries.push(v);
      }
      if (macdSeries.length < signalP + 1) return {};
      const emaOf = (series, period) => {
        const k = 2 / (period + 1);
        let prev = series.slice(0, period).reduce((a, b) => a + b, 0) / period;
        for (let idx = period; idx < series.length; idx++) prev = series[idx] * k + prev * (1 - k);
        return prev;
      };
      const currMacd = macdSeries[macdSeries.length - 1];
      const prevMacd = macdSeries[macdSeries.length - 2];
      const currSignal = emaOf(macdSeries, signalP);
      const prevSignal = emaOf(macdSeries.slice(0, -1), signalP);
      if (prevMacd <= prevSignal && currMacd > currSignal) return { entry: true, exit: true, direction: "long" };
      if (prevMacd >= prevSignal && currMacd < currSignal) return { exit: true };
      return {};
    },
  },

  bollinger_bands: {
    minBars: (p) => (p.period ?? 20) + 1,
    generateSignal(closes, i, p) {
      const period = p.period ?? 20, stdDev = p.std_dev ?? 2.0;
      const currMid = sma(closes, period, i), prevMid = sma(closes, period, i - 1);
      if (currMid == null || prevMid == null) return {};
      const currStd = stdevSlice(closes, period, i, currMid);
      const prevStd = stdevSlice(closes, period, i - 1, prevMid);
      const currLower = currMid - currStd * stdDev, prevLower = prevMid - prevStd * stdDev;
      const currUpper = currMid + currStd * stdDev, prevUpper = prevMid + prevStd * stdDev;
      const curr = closes[i], prev = closes[i - 1];
      if (prev >= prevLower && curr < currLower) return { entry: true, exit: true, direction: "long" };
      if (prev <= prevUpper && curr > currUpper) return { exit: true };
      if ((prev < prevMid && curr >= currMid) || (prev > prevMid && curr <= currMid)) return { exit: true };
      return {};
    },
  },

  mean_reversion: {
    minBars: (p) => (p.period ?? 20) + 1,
    generateSignal(closes, i, p) {
      const period = p.period ?? 20, zThresh = p.z_threshold ?? 2.0;
      const currMean = sma(closes, period, i), prevMean = sma(closes, period, i - 1);
      if (currMean == null || prevMean == null) return {};
      const currStd = stdevSlice(closes, period, i, currMean);
      const prevStd = stdevSlice(closes, period, i - 1, prevMean);
      if (currStd === 0 || prevStd === 0) return {};
      const z = (closes[i] - currMean) / currStd;
      const prevZ = (closes[i - 1] - prevMean) / prevStd;
      if (z < -zThresh && prevZ >= -zThresh) return { entry: true, exit: true, direction: "long" };
      if (z > zThresh && prevZ <= zThresh) return { exit: true };
      if ((prevZ < 0 && z >= 0) || (prevZ > 0 && z <= 0)) return { exit: true };
      return {};
    },
  },

  momentum: {
    minBars: (p) => (p.period ?? 14) + 2,
    generateSignal(closes, i, p) {
      const period = p.period ?? 14, threshold = p.threshold ?? 5.0;
      if (i - period - 1 < 0) return {};
      const roc = (closes[i] - closes[i - period]) / closes[i - period] * 100;
      const prevRoc = (closes[i - 1] - closes[i - period - 1]) / closes[i - period - 1] * 100;
      if (prevRoc <= threshold && roc > threshold) return { entry: true, direction: "long" };
      if (prevRoc >= 0 && roc < 0) return { exit: true };
      return {};
    },
  },
};

/**
 * runStrategyBacktest — long-only backtest over a daily close-price series.
 *
 * @param {object} opts
 * @param {string[]} opts.dates    ISO date strings, ascending
 * @param {number[]} opts.closes   Daily closes, same length/order as dates
 * @param {string} opts.strategy   One of the keys in STRATEGIES
 * @param {object} [opts.params]   Strategy parameters
 * @param {number} [opts.initialCapital=10000]
 * @param {number} [opts.commission=0.001]
 * @param {number} [opts.slippage=0.0005]
 * @returns {{ equityCurve: number[], trades: {entryDate,exitDate,entryPrice,exitPrice,pnl}[], dates: string[] }}
 */
function runStrategyBacktest({
  dates, closes, strategy, params = {},
  initialCapital = 10000, commission = 0.001, slippage = 0.0005,
}) {
  const strat = STRATEGIES[strategy];
  if (!strat) throw new Error(`Unknown strategy: ${strategy}. Available: ${Object.keys(STRATEGIES).join(", ")}`);

  const minBars = strat.minBars(params);
  let cash = initialCapital;
  let position = null; // { entryDate, entryPrice, size }
  const trades = [];
  const equityCurve = [];
  const curveDates = [];

  for (let i = 0; i < closes.length; i++) {
    if (i < minBars) continue;

    const signal = strat.generateSignal(closes, i, params);
    const price = closes[i];
    const buyPrice = price * (1 + slippage);
    const sellPrice = price * (1 - slippage);

    if (position && signal.exit) {
      const exitValue = position.size * sellPrice;
      cash += exitValue * (1 - commission);
      trades.push({
        entryDate: position.entryDate,
        exitDate: dates[i],
        entryPrice: position.entryPrice,
        exitPrice: sellPrice,
        pnl: exitValue * (1 - commission) - position.size * position.entryPrice,
      });
      position = null;
    }

    if (!position && signal.entry && signal.direction === "long") {
      const positionValue = cash * 0.95;
      const size = positionValue / buyPrice;
      cash -= positionValue * (1 + commission);
      position = { entryDate: dates[i], entryPrice: buyPrice, size };
    }

    const equity = position ? cash + position.size * price : cash;
    equityCurve.push(equity);
    curveDates.push(dates[i]);
  }

  // Close any open position at the final price
  if (position) {
    const lastPrice = closes[closes.length - 1] * (1 - slippage);
    const exitValue = position.size * lastPrice;
    cash += exitValue * (1 - commission);
    trades.push({
      entryDate: position.entryDate,
      exitDate: dates[dates.length - 1],
      entryPrice: position.entryPrice,
      exitPrice: lastPrice,
      pnl: exitValue * (1 - commission) - position.size * position.entryPrice,
    });
    equityCurve[equityCurve.length - 1] = cash;
  }

  return { equityCurve, trades, dates: curveDates };
}

/**
 * runBuyAndHold — passive benchmark: buy at the first close, hold to the last.
 *
 * @param {object} opts
 * @param {string[]} opts.dates
 * @param {number[]} opts.closes
 * @param {number} [opts.initialCapital=10000]
 * @param {number} [opts.commission=0.001]
 * @returns {{ equityCurve: number[], dates: string[] }}
 */
function runBuyAndHold({ dates, closes, initialCapital = 10000, commission = 0.001 }) {
  const shares = (initialCapital * (1 - commission)) / closes[0];
  const equityCurve = closes.map(c => shares * c);
  return { equityCurve, dates: [...dates] };
}

module.exports = { STRATEGIES, runStrategyBacktest, runBuyAndHold };
