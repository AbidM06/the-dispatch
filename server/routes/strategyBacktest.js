/**
 * server/routes/strategyBacktest.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GET /api/analytics/strategy-backtest
 *   ?ticker=AMD&strategy=rsi_reversal&days=252&params={"period":14,"oversold":30}
 *
 * Runs a technical-strategy backtest (server/engine/tradingStrategies.js) over
 * daily price history and scores it with server/engine/metrics.js.
 *
 * Provider routing:
 *   - Tickers ending in .KS/.KQ/.T/.TW/.HK/.SS/.SZ/.NS/.BO (native Asian listings)
 *     → Yahoo Finance (no key required)
 *   - Everything else (US tickers, ADRs, ETFs) → Polygon (requires POLYGON_API_KEY)
 *
 * Cache: 30 min per (ticker, strategy, days, params).
 * ?refresh=true — bust cache.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const { Router } = require("express");
const cache       = require("../cache");
const polygon     = require("../providers/polygon");
const yahoo       = require("../providers/yahoo");
const { STRATEGIES, runStrategyBacktest, runBuyAndHold } = require("../engine/tradingStrategies");
const { calculateAllMetrics } = require("../engine/metrics");

const STRATEGY_LABELS = {
  sma_crossover: "the SMA crossover strategy",
  ema_crossover: "the EMA crossover strategy",
  rsi_reversal: "the RSI reversal strategy",
  macd: "the MACD strategy",
  bollinger_bands: "the Bollinger Bands strategy",
  mean_reversion: "the mean-reversion strategy",
  momentum: "the momentum strategy",
};

function roundMetrics(metrics) {
  return {
    totalReturn: +metrics.totalReturn.toFixed(2),
    cagr: +metrics.cagr.toFixed(2),
    sharpe: +metrics.sharpe.toFixed(2),
    sortino: Number.isFinite(metrics.sortino) ? +metrics.sortino.toFixed(2) : null,
    calmar: +metrics.calmar.toFixed(2),
    maxDrawdown: +metrics.maxDrawdown.toFixed(2),
    maxDrawdownDuration: metrics.maxDrawdownDuration,
    volatility: +metrics.volatility.toFixed(2),
    var95: +metrics.var95.toFixed(2),
    cvar95: +metrics.cvar95.toFixed(2),
    ulcerIndex: +metrics.ulcerIndex.toFixed(2),
    totalTrades: metrics.totalTrades,
    winRate: +metrics.winRate.toFixed(1),
    profitFactor: Number.isFinite(metrics.profitFactor) ? +metrics.profitFactor.toFixed(2) : null,
    avgWin: +metrics.avgWin.toFixed(2),
    avgLoss: +metrics.avgLoss.toFixed(2),
    expectancy: +metrics.expectancy.toFixed(2),
    maxConsecutiveWins: metrics.maxConsecutiveWins,
    maxConsecutiveLosses: metrics.maxConsecutiveLosses,
  };
}

// Build a plain-language "why these numbers" narrative from the metrics.
function buildExplainer({ ticker, strategy, metrics, buyHoldMetrics, oos }) {
  const label = STRATEGY_LABELS[strategy] || `the ${strategy} strategy`;
  const lines = [];

  const beatBH = metrics.totalReturn > buyHoldMetrics.totalReturn;
  const diff = Math.abs(metrics.totalReturn - buyHoldMetrics.totalReturn).toFixed(1);
  lines.push(
    `${label} returned ${metrics.totalReturn.toFixed(1)}% on ${ticker} over this window, versus ` +
    `${buyHoldMetrics.totalReturn.toFixed(1)}% for simply buying and holding — ` +
    `${beatBH ? `outperforming buy-and-hold by ${diff} points` : `underperforming buy-and-hold by ${diff} points`}.`
  );

  if (metrics.totalTrades === 0) {
    lines.push("No entry signals fired in this window, so the strategy held cash throughout.");
  } else {
    lines.push(
      `It took ${metrics.totalTrades} trade${metrics.totalTrades === 1 ? "" : "s"} with a ` +
      `${metrics.winRate.toFixed(0)}% win rate. ` +
      (metrics.expectancy > 0
        ? `Average expectancy per trade was positive ($${metrics.expectancy.toFixed(2)}), `
        : `Average expectancy per trade was negative ($${metrics.expectancy.toFixed(2)}), `) +
      (Number.isFinite(metrics.profitFactor)
        ? `with a profit factor of ${metrics.profitFactor.toFixed(2)}` +
          (metrics.profitFactor >= 1.5 ? " — wins clearly outweighed losses." : metrics.profitFactor >= 1 ? " — a thin edge over breakeven." : " — losses outweighed wins.")
        : " and no losing trades.")
    );
  }

  if (metrics.sharpe > 1) {
    lines.push(`Risk-adjusted returns were strong (Sharpe ${metrics.sharpe.toFixed(2)}) relative to the volatility taken on.`);
  } else if (metrics.sharpe > 0) {
    lines.push(`Risk-adjusted returns were modest (Sharpe ${metrics.sharpe.toFixed(2)}) — the return barely compensated for the volatility.`);
  } else {
    lines.push(`Sharpe was negative (${metrics.sharpe.toFixed(2)}), meaning the strategy lost money on a risk-adjusted basis.`);
  }

  lines.push(
    `Max drawdown was ${metrics.maxDrawdown.toFixed(1)}%, lasting up to ${metrics.maxDrawdownDuration} bars — ` +
    `that's the worst peak-to-trough decline an investor would have sat through.`
  );

  if (oos && oos.inSample && oos.outOfSample) {
    const isR = oos.inSample.totalReturn, oosR = oos.outOfSample.totalReturn;
    const degraded = oosR < isR - 5;
    lines.push(
      `Walk-forward check: the first 70% of the window (in-sample) returned ${isR.toFixed(1)}%, ` +
      `while the final 30% (out-of-sample) returned ${oosR.toFixed(1)}%. ` +
      (degraded
        ? "The drop-off suggests some of the in-sample edge may be overfit to that period."
        : "Performance held up reasonably well out-of-sample, a good sign against overfitting.")
    );
  }

  return lines.join(" ");
}

const router  = Router();
const TTL_30M = 30 * 60 * 1000;

const YAHOO_SUFFIX = /\.(KS|KQ|T|TW|HK|SS|SZ|NS|BO)$/i;

function now() { return new Date().toISOString(); }

function pickProvider(ticker) {
  return YAHOO_SUFFIX.test(ticker) ? "yahoo" : "polygon";
}

// GET /api/analytics/strategy-backtest
router.get("/strategy-backtest", async (req, res) => {
  const ticker = (req.query.ticker || "").trim().toUpperCase();
  const strategy = (req.query.strategy || "").trim();
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 252, 50), 1825);
  const force = req.query.refresh === "true";

  if (!ticker) return res.status(400).json({ error: "ticker is required" });
  if (!STRATEGIES[strategy]) {
    return res.status(400).json({ error: `strategy must be one of: ${Object.keys(STRATEGIES).join(", ")}` });
  }

  let params = {};
  if (req.query.params) {
    try {
      params = JSON.parse(req.query.params);
    } catch (_) {
      return res.status(400).json({ error: "params must be valid JSON" });
    }
  }

  const provider = pickProvider(ticker);
  const cacheKey = `analytics:strategy-backtest:${provider}:${ticker}:${strategy}:${days}:${JSON.stringify(params)}`;

  if (!force) {
    const cached = cache.getWithMeta(cacheKey);
    if (cached && !cached.stale) {
      return res.json({ source: "cache", fetchedAt: now(), data: cached.value });
    }
  }

  if (provider === "polygon" && !process.env.POLYGON_API_KEY) {
    return res.status(503).json({ error: "POLYGON_API_KEY not configured" });
  }

  let bars;
  try {
    bars = provider === "yahoo"
      ? await yahoo.getHistory(ticker, days)
      : await polygon.getHistory(ticker, days);
  } catch (err) {
    console.warn(`[strategyBacktest] ${ticker} (${provider}) fetch failed:`, err.message);
    return res.status(502).json({ error: `Failed to fetch price history for ${ticker}: ${err.message}`, provider });
  }

  if (bars.length < 50) {
    return res.status(422).json({ error: `Insufficient price history for ${ticker}: got ${bars.length} bars, need at least 50`, provider });
  }

  const dates = bars.map(b => b.date);
  const closes = bars.map(b => b.close);

  let result;
  try {
    result = runStrategyBacktest({ dates, closes, strategy, params });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const { equityCurve, trades, dates: curveDates } = result;
  if (equityCurve.length < 2) {
    return res.status(422).json({ error: `Not enough bars to run ${strategy} (needs more history)`, provider });
  }

  const metrics = calculateAllMetrics({
    equityCurve,
    trades,
    startDate: new Date(curveDates[0]),
    endDate: new Date(curveDates[curveDates.length - 1]),
  });

  // Buy & hold benchmark over the same window
  const buyHold = runBuyAndHold({ dates, closes });
  const buyHoldMetrics = calculateAllMetrics({
    equityCurve: buyHold.equityCurve,
    trades: [],
    startDate: new Date(dates[0]),
    endDate: new Date(dates[dates.length - 1]),
  });
  const buyHoldByDate = new Map(buyHold.dates.map((d, i) => [d, buyHold.equityCurve[i]]));

  // Walk-forward-lite: split the price series 70/30 and backtest each half independently
  let oos = null;
  const splitIdx = Math.floor(closes.length * 0.7);
  if (splitIdx >= 50 && closes.length - splitIdx >= 30) {
    try {
      const isSlice = { dates: dates.slice(0, splitIdx), closes: closes.slice(0, splitIdx) };
      const oosSlice = { dates: dates.slice(splitIdx), closes: closes.slice(splitIdx) };
      const isResult = runStrategyBacktest({ ...isSlice, strategy, params });
      const oosResult = runStrategyBacktest({ ...oosSlice, strategy, params });
      if (isResult.equityCurve.length >= 2 && oosResult.equityCurve.length >= 2) {
        oos = {
          splitDate: dates[splitIdx],
          inSample: roundMetrics(calculateAllMetrics({
            equityCurve: isResult.equityCurve,
            trades: isResult.trades,
            startDate: new Date(isResult.dates[0]),
            endDate: new Date(isResult.dates[isResult.dates.length - 1]),
          })),
          outOfSample: roundMetrics(calculateAllMetrics({
            equityCurve: oosResult.equityCurve,
            trades: oosResult.trades,
            startDate: new Date(oosResult.dates[0]),
            endDate: new Date(oosResult.dates[oosResult.dates.length - 1]),
          })),
        };
      }
    } catch (_) {
      oos = null;
    }
  }

  const roundedMetrics = roundMetrics(metrics);

  const payload = {
    ticker,
    strategy,
    params,
    provider,
    bars: bars.length,
    range: { start: dates[0], end: dates[dates.length - 1] },
    equityCurve: curveDates.map((date, i) => ({
      date,
      equity: +equityCurve[i].toFixed(2),
      buyHold: buyHoldByDate.has(date) ? +buyHoldByDate.get(date).toFixed(2) : null,
    })),
    trades: trades.map(t => ({
      entryDate: t.entryDate,
      exitDate: t.exitDate,
      entryPrice: +t.entryPrice.toFixed(4),
      exitPrice: +t.exitPrice.toFixed(4),
      pnl: +t.pnl.toFixed(2),
      pnlPct: +((t.exitPrice - t.entryPrice) / t.entryPrice * 100).toFixed(2),
    })),
    metrics: roundedMetrics,
    buyHold: {
      totalReturn: +buyHoldMetrics.totalReturn.toFixed(2),
      cagr: +buyHoldMetrics.cagr.toFixed(2),
      sharpe: +buyHoldMetrics.sharpe.toFixed(2),
      maxDrawdown: +buyHoldMetrics.maxDrawdown.toFixed(2),
    },
    walkForward: oos,
    explainer: buildExplainer({ ticker, strategy, metrics, buyHoldMetrics, oos }),
  };

  cache.set(cacheKey, payload, TTL_30M);
  res.json({ source: "live", fetchedAt: now(), data: payload });
});

// GET /api/analytics/strategy-backtest/strategies — list available strategies + default params
router.get("/strategy-backtest/strategies", (_req, res) => {
  const DEFAULTS = {
    sma_crossover:   { fast_period: 20, slow_period: 50 },
    ema_crossover:   { fast_period: 12, slow_period: 26 },
    rsi_reversal:    { period: 14, oversold: 30, overbought: 70 },
    macd:            { fast: 12, slow: 26, signal: 9 },
    bollinger_bands: { period: 20, std_dev: 2.0 },
    mean_reversion:  { period: 20, z_threshold: 2.0 },
    momentum:        { period: 14, threshold: 5.0 },
  };
  res.json({
    source: "static",
    fetchedAt: now(),
    data: Object.keys(STRATEGIES).map(id => ({ id, defaultParams: DEFAULTS[id] || {} })),
  });
});

module.exports = router;
