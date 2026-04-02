/**
 * tests/endpoints.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * API contract tests using supertest.
 * All provider modules are mocked — tests never hit real APIs.
 *
 * Tests verify:
 *   - Routes return 200 with correct envelope shape (source, fetchedAt, stale, data)
 *   - GET endpoints return seeded data when cache is empty
 *   - POST /refresh endpoints call fetchAllAnalysis (merged) and return updated data
 *   - Cooldown guard returns cache/seed instead of calling AI within cooldown period
 *   - POST /events/refresh populates risk cache as side-effect (and vice versa)
 *   - /api/portfolio costGBP_ = shares × avg cost per share (correctness fix)
 *   - /api/portfolio T212 snapshot costGBP_total used directly when snapshot present
 *   - /api/portfolio analystMetrics are present and numerically valid
 *   - /api/scenario returns non-zero impacts (scenario engine fix)
 *   - /api/scenario/custom returns per-factor decomposition (Phase 5)
 *   - /api/health returns all key flags including budget status
 *   - /api/explain/:ticker returns structured AI explanation
 *   - LOW_COST_MODE=true returns deterministic narrative without calling AI
 *   - Budget exhaustion (BUDGET_DAILY) falls back to deterministic narrative
 *   - /api/import routes accept CSV, persist snapshot, bust portfolio cache
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const request = require("supertest");

// ── Mock all external providers before loading the app ────────────────────────
jest.mock("../server/providers/fred", () => ({
  getAllRates:      jest.fn(),
  getRecentHistory: jest.fn(),
}));
jest.mock("../server/providers/alphaVantage", () => ({
  getQuotes:    jest.fn(),
  getFxRate:    jest.fn(),
  getQuote:     jest.fn(),
  // AV_SUPPORTED now only AMD — portfolio.js uses this to filter USD tickers
  AV_SUPPORTED: new Set(["AMD"]),
  _getBudget:   jest.fn(() => ({ date: null, count: 0, limit: 20 })),
  _resetBudget: jest.fn(),
}));
jest.mock("../server/providers/polygon", () => ({
  getSnapshots:  jest.fn(),
  POLYGON_PEERS: new Set(["NVDA", "MSFT", "TSLA", "MU", "AMAT", "LRCX"]),
}));
jest.mock("../server/providers/anthropic", () => ({
  // Phase 2b: events and risk routes now use fetchAllAnalysis (merged call)
  fetchAllAnalysis:    jest.fn(),
  // Legacy — kept in mock for backward compat but routes no longer call them
  fetchMarketEvents:   jest.fn(),
  fetchEconAnalysis:   jest.fn(),
  fetchRiskScores:     jest.fn(),
  // Deprecated
  fetchWatchlistPrices: jest.fn(),
  // Still used by explain and thesis routes
  fetchTickerExplain:  jest.fn(),
  evaluateThesis:      jest.fn(),
}));
// T212 importer — mocked so tests never touch the filesystem
jest.mock("../server/importers/t212", () => ({
  parseCsv:     jest.fn(),
  loadSnapshot: jest.fn(),
  saveSnapshot: jest.fn(),
}));
// Finnhub — mocked so news routes don't make real HTTP calls
jest.mock("../server/providers/finnhub", () => ({
  getMarketNews:      jest.fn().mockResolvedValue([]),
  getCompanyNews:     jest.fn().mockResolvedValue([]),
  getEarningsCalendar: jest.fn().mockResolvedValue([]),
  getEconomicCalendar: jest.fn().mockResolvedValue([]),
  getNewsSentiment:   jest.fn().mockResolvedValue(null),
  isConfigured:       jest.fn().mockReturnValue(false),
  TTL_NEWS_MS:        30 * 60 * 1000,
  TTL_CALENDAR_MS:    60 * 60 * 1000,
}));

// ── Module imports (after mocks) ──────────────────────────────────────────────
const fredMock      = require("../server/providers/fred");
const avMock        = require("../server/providers/alphaVantage");
const polyMock      = require("../server/providers/polygon");
const anthropicMock = require("../server/providers/anthropic");
const t212Mock      = require("../server/importers/t212");
const cache         = require("../server/cache");
const budget        = require("../server/providers/budget");
const seeds         = require("../seeds/fallback");

// ── Load app once ──────────────────────────────────────────────────────────────
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
  t212Mock.loadSnapshot.mockReturnValue(null); // default: no T212 snapshot on disk
  budget._reset();                             // reset AI call counters
  delete process.env.LOW_COST_MODE;            // ensure full-AI mode by default
});

afterAll(() => {
  delete process.env.LOW_COST_MODE;
});

// ── Shared fixture helpers ────────────────────────────────────────────────────

/** Build a complete fetchAllAnalysis mock response and register it. */
function mockAllAnalysis(overrides = {}) {
  const events = overrides.events ?? [
    { headline: "Test Event", impact: "BULLISH", ticker: "AMD", date: "2026-03-09", detail: "test detail" },
  ];
  const risks = overrides.risks ?? Array.from({ length: 7 }, (_, i) => ({
    id: i + 1, title: `Risk ${i + 1}`, level: "MEDIUM", score: 50,
    date: "2026-03-09", detail: "test detail.", affects: "ALL",
  }));
  const econ = overrides.econ ?? [
    { id: 1, label: "MACRO THEME",      color: "#c8392b", bg: "rgba(200,57,43,.08)", border: "rgba(200,57,43,.2)", date: "2026-03-09", title: "T1", body: "B1." },
    { id: 2, label: "RATES ANALYSIS",   color: "#1a3a5c", bg: "rgba(26,58,92,.15)",  border: "rgba(88,166,255,.2)", date: "2026-03-09", title: "T2", body: "B2." },
    { id: 3, label: "EQUITY DEEP DIVE", color: "#2c6e49", bg: "rgba(44,110,73,.08)", border: "rgba(63,185,80,.2)",  date: "2026-03-09", title: "T3", body: "B3." },
  ];
  anthropicMock.fetchAllAnalysis.mockResolvedValue({ events, risks, econ });
  return { events, risks, econ };
}

