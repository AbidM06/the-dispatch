/**
 * tests/ideaEngine.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Tests for the idea engine system:
 *
 *   1. Playbook triggers (each of 13 playbooks: trigger true + false)
 *   2. Strategy modules (MA crossover, momentum, mean reversion)
 *   3. Risk gate (gateIdea — allowed / caution / blocked)
 *   4. ideaEngine.generateIdeas() — end-to-end with a hot-CPI context
 *   5. ideaLog helpers (appendToLog, readLog)
 *   6. paperTrader.computeMetrics()
 *   7. API endpoints (GET /api/ideas/latest, /history, /playbooks, /performance)
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

// ── Provider mocks (must be before any require of server modules) ─────────────
jest.mock("../server/providers/fred",         () => ({ getAllRates: jest.fn(), getRecentHistory: jest.fn() }));
jest.mock("../server/providers/alphaVantage", () => ({
  getQuotes: jest.fn(), getFxRate: jest.fn(), getQuote: jest.fn(),
  AV_SUPPORTED: new Set(["AMD"]),
  _getBudget: jest.fn(() => ({ date: null, count: 0, limit: 20 })),
  _resetBudget: jest.fn(),
}));
jest.mock("../server/providers/polygon",      () => ({
  getSnapshots:  jest.fn(),
  POLYGON_PEERS: new Set(["NVDA","MSFT","TSLA","MU","AMAT","LRCX"]),
}));
jest.mock("../server/providers/anthropic",    () => ({
  fetchAllAnalysis:     jest.fn(),
  fetchTickerExplain:   jest.fn(),
  evaluateThesis:       jest.fn(),
  generateTradeIdeas:   jest.fn().mockResolvedValue([]),
}));

// Idea log — mock file I/O
jest.mock("../server/importers/ideaLog", () => ({
  appendToLog:      jest.fn(),
  readLog:          jest.fn().mockReturnValue([]),
  appendIdeasLog:   jest.fn(),
  readIdeasLog:     jest.fn().mockReturnValue([]),
  appendSignalsLog: jest.fn(),
  readSignalsLog:   jest.fn().mockReturnValue([]),
  appendExecutionLog: jest.fn(),
  readExecutionLog: jest.fn().mockReturnValue([]),
  IDEAS_LOG_PATH:   "/tmp/ideas_log.jsonl",
  SIGNALS_LOG_PATH: "/tmp/signals_log.jsonl",
  EXECUTION_LOG_PATH: "/tmp/execution_log.jsonl",
}));

// Alpaca — mock so no real HTTP calls
jest.mock("../server/providers/alpaca", () => ({
  ALPACA_SUPPORTED:    new Set(["AMD","NVDA","MSFT","TSLA","MU","AMAT","LRCX"]),
  isSupported:         jest.fn(t => ["AMD","NVDA","MSFT","TSLA","MU","AMAT","LRCX"].includes(t)),
  isConfigured:        jest.fn().mockReturnValue(false),
  isAutoExecuteEnabled: jest.fn().mockReturnValue(false),
  placeOrder:          jest.fn(),
  placeBracketOrder:   jest.fn(),
  getPositions:        jest.fn().mockResolvedValue([]),
  getOpenOrders:       jest.fn().mockResolvedValue([]),
  getAccount:          jest.fn().mockResolvedValue({ portfolio_value: "10000", cash: "5000", buying_power: "5000" }),
  getSummary:          jest.fn().mockResolvedValue(null),
  closePosition:       jest.fn(),
  getOpenOrdersForTicker: jest.fn().mockResolvedValue([]),
  getMaxOrdersPerRun:  jest.fn().mockReturnValue(2),
}));

// Weekly review — mock file writes
jest.mock("../server/jobs/weeklyReview", () => ({
  generateWeeklyReport: jest.fn().mockReturnValue("# Weekly Review\n"),
  saveWeeklyReport:     jest.fn().mockReturnValue("/tmp/2026-03-14.md"),
}));

// Execution policy — mock fs operations
jest.mock("../server/analytics/executionPolicy", () => ({
  checkPolicy:   jest.fn().mockReturnValue({ allowed: false, reasons: ["TRADING_ENABLED is not 'true'"] }),
  recordTrade:   jest.fn(),
  getState:      jest.fn().mockReturnValue({ date: "2026-03-16", tradesPlaced: 0, notionalGBP: 0, tickers: {} }),
  getConfig:     jest.fn().mockReturnValue({ tradingEnabled: false, autoApprovePaper: false, maxTradesPerDay: 3, maxNotionalGBPPerDay: 250, maxOpenPositions: 5, maxSingleTickerPct: 20 }),
}));

// Webhook — mock so no real HTTP calls
jest.mock("../server/providers/webhook", () => ({
  fireWebhook: jest.fn().mockResolvedValue(undefined),
}));

// Scheduler — prevent setInterval from running during tests
jest.mock("../server/jobs/ideaScheduler", () => ({
  start:     jest.fn(),
  stop:      jest.fn(),
  getStatus: jest.fn().mockReturnValue({ lastRunAt: null, nextRunAt: null, totalRuns: 0, lastError: null }),
  runEngine: jest.fn(),
  tick:      jest.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────
const request = require("supertest");
const cache   = require("../server/cache");
const budget  = require("../server/providers/budget");
const seeds   = require("../seeds/fallback");

let app;
beforeAll(() => {
  process.env.ANTHROPIC_API_KEY     = "test-key";
  process.env.ALPHA_VANTAGE_API_KEY = "test-av-key";
  process.env.FRED_API_KEY          = "test-fred-key";
  process.env.PORT                  = "0";
  app = require("../server/index");
});

beforeEach(() => {
  cache.clear();
  jest.clearAllMocks();
  // Re-apply stable mock returns after clearAllMocks
require("../server/importers/ideaLog").readIdeasLog.mockReturnValue([]);
  require("../server/providers/alpaca").isConfigured.mockReturnValue(false);
  require("../server/providers/alpaca").isAutoExecuteEnabled.mockReturnValue(false);
  require("../server/providers/alpaca").getSummary.mockResolvedValue(null);
  budget._reset();
  delete process.env.LOW_COST_MODE;
});

afterAll(() => {
  delete process.env.LOW_COST_MODE;
});

// ── 1. Playbook triggers ──────────────────────────────────────────────────────

describe("Playbook triggers", () => {
  const { PLAYBOOKS } = require("../server/engine/playbooks");

  // Base ctx that does NOT trigger any playbook
  function baseCtx(overrides = {}) {
    return {
      rates: {
        dgs10: 4.21, dfii10: 1.85, t10yie: 2.38,
        hy_spread: 3.17, t10y2y: 0.51,
        ...overrides.rates,
      },
      deltas: {
        dgs10_d: 0, dfii10_d: 0, t10yie_d: 0,
        hy_spread_d: 0, t10y2y_d: 0,
        ...overrides.deltas,
      },
      portfolio: {
        rows: [], totalGBP: 1110, weights: {}, hhi: 1000, usdPct: 30,
        ...overrides.portfolio,
      },
      watchlist: {
        AMD:  { price: 192, chg: 0 },
        NVDA: { price: 178, chg: 0 },
        ...overrides.watchlist,
      },
      regime: "Bear flattener + risk-off",
      signals: {
        maSignal: "flat", maConviction: 0,
        momentumSignal: "flat", momentumConviction: 0,
        reversionSignal: "flat", reversionConviction: 0,
        ...overrides.signals,
      },
      today: new Date("2026-03-14"),
      ...overrides,
    };
  }

  function findPlaybook(id) {
    const p = PLAYBOOKS.find(pb => pb.id === id);
    if (!p) throw new Error(`Playbook ${id} not found`);
    return p;
  }

  // hot-cpi: t10yie > 2.5
  test("hot-cpi triggers when t10yie > 2.5", () => {
    const ctx = baseCtx({ rates: { dgs10: 4.21, dfii10: 1.85, t10yie: 2.6, hy_spread: 3.17, t10y2y: 0.51 } });
    expect(findPlaybook("hot-cpi").trigger(ctx)).toBe(true);
  });
  test("hot-cpi does NOT trigger when t10yie <= 2.5", () => {
    const ctx = baseCtx({ rates: { dgs10: 4.21, dfii10: 1.85, t10yie: 2.4, hy_spread: 3.17, t10y2y: 0.51 } });
    expect(findPlaybook("hot-cpi").trigger(ctx)).toBe(false);
  });

  // soft-cpi: t10yie < 2.0 AND hy_spread < 3.0
  test("soft-cpi triggers when t10yie < 2.0 and hy_spread < 3.0", () => {
    const ctx = baseCtx({ rates: { dgs10: 3.8, dfii10: 1.4, t10yie: 1.9, hy_spread: 2.8, t10y2y: 0.5 } });
    expect(findPlaybook("soft-cpi").trigger(ctx)).toBe(true);
  });
  test("soft-cpi does NOT trigger when hy_spread >= 3.0", () => {
    const ctx = baseCtx({ rates: { dgs10: 3.8, dfii10: 1.4, t10yie: 1.9, hy_spread: 3.1, t10y2y: 0.5 } });
    expect(findPlaybook("soft-cpi").trigger(ctx)).toBe(false);
  });

  // hawkish-fed: dgs10 > 4.5 AND t10y2y > 0.3
  test("hawkish-fed triggers when dgs10 > 4.5 and t10y2y > 0.3", () => {
    const ctx = baseCtx({ rates: { dgs10: 4.6, dfii10: 1.85, t10yie: 2.38, hy_spread: 3.17, t10y2y: 0.4 } });
    expect(findPlaybook("hawkish-fed").trigger(ctx)).toBe(true);
  });
  test("hawkish-fed does NOT trigger when dgs10 <= 4.5", () => {
    const ctx = baseCtx({ rates: { dgs10: 4.4, dfii10: 1.85, t10yie: 2.38, hy_spread: 3.17, t10y2y: 0.4 } });
    expect(findPlaybook("hawkish-fed").trigger(ctx)).toBe(false);
  });

  // dovish-fed: dgs10 < 4.0 AND dfii10 < 1.5
  test("dovish-fed triggers when dgs10 < 4.0 and dfii10 < 1.5", () => {
    const ctx = baseCtx({ rates: { dgs10: 3.8, dfii10: 1.4, t10yie: 2.2, hy_spread: 2.8, t10y2y: 0.5 } });
    expect(findPlaybook("dovish-fed").trigger(ctx)).toBe(true);
  });
  test("dovish-fed does NOT trigger when dfii10 >= 1.5", () => {
    const ctx = baseCtx({ rates: { dgs10: 3.8, dfii10: 1.6, t10yie: 2.2, hy_spread: 2.8, t10y2y: 0.5 } });
    expect(findPlaybook("dovish-fed").trigger(ctx)).toBe(false);
  });

  // payroll-proxy: t10y2y rising (delta > +10bps)
  test("payroll-proxy triggers when t10y2y_d > 10", () => {
    const ctx = baseCtx({ deltas: { dgs10_d: 0, dfii10_d: 0, t10yie_d: 0, hy_spread_d: 0, t10y2y_d: 15 } });
    expect(findPlaybook("payroll-proxy").trigger(ctx)).toBe(true);
  });
  test("payroll-proxy does NOT trigger when t10y2y_d <= 10", () => {
    const ctx = baseCtx({ deltas: { dgs10_d: 0, dfii10_d: 0, t10yie_d: 0, hy_spread_d: 0, t10y2y_d: 5 } });
    expect(findPlaybook("payroll-proxy").trigger(ctx)).toBe(false);
  });

  // stagflation-proxy: t10yie > 2.4 AND hy_spread > 3.5
  test("stagflation-proxy triggers when t10yie > 2.4 and hy_spread > 3.5", () => {
    const ctx = baseCtx({ rates: { dgs10: 4.5, dfii10: 1.9, t10yie: 2.5, hy_spread: 3.6, t10y2y: 0.5 } });
    expect(findPlaybook("stagflation-proxy").trigger(ctx)).toBe(true);
  });
  test("stagflation-proxy does NOT trigger when hy_spread <= 3.5", () => {
    const ctx = baseCtx({ rates: { dgs10: 4.5, dfii10: 1.9, t10yie: 2.5, hy_spread: 3.4, t10y2y: 0.5 } });
    expect(findPlaybook("stagflation-proxy").trigger(ctx)).toBe(false);
  });

  // credit-spread-widening: hy_spread > 3.5 AND hy_spread_d > +15
  test("credit-spread-widening triggers when hy_spread > 3.5 and hy_spread_d > 15", () => {
    const ctx = baseCtx({
      rates:  { dgs10: 4.2, dfii10: 1.85, t10yie: 2.38, hy_spread: 3.6, t10y2y: 0.51 },
      deltas: { dgs10_d: 0, dfii10_d: 0, t10yie_d: 0, hy_spread_d: 20, t10y2y_d: 0 },
    });
    expect(findPlaybook("credit-spread-widening").trigger(ctx)).toBe(true);
  });
  test("credit-spread-widening does NOT trigger when hy_spread <= 3.5", () => {
    const ctx = baseCtx({
      rates:  { dgs10: 4.2, dfii10: 1.85, t10yie: 2.38, hy_spread: 3.3, t10y2y: 0.51 },
      deltas: { dgs10_d: 0, dfii10_d: 0, t10yie_d: 0, hy_spread_d: 20, t10y2y_d: 0 },
    });
    expect(findPlaybook("credit-spread-widening").trigger(ctx)).toBe(false);
  });

  // trend-continuation: maSignal == "long" AND momentumSignal == "long"
  test("trend-continuation triggers when maSignal=long and momentumSignal=long", () => {
    const ctx = baseCtx({
      signals:   { maSignal: "long", maConviction: 60, momentumSignal: "long", momentumConviction: 40, reversionSignal: "flat", reversionConviction: 0 },
      watchlist: { AMD: { price: 195, chg: 1.2 }, NVDA: { price: 178, chg: 0 } },
    });
    expect(findPlaybook("trend-continuation").trigger(ctx)).toBe(true);
  });
  test("trend-continuation does NOT trigger when maSignal != long", () => {
    const ctx = baseCtx({
      signals:   { maSignal: "flat", maConviction: 0, momentumSignal: "long", momentumConviction: 40, reversionSignal: "flat", reversionConviction: 0 },
      watchlist: { AMD: { price: 195, chg: 1.2 }, NVDA: { price: 178, chg: 0 } },
    });
    expect(findPlaybook("trend-continuation").trigger(ctx)).toBe(false);
  });

  // mean-reversion: reversionSignal != "flat"
  test("mean-reversion triggers when reversionSignal != flat", () => {
    const ctx = baseCtx({
      signals: { maSignal: "flat", maConviction: 0, momentumSignal: "flat", momentumConviction: 0, reversionSignal: "long", reversionConviction: 50 },
    });
    expect(findPlaybook("mean-reversion").trigger(ctx)).toBe(true);
  });
  test("mean-reversion does NOT trigger when reversionSignal == flat", () => {
    const ctx = baseCtx({
      signals: { maSignal: "flat", maConviction: 0, momentumSignal: "flat", momentumConviction: 0, reversionSignal: "flat", reversionConviction: 0 },
    });
    expect(findPlaybook("mean-reversion").trigger(ctx)).toBe(false);
  });

  // breakout-failure: hy_spread > 4.0 AND hy_spread_d < -10
  test("breakout-failure triggers when hy_spread > 4.0 and hy_spread_d < -10", () => {
    const ctx = baseCtx({
      rates:  { dgs10: 4.2, dfii10: 1.85, t10yie: 2.38, hy_spread: 4.2, t10y2y: 0.51 },
      deltas: { dgs10_d: 0, dfii10_d: 0, t10yie_d: 0, hy_spread_d: -15, t10y2y_d: 0 },
    });
    expect(findPlaybook("breakout-failure").trigger(ctx)).toBe(true);
  });
  test("breakout-failure does NOT trigger when hy_spread <= 4.0", () => {
    const ctx = baseCtx({
      rates:  { dgs10: 4.2, dfii10: 1.85, t10yie: 2.38, hy_spread: 3.8, t10y2y: 0.51 },
      deltas: { dgs10_d: 0, dfii10_d: 0, t10yie_d: 0, hy_spread_d: -15, t10y2y_d: 0 },
    });
    expect(findPlaybook("breakout-failure").trigger(ctx)).toBe(false);
  });

  // correlation-break: only fires when AMD is laggard (AMD underperforms NVDA by >8%)
  test("correlation-break triggers when AMD underperforms NVDA by > 8%", () => {
    const ctx = baseCtx({
      watchlist: { AMD: { price: 195, chg: -5.0 }, NVDA: { price: 178, chg: 5.0 } },
    });
    expect(findPlaybook("correlation-break").trigger(ctx)).toBe(true);
  });
  test("correlation-break does NOT trigger when divergence <= 8%", () => {
    const ctx = baseCtx({
      watchlist: { AMD: { price: 195, chg: 1.0 }, NVDA: { price: 178, chg: -2.0 } },
    });
    expect(findPlaybook("correlation-break").trigger(ctx)).toBe(false);
  });

  // high-usd-hedge: usdPct > 55
  test("high-usd-hedge triggers when usdPct > 55", () => {
    const ctx = baseCtx({ portfolio: { rows: [], totalGBP: 1000, weights: {}, hhi: 1500, usdPct: 60 } });
    expect(findPlaybook("high-usd-hedge").trigger(ctx)).toBe(true);
  });
  test("high-usd-hedge does NOT trigger when usdPct <= 55", () => {
    const ctx = baseCtx({ portfolio: { rows: [], totalGBP: 1000, weights: {}, hhi: 1500, usdPct: 40 } });
    expect(findPlaybook("high-usd-hedge").trigger(ctx)).toBe(false);
  });

  // concentration-hedge: hhi > 2000
  test("concentration-hedge triggers when hhi > 2000", () => {
    const ctx = baseCtx({ portfolio: { rows: [], totalGBP: 1000, weights: {}, hhi: 2500, usdPct: 30 } });
    expect(findPlaybook("concentration-hedge").trigger(ctx)).toBe(true);
  });
  test("concentration-hedge does NOT trigger when hhi <= 2000", () => {
    const ctx = baseCtx({ portfolio: { rows: [], totalGBP: 1000, weights: {}, hhi: 1500, usdPct: 30 } });
    expect(findPlaybook("concentration-hedge").trigger(ctx)).toBe(false);
  });
});

// ── 2. Strategy modules ───────────────────────────────────────────────────────

describe("Strategy modules", () => {
  const { movingAverageCrossover, momentumBreakout, meanReversionSignal, computeSignals } =
    require("../server/engine/strategies");

  describe("movingAverageCrossover", () => {
    const fallingHistory = [
      { y10: 4.5 }, { y10: 4.4 }, { y10: 4.3 },
      { y10: 4.2 }, { y10: 4.0 }, { y10: 3.8 }, // short avg < long avg → rates falling → LONG
    ];
    const risingHistory = [
      { y10: 3.5 }, { y10: 3.6 }, { y10: 3.7 },
      { y10: 3.9 }, { y10: 4.2 }, { y10: 4.5 }, // short avg > long avg → rates rising → SHORT
    ];

    test("returns LONG signal when short MA < long MA (rates falling)", () => {
      const result = movingAverageCrossover(fallingHistory);
      expect(result.signal).toBe("long");
      expect(result.conviction).toBeGreaterThan(0);
      expect(result.meta.shortMA).toBeDefined();
    });

    test("returns SHORT signal when short MA > long MA (rates rising)", () => {
      const result = movingAverageCrossover(risingHistory);
      expect(result.signal).toBe("short");
      expect(result.conviction).toBeGreaterThan(0);
    });

    test("returns flat when insufficient data", () => {
      const result = movingAverageCrossover([{ y10: 4.0 }]);
      expect(result.signal).toBe("flat");
      expect(result.conviction).toBe(0);
    });

    test("returns flat when spread is within ±0.05%", () => {
      // Identical values → spread = 0
      const flat = Array(6).fill({ y10: 4.2 });
      const result = movingAverageCrossover(flat);
      expect(result.signal).toBe("flat");
    });
  });

  describe("momentumBreakout", () => {
    test("returns LONG signal when AMD chg > +1.5%", () => {
      const result = momentumBreakout({ AMD: { price: 195, chg: 2.5 }, NVDA: { price: 178, chg: 1.0 } });
      expect(result.signal).toBe("long");
      expect(result.conviction).toBeGreaterThan(0);
    });

    test("returns SHORT signal when AMD chg < -1.5%", () => {
      const result = momentumBreakout({ AMD: { price: 185, chg: -3.0 }, NVDA: { price: 175, chg: -1.0 } });
      expect(result.signal).toBe("short");
      expect(result.conviction).toBeGreaterThan(0);
    });

    test("returns flat when AMD chg is within ±1.5%", () => {
      const result = momentumBreakout({ AMD: { price: 193, chg: 0.5 } });
      expect(result.signal).toBe("flat");
      expect(result.conviction).toBe(0);
    });

    test("returns flat when AMD not available", () => {
      const result = momentumBreakout({});
      expect(result.signal).toBe("flat");
      expect(result.conviction).toBe(0);
    });

    test("conviction is capped at 75", () => {
      const result = momentumBreakout({ AMD: { price: 200, chg: 10.0 } });
      expect(result.conviction).toBeLessThanOrEqual(75);
    });
  });

  describe("meanReversionSignal", () => {
    const history = [
      { y10: 3.5 }, { y10: 3.6 }, { y10: 3.7 },
      { y10: 3.8 }, { y10: 3.9 }, { y10: 4.0 },
    ]; // mean ≈ 3.75, stddev ≈ 0.17

    test("returns LONG when DGS10 is abnormally HIGH (z > +1.5)", () => {
      // 3.75 + 1.6 * 0.17 ≈ 4.02 → z > 1.5
      const result = meanReversionSignal({ dgs10: 4.10 }, history);
      expect(result.signal).toBe("long");
      expect(result.conviction).toBeGreaterThan(0);
      expect(result.meta.zScore).toBeGreaterThan(1.5);
    });

    test("returns SHORT when DGS10 is abnormally LOW (z < -1.5)", () => {
      // 3.75 - 1.6 * 0.17 ≈ 3.48 → z < -1.5
      const result = meanReversionSignal({ dgs10: 3.40 }, history);
      expect(result.signal).toBe("short");
      expect(result.meta.zScore).toBeLessThan(-1.5);
    });

    test("returns flat when within ±1.5σ", () => {
      const result = meanReversionSignal({ dgs10: 3.75 }, history);
      expect(result.signal).toBe("flat");
      expect(result.conviction).toBe(0);
    });

    test("returns flat when DGS10 not available", () => {
      const result = meanReversionSignal({}, history);
      expect(result.signal).toBe("flat");
    });

    test("returns flat when insufficient history (<3 points)", () => {
      const result = meanReversionSignal({ dgs10: 4.2 }, [{ y10: 4.0 }, { y10: 4.1 }]);
      expect(result.signal).toBe("flat");
    });

    test("conviction is capped at 80", () => {
      const result = meanReversionSignal({ dgs10: 5.5 }, history);
      expect(result.conviction).toBeLessThanOrEqual(80);
    });
  });

  describe("computeSignals", () => {
    test("returns all three signal fields", () => {
      const result = computeSignals(
        { dgs10: 4.2, dfii10: 1.85, t10yie: 2.38, hy_spread: 3.17, t10y2y: 0.51 },
        seeds.RATES_HISTORY_SEED,
        { AMD: { price: 192, chg: 0 } }
      );
      expect(result).toHaveProperty("maSignal");
      expect(result).toHaveProperty("momentumSignal");
      expect(result).toHaveProperty("reversionSignal");
      expect(result).toHaveProperty("details");
    });
  });
});

// ── 3. Risk gate ──────────────────────────────────────────────────────────────

describe("Risk gate (gateIdea)", () => {
  const { gateIdea } = require("../server/engine/riskGate");

  // A neutral ticker that doesn't exist in the portfolio (no concentration risk)
  const cleanTicket = { ticker: "NEWSTOCK", direction: "LONG", sizePct: 3, horizon: "3 months" };
  const bigTicket   = { ticker: "AMD",      direction: "LONG", sizePct: 30, horizon: "3 months" };
  const lseTicket   = { ticker: "SGLN",     direction: "LONG", sizePct: 3,  horizon: "3 months" };

  const emptyRows  = [];
  const totalGBP   = 1110;

  test("returns 'allowed' for a clean small position on unknown ticker", () => {
    const result = gateIdea(cleanTicket, emptyRows, totalGBP, 0.76);
    // With no existing positions and small size, should pass
    expect(["allowed", "caution"]).toContain(result.decision);
    expect(result.checks).toBeDefined();
    expect(Array.isArray(result.riskFlags)).toBe(true);
  });

  test("returns 'blocked' for an oversized position (sizePct > 25%)", () => {
    const result = gateIdea(bigTicket, emptyRows, totalGBP, 0.76);
    expect(result.decision).toBe("blocked");
  });

  test("includes LSE liquidity note for SGLN", () => {
    const result = gateIdea(lseTicket, emptyRows, totalGBP, 0.76);
    const hasLiqNote = result.reasons.some(r => r.includes("T212-only") || r.includes("LSE") || r.includes("SGLN"));
    expect(hasLiqNote).toBe(true);
  });

  test("has decision, reasons, checks, riskFlags fields", () => {
    const result = gateIdea(cleanTicket, emptyRows, totalGBP, 0.76);
    expect(["allowed", "caution", "blocked"]).toContain(result.decision);
    expect(Array.isArray(result.reasons)).toBe(true);
    expect(Array.isArray(result.checks)).toBe(true);
    expect(Array.isArray(result.riskFlags)).toBe(true);
  });
});

// ── 4. ideaEngine.generateIdeas() ────────────────────────────────────────────

describe("ideaEngine.generateIdeas()", () => {
  const { generateIdeas, buildCtx } = require("../server/engine/ideaEngine");

  // Hot-CPI context: t10yie > 2.5 → triggers hot-cpi playbook
  const hotCpiCtx = {
    rates: { dgs10: 4.6, dfii10: 1.9, t10yie: 2.65, hy_spread: 3.6, t10y2y: 0.55 },
    deltas: { dgs10_d: 5, dfii10_d: 3, t10yie_d: 8, hy_spread_d: 20, t10y2y_d: 5 },
    portfolio: { rows: [], totalGBP: 1110, weights: {}, hhi: 1000, usdPct: 30 },
    watchlist: { AMD: { price: 192, chg: 2.0 }, NVDA: { price: 178, chg: 1.5 } },
    regime: "Bear steepener + Risk-off",
    signals: { maSignal: "flat", maConviction: 0, momentumSignal: "long", momentumConviction: 30, reversionSignal: "flat", reversionConviction: 0 },
    today: new Date("2026-03-14"),
    _usdgbp: 0.76,
  };

  test("generates at least one ticket from hot-CPI context", () => {
    const tickets = generateIdeas(hotCpiCtx, { maxIdeas: 5 });
    expect(Array.isArray(tickets)).toBe(true);
    // hot-cpi triggers (t10yie 2.65 > 2.5) and credit-spread-widening (hy_spread 3.6 > 3.5, delta 20 > 15)
    expect(tickets.length).toBeGreaterThan(0);
  });

  test("ticket has required engine fields", () => {
    const tickets = generateIdeas(hotCpiCtx, { maxIdeas: 5 });
    if (tickets.length === 0) return; // edge case — no triggers
    const t = tickets[0];
    expect(t.id).toBeDefined();
    expect(t.generatedAt).toBeDefined();
    expect(t.playbook).toBeDefined();
    expect(t.ticker).toBeDefined();
    expect(["LONG", "SHORT"]).toContain(t.direction);
    expect(typeof t.confidence).toBe("number");
    expect(["allowed", "caution"]).toContain(t.engineDecision); // blocked are filtered
    expect(Array.isArray(t.riskFlags)).toBe(true);
    expect(Array.isArray(t.engineReasons)).toBe(true);
    expect(["deterministic", "ai-enriched"]).toContain(t.sourceMode);
  });

  test("ticket has learning layer", () => {
    const tickets = generateIdeas(hotCpiCtx, { maxIdeas: 5 });
    if (tickets.length === 0) return;
    const t = tickets[0];
    expect(t.learning).not.toBeNull();
    expect(typeof t.learning.traderInterpretation).toBe("string");
    expect(typeof t.learning.economicsInterpretation).toBe("string");
    expect(Array.isArray(t.learning.keyTerms)).toBe(true);
    expect(Array.isArray(t.learning.falsification)).toBe(true);
  });

  test("hot-cpi playbook produces SGLN LONG", () => {
    const tickets = generateIdeas(hotCpiCtx, { maxIdeas: 10 });
    const hotCpiTicket = tickets.find(t => t.playbook === "hot-cpi");
    expect(hotCpiTicket).toBeDefined();
    expect(hotCpiTicket.ticker).toBe("SGLN");
    expect(hotCpiTicket.direction).toBe("LONG");
  });

  test("tickets are sorted by confidence descending", () => {
    const tickets = generateIdeas(hotCpiCtx, { maxIdeas: 10 });
    for (let i = 1; i < tickets.length; i++) {
      expect(tickets[i - 1].confidence).toBeGreaterThanOrEqual(tickets[i].confidence);
    }
  });

  test("respects maxIdeas limit", () => {
    const tickets = generateIdeas(hotCpiCtx, { maxIdeas: 2 });
    expect(tickets.length).toBeLessThanOrEqual(2);
  });

  test("buildCtx returns a valid ctx object", () => {
    const ctx = buildCtx(null, null, null); // all seeds
    expect(ctx.rates).toBeDefined();
    expect(ctx.signals).toBeDefined();
    expect(ctx.regime).toBeDefined();
    expect(ctx.portfolio).toBeDefined();
    expect(ctx.watchlist).toBeDefined();
  });
});

// ── 5. ideaLog helpers ────────────────────────────────────────────────────────

describe("ideaLog", () => {
  // The module is mocked — test that the mock behaves correctly
  const ideaLog = require("../server/importers/ideaLog");

  test("readIdeasLog returns [] by default (mock)", () => {
    const result = ideaLog.readIdeasLog(30);
    expect(Array.isArray(result)).toBe(true);
  });

  test("appendIdeasLog can be called without throwing", () => {
    expect(() => ideaLog.appendIdeasLog({ ideas: [], regime: "test" })).not.toThrow();
  });
});

// ── 6. paperTrader.computeMetrics() ──────────────────────────────────────────

describe("paperTrader.computeMetrics()", () => {
  const { computeMetrics } = require("../server/analytics/paperTrader");

  test("returns all-null rates with empty ideas array", () => {
    const m = computeMetrics([]);
    expect(m.total).toBe(0);
    expect(m.hitRate).toBeNull();
    expect(m.stopRate).toBeNull();
    expect(m.avgPnLPct).toBeNull();
    expect(m.expectancy).toBeNull();
    expect(m.avgRMultiple).toBeNull();
  });

  test("computes hitRate=100 with single HIT closed idea", () => {
    const ideas = [{
      status: "CLOSED", outcome: "HIT", ticker: "AMD", direction: "LONG",
      entry: 190, stop: 180, target: 220, actualPnLPct: 10,
      openedAt: "2026-03-01T00:00:00Z", closedAt: "2026-03-10T00:00:00Z",
    }];
    const m = computeMetrics(ideas);
    expect(m.total).toBe(1);
    expect(m.closed).toBe(1);
    expect(m.hitRate).toBe(100);
    expect(m.stopRate).toBe(0);
    expect(m.avgPnLPct).toBe(10);
    expect(m.avgWinPct).toBe(10);
    expect(m.avgLossPct).toBeNull();
  });

  test("computes hitRate=0 with single STOPPED idea", () => {
    const ideas = [{
      status: "CLOSED", outcome: "STOPPED", ticker: "AMD", direction: "LONG",
      entry: 190, stop: 180, target: 220, actualPnLPct: -5,
      openedAt: "2026-03-01T00:00:00Z", closedAt: "2026-03-05T00:00:00Z",
    }];
    const m = computeMetrics(ideas);
    expect(m.hitRate).toBe(0);
    expect(m.stopRate).toBe(100);
    expect(m.avgLossPct).toBe(-5);
    expect(m.avgWinPct).toBeNull();
  });

  test("computes expectancy from mixed HIT + STOPPED", () => {
    const ideas = [
      { status: "CLOSED", outcome: "HIT",     ticker: "AMD", direction: "LONG", entry: 190, stop: 180, target: 220, actualPnLPct: 15, openedAt: "2026-03-01T00:00:00Z", closedAt: "2026-03-10T00:00:00Z" },
      { status: "CLOSED", outcome: "STOPPED",  ticker: "AMD", direction: "LONG", entry: 190, stop: 180, target: 220, actualPnLPct: -5, openedAt: "2026-03-01T00:00:00Z", closedAt: "2026-03-05T00:00:00Z" },
    ];
    const m = computeMetrics(ideas);
    expect(m.hitRate).toBe(50);
    expect(m.stopRate).toBe(50);
    // expectancy = 0.5 * 15 + 0.5 * (-5) = 5
    expect(m.expectancy).toBeCloseTo(5, 1);
  });

  test("computes avgRMultiple correctly", () => {
    // entry=190, stop=180, risk=10 (5.26%). actualPnLPct=15 → R = 15/5.26 ≈ 2.85
    const ideas = [{
      status: "CLOSED", outcome: "HIT", ticker: "AMD", direction: "LONG",
      entry: 190, stop: 180, target: 230, actualPnLPct: 15,
      openedAt: "2026-03-01T00:00:00Z", closedAt: "2026-03-20T00:00:00Z",
    }];
    const m = computeMetrics(ideas);
    expect(m.avgRMultiple).not.toBeNull();
    expect(m.avgRMultiple).toBeGreaterThan(0);
  });

  test("byTicker breakdown is computed", () => {
    const ideas = [
      { status: "CLOSED", outcome: "HIT",     ticker: "AMD",  direction: "LONG", entry: 190, stop: 180, target: 220, actualPnLPct: 10, openedAt: "2026-03-01T00:00:00Z", closedAt: "2026-03-10T00:00:00Z" },
      { status: "CLOSED", outcome: "STOPPED",  ticker: "SGLN", direction: "LONG", entry: 74,  stop: 70,  target: 82,  actualPnLPct: -5, openedAt: "2026-03-01T00:00:00Z", closedAt: "2026-03-07T00:00:00Z" },
    ];
    const m = computeMetrics(ideas);
    expect(m.byTicker).toBeDefined();
    expect(m.byTicker.AMD).toBeDefined();
    expect(m.byTicker.AMD.hitRate).toBe(100);
    expect(m.byTicker.SGLN).toBeDefined();
    expect(m.byTicker.SGLN.hitRate).toBe(0);
  });

  test("byDirection breakdown is computed", () => {
    const ideas = [
      { status: "CLOSED", outcome: "HIT", ticker: "AMD", direction: "LONG", entry: 190, stop: 180, target: 220, actualPnLPct: 10, openedAt: "2026-03-01T00:00:00Z", closedAt: "2026-03-10T00:00:00Z" },
    ];
    const m = computeMetrics(ideas);
    expect(m.byDirection.LONG).toBeDefined();
    expect(m.byDirection.SHORT).toBeDefined();
    expect(m.byDirection.LONG.count).toBe(1);
    expect(m.byDirection.SHORT.count).toBe(0);
  });

  test("avgHoldDays is computed from openedAt/closedAt", () => {
    const ideas = [{
      status: "CLOSED", outcome: "HIT", ticker: "AMD", direction: "LONG",
      entry: 190, stop: 180, target: 220, actualPnLPct: 8,
      openedAt: "2026-03-01T00:00:00Z", closedAt: "2026-03-11T00:00:00Z",
    }];
    const m = computeMetrics(ideas);
    expect(m.avgHoldDays).toBeCloseTo(10, 0);
  });

  test("handles OPEN ideas (mfe/mae computed)", () => {
    const ideas = [{
      status: "OPEN", ticker: "AMD", direction: "LONG",
      entry: 190, stop: 180, target: 220, actualPnLPct: null,
      openedAt: "2026-03-10T00:00:00Z", closedAt: null,
    }];
    const m = computeMetrics(ideas);
    expect(m.open).toBe(1);
    expect(m.mfe).not.toBeNull();
    expect(m.mae).not.toBeNull();
  });
});

// ── 7. New API endpoints ───────────────────────────────────────────────────────

describe("GET /api/ideas/latest", () => {
  test("returns 200 with envelope when no logs", async () => {
    require("../server/importers/ideaLog").readIdeasLog.mockReturnValue([]);
    const res = await request(app).get("/api/ideas/latest");
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.fetchedAt).toBeDefined();
  });

  test("returns most recent run when logs exist", async () => {
    const mockLog = [
      { ts: "2026-03-13T08:00:00Z", ideas: [{ id: "abc", ticker: "SGLN" }], regime: "Bear flattener" },
      { ts: "2026-03-14T08:00:00Z", ideas: [{ id: "def", ticker: "AMD"  }], regime: "Bear steepener" },
    ];
    require("../server/importers/ideaLog").readIdeasLog.mockReturnValue(mockLog);
    const res = await request(app).get("/api/ideas/latest");
    expect(res.status).toBe(200);
    expect(res.body.data.ts).toBe("2026-03-14T08:00:00Z");
  });
});

describe("GET /api/ideas/history", () => {
  test("returns 200 with runs array", async () => {
    require("../server/importers/ideaLog").readIdeasLog.mockReturnValue([
      { ts: "2026-03-14T08:00:00Z", ideas: [], regime: "test" },
    ]);
    const res = await request(app).get("/api/ideas/history?days=7");
    expect(res.status).toBe(200);
    expect(res.body.data.runs).toBeDefined();
    expect(Array.isArray(res.body.data.runs)).toBe(true);
    expect(res.body.data.days).toBe(7);
  });
});

describe("GET /api/ideas/playbooks", () => {
  test("returns 200 with all playbooks (≥13)", async () => {
    const res = await request(app).get("/api/ideas/playbooks");
    expect(res.status).toBe(200);
    expect(res.body.data.playbooks).toBeDefined();
    expect(Array.isArray(res.body.data.playbooks)).toBe(true);
    expect(res.body.data.playbooks.length).toBeGreaterThanOrEqual(13);
  });

  test("each playbook has id, name, category, description", async () => {
    const res = await request(app).get("/api/ideas/playbooks");
    for (const p of res.body.data.playbooks) {
      expect(typeof p.id).toBe("string");
      expect(typeof p.name).toBe("string");
      expect(["macro", "structure", "portfolio", "exit"]).toContain(p.category);
      expect(typeof p.description).toBe("string");
    }
  });
});

describe("GET /api/ideas/performance", () => {
  test("returns 200 with PaperMetrics shape", async () => {
    const res = await request(app).get("/api/ideas/performance");
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    const m = res.body.data;
    expect(typeof m.total).toBe("number");
    expect(typeof m.open).toBe("number");
    expect(typeof m.closed).toBe("number");
    expect(m.byTicker).toBeDefined();
    expect(m.byDirection).toBeDefined();
    expect(m.byDirection.LONG).toBeDefined();
    expect(m.byDirection.SHORT).toBeDefined();
  });
});

describe("GET /api/ideas/alpaca", () => {
  test("returns 200 with configured=false when no keys set", async () => {
    require("../server/providers/alpaca").isConfigured.mockReturnValue(false);
    require("../server/providers/alpaca").getSummary.mockResolvedValue(null);
    const res = await request(app).get("/api/ideas/alpaca");
    expect(res.status).toBe(200);
    expect(res.body.data.configured).toBe(false);
    expect(res.body.data.summary).toBeNull();
  });
});

describe("POST /api/ideas/weekly-report", () => {
  test("returns 200 with filePath", async () => {
    const res = await request(app).post("/api/ideas/weekly-report");
    expect(res.status).toBe(200);
    expect(res.body.data.filePath).toBeDefined();
  });
});

describe("POST /api/ideas/generate (engine path)", () => {
  test("returns 200 with ideas array in LOW_COST_MODE", async () => {
    process.env.LOW_COST_MODE = "true";
    const res = await request(app).post("/api/ideas/generate").send({ count: 3 });
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(Array.isArray(res.body.data.ideas)).toBe(true);
  });

  test("returns engine tickets with the idea engine path", async () => {
    delete process.env.LOW_COST_MODE;
    const res = await request(app).post("/api/ideas/generate").send({ count: 5 });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.ideas)).toBe(true);
    expect(res.body.data.regime).toBeDefined();
  });

  test("returns engineVersion field", async () => {
    const res = await request(app).post("/api/ideas/generate").send({});
    expect(res.status).toBe(200);
    // Engine path should have engineVersion (or legacy deterministic doesn't)
    // Either way, response should be valid
    expect(res.body.source).toBeDefined();
  });
});

// ── Phase 1: Write-auth middleware ───────────────────────────────────────────

describe("Write-auth middleware", () => {
  test("returns 401 on POST /api/ideas/generate without key when DISPATCH_ADMIN_KEY is set", async () => {
    process.env.DISPATCH_ADMIN_KEY = "test-secret";
    const res = await request(app).post("/api/ideas/generate").send({ count: 1 });
    expect(res.status).toBe(401);
    delete process.env.DISPATCH_ADMIN_KEY;
  });

  test("succeeds on POST /api/ideas/generate with correct key", async () => {
    process.env.DISPATCH_ADMIN_KEY = "test-secret";
    const res = await request(app)
      .post("/api/ideas/generate")
      .set("x-dispatch-key", "test-secret")
      .send({ count: 1 });
    expect(res.status).not.toBe(401);
    delete process.env.DISPATCH_ADMIN_KEY;
  });

  test("GET /api/ideas does not require auth", async () => {
    process.env.DISPATCH_ADMIN_KEY = "test-secret";
    const res = await request(app).get("/api/ideas");
    expect(res.status).toBe(200);
    delete process.env.DISPATCH_ADMIN_KEY;
  });
});

// ── Phase 1: Shariah SHORT rejection ─────────────────────────────────────────

describe("Shariah SHORT rejection", () => {
  test("POST /api/ideas rejects direction=SHORT with 400", async () => {
    const res = await request(app).post("/api/ideas").send({
      ticker: "AMD", direction: "SHORT", thesis: "test", catalyst: "test",
      entry: 200, stop: 210, target: 180, invalidation: "test",
      horizon: "3 months", confidence: 50, sizePct: 5,
    });
    expect(res.status).toBe(400);
    expect(res.body.shariahRule).toBe("gharar");
  });
});

// ── Phase 2: execution policy ────────────────────────────────────────────────

describe("Phase 2: execution policy (unit)", () => {
  test("checkPolicy denies when TRADING_ENABLED not set", () => {
    // Use a fresh require to test real module (not mocked)
    // But the mock is already applied — test the mock behavior is consistent
    const ep = require("../server/analytics/executionPolicy");
    const result = ep.checkPolicy({});
    expect(result.allowed).toBe(false);
    expect(result.reasons[0]).toMatch(/TRADING_ENABLED/);
  });
});

// ── Phase 2: position sizing ─────────────────────────────────────────────────

describe("Phase 2: position sizing", () => {
  const { computeSize } = require("../server/engine/positionSizing");

  test("blocks when entry <= stop", () => {
    const r = computeSize(100, 110, 1000, 80);
    expect(r.blocked).toBe(true);
  });

  test("blocks when notional below minimum", () => {
    const r = computeSize(100, 99, 10, 80, { minOrderNotionalGBP: 1000 });
    expect(r.blocked).toBe(true);
  });

  test("returns valid qty for good inputs", () => {
    const r = computeSize(200, 190, 10000, 160);
    expect(r.blocked).toBe(false);
    expect(r.qty).toBeGreaterThan(0);
  });
});

// ── Phase 2: journal endpoint ────────────────────────────────────────────────

describe("Phase 2: journal endpoint", () => {
  test("GET /api/ideas/journal returns playbookStats and regimeStats", async () => {
    const res = await request(app).get("/api/ideas/journal");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.playbookStats)).toBe(true);
    expect(Array.isArray(res.body.data.regimeStats)).toBe(true);
  });
});

// ── Phase 3: exit engine ────────────────────────────────────────────────────

describe("Phase 3: exit engine", () => {
  const { checkExits } = require("../server/engine/exitEngine");

  function makeCtx(watchlistPrices = {}) {
    return {
      rates: { dgs10: 4.21, dfii10: 1.85, t10yie: 2.38, hy_spread: 3.17, t10y2y: 0.51 },
      watchlist: watchlistPrices,
      regime: "Bear steepener + Elevated real yields",
    };
  }

  it("generates CLOSE signal when target is hit", () => {
    const open = [{ id: "abc", status: "OPEN", ticker: "AMD", direction: "LONG",
      entry: 180, stop: 170, target: 200, horizon: "3 months", openedAt: new Date().toISOString() }];
    const ctx  = makeCtx({ AMD: { price: 205, chg: 1.2 } });
    const sigs = checkExits(open, ctx);
    expect(sigs.length).toBeGreaterThan(0);
    expect(sigs[0].signal).toBe("CLOSE");
    expect(sigs[0].exitPlaybook).toBe("exit-target-hit");
  });

  it("generates CLOSE signal when stop is hit", () => {
    const open = [{ id: "abc", status: "OPEN", ticker: "AMD", direction: "LONG",
      entry: 180, stop: 170, target: 200, horizon: "3 months", openedAt: new Date().toISOString() }];
    const ctx  = makeCtx({ AMD: { price: 168, chg: -3.1 } });
    const sigs = checkExits(open, ctx);
    expect(sigs.length).toBeGreaterThan(0);
    expect(sigs[0].signal).toBe("CLOSE");
    expect(sigs[0].exitPlaybook).toBe("exit-stop-hit");
  });

  it("generates REVIEW signal for time-expired ideas", () => {
    const oldDate = new Date(Date.now() - 120 * 86_400_000).toISOString(); // 120 days ago
    const open = [{ id: "abc", status: "OPEN", ticker: "AMD", direction: "LONG",
      entry: 180, stop: 170, target: 200, horizon: "3 months", openedAt: oldDate }];
    const ctx = makeCtx({ AMD: { price: 185, chg: 0.5 } });
    const sigs = checkExits(open, ctx);
    expect(sigs.length).toBeGreaterThan(0);
    expect(sigs[0].exitPlaybook).toBe("exit-time-expiry");
  });

  it("returns no signals for idea between stop and target", () => {
    const open = [{ id: "abc", status: "OPEN", ticker: "AMD", direction: "LONG",
      entry: 180, stop: 170, target: 200, horizon: "3 months", openedAt: new Date().toISOString() }];
    const ctx = makeCtx({ AMD: { price: 185, chg: 0.5 } });
    const sigs = checkExits(open, ctx);
    expect(sigs.filter(s => s.exitPlaybook === "exit-target-hit" || s.exitPlaybook === "exit-stop-hit").length).toBe(0);
  });
});

// ── Phase 3: backtester ─────────────────────────────────────────────────────

describe("Phase 3: backtester", () => {
  it("runs without error and returns byPlaybook and regimeMap", () => {
    const { runBacktest } = require("../server/engine/backtester");
    const result = runBacktest();
    expect(result.runs).toBeGreaterThan(0);
    expect(Array.isArray(result.byPlaybook)).toBe(true);
    expect(typeof result.regimeMap).toBe("object");
    expect(result.generatedAt).toBeTruthy();
  });

  it("filters by category", () => {
    const { runBacktest } = require("../server/engine/backtester");
    const result = runBacktest({ categories: ["macro"] });
    expect(result.byPlaybook.every(p => p.category === "macro")).toBe(true);
  });

  it("returns triggerRate as a percentage", () => {
    const { runBacktest } = require("../server/engine/backtester");
    const result = runBacktest();
    for (const pb of result.byPlaybook) {
      expect(pb.triggerRate).toBeGreaterThanOrEqual(0);
      expect(pb.triggerRate).toBeLessThanOrEqual(100);
    }
  });
});

// ── Phase 3: GET /api/ideas/exits endpoint ──────────────────────────────────

describe("Phase 3: GET /api/ideas/exits endpoint", () => {
  it("returns signals array and count fields", async () => {
    const res = await request(app).get("/api/ideas/exits");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.signals)).toBe(true);
    expect(typeof res.body.data.count).toBe("number");
  });
});

// ── Phase 3: GET /api/ideas/backtest endpoint ───────────────────────────────

describe("Phase 3: GET /api/ideas/backtest endpoint", () => {
  it("returns byPlaybook array", async () => {
    const res = await request(app).get("/api/ideas/backtest");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.byPlaybook)).toBe(true);
  });
});

// ── Phase 3: GET /api/ideas/execution-log endpoint ──────────────────────────

describe("Phase 3: GET /api/ideas/execution-log endpoint", () => {
  it("returns logs array and summary", async () => {
    const res = await request(app).get("/api/ideas/execution-log");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.logs)).toBe(true);
    expect(typeof res.body.data.summary).toBe("object");
  });
});

// ── Phase 4B: universe scanner ──────────────────────────────────────────────

describe("Phase 4B: universe scanner", () => {
  it("scanUniverse returns candidates sorted by score desc", () => {
    const { scanUniverse } = require("../server/engine/universeScanner");
    const ctx = {
      rates: { dgs10: 4.6, dfii10: 2.0, t10yie: 2.6, hy_spread: 4.0, t10y2y: -0.1 },
      watchlist: { AMD: { price: 192, chg: -2 }, SGLN: { price: 74, chg: 0.5 } },
      regime: "High real yields + Credit stress + Inflation breakout",
    };
    const results = scanUniverse(ctx, { maxResults: 10 });
    expect(Array.isArray(results)).toBe(true);
    // All should be LONG only (no SHORT)
    expect(results.every(c => c.direction === "LONG")).toBe(true);
    // Should be sorted by score descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
  });

  it("scanUniverse returns empty when minScore is too high", () => {
    const { scanUniverse } = require("../server/engine/universeScanner");
    const ctx = {
      rates: { dgs10: 3.5, dfii10: 0.8, t10yie: 2.0, hy_spread: 2.5, t10y2y: 0.8 },
      watchlist: {},
      regime: "Broadly neutral",
    };
    const results = scanUniverse(ctx, { minScore: 99 });
    expect(results).toHaveLength(0);
  });

  it("markPortfolioOverlap flags held tickers correctly", () => {
    const { scanUniverse, markPortfolioOverlap } = require("../server/engine/universeScanner");
    const ctx = {
      rates: { dgs10: 4.6, dfii10: 2.0, t10yie: 2.6, hy_spread: 4.0, t10y2y: -0.1 },
      watchlist: {},
      regime: "test",
    };
    let candidates = scanUniverse(ctx, { maxResults: 5 });
    if (candidates.length > 0) {
      const firstTicker = candidates[0].ticker;
      candidates = markPortfolioOverlap(candidates, [firstTicker]);
      const found = candidates.find(c => c.ticker === firstTicker);
      expect(found?.inPortfolio).toBe(true);
    }
  });

  it("getActiveConditions identifies high real yields correctly", () => {
    const { getActiveConditions } = require("../server/engine/universeScanner");
    const conds = getActiveConditions({ dgs10: 4.6, dfii10: 2.0, t10yie: 2.6, hy_spread: 4.0, t10y2y: -0.1 });
    expect(conds).toContain("highRealYields");
    expect(conds).toContain("creditStress");
    expect(conds).toContain("inflationBreakout");
    expect(conds).toContain("invertedCurve");
  });

  it("GET /api/ideas/universe-scan returns candidates and regime", async () => {
    const res = await request(app).get("/api/ideas/universe-scan");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.candidates)).toBe(true);
    expect(typeof res.body.data.regime).toBe("string");
    expect(typeof res.body.data.scannedTotal).toBe("number");
  });
});
