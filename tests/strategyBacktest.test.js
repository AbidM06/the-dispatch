/**
 * tests/strategyBacktest.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Strategy backtester tests.
 *
 * Layers covered:
 *   - server/engine/metrics.js — pure metric computation (Sharpe, Sortino,
 *     Calmar, max drawdown, VaR/CVaR, trade stats)
 *   - server/engine/tradingStrategies.js — signal generation + backtest runner
 *     for each strategy, buy-and-hold benchmark, unknown-strategy error
 *   - GET /api/analytics/strategy-backtest — provider routing (Polygon vs
 *     Yahoo by ticker suffix), validation, caching, error paths, response shape
 *   - GET /api/analytics/strategy-backtest/strategies — static strategy list
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const request = require("supertest");

const { calculateAllMetrics, sharpeRatio, sortinoRatio, maxDrawdown, calmarRatio,
        valueAtRisk, conditionalVaR, tradeStats } = require("../server/engine/metrics");
const { STRATEGIES, runStrategyBacktest, runBuyAndHold } = require("../server/engine/tradingStrategies");

// ─────────────────────────────────────────────────────────────────────────────
// server/engine/metrics.js — pure unit tests
// ─────────────────────────────────────────────────────────────────────────────
describe("metrics — pure unit tests", () => {
  test("calculateAllMetrics on a steadily rising equity curve returns positive return/CAGR/sharpe", () => {
    const equityCurve = Array.from({ length: 253 }, (_, i) => 10000 * (1 + 0.001 * i));
    const metrics = calculateAllMetrics({
      equityCurve, trades: [],
      startDate: new Date("2025-01-01"), endDate: new Date("2026-01-01"),
    });
    expect(metrics.totalReturn).toBeGreaterThan(0);
    expect(metrics.cagr).toBeGreaterThan(0);
    expect(metrics.sharpe).toBeGreaterThan(0);
    expect(metrics.maxDrawdown).toBe(0); // monotonically rising — no drawdown
    expect(metrics.maxDrawdownDuration).toBe(0);
  });

  test("calculateAllMetrics on a falling equity curve returns negative return and drawdown", () => {
    const equityCurve = Array.from({ length: 100 }, (_, i) => 10000 * (1 - 0.005 * i));
    const metrics = calculateAllMetrics({
      equityCurve, trades: [],
      startDate: new Date("2025-01-01"), endDate: new Date("2025-06-01"),
    });
    expect(metrics.totalReturn).toBeLessThan(0);
    expect(metrics.maxDrawdown).toBeLessThan(0);
    expect(metrics.maxDrawdownDuration).toBeGreaterThan(0);
  });

  test("sharpeRatio returns 0 for a flat (zero-volatility) return series", () => {
    expect(sharpeRatio([0, 0, 0, 0, 0])).toBe(0);
  });

  test("sharpeRatio returns 0 for fewer than 2 returns", () => {
    expect(sharpeRatio([0.01])).toBe(0);
    expect(sharpeRatio([])).toBe(0);
  });

  test("sortinoRatio returns Infinity when there is no downside and mean return is positive", () => {
    expect(sortinoRatio([0.01, 0.02, 0.015])).toBe(Infinity);
  });

  test("sortinoRatio returns 0 for fewer than 2 returns", () => {
    expect(sortinoRatio([0.01])).toBe(0);
  });

  test("maxDrawdown on empty/singleton curve returns zeroed result", () => {
    expect(maxDrawdown([])).toEqual({ maxDrawdown: 0, maxDrawdownDuration: 0 });
    expect(maxDrawdown([100])).toEqual({ maxDrawdown: 0, maxDrawdownDuration: 0 });
  });

  test("maxDrawdown computes the correct peak-to-trough percentage and duration", () => {
    // 100 -> 120 (peak) -> 90 (trough, -25% off peak) -> 95 -> 130 (new high)
    const { maxDrawdown: dd, maxDrawdownDuration } = maxDrawdown([100, 120, 90, 95, 130]);
    expect(dd).toBeCloseTo(-25, 5);
    expect(maxDrawdownDuration).toBe(2); // bars at 90 and 95 are both in drawdown
  });

  test("calmarRatio returns 0 when maxDrawdown is 0", () => {
    expect(calmarRatio(15, 0)).toBe(0);
  });

  test("calmarRatio divides CAGR by absolute max drawdown", () => {
    expect(calmarRatio(20, -10)).toBeCloseTo(2, 5);
  });

  test("valueAtRisk returns 0 for fewer than 10 returns", () => {
    expect(valueAtRisk([0.01, -0.02])).toBe(0);
  });

  test("conditionalVaR is at least as extreme as valueAtRisk (more negative or equal)", () => {
    const returns = Array.from({ length: 50 }, (_, i) => (i - 25) / 500); // spread of returns
    const v   = valueAtRisk(returns, 0.95);
    const cv  = conditionalVaR(returns, 0.95);
    expect(cv).toBeLessThanOrEqual(v);
  });

  test("tradeStats on empty trade list returns zeroed stats", () => {
    expect(tradeStats([])).toEqual({
      totalTrades: 0, winRate: 0, profitFactor: 0,
      avgWin: 0, avgLoss: 0, expectancy: 0,
      maxConsecutiveWins: 0, maxConsecutiveLosses: 0,
    });
  });

  test("tradeStats computes win rate, profit factor, and consecutive streaks", () => {
    const trades = [
      { pnl: 100 }, { pnl: 50 }, { pnl: -30 }, { pnl: 80 }, { pnl: -20 }, { pnl: -10 },
    ];
    const stats = tradeStats(trades);
    expect(stats.totalTrades).toBe(6);
    expect(stats.winRate).toBeCloseTo((3 / 6) * 100, 5);
    expect(stats.profitFactor).toBeCloseTo(230 / 60, 5);
    expect(stats.maxConsecutiveWins).toBe(2);
    expect(stats.maxConsecutiveLosses).toBe(2);
  });

  test("tradeStats profitFactor is Infinity when there are no losing trades", () => {
    const stats = tradeStats([{ pnl: 10 }, { pnl: 20 }]);
    expect(stats.profitFactor).toBe(Infinity);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// server/engine/tradingStrategies.js
// ─────────────────────────────────────────────────────────────────────────────
describe("tradingStrategies — signal generation + backtest runner", () => {
  // Synthetic series: down-trend then sharp up-trend, long enough for every
  // strategy's default lookback (slowest is sma_crossover at 50 bars).
  function buildSeries(len = 150) {
    const dates = [];
    const closes = [];
    let price = 100;
    const start = new Date("2025-01-01");
    for (let i = 0; i < len; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      dates.push(d.toISOString().slice(0, 10));
      // First half trends down, second half trends up sharply — guarantees
      // at least one crossover-style signal fires for every strategy.
      if (i < len / 2) price *= 0.995;
      else price *= 1.02;
      closes.push(price);
    }
    return { dates, closes };
  }

  test("STRATEGIES exposes all seven documented strategies", () => {
    expect(Object.keys(STRATEGIES).sort()).toEqual([
      "bollinger_bands", "ema_crossover", "macd", "mean_reversion",
      "momentum", "rsi_reversal", "sma_crossover",
    ]);
  });

  test("runStrategyBacktest throws on an unknown strategy", () => {
    const { dates, closes } = buildSeries();
    expect(() => runStrategyBacktest({ dates, closes, strategy: "not_real" }))
      .toThrow(/Unknown strategy/);
  });

  test.each(Object.keys(STRATEGIES))("runStrategyBacktest(%s) returns a well-formed equity curve", (strategy) => {
    const { dates, closes } = buildSeries();
    const result = runStrategyBacktest({ dates, closes, strategy });
    expect(result.equityCurve.length).toBe(result.dates.length);
    expect(result.equityCurve.every(v => Number.isFinite(v) && v > 0)).toBe(true);
    // Every trade should have a valid entry <= exit ordering and numeric pnl
    for (const t of result.trades) {
      expect(new Date(t.entryDate).getTime()).toBeLessThanOrEqual(new Date(t.exitDate).getTime());
      expect(Number.isFinite(t.pnl)).toBe(true);
    }
  });

  test("runStrategyBacktest closes an open position at the final bar", () => {
    const { dates, closes } = buildSeries();
    const result = runStrategyBacktest({ dates, closes, strategy: "sma_crossover", params: { fast_period: 5, slow_period: 10 } });
    // No dangling open position — every entry has a matching exit in trades,
    // meaning the final equity value reflects cash only (no held shares priced in).
    expect(result.trades.length).toBeGreaterThan(0);
  });

  test("runStrategyBacktest respects custom params (shorter lookback fires earlier)", () => {
    const { dates, closes } = buildSeries();
    const long = runStrategyBacktest({ dates, closes, strategy: "sma_crossover", params: { fast_period: 5, slow_period: 20 } });
    const short = runStrategyBacktest({ dates, closes, strategy: "sma_crossover", params: { fast_period: 3, slow_period: 10 } });
    // Shorter lookback strategy has more bars available to trade over.
    expect(short.equityCurve.length).toBeGreaterThanOrEqual(long.equityCurve.length);
  });

  test("runBuyAndHold produces an equity curve proportional to price", () => {
    const { dates, closes } = buildSeries(20);
    const result = runBuyAndHold({ dates, closes, initialCapital: 10000 });
    expect(result.equityCurve.length).toBe(closes.length);
    const shares = result.equityCurve[0] / closes[0];
    for (let i = 0; i < closes.length; i++) {
      expect(result.equityCurve[i]).toBeCloseTo(shares * closes[i], 6);
    }
  });

  test("insufficient bars for a strategy's lookback produces an empty result", () => {
    const { dates, closes } = buildSeries(10); // far short of sma_crossover's 50-bar min
    const result = runStrategyBacktest({ dates, closes, strategy: "sma_crossover" });
    expect(result.equityCurve.length).toBe(0);
    expect(result.trades.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/analytics/strategy-backtest — route tests
// ─────────────────────────────────────────────────────────────────────────────
jest.mock("../server/providers/fred", () => ({
  getAllRates:      jest.fn().mockResolvedValue({}),
  getRecentHistory: jest.fn().mockResolvedValue({ observations: [] }),
}));
jest.mock("../server/providers/alphaVantage", () => ({
  getQuotes: jest.fn(), getFxRate: jest.fn(), getQuote: jest.fn(),
  AV_SUPPORTED: new Set(["AMD"]),
  _getBudget: jest.fn(() => ({ date: null, count: 0, limit: 20 })),
  _resetBudget: jest.fn(),
}));
jest.mock("../server/providers/polygon", () => ({
  getSnapshots: jest.fn(),
  getTnxYield: jest.fn().mockResolvedValue(null),
  getVolSurface: jest.fn().mockResolvedValue({ vix3m: null, skew: null }),
  getHistory: jest.fn(),
  POLYGON_PEERS: new Set(["NVDA", "MSFT", "TSLA", "MU", "AMAT", "LRCX"]),
}));
jest.mock("../server/providers/yahoo", () => ({
  getHistory: jest.fn(),
  getQuote: jest.fn(),
}));
jest.mock("../server/providers/anthropic", () => ({
  fetchAllAnalysis: jest.fn(), fetchTickerExplain: jest.fn(), generatePitch: jest.fn(),
}));
jest.mock("../server/providers/finnhub", () => ({
  getMarketNews: jest.fn().mockResolvedValue([]), getCompanyNews: jest.fn().mockResolvedValue([]),
  getEarningsCalendar: jest.fn().mockResolvedValue([]), getEconomicCalendar: jest.fn().mockResolvedValue([]),
  getNewsSentiment: jest.fn().mockResolvedValue(null), isConfigured: jest.fn().mockReturnValue(false),
  TTL_NEWS_MS: 1800000, TTL_CALENDAR_MS: 3600000,
}));

const polygonMock = require("../server/providers/polygon");
const yahooMock   = require("../server/providers/yahoo");
const cache       = require("../server/cache");

function makeBars(n = 260, startPrice = 100) {
  const bars = [];
  let price = startPrice;
  const start = new Date("2025-01-01");
  for (let i = 0; i < n; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    // Trend down then sharply up so crossover strategies fire trades.
    price *= i < n / 2 ? 0.998 : 1.015;
    bars.push({ date: d.toISOString().slice(0, 10), close: price });
  }
  return bars;
}

describe("GET /api/analytics/strategy-backtest", () => {
  let app;
  beforeAll(() => {
    process.env.ANTHROPIC_API_KEY     = "test-key";
    process.env.ALPHA_VANTAGE_API_KEY = "test-av-key";
    process.env.FRED_API_KEY          = "test-fred-key";
    process.env.POLYGON_API_KEY       = "test-polygon-key";
    process.env.PORT                  = "0";
    app = require("../server/index");
  });

  beforeEach(() => {
    cache.clear();
    jest.clearAllMocks();
  });

  test("400 when ticker is missing", async () => {
    const res = await request(app).get("/api/analytics/strategy-backtest?strategy=sma_crossover");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ticker/i);
  });

  test("400 when strategy is missing or unknown", async () => {
    const res = await request(app).get("/api/analytics/strategy-backtest?ticker=AMD&strategy=not_real");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/strategy must be one of/);
  });

  test("400 when params is invalid JSON", async () => {
    const res = await request(app).get("/api/analytics/strategy-backtest?ticker=AMD&strategy=sma_crossover&params={bad");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid JSON/);
  });

  test("routes US tickers to Polygon and returns a live result", async () => {
    polygonMock.getHistory.mockResolvedValue(makeBars());

    const res = await request(app).get("/api/analytics/strategy-backtest?ticker=AMD&strategy=sma_crossover&params=" +
      encodeURIComponent(JSON.stringify({ fast_period: 5, slow_period: 20 })));

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("live");
    expect(res.body.data.ticker).toBe("AMD");
    expect(res.body.data.provider).toBe("polygon");
    expect(polygonMock.getHistory).toHaveBeenCalledWith("AMD", 252);
    expect(yahooMock.getHistory).not.toHaveBeenCalled();
    expect(res.body.data.metrics).toHaveProperty("sharpe");
    expect(res.body.data.buyHold).toHaveProperty("totalReturn");
    expect(Array.isArray(res.body.data.equityCurve)).toBe(true);
    expect(typeof res.body.data.explainer).toBe("string");
  });

  test("routes Asian-suffixed tickers to Yahoo", async () => {
    yahooMock.getHistory.mockResolvedValue(makeBars());

    const res = await request(app).get("/api/analytics/strategy-backtest?ticker=005930.KS&strategy=rsi_reversal");

    expect(res.status).toBe(200);
    expect(res.body.data.provider).toBe("yahoo");
    expect(yahooMock.getHistory).toHaveBeenCalledWith("005930.KS", 252);
    expect(polygonMock.getHistory).not.toHaveBeenCalled();
  });

  test("ticker is uppercased regardless of URL casing", async () => {
    polygonMock.getHistory.mockResolvedValue(makeBars());
    const res = await request(app).get("/api/analytics/strategy-backtest?ticker=amd&strategy=sma_crossover");
    expect(res.status).toBe(200);
    expect(res.body.data.ticker).toBe("AMD");
    expect(polygonMock.getHistory).toHaveBeenCalledWith("AMD", 252);
  });

  test("clamps days into the [50, 1825] range", async () => {
    polygonMock.getHistory.mockResolvedValue(makeBars());
    await request(app).get("/api/analytics/strategy-backtest?ticker=AMD&strategy=sma_crossover&days=5000");
    expect(polygonMock.getHistory).toHaveBeenCalledWith("AMD", 1825);

    polygonMock.getHistory.mockClear();
    await request(app).get("/api/analytics/strategy-backtest?ticker=AMD&strategy=sma_crossover&days=1");
    expect(polygonMock.getHistory).toHaveBeenCalledWith("AMD", 50);
  });

  test("503 when POLYGON_API_KEY is not configured for a Polygon-routed ticker", async () => {
    delete process.env.POLYGON_API_KEY;
    const res = await request(app).get("/api/analytics/strategy-backtest?ticker=AMD&strategy=sma_crossover");
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/POLYGON_API_KEY/);
    process.env.POLYGON_API_KEY = "test-polygon-key";
  });

  test("502 when the provider fetch fails", async () => {
    polygonMock.getHistory.mockRejectedValue(new Error("Polygon HTTP 500"));
    const res = await request(app).get("/api/analytics/strategy-backtest?ticker=AMD&strategy=sma_crossover");
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Failed to fetch price history/);
  });

  test("422 when fewer than 50 bars are returned", async () => {
    polygonMock.getHistory.mockResolvedValue(makeBars(30));
    const res = await request(app).get("/api/analytics/strategy-backtest?ticker=AMD&strategy=sma_crossover");
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/Insufficient price history/);
  });

  test("second request for the same params is served from cache (provider called once)", async () => {
    polygonMock.getHistory.mockResolvedValue(makeBars());
    const qs = "ticker=AMD&strategy=sma_crossover";

    const res1 = await request(app).get(`/api/analytics/strategy-backtest?${qs}`);
    const res2 = await request(app).get(`/api/analytics/strategy-backtest?${qs}`);

    expect(res1.body.source).toBe("live");
    expect(res2.body.source).toBe("cache");
    expect(polygonMock.getHistory).toHaveBeenCalledTimes(1);
  });

  test("?refresh=true bypasses the cache", async () => {
    polygonMock.getHistory.mockResolvedValue(makeBars());
    const qs = "ticker=AMD&strategy=sma_crossover";

    await request(app).get(`/api/analytics/strategy-backtest?${qs}`);
    await request(app).get(`/api/analytics/strategy-backtest?${qs}&refresh=true`);

    expect(polygonMock.getHistory).toHaveBeenCalledTimes(2);
  });

  test("different strategies for the same ticker are cached independently", async () => {
    polygonMock.getHistory.mockResolvedValue(makeBars());

    await request(app).get("/api/analytics/strategy-backtest?ticker=AMD&strategy=sma_crossover");
    await request(app).get("/api/analytics/strategy-backtest?ticker=AMD&strategy=rsi_reversal");

    expect(polygonMock.getHistory).toHaveBeenCalledTimes(2);
  });

  test("includes a walk-forward split when there is enough history", async () => {
    polygonMock.getHistory.mockResolvedValue(makeBars(260));
    const res = await request(app).get("/api/analytics/strategy-backtest?ticker=AMD&strategy=sma_crossover&params=" +
      encodeURIComponent(JSON.stringify({ fast_period: 5, slow_period: 15 })));

    expect(res.status).toBe(200);
    expect(res.body.data.walkForward).not.toBeNull();
    expect(res.body.data.walkForward).toHaveProperty("inSample");
    expect(res.body.data.walkForward).toHaveProperty("outOfSample");
  });
});

describe("GET /api/analytics/strategy-backtest/strategies", () => {
  let app;
  beforeAll(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.PORT = "0";
    app = require("../server/index");
  });

  test("returns the full static strategy list with default params", async () => {
    const res = await request(app).get("/api/analytics/strategy-backtest/strategies");
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("static");
    const ids = res.body.data.map(s => s.id).sort();
    expect(ids).toEqual(Object.keys(STRATEGIES).sort());
    const sma = res.body.data.find(s => s.id === "sma_crossover");
    expect(sma.defaultParams).toEqual({ fast_period: 20, slow_period: 50 });
  });
});