/** Build a realistic T212 snapshot fixture. */
function makeT212Snapshot(overrides = {}) {
  return {
    importedAt:       overrides.importedAt ?? "2026-03-09T22:34:23.077Z",
    usdgbpAtImport:   overrides.usdgbp ?? 0.7921,
    totalInvestedGBP: overrides.totalInvestedGBP ?? 409.44,
    totalValueGBP:    overrides.totalValueGBP    ?? 409.73,
    positions: overrides.positions ?? [
      {
        ticker:                 "AMD",
        name:                   "Advanced Micro Devices",
        shares:                 1.9366,
        currency:               "USD",
        costGBP_total:          156.31,   // ← used directly as cost basis
        snapshotValueGBP_total: 148.23,
        snapshotPriceNative:     96.44,   // back-calculated USD price
      },
      {
        ticker:                 "HIES",
        name:                   "iShares MSCI EM UCITS ETF",
        shares:                 100,
        currency:               "GBP",
        costGBP_total:          253.13,
        snapshotValueGBP_total: 261.50,
        snapshotPriceNative:      2.615,
      },
    ],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// /api/health
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /api/health", () => {
  test("returns 200 with status ok and env flags", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.env).toBeDefined();
    expect(typeof res.body.env.anthropic).toBe("boolean");
    expect(typeof res.body.uptime).toBe("number");
  });

  test("includes budget status with daily/monthly usage (Phase 1 hardening)", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.budget).toBeDefined();
    // Shape check: daily and monthly tracking objects present with usage counters
    expect(typeof res.body.budget.daily).toBe("object");
    expect(typeof res.body.budget.monthly).toBe("object");
    // .used is always a number (call counter starts at 0)
    expect(typeof res.body.budget.daily.used).toBe("number");
    expect(typeof res.body.budget.monthly.used).toBe("number");
    // .cap may serialise as null in JSON when env var is unset (NaN → null in JSON.stringify)
    // just confirm the key is present
    expect("cap" in res.body.budget.daily).toBe(true);
    expect("cap" in res.body.budget.monthly).toBe(true);
  });

  test("lowCostMode flag reflects LOW_COST_MODE env var", async () => {
    process.env.LOW_COST_MODE = "true";
    const res = await request(app).get("/api/health");
    expect(res.body.lowCostMode).toBe(true);
    delete process.env.LOW_COST_MODE;

    cache.clear();
    const res2 = await request(app).get("/api/health");
    expect(res2.body.lowCostMode).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/snapshot  (AV for AMD + FX, Polygon for peers)
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /api/snapshot", () => {
  test("returns envelope + data shape when live providers succeed", async () => {
    fredMock.getAllRates.mockResolvedValue({
      dgs10:     { seriesId: "DGS10",        value: 4.13, date: "2026-03-05", source: "FRED" },
      dfii10:    { seriesId: "DFII10",       value: 1.82, date: "2026-03-05", source: "FRED" },
      t10yie:    { seriesId: "T10YIE",       value: 2.35, date: "2026-03-05", source: "FRED" },
      hy_spread: { seriesId: "BAMLH0A0HYM2", value: 3.00, date: "2026-03-06", source: "FRED" },
      t10y2y:    { seriesId: "T10Y2Y",       value: 0.59, date: "2026-03-06", source: "FRED" },
    });
    fredMock.getRecentHistory.mockResolvedValue({
      seriesId: "DGS10",
      observations: [{ date: "2026-03-05", value: 4.13 }],
      source: "FRED",
    });
    // AV now only returns AMD quote
    avMock.getQuotes.mockResolvedValue([{
      sym: "AMD", price: 192.43, chgPct: -3.52, volume: 5_000_000,
      latestTradingDay: "2026-03-06", source: "Alpha Vantage",
    }]);
    avMock.getFxRate.mockResolvedValue({
      rate: 0.7921, fromCurrency: "USD", toCurrency: "GBP",
      lastRefreshed: "2026-03-07", source: "Alpha Vantage",
    });
    // Polygon returns peers in one batch call
    polyMock.getSnapshots.mockResolvedValue([
      { sym: "NVDA", price: 175.00, chg: -2.00, chgPct: -1.13, volume: 4_000_000, source: "Polygon.io", date: "2026-03-06" },
      { sym: "MSFT", price: 405.00, chg:  1.00, chgPct:  0.25, volume: 3_000_000, source: "Polygon.io", date: "2026-03-06" },
    ]);

    const res = await request(app).get("/api/snapshot");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      source:    expect.stringMatching(/live|cache|seeded/),
      fetchedAt: expect.any(String),
      stale:     expect.any(Boolean),
      data:      expect.any(Object),
    });
    expect(res.body.data.rates).toBeDefined();
    expect(res.body.data.fx).toBeDefined();
    expect(res.body.data.watchlist).toBeInstanceOf(Array);
    // Watchlist should contain AMD (from AV) and peers (from Polygon)
    const syms = res.body.data.watchlist.map(w => w.sym);
    expect(syms).toContain("AMD");
  });

  test("falls back to seeded data when all providers fail", async () => {
    fredMock.getAllRates.mockRejectedValue(new Error("FRED down"));
    fredMock.getRecentHistory.mockRejectedValue(new Error("FRED down"));
    avMock.getQuotes.mockRejectedValue(new Error("AV down"));
    avMock.getFxRate.mockRejectedValue(new Error("AV down"));
    polyMock.getSnapshots.mockRejectedValue(new Error("Polygon down"));

    const res = await request(app).get("/api/snapshot");
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.stale).toBe(true);
  });

  test("watchlist merges AV (AMD) and Polygon (peers) correctly", async () => {
    fredMock.getAllRates.mockResolvedValue({
      dgs10: { seriesId: "DGS10", value: 4.13, date: "2026-03-05", source: "FRED" },
      dfii10: { seriesId: "DFII10", value: 1.82, date: "2026-03-05", source: "FRED" },
      t10yie: { seriesId: "T10YIE", value: 2.35, date: "2026-03-05", source: "FRED" },
      hy_spread: { seriesId: "BAMLH0A0HYM2", value: 3.00, date: "2026-03-06", source: "FRED" },
      t10y2y: { seriesId: "T10Y2Y", value: 0.59, date: "2026-03-06", source: "FRED" },
    });
    fredMock.getRecentHistory.mockResolvedValue({
      seriesId: "DGS10", observations: [{ date: "2026-03-05", value: 4.13 }], source: "FRED",
    });
    avMock.getQuotes.mockResolvedValue([{
      sym: "AMD", price: 192.43, chgPct: -3.52, volume: 5_000_000,
      latestTradingDay: "2026-03-06", source: "Alpha Vantage",
    }]);
    avMock.getFxRate.mockResolvedValue({
      rate: 0.7921, fromCurrency: "USD", toCurrency: "GBP",
      lastRefreshed: "2026-03-07", source: "Alpha Vantage",
    });
    polyMock.getSnapshots.mockResolvedValue([
      { sym: "NVDA", price: 175.00, chg: -2.00, chgPct: -1.13, volume: 4_000_000, source: "Polygon.io", date: "2026-03-06" },
    ]);

    const res = await request(app).get("/api/snapshot");
    expect(res.status).toBe(200);
    const wl = res.body.data.watchlist;
    const amd = wl.find(w => w.sym === "AMD");
    const nvda = wl.find(w => w.sym === "NVDA");
    expect(amd).toMatchObject({ sym: "AMD", price: 192.43, source: "Alpha Vantage" });
    expect(nvda).toMatchObject({ sym: "NVDA", price: 175.00, source: "Polygon.io" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/snapshot/prefetch
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/snapshot/prefetch", () => {
  test("returns prefetched:true with source info when providers succeed", async () => {
    avMock.getFxRate.mockResolvedValue({
      rate: 0.7921, fromCurrency: "USD", toCurrency: "GBP",
      lastRefreshed: "2026-03-07", source: "Alpha Vantage",
    });
    avMock.getQuotes.mockResolvedValue([{
      sym: "AMD", price: 192.43, chgPct: -3.52, volume: 5_000_000,
      latestTradingDay: "2026-03-06", source: "Alpha Vantage",
    }]);
    polyMock.getSnapshots.mockResolvedValue([
      { sym: "NVDA", price: 175.00, chg: -2.00, chgPct: -1.13, volume: 4_000_000, source: "Polygon.io", date: "2026-03-06" },
    ]);

    const res = await request(app).post("/api/snapshot/prefetch");
    expect(res.status).toBe(200);
    expect(res.body.prefetched).toBe(true);
    expect(res.body.fetchedAt).toBeDefined();
    expect(res.body.fx.source).toMatch(/live|cache|seeded/);
    expect(res.body.watchlist.source).toMatch(/live|cache|seeded/);
  });

  test("prefetch still returns 200 when providers fail (falls to seed)", async () => {
    avMock.getFxRate.mockRejectedValue(new Error("AV down"));
    avMock.getQuotes.mockRejectedValue(new Error("AV down"));
    polyMock.getSnapshots.mockRejectedValue(new Error("Polygon down"));

    const res = await request(app).post("/api/snapshot/prefetch");
    expect(res.status).toBe(200);
    expect(res.body.prefetched).toBe(true);
    expect(res.body.watchlist.source).toBe("seeded");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/portfolio — correctness (Phase 1a fix) + T212 snapshot (Phase 2)
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /api/portfolio", () => {
  test("returns portfolio rows with P&L fields", async () => {
    avMock.getQuote.mockImplementation(async (sym) => ({
      sym, price: 100, chgPct: 1.0, volume: 1_000_000,
      latestTradingDay: "2026-03-06", source: "Alpha Vantage",
    }));
    avMock.getFxRate.mockResolvedValue({
      rate: 0.79, fromCurrency: "USD", toCurrency: "GBP",
      lastRefreshed: "2026-03-06", source: "Alpha Vantage",
    });

    const res = await request(app).get("/api/portfolio");
    expect(res.status).toBe(200);
    expect(res.body.data.rows).toBeInstanceOf(Array);
    expect(res.body.data.rows.length).toBeGreaterThan(0);
    expect(typeof res.body.data.totalGBP).toBe("number");
    expect(typeof res.body.data.totalPnL).toBe("number");
    expect(res.body.data.betas).toBeDefined();
    expect(res.body.data.scenarios).toBeInstanceOf(Array);
  });

  test("costGBP_ = shares × avg_cost_per_share (correctness fix for total cost basis)", async () => {
    // Force seed fallback so math is deterministic
    avMock.getQuote.mockRejectedValue(new Error("AV down"));
    avMock.getFxRate.mockRejectedValue(new Error("AV down"));

    const res = await request(app).get("/api/portfolio");
    expect(res.status).toBe(200);

    const usdgbp = res.body.data.usdgbp;
    expect(typeof usdgbp).toBe("number");
    expect(usdgbp).toBeGreaterThan(0);

    for (const row of res.body.data.rows) {
      const pos = seeds.POSITIONS_SEED.find(p => p.ticker === row.ticker);
      if (!pos) continue;

      const expectedCost = pos.currency === "USD"
        ? pos.shares * pos.costUSD * usdgbp   // total USD cost → GBP
        : pos.shares * pos.costGBP;            // total GBP cost

      // Allow 0.5% tolerance for floating point / FX rounding
      const relativeDiff = Math.abs(row.costGBP_ - expectedCost) / (expectedCost || 1);
      expect(relativeDiff).toBeLessThan(0.005);
    }
  });

  test("pnlGBP = valGBP − costGBP_ for each row", async () => {
    avMock.getQuote.mockRejectedValue(new Error("AV down"));
    avMock.getFxRate.mockRejectedValue(new Error("AV down"));

    const res = await request(app).get("/api/portfolio");
    for (const row of res.body.data.rows) {
      const expectedPnL = +(row.valGBP - row.costGBP_).toFixed(2);
      expect(Math.abs(row.pnlGBP - expectedPnL)).toBeLessThan(0.02); // £0.02 tolerance
    }
  });

  test("analystMetrics are present with valid HHI (0–10000) and beta", async () => {
    avMock.getQuote.mockRejectedValue(new Error("AV down"));
    avMock.getFxRate.mockRejectedValue(new Error("AV down"));

    const res = await request(app).get("/api/portfolio");
    const m = res.body.data.analystMetrics;

    expect(m).toBeDefined();
    expect(typeof m.weightedBeta).toBe("number");
    expect(m.weightedBeta).toBeGreaterThan(0);

    expect(typeof m.hhi).toBe("number");
    expect(m.hhi).toBeGreaterThan(0);
    expect(m.hhi).toBeLessThanOrEqual(10_000);

    expect(typeof m.usdExposurePct).toBe("number");
    expect(m.usdExposurePct).toBeGreaterThanOrEqual(0);
    expect(m.usdExposurePct).toBeLessThanOrEqual(100);

    expect(m.scenarioSensitivity).toBeInstanceOf(Array);
    expect(m.scenarioSensitivity.length).toBeGreaterThan(0);

    expect(typeof m.expectedImpactPct).toBe("number");
  });

  test("returns seeded values when prices are unavailable", async () => {
    avMock.getQuote.mockRejectedValue(new Error("AV down"));
    avMock.getFxRate.mockRejectedValue(new Error("AV down"));

    const res = await request(app).get("/api/portfolio");
    expect(res.status).toBe(200);
    expect(res.body.data.rows).toBeInstanceOf(Array);
    expect(res.body.data.rows.length).toBeGreaterThan(0);
  });

  test("T212 snapshot: costGBP_total used directly as cost basis (Phase 2)", async () => {
    // Mock the snapshot so portfolio.js uses it instead of seeds
    t212Mock.loadSnapshot.mockReturnValue(makeT212Snapshot());
    avMock.getQuote.mockRejectedValue(new Error("AV down"));
    avMock.getFxRate.mockRejectedValue(new Error("AV down"));

    const res = await request(app).get("/api/portfolio");
    expect(res.status).toBe(200);

    const rows = res.body.data.rows;
    expect(rows.length).toBe(2); // AMD + HIES from fixture

    const amd  = rows.find(r => r.ticker === "AMD");
    const hies = rows.find(r => r.ticker === "HIES");

    expect(amd).toBeDefined();
    expect(hies).toBeDefined();

    // costGBP_ should come directly from costGBP_total, not shares × costPerShare
    expect(Math.abs(amd.costGBP_  - 156.31)).toBeLessThan(0.02);
    expect(Math.abs(hies.costGBP_ - 253.13)).toBeLessThan(0.02);
  });

  test("T212 snapshot: loadSnapshot consulted and row count matches snapshot positions", async () => {
    // snapshotMeta is added to portfolioData but stripped by Zod on schema validation.
    // Instead verify loadSnapshot was called and the row count matches the fixture.
    t212Mock.loadSnapshot.mockReturnValue(makeT212Snapshot());
    avMock.getQuote.mockRejectedValue(new Error("AV down"));
    avMock.getFxRate.mockRejectedValue(new Error("AV down"));

    const res = await request(app).get("/api/portfolio");
    expect(res.status).toBe(200);
    expect(t212Mock.loadSnapshot).toHaveBeenCalled();
    // Fixture has 2 positions: AMD + HIES
    expect(res.body.data.rows.length).toBe(2);
    expect(res.body.data.rows.map(r => r.ticker).sort()).toEqual(["AMD", "HIES"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/scenario — math correctness (Phase 1b fix) + per-factor (Phase 5)
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /api/scenario", () => {
  test("named scenarios have non-zero totalImpactGBP (scenario engine fix)", async () => {
    const res = await request(app).get("/api/scenario");
    expect(res.status).toBe(200);

    const scenarios = res.body.data?.scenarios ?? [];
    expect(scenarios.length).toBeGreaterThan(0);

    // At least one scenario (bear) should have a meaningful negative impact
    const hasNonZero = scenarios.some(s => Math.abs(s.impact?.totalImpactGBP ?? 0) > 1);
    expect(hasNonZero).toBe(true);
  });

  test("scenario impact rows sum to totalImpactGBP", async () => {
    const res = await request(app).get("/api/scenario");
    expect(res.status).toBe(200);

    for (const sc of res.body.data?.scenarios ?? []) {
      const rowSum = (sc.impact?.rows ?? []).reduce((s, r) => s + (r.impactGBP ?? 0), 0);
      const diff   = Math.abs(rowSum - (sc.impact?.totalImpactGBP ?? 0));
      expect(diff).toBeLessThan(0.05); // £0.05 rounding tolerance
    }
  });

  test("POST /scenario/custom returns computed result with non-zero impact for -10% equity shock", async () => {
    const res = await request(app)
      .post("/api/scenario/custom")
      .send({ equityMktDelta: -0.10, ratesDelta: 0, fxDelta: 0 });

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("computed");
    expect(res.body.data.impact.totalImpactGBP).toBeLessThan(-1); // meaningful negative impact
    expect(res.body.data.impact.impactPct).toBeLessThan(0);
  });

  test("POST /scenario/custom validates bounds — equityMktDelta > 1 is rejected", async () => {
    const res = await request(app)
      .post("/api/scenario/custom")
      .send({ equityMktDelta: 5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test("POST /scenario/custom returns per-factor decomposition per position (Phase 5)", async () => {
    const res = await request(app)
      .post("/api/scenario/custom")
      .send({ equityMktDelta: -0.10, ratesDelta: 50, fxDelta: -0.05 });

    expect(res.status).toBe(200);
    expect(res.body.data.impact.rows).toBeInstanceOf(Array);
    expect(res.body.data.impact.rows.length).toBeGreaterThan(0);

    for (const row of res.body.data.impact.rows) {
      expect(typeof row.equityImpactGBP).toBe("number");
      expect(typeof row.ratesImpactGBP).toBe("number");
      expect(typeof row.fxImpactGBP).toBe("number");
      expect(typeof row.totalImpactGBP).toBe("number");

      // Sum of factor impacts should equal totalImpactGBP (within rounding)
      const factorSum = row.equityImpactGBP + row.ratesImpactGBP + row.fxImpactGBP;
      expect(Math.abs(factorSum - row.totalImpactGBP)).toBeLessThan(0.02);
    }
  });

  test("POST /scenario/custom returns portfolio-level factor totals (Phase 5)", async () => {
    const res = await request(app)
      .post("/api/scenario/custom")
      .send({ equityMktDelta: -0.10, ratesDelta: 50, fxDelta: -0.05 });

    const impact = res.body.data.impact;
    expect(typeof impact.totalEquityImpact).toBe("number");
    expect(typeof impact.totalRatesImpact).toBe("number");
    expect(typeof impact.totalFxImpact).toBe("number");
    expect(typeof impact.totalImpactGBP).toBe("number");

    // Verify portfolio-level totals are consistent with row sums
    const rowEquitySum = impact.rows.reduce((s, r) => s + r.equityImpactGBP, 0);
    const rowRatesSum  = impact.rows.reduce((s, r) => s + r.ratesImpactGBP,  0);
    const rowFxSum     = impact.rows.reduce((s, r) => s + r.fxImpactGBP,     0);

    expect(Math.abs(rowEquitySum - impact.totalEquityImpact)).toBeLessThan(0.05);
    expect(Math.abs(rowRatesSum  - impact.totalRatesImpact)).toBeLessThan(0.05);
    expect(Math.abs(rowFxSum     - impact.totalFxImpact)).toBeLessThan(0.05);
  });

  test("POST /scenario/custom includes assumptions object (Phase 5)", async () => {
    const res = await request(app)
      .post("/api/scenario/custom")
      .send({ equityMktDelta: 0, ratesDelta: 0, fxDelta: 0 });

    expect(res.body.data.assumptions).toBeDefined();
    expect(res.body.data.assumptions.betas).toBeDefined();
    expect(res.body.data.assumptions.rateDurations).toBeDefined();
    expect(typeof res.body.data.assumptions.note).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/risk — Phase 2b + Phase 1 (LOW_COST_MODE, budget exhaustion, cooldown)
// ─────────────────────────────────────────────────────────────────────────────
describe("/api/risk", () => {
  test("GET returns seeded risks with stale:true when cache is empty", async () => {
    const res = await request(app).get("/api/risk");
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("seeded");
    expect(res.body.stale).toBe(true);
    expect(res.body.data.risks).toBeInstanceOf(Array);
    expect(res.body.data.risks.length).toBe(7);
  });

  test("POST /refresh calls fetchAllAnalysis once (merged call)", async () => {
    mockAllAnalysis();

    const res = await request(app).post("/api/risk/refresh").send({ force: true });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("live");
    expect(res.body.data.risks).toHaveLength(7);
    // fetchAllAnalysis called exactly once — not fetchRiskScores separately
    expect(anthropicMock.fetchAllAnalysis).toHaveBeenCalledTimes(1);
    expect(anthropicMock.fetchRiskScores).not.toHaveBeenCalled();
  });

  test("GET returns cached risks with source:cache after refresh", async () => {
    mockAllAnalysis();
    await request(app).post("/api/risk/refresh").send({ force: true });

    const res = await request(app).get("/api/risk");
    expect(res.body.source).toBe("cache");
    expect(res.body.stale).toBe(false);
    expect(res.body.data.risks).toHaveLength(7);
  });

  test("POST /refresh also populates events cache as side-effect", async () => {
    mockAllAnalysis();
    await request(app).post("/api/risk/refresh").send({ force: true });

    // GET /events should now be served from cache, not seeds
    const evRes = await request(app).get("/api/events");
    expect(evRes.body.source).toBe("cache");
    expect(evRes.body.stale).toBe(false);
  });

  test("second POST /refresh within cooldown window returns _cooldown flag without calling AI", async () => {
    mockAllAnalysis();
    await request(app).post("/api/risk/refresh").send({ force: true });
    jest.clearAllMocks(); // reset call count; cache is still warm

    const res = await request(app).post("/api/risk/refresh"); // no force
    expect(res.status).toBe(200);
    expect(res.body._cooldown).toBeDefined();
    expect(anthropicMock.fetchAllAnalysis).not.toHaveBeenCalled();
  });

  test("POST /refresh with force:true bypasses cooldown and calls AI again", async () => {
    mockAllAnalysis();
    await request(app).post("/api/risk/refresh").send({ force: true });
    jest.clearAllMocks();
    mockAllAnalysis();

    const res = await request(app).post("/api/risk/refresh").send({ force: true });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("live");
    expect(anthropicMock.fetchAllAnalysis).toHaveBeenCalledTimes(1);
  });

  test("POST /refresh returns fallback payload when AI fails (generic error)", async () => {
    anthropicMock.fetchAllAnalysis.mockRejectedValue(new Error("AI error"));

    const res = await request(app).post("/api/risk/refresh").send({ force: true });
    expect(res.status).toBe(200);
    expect(res.body._refreshError).toBeDefined();
    expect(res.body.data.risks).toBeInstanceOf(Array);
  });

  // ── LOW_COST_MODE tests (Phase 1) ────────────────────────────────────────────

  test("GET returns deterministic narrative when LOW_COST_MODE=true", async () => {
    process.env.LOW_COST_MODE = "true";

    const res = await request(app).get("/api/risk");
    expect(res.status).toBe(200);
    expect(res.body.analysisMode).toBe("deterministic");
    expect(res.body.data.risks).toBeInstanceOf(Array);
    expect(res.body.data.risks.length).toBeGreaterThan(0);
    // Must NOT call AI
    expect(anthropicMock.fetchAllAnalysis).not.toHaveBeenCalled();
  });

  test("POST /refresh returns deterministic narrative when LOW_COST_MODE=true (no AI)", async () => {
    process.env.LOW_COST_MODE = "true";

    const res = await request(app).post("/api/risk/refresh");
    expect(res.status).toBe(200);
    expect(res.body.analysisMode).toBe("deterministic");
    expect(res.body._lowCostMode).toBeDefined();
    expect(anthropicMock.fetchAllAnalysis).not.toHaveBeenCalled();
  });

  test("POST /refresh with force:true in LOW_COST_MODE still calls AI", async () => {
    process.env.LOW_COST_MODE = "true";
    mockAllAnalysis();

    const res = await request(app).post("/api/risk/refresh").send({ force: true });
    expect(res.status).toBe(200);
    expect(anthropicMock.fetchAllAnalysis).toHaveBeenCalledTimes(1);
  });

  // ── Budget exhaustion tests (Phase 1) ────────────────────────────────────────

  test("POST /refresh falls back to deterministic narrative on BUDGET_DAILY error", async () => {
    const budgetErr = new Error("Daily budget exhausted (5/5 calls today).");
    budgetErr.code  = "BUDGET_DAILY";
    anthropicMock.fetchAllAnalysis.mockRejectedValue(budgetErr);

    const res = await request(app).post("/api/risk/refresh").send({ force: true });
    expect(res.status).toBe(200);
    expect(res.body.analysisMode).toBe("deterministic");
    expect(res.body._refreshError).toBeDefined();
    expect(res.body.data.risks).toBeInstanceOf(Array);
    expect(res.body.data.risks.length).toBeGreaterThan(0);
  });

  test("POST /refresh falls back to deterministic narrative on BUDGET_MONTHLY error", async () => {
    const budgetErr = new Error("Monthly budget exhausted (50/50).");
    budgetErr.code  = "BUDGET_MONTHLY";
    anthropicMock.fetchAllAnalysis.mockRejectedValue(budgetErr);

    const res = await request(app).post("/api/risk/refresh").send({ force: true });
    expect(res.status).toBe(200);
    expect(res.body.analysisMode).toBe("deterministic");
    expect(res.body._refreshError).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/events — Phase 2b + Phase 1 (LOW_COST_MODE, budget exhaustion, cooldown)
// ─────────────────────────────────────────────────────────────────────────────
describe("/api/events", () => {
  test("GET returns seeded events when cache is empty", async () => {
    const res = await request(app).get("/api/events");
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("seeded");
    expect(res.body.data.events).toBeInstanceOf(Array);
    expect(res.body.data.econ).toBeInstanceOf(Array);
  });

  test("POST /refresh calls fetchAllAnalysis once (not fetchMarketEvents + fetchEconAnalysis)", async () => {
    const { events } = mockAllAnalysis();

    const res = await request(app).post("/api/events/refresh").send({ force: true });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("live");
    expect(res.body.data.events).toHaveLength(events.length);
    expect(res.body.data.econ).toHaveLength(3);

    // Merged single call
    expect(anthropicMock.fetchAllAnalysis).toHaveBeenCalledTimes(1);
    expect(anthropicMock.fetchMarketEvents).not.toHaveBeenCalled();
    expect(anthropicMock.fetchEconAnalysis).not.toHaveBeenCalled();
  });

  test("POST /events/refresh also populates risk cache as side-effect", async () => {
    mockAllAnalysis();
    await request(app).post("/api/events/refresh").send({ force: true });

    // GET /risk should now be served from cache, not seeds
    const riskRes = await request(app).get("/api/risk");
    expect(riskRes.body.source).toBe("cache");
    expect(riskRes.body.stale).toBe(false);
  });

  test("second POST /refresh within cooldown window returns _cooldown flag without calling AI", async () => {
    mockAllAnalysis();
    await request(app).post("/api/events/refresh").send({ force: true });
    jest.clearAllMocks(); // reset call count; cache still warm

    const res = await request(app).post("/api/events/refresh"); // no force
    expect(res.status).toBe(200);
    expect(res.body._cooldown).toBeDefined();
    expect(anthropicMock.fetchAllAnalysis).not.toHaveBeenCalled();
  });

  test("POST /refresh with force:true bypasses cooldown", async () => {
    mockAllAnalysis();
    await request(app).post("/api/events/refresh").send({ force: true });
    jest.clearAllMocks();
    mockAllAnalysis();

    const res = await request(app).post("/api/events/refresh").send({ force: true });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("live");
    expect(anthropicMock.fetchAllAnalysis).toHaveBeenCalledTimes(1);
  });

  test("POST /refresh returns fallback payload when AI fails (generic error)", async () => {
    anthropicMock.fetchAllAnalysis.mockRejectedValue(new Error("AI error"));

    const res = await request(app).post("/api/events/refresh").send({ force: true });
    expect(res.status).toBe(200);
    expect(res.body._refreshError).toBeDefined();
    expect(res.body.data.events).toBeInstanceOf(Array);
  });

  // ── LOW_COST_MODE tests (Phase 1) ────────────────────────────────────────────

  test("GET returns deterministic narrative when LOW_COST_MODE=true", async () => {
    process.env.LOW_COST_MODE = "true";

    const res = await request(app).get("/api/events");
    expect(res.status).toBe(200);
    expect(res.body.analysisMode).toBe("deterministic");
    expect(res.body.data.events).toBeInstanceOf(Array);
    expect(res.body.data.econ).toBeInstanceOf(Array);
    expect(res.body.data.events.length).toBeGreaterThan(0);
    expect(res.body.data.econ.length).toBeGreaterThan(0);
    expect(anthropicMock.fetchAllAnalysis).not.toHaveBeenCalled();
  });

  test("POST /refresh returns deterministic narrative when LOW_COST_MODE=true (no AI)", async () => {
    process.env.LOW_COST_MODE = "true";

    const res = await request(app).post("/api/events/refresh");
    expect(res.status).toBe(200);
    expect(res.body.analysisMode).toBe("deterministic");
    expect(res.body._lowCostMode).toBeDefined();
    expect(anthropicMock.fetchAllAnalysis).not.toHaveBeenCalled();
  });

  test("POST /refresh with force:true in LOW_COST_MODE still calls AI", async () => {
    process.env.LOW_COST_MODE = "true";
    mockAllAnalysis();

    const res = await request(app).post("/api/events/refresh").send({ force: true });
    expect(res.status).toBe(200);
    expect(anthropicMock.fetchAllAnalysis).toHaveBeenCalledTimes(1);
  });

  // ── Budget exhaustion tests (Phase 1) ────────────────────────────────────────

  test("POST /refresh falls back to deterministic narrative on BUDGET_DAILY error", async () => {
    const budgetErr = new Error("Daily budget exhausted (5/5 calls today).");
    budgetErr.code  = "BUDGET_DAILY";
    anthropicMock.fetchAllAnalysis.mockRejectedValue(budgetErr);

    const res = await request(app).post("/api/events/refresh").send({ force: true });
    expect(res.status).toBe(200);
    expect(res.body.analysisMode).toBe("deterministic");
    expect(res.body._refreshError).toBeDefined();
    expect(res.body.data.events).toBeInstanceOf(Array);
    expect(res.body.data.econ).toBeInstanceOf(Array);
  });

  test("POST /refresh falls back to deterministic narrative on BUDGET_MONTHLY error", async () => {
    const budgetErr = new Error("Monthly budget exhausted.");
    budgetErr.code  = "BUDGET_MONTHLY";
    anthropicMock.fetchAllAnalysis.mockRejectedValue(budgetErr);

    const res = await request(app).post("/api/events/refresh").send({ force: true });
    expect(res.status).toBe(200);
    expect(res.body.analysisMode).toBe("deterministic");
    expect(res.body._refreshError).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/explain/:ticker
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /api/explain/:ticker", () => {
  test("returns AI explanation for valid ticker", async () => {
    anthropicMock.fetchTickerExplain.mockResolvedValue({
      ticker: "AMD",
      what:       "Advanced Micro Devices is a semiconductor company…",
      now:        "AMD is trading at $192 following…",
      portfolio:  "AMD represents a 20% weight…",
      confidence: 85,
    });

    const res = await request(app).get("/api/explain/AMD");
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("live");
    expect(res.body.data.ticker).toBe("AMD");
    expect(res.body.data.confidence).toBe(85);
    expect(res.body.data.what).toBeDefined();
  });

  test("returns graceful error payload when AI fails — no 500", async () => {
    anthropicMock.fetchTickerExplain.mockRejectedValue(new Error("AI unavailable"));

    const res = await request(app).get("/api/explain/DGS10");
    expect(res.status).toBe(200);
    expect(res.body.data.ticker).toBe("DGS10");
    expect(res.body.data.confidence).toBe(0);
    expect(res.body._error).toBeDefined();
  });

  test("second request for same ticker is served from cache (AI called only once)", async () => {
    anthropicMock.fetchTickerExplain.mockResolvedValue({
      ticker: "NVDA", what: "NVIDIA…", now: "…", portfolio: "…", confidence: 90,
    });

    await request(app).get("/api/explain/NVDA");
    await request(app).get("/api/explain/NVDA");

    expect(anthropicMock.fetchTickerExplain).toHaveBeenCalledTimes(1);
  });

  test("ticker is uppercased regardless of URL casing", async () => {
    anthropicMock.fetchTickerExplain.mockResolvedValue({
      ticker: "AMD", what: "…", now: "…", portfolio: "…", confidence: 80,
    });

    const res = await request(app).get("/api/explain/amd");
    expect(res.status).toBe(200);
    expect(anthropicMock.fetchTickerExplain).toHaveBeenCalledWith("AMD");
  });

  test("different tickers are cached independently", async () => {
    anthropicMock.fetchTickerExplain.mockResolvedValue({
      ticker: "HIES", what: "iShares MSCI EM ETF…", now: "…", portfolio: "…", confidence: 75,
    });

    await request(app).get("/api/explain/AMD");    // separate cache key
    await request(app).get("/api/explain/HIES");

    expect(anthropicMock.fetchTickerExplain).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/import — T212 CSV import (Phase 2)
// ─────────────────────────────────────────────────────────────────────────────
describe("/api/import", () => {
  test("GET /status returns hasSnapshot:false when no snapshot on disk", async () => {
    t212Mock.loadSnapshot.mockReturnValue(null);

    const res = await request(app).get("/api/import/status");
    expect(res.status).toBe(200);
    expect(res.body.hasSnapshot).toBe(false);
    expect(res.body.snapshot).toBeNull();
  });

  test("GET /status returns metadata when snapshot exists", async () => {
    t212Mock.loadSnapshot.mockReturnValue(makeT212Snapshot());

    const res = await request(app).get("/api/import/status");
    expect(res.status).toBe(200);
    expect(res.body.hasSnapshot).toBe(true);
    expect(res.body.snapshot.positionCount).toBe(2);
    expect(res.body.snapshot.importedAt).toBe("2026-03-09T22:34:23.077Z");
    expect(Array.isArray(res.body.snapshot.tickers)).toBe(true);
    expect(res.body.snapshot.tickers).toContain("AMD");
  });

  test("POST /t212 with valid JSON body parses CSV and returns position summary", async () => {
    const mockSnapshot = makeT212Snapshot();
    t212Mock.parseCsv.mockReturnValue(mockSnapshot);
    t212Mock.saveSnapshot.mockImplementation(() => {}); // no-op (no FS)

    const csvStr = [
      '"Slice","Name","Invested value","Value","Result","Owned quantity","Dividends gained","Dividends cash","Dividends reinvested"',
      '"AMD","Advanced Micro Devices","156.31","148.23","-8.08","1.9366","0","0","0"',
      '"HIES","iShares MSCI EM UCITS ETF","253.13","261.50","8.37","100","0","0","0"',
    ].join("\n");

    const res = await request(app)
      .post("/api/import/t212")
      .set("Content-Type", "application/json")
      .send({ csv: csvStr, usdgbp: 0.7921 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.positionCount).toBe(2);
    expect(typeof res.body.importedAt).toBe("string");
    expect(t212Mock.parseCsv).toHaveBeenCalled();
    expect(t212Mock.saveSnapshot).toHaveBeenCalled();
  });

  test("POST /t212 returns 400 when parseCsv throws (malformed CSV)", async () => {
    t212Mock.parseCsv.mockImplementation(() => {
      throw new Error("t212.parseCsv: missing expected columns: qty");
    });

    const res = await request(app)
      .post("/api/import/t212")
      .set("Content-Type", "application/json")
      .send({ csv: "bad,csv,data\nno,valid,headers" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("missing expected columns");
  });

  test("POST /t212 returns 400 when JSON body is missing the csv field", async () => {
    const res = await request(app)
      .post("/api/import/t212")
      .set("Content-Type", "application/json")
      .send({ usdgbp: 0.79 }); // no csv field

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test("POST /t212 busts portfolio cache so next GET recomputes from snapshot", async () => {
    // 1. Warm the portfolio cache (using seeds — no snapshot yet)
    avMock.getQuote.mockRejectedValue(new Error("AV down"));
    avMock.getFxRate.mockRejectedValue(new Error("AV down"));
    await request(app).get("/api/portfolio");
    expect(cache.has("portfolio:data")).toBe(true);

    // 2. Import a T212 snapshot — should delete the portfolio cache key
    const mockSnapshot = makeT212Snapshot({
      positions: [{
        ticker: "AMD", name: "AMD", shares: 2, currency: "USD",
        costGBP_total: 200, snapshotValueGBP_total: 190, snapshotPriceNative: 95,
      }],
      totalInvestedGBP: 200, totalValueGBP: 190,
    });
    t212Mock.parseCsv.mockReturnValue(mockSnapshot);
    t212Mock.saveSnapshot.mockImplementation(() => {});

    await request(app)
      .post("/api/import/t212")
      .set("Content-Type", "application/json")
      .send({ csv: "some,csv,data", usdgbp: 0.79 });

    // 3. Portfolio cache should now be busted
    expect(cache.has("portfolio:data")).toBe(false);
  });

  test("POST /t212 returns 415 for unsupported Content-Type", async () => {
    const res = await request(app)
      .post("/api/import/t212")
      .set("Content-Type", "application/xml")
      .send("<csv>not valid</csv>");

    expect(res.status).toBe(415);
    expect(res.body.error).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auto-fallback: API credits exhausted → deterministic → restore when credits back
// ─────────────────────────────────────────────────────────────────────────────
describe("Auto API-credits fallback", () => {
  // Helper: make fetchAllAnalysis throw with a billing error code
  function mockBillingError(message = "Anthropic: Your credit balance is too low.") {
    const err = new Error(message);
    err.code = "API_CREDITS_EXHAUSTED";
    anthropicMock.fetchAllAnalysis.mockRejectedValue(err);
  }

  test("/api/health includes apiFallback status (inactive by default)", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.budget.apiFallback).toBeDefined();
    expect(res.body.budget.apiFallback.active).toBe(false);
    expect(res.body.budget.apiFallback.expiresAt).toBeNull();
  });

  test("POST /events/refresh with billing error → deterministic fallback + _apiFallback info", async () => {
    mockBillingError();

    const res = await request(app).post("/api/events/refresh").send({ force: true });
    expect(res.status).toBe(200);
    expect(res.body.analysisMode).toBe("deterministic");
    expect(res.body._refreshError).toBeDefined();
    expect(res.body.data.events).toBeInstanceOf(Array);
    expect(res.body.data.econ).toBeInstanceOf(Array);
  });

  test("GET /api/events uses deterministic after billing error (auto-fallback active)", async () => {
    // 1. Trigger a billing error on POST /refresh — this sets the fallback flag
    mockBillingError();
    await request(app).post("/api/events/refresh").send({ force: true });
    jest.clearAllMocks();
    cache.clear(); // clear cached deterministic data so GET re-evaluates

    // 2. Next GET should use deterministic WITHOUT calling AI
    const res = await request(app).get("/api/events");
    expect(res.status).toBe(200);
    expect(res.body.analysisMode).toBe("deterministic");
    expect(anthropicMock.fetchAllAnalysis).not.toHaveBeenCalled();
    // _apiFallback info visible on GET
    expect(res.body._apiFallback).toBeDefined();
    expect(res.body._apiFallback.active).toBe(true);
    expect(typeof res.body._apiFallback.retryInMins).toBe("number");
    expect(res.body._apiFallback.expiresAt).not.toBeNull();
  });

  test("POST /events/refresh (no force) uses deterministic while fallback is active", async () => {
    mockBillingError();
    await request(app).post("/api/events/refresh").send({ force: true });
    jest.clearAllMocks();

    const res = await request(app).post("/api/events/refresh"); // no force
    expect(res.status).toBe(200);
    expect(res.body.analysisMode).toBe("deterministic");
    // _apiFallback note present in the response body
    expect(res.body._apiFallback).toBeDefined();
    expect(anthropicMock.fetchAllAnalysis).not.toHaveBeenCalled();
  });

  test("POST /risk/refresh with billing error → deterministic fallback", async () => {
    mockBillingError();

    const res = await request(app).post("/api/risk/refresh").send({ force: true });
    expect(res.status).toBe(200);
    expect(res.body.analysisMode).toBe("deterministic");
    expect(res.body._refreshError).toBeDefined();
    expect(res.body.data.risks).toBeInstanceOf(Array);
  });

  test("GET /api/risk uses deterministic after billing error", async () => {
    // Trigger fallback via risk refresh
    mockBillingError();
    await request(app).post("/api/risk/refresh").send({ force: true });
    jest.clearAllMocks();
    cache.clear();

    const res = await request(app).get("/api/risk");
    expect(res.status).toBe(200);
    expect(res.body.analysisMode).toBe("deterministic");
    expect(anthropicMock.fetchAllAnalysis).not.toHaveBeenCalled();
    expect(res.body._apiFallback.active).toBe(true);
  });

  test("/api/health shows apiFallback active after billing error", async () => {
    mockBillingError();
    await request(app).post("/api/events/refresh").send({ force: true });

    const res = await request(app).get("/api/health");
    expect(res.body.budget.apiFallback.active).toBe(true);
    expect(typeof res.body.budget.apiFallback.retryInMins).toBe("number");
    expect(res.body.budget.apiFallback.expiresAt).not.toBeNull();
  });

  test("successful AI call after fallback clears the fallback flag", async () => {
    // 1. Enter fallback via billing error
    mockBillingError();
    await request(app).post("/api/events/refresh").send({ force: true });

    let health = await request(app).get("/api/health");
    expect(health.body.budget.apiFallback.active).toBe(true);

    // 2. Simulate credits refilled — AI call succeeds
    jest.clearAllMocks();
    mockAllAnalysis();
    await request(app).post("/api/events/refresh").send({ force: true });

    // 3. Fallback should now be cleared
    health = await request(app).get("/api/health");
    expect(health.body.budget.apiFallback.active).toBe(false);
    expect(health.body.budget.apiFallback.expiresAt).toBeNull();
  });
});

// ── Glossary endpoints ──────────────────────────────────────────────────────

describe("Glossary endpoints", () => {
  it("GET /api/glossary returns terms array and categories", async () => {
    const res = await request(app).get("/api/glossary");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.terms)).toBe(true);
    expect(res.body.data.terms.length).toBeGreaterThan(50);
    expect(Array.isArray(res.body.data.categories)).toBe(true);
  });

  it("GET /api/glossary/term-of-the-day returns a term object", async () => {
    const res = await request(app).get("/api/glossary/term-of-the-day");
    expect(res.status).toBe(200);
    expect(res.body.data.term).toBeTruthy();
    expect(res.body.data.term.term).toBeTruthy();
    expect(res.body.data.term.definition).toBeTruthy();
  });

  it("GET /api/glossary/categories returns category list with counts", async () => {
    const res = await request(app).get("/api/glossary/categories");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.categories)).toBe(true);
    const cats = res.body.data.categories.map(c => c.category);
    expect(cats).toContain("macro");
    expect(cats).toContain("islamic");
    expect(cats).toContain("interview");
  });

  it("GET /api/glossary/category/macro returns macro terms", async () => {
    const res = await request(app).get("/api/glossary/category/macro");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.terms)).toBe(true);
    expect(res.body.data.terms.every(t => t.category === "macro")).toBe(true);
  });

  it("GET /api/glossary/category/nonexistent returns 404", async () => {
    const res = await request(app).get("/api/glossary/category/nonexistent");
    expect(res.status).toBe(404);
  });

  it("GET /api/glossary/search?q=yield returns matching terms", async () => {
    const res = await request(app).get("/api/glossary/search?q=yield");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBeGreaterThan(0);
    expect(res.body.data.results[0].term).toBeTruthy();
  });

  it("GET /api/glossary/:slug returns specific term", async () => {
    const res = await request(app).get("/api/glossary/riba");
    expect(res.status).toBe(200);
    expect(res.body.data.term.term).toBe("Riba");
    expect(res.body.data.term.category).toBe("islamic");
    expect(res.body.data.term.definition).toBeTruthy();
  });

  it("GET /api/glossary/:slug returns 404 for unknown term", async () => {
    const res = await request(app).get("/api/glossary/nonexistent-term-xyz");
    expect(res.status).toBe(404);
  });

  it("GET /api/glossary?category=islamic returns only islamic terms", async () => {
    const res = await request(app).get("/api/glossary?category=islamic");
    expect(res.status).toBe(200);
    expect(res.body.data.terms.every(t => t.category === "islamic")).toBe(true);
  });
});
