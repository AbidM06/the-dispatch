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
 *   - /api/health returns all key flags including budget status
 *   - /api/explain/:ticker returns structured AI explanation
 *   - LOW_COST_MODE=true returns deterministic narrative without calling AI
 *   - Budget exhaustion (BUDGET_DAILY) falls back to deterministic narrative
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
  getSnapshots:   jest.fn(),
  getTnxYield:    jest.fn().mockResolvedValue(null),                         // null = graceful no-op, FRED value kept
  getVolSurface:  jest.fn().mockResolvedValue({ vix3m: null, skew: null }), // null = no vol data, omitted from prompt
  POLYGON_PEERS:  new Set(["NVDA", "MSFT", "TSLA", "MU", "AMAT", "LRCX"]),
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
  // Still used by explain route
  fetchTickerExplain:  jest.fn(),
  // Used by pitch route
  generatePitch:       jest.fn(),
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
// /api/pitch/:ticker
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/pitch/:ticker", () => {
  const samplePitch = (ticker = "AMD") => ({
    ticker,
    companyName:  "Advanced Micro Devices, Inc.",
    direction:    "OVERWEIGHT",
    priceTarget:  220,
    currentPrice: 192,
    timeframe:    "Dec-27",
    upsidePct:    14.6,
    conclusion:   `We are pitching ${ticker} as overweight with a Dec-27 price target of $220 at 14.6% upside.`,
    scene:        "AMD designs CPUs and GPUs across client, datacenter, and gaming segments…",
    thesis:       "We see upside to consensus EPS through above-street datacenter GPU growth…",
    catalyst:     "AMD reports Q1 earnings on Apr 22; guidance above $9.8B would validate the thesis.",
    risks: [
      { risk: "NVDA maintains share lead in AI accelerators.", mitigation: "Size position modestly." },
      { risk: "Macro slowdown hits PC/datacenter capex.", mitigation: "Pair with a defensive hedge." },
    ],
    hedge:      "Hedge with a small SOXS position or NVDA pairs trade.",
    confidence: 72,
  });

  test("returns AI pitch for valid ticker", async () => {
    anthropicMock.generatePitch.mockResolvedValue(samplePitch("AMD"));

    const res = await request(app).post("/api/pitch/AMD").send({});
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("live");
    expect(res.body.data.ticker).toBe("AMD");
    expect(res.body.data.direction).toBe("OVERWEIGHT");
    expect(res.body.data.risks.length).toBe(2);
    expect(anthropicMock.generatePitch).toHaveBeenCalledWith("AMD", "");
  });

  test("returns graceful error payload when AI fails — no 500", async () => {
    anthropicMock.generatePitch.mockRejectedValue(new Error("AI unavailable"));

    const res = await request(app).post("/api/pitch/AMD").send({});
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("error");
    expect(res.body.data.ticker).toBe("AMD");
    expect(res.body.data.confidence).toBe(0);
    expect(res.body._error).toBeDefined();
  });

  test("second request for same ticker is served from cache (AI called only once)", async () => {
    anthropicMock.generatePitch.mockResolvedValue(samplePitch("NVDA"));

    await request(app).post("/api/pitch/NVDA").send({});
    const res2 = await request(app).post("/api/pitch/NVDA").send({});

    expect(anthropicMock.generatePitch).toHaveBeenCalledTimes(1);
    expect(res2.body.source).toBe("cache");
  });

  test("ticker is uppercased regardless of URL casing", async () => {
    anthropicMock.generatePitch.mockResolvedValue(samplePitch("AMD"));

    const res = await request(app).post("/api/pitch/amd").send({});
    expect(res.status).toBe(200);
    expect(anthropicMock.generatePitch).toHaveBeenCalledWith("AMD", "");
  });

  test("different tickers are cached independently", async () => {
    anthropicMock.generatePitch.mockImplementation((ticker) => Promise.resolve(samplePitch(ticker)));

    await request(app).post("/api/pitch/AMD").send({});
    await request(app).post("/api/pitch/NVDA").send({});

    expect(anthropicMock.generatePitch).toHaveBeenCalledTimes(2);
  });

  test("context-bearing requests always go live, bypassing cache", async () => {
    anthropicMock.generatePitch.mockImplementation((ticker, ctx) => Promise.resolve(samplePitch(ticker)));

    await request(app).post("/api/pitch/AMD").send({});                                  // populates cache
    await request(app).post("/api/pitch/AMD").send({ context: "focus on datacenter GPUs" }); // bypasses cache

    expect(anthropicMock.generatePitch).toHaveBeenCalledTimes(2);
    expect(anthropicMock.generatePitch).toHaveBeenLastCalledWith("AMD", "focus on datacenter GPUs");
  });

  test("force=true bypasses cache for a fresh call", async () => {
    anthropicMock.generatePitch.mockResolvedValue(samplePitch("AMD"));

    await request(app).post("/api/pitch/AMD").send({});
    await request(app).post("/api/pitch/AMD?force=true").send({});

    expect(anthropicMock.generatePitch).toHaveBeenCalledTimes(2);
  });

  test("LOW_COST_MODE=true returns source: error without calling AI", async () => {
    process.env.LOW_COST_MODE = "true";

    const res = await request(app).post("/api/pitch/AMD").send({});
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("error");
    expect(res.body._note).toMatch(/LOW_COST_MODE/);
    expect(anthropicMock.generatePitch).not.toHaveBeenCalled();
  });

  test("active API fallback returns source: error without calling AI", async () => {
    budget.setApiFallback(60_000 * 60);

    const res = await request(app).post("/api/pitch/AMD").send({});
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("error");
    expect(res.body._note).toMatch(/fallback/i);
    expect(anthropicMock.generatePitch).not.toHaveBeenCalled();
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
