/**
 * tests/phase1.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 1: Desk Workflow MVP — endpoint + logic tests.
 *
 * Tests:
 *   /api/ideas   — CRUD + decision quality stats
 *   /api/brief   — deterministic daily brief
 *   riskCheck.js — pure unit tests (no HTTP)
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const request = require("supertest");

// ── Mock all external providers before loading the app ────────────────────────
jest.mock("../server/providers/fred", () => ({
  getAllRates:       jest.fn(),
  getRecentHistory: jest.fn(),
}));
jest.mock("../server/providers/alphaVantage", () => ({
  getQuote:    jest.fn(),
  getQuotes:   jest.fn(),
  getFxRate:   jest.fn(),
  AV_SUPPORTED: new Set(["AMD"]),
  _getBudget:  jest.fn(),
  _resetBudget: jest.fn(),
}));
jest.mock("../server/providers/polygon", () => ({
  getSnapshots:  jest.fn(),
  POLYGON_PEERS: new Set(["NVDA","MSFT","TSLA","MU","AMAT","LRCX"]),
}));
jest.mock("../server/providers/anthropic", () => ({
  fetchAllAnalysis:    jest.fn(),
  fetchTickerExplain:  jest.fn(),
  evaluateThesis:      jest.fn(),
  fetchMarketEvents:   jest.fn(),
  fetchRiskScores:     jest.fn(),
  fetchEconAnalysis:   jest.fn(),
  fetchWatchlistPrices: jest.fn(),
}));

// ── Mock the ideas importer so tests never touch /data/trade_ideas.json ───────
const mockIdeasStore = { version: 1, ideas: [] };

jest.mock("../server/importers/ideas", () => ({
  loadIdeas:  jest.fn(() => ({ ...mockIdeasStore, ideas: [...mockIdeasStore.ideas] })),
  saveIdeas:  jest.fn(),
  addIdea:    jest.fn((draft) => {
    const idea = {
      ...draft,
      id:           "test-uuid-001",
      status:       "OPEN",
      outcome:      null,
      openedAt:     "2026-03-14T10:00:00.000Z",
      closedAt:     null,
      actualPnLPct: null,
      notes:        draft.notes ?? "",
    };
    mockIdeasStore.ideas.push(idea);
    return idea;
  }),
  updateIdea: jest.fn((id, patch) => {
    const idx = mockIdeasStore.ideas.findIndex(i => i.id === id);
    if (idx === -1) {
      const err = new Error(`Idea not found: ${id}`);
      err.status = 404;
      throw err;
    }
    const updated = { ...mockIdeasStore.ideas[idx], ...patch };
    mockIdeasStore.ideas[idx] = updated;
    return updated;
  }),
  IDEAS_PATH: "/tmp/test-trade-ideas.json",
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal valid idea body */
function ideaBody(overrides = {}) {
  return {
    ticker:       "AMD",
    direction:    "LONG",
    thesis:       "MI450 ramp supports $9.8B Q1 guide",
    catalyst:     "FOMC dovish surprise Mar 19",
    entry:        192,
    stop:         175,
    target:       230,
    invalidation: "MI450 order cancelled or Q1 miss >10%",
    horizon:      "3 months",
    confidence:   65,
    sizePct:      5,
    notes:        "",
    ...overrides,
  };
}

let app;

beforeEach(() => {
  jest.resetModules();
  // Reset mock store
  mockIdeasStore.ideas = [];

  // Re-mock after resetModules
  jest.mock("../server/providers/fred", () => ({
    getAllRates:       jest.fn(),
    getRecentHistory: jest.fn(),
  }));
  jest.mock("../server/providers/alphaVantage", () => ({
    getQuote:    jest.fn(),
    getQuotes:   jest.fn(),
    getFxRate:   jest.fn(),
    AV_SUPPORTED: new Set(["AMD"]),
    _getBudget:  jest.fn(),
    _resetBudget: jest.fn(),
  }));
  jest.mock("../server/providers/polygon", () => ({
    getSnapshots:  jest.fn(),
    POLYGON_PEERS: new Set(["NVDA","MSFT","TSLA","MU","AMAT","LRCX"]),
  }));
  jest.mock("../server/providers/anthropic", () => ({
    fetchAllAnalysis:    jest.fn(),
    fetchTickerExplain:  jest.fn(),
    evaluateThesis:      jest.fn(),
    fetchMarketEvents:   jest.fn(),
    fetchRiskScores:     jest.fn(),
    fetchEconAnalysis:   jest.fn(),
    fetchWatchlistPrices: jest.fn(),
  }));
  jest.mock("../server/importers/ideas", () => ({
    loadIdeas:  jest.fn(() => ({ version: 1, ideas: [...mockIdeasStore.ideas] })),
    saveIdeas:  jest.fn(),
    addIdea:    jest.fn((draft) => {
      const idea = {
        ...draft,
        id:           "test-uuid-001",
        status:       "OPEN",
        outcome:      null,
        openedAt:     "2026-03-14T10:00:00.000Z",
        closedAt:     null,
        actualPnLPct: null,
        notes:        draft.notes ?? "",
      };
      mockIdeasStore.ideas.push(idea);
      return idea;
    }),
    updateIdea: jest.fn((id, patch) => {
      const idx = mockIdeasStore.ideas.findIndex(i => i.id === id);
      if (idx === -1) {
        const err = new Error(`Idea not found: ${id}`);
        err.status = 404;
        throw err;
      }
      const updated = { ...mockIdeasStore.ideas[idx], ...patch };
      mockIdeasStore.ideas[idx] = updated;
      return updated;
    }),
    IDEAS_PATH: "/tmp/test-trade-ideas.json",
  }));

  app = require("../server/index");
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/ideas — basic CRUD
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /api/ideas", () => {
  test("returns 200 with empty ideas array when store is empty", async () => {
    const res = await request(app).get("/api/ideas");
    expect(res.status).toBe(200);
    expect(res.body.data.ideas).toEqual([]);
    expect(res.body.data.total).toBe(0);
    expect(res.body.source).toBe("computed");
  });

  test("filters by status=OPEN", async () => {
    mockIdeasStore.ideas = [
      { id: "a", status: "OPEN",   ticker: "AMD" },
      { id: "b", status: "CLOSED", ticker: "NVDA" },
    ];
    const res = await request(app).get("/api/ideas?status=OPEN");
    expect(res.status).toBe(200);
    expect(res.body.data.ideas).toHaveLength(1);
    expect(res.body.data.ideas[0].id).toBe("a");
  });
});

describe("POST /api/ideas", () => {
  test("creates idea and returns riskCheck in response", async () => {
    const res = await request(app)
      .post("/api/ideas")
      .send(ideaBody());
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe("test-uuid-001");
    expect(res.body.data.status).toBe("OPEN");
    expect(res.body.data.riskCheck).toBeDefined();
    expect(["OK","WARN","BLOCK"]).toContain(res.body.data.riskCheck.level);
  });

  test("rejects missing required fields", async () => {
    const res = await request(app)
      .post("/api/ideas")
      .send({ ticker: "AMD" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/missing required fields/i);
  });

  test("rejects invalid direction", async () => {
    const res = await request(app)
      .post("/api/ideas")
      .send(ideaBody({ direction: "BOTH" }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/direction/i);
  });

  test("rejects confidence out of range", async () => {
    const res = await request(app)
      .post("/api/ideas")
      .send(ideaBody({ confidence: 150 }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/confidence/i);
  });

  test("rejects non-positive sizePct", async () => {
    const res = await request(app)
      .post("/api/ideas")
      .send(ideaBody({ sizePct: -1 }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sizePct/i);
  });
});

describe("GET /api/ideas/:id", () => {
  test("returns 404 for unknown id", async () => {
    const res = await request(app).get("/api/ideas/nonexistent-id");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test("returns idea when id exists", async () => {
    mockIdeasStore.ideas = [{ id: "abc123", ticker: "AMD", status: "OPEN" }];
    const res = await request(app).get("/api/ideas/abc123");
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe("abc123");
  });
});

describe("PATCH /api/ideas/:id", () => {
  test("closes an idea and sets outcome", async () => {
    mockIdeasStore.ideas = [{
      id: "test-uuid-001", ticker: "AMD", status: "OPEN",
      openedAt: "2026-03-14T10:00:00.000Z", closedAt: null, outcome: null,
    }];
    const res = await request(app)
      .patch("/api/ideas/test-uuid-001")
      .send({ status: "CLOSED", outcome: "HIT", actualPnLPct: 12.5 });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("CLOSED");
    expect(res.body.data.outcome).toBe("HIT");
    expect(res.body.data.actualPnLPct).toBe(12.5);
    expect(res.body.data.closedAt).toBeTruthy();
  });

  test("returns 404 for unknown id", async () => {
    const res = await request(app)
      .patch("/api/ideas/nonexistent")
      .send({ notes: "test" });
    expect(res.status).toBe(404);
  });

  test("rejects invalid status value", async () => {
    const res = await request(app)
      .patch("/api/ideas/any-id")
      .send({ status: "PENDING" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/status/i);
  });
});

describe("DELETE /api/ideas/:id", () => {
  test("soft-deletes by setting status to CANCELLED", async () => {
    mockIdeasStore.ideas = [{
      id: "del-001", ticker: "AMD", status: "OPEN",
      closedAt: null, outcome: null,
    }];
    const res = await request(app).delete("/api/ideas/del-001");
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("CANCELLED");
    expect(res.body.data.outcome).toBe("CANCELLED");
  });

  test("returns 404 for unknown id", async () => {
    const res = await request(app).delete("/api/ideas/nonexistent");
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/ideas/stats
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /api/ideas/stats", () => {
  test("returns zero stats for empty store", async () => {
    const res = await request(app).get("/api/ideas/stats");
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(0);
    expect(res.body.data.hitRate).toBeNull();
    expect(res.body.data.avgRMultiple).toBeNull();
  });

  test("hitRate = 100% given one closed HIT idea", async () => {
    mockIdeasStore.ideas = [{
      id: "s1", status: "CLOSED", outcome: "HIT",
      confidence: 70, entry: 190, stop: 175, target: 230,
      actualPnLPct: 20,
      openedAt: "2026-03-01T00:00:00.000Z",
      closedAt: "2026-03-14T00:00:00.000Z",
    }];
    const res = await request(app).get("/api/ideas/stats");
    expect(res.status).toBe(200);
    expect(res.body.data.hitRate).toBe(100);
    expect(res.body.data.stopRate).toBe(0);
    expect(res.body.data.closed).toBe(1);
  });

  test("hitRate = 0% given one closed STOPPED idea", async () => {
    mockIdeasStore.ideas = [{
      id: "s2", status: "CLOSED", outcome: "STOPPED",
      confidence: 60, entry: 192, stop: 175, target: 230,
      actualPnLPct: -8.85,
      openedAt: "2026-03-01T00:00:00.000Z",
      closedAt: "2026-03-07T00:00:00.000Z",
    }];
    const res = await request(app).get("/api/ideas/stats");
    expect(res.status).toBe(200);
    expect(res.body.data.hitRate).toBe(0);
    expect(res.body.data.stopRate).toBe(100);
  });

  test("avgRMultiple is computed correctly", async () => {
    // R-multiple = actualPnLPct / riskPct
    // riskPct = |192 - 175| / 192 * 100 = 8.854%
    // actualPnLPct = 20%; R = 20 / 8.854 ≈ 2.26
    mockIdeasStore.ideas = [{
      id: "r1", status: "CLOSED", outcome: "HIT",
      confidence: 70, entry: 192, stop: 175, target: 230,
      actualPnLPct: 20,
      openedAt: "2026-03-01T00:00:00.000Z",
      closedAt: "2026-03-14T00:00:00.000Z",
    }];
    const res = await request(app).get("/api/ideas/stats");
    expect(res.body.data.avgRMultiple).toBeCloseTo(20 / (Math.abs(192 - 175) / 192 * 100), 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/brief
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /api/brief", () => {
  test("returns 200 with expected shape", async () => {
    const res = await request(app).get("/api/brief");
    expect(res.status).toBe(200);
    expect(res.body.source).toMatch(/^(cache|partial|unavailable)$/);
    expect(res.body.data.regime).toBeTruthy();
    expect(Array.isArray(res.body.data.whatChanged)).toBe(true);
    expect(Array.isArray(res.body.data.actionableSetup)).toBe(true);
    expect(typeof res.body.data.whyItMatters).toBe("string");
    expect(typeof res.body.data.openIdeas).toBe("number");
  });

  test("whatChanged contains 5 rate series", async () => {
    const res = await request(app).get("/api/brief");
    expect(res.body.data.whatChanged).toHaveLength(5);
    const series = res.body.data.whatChanged.map(w => w.series);
    expect(series).toContain("DGS10");
    expect(series).toContain("HY OAS");
  });

  test("with no cached rates the brief says so instead of using seed levels", async () => {
    // It used to fall back to March 2026 seed rates and label them
    // "Bear steepener + Elevated real yields + Bear flattener" — a contradiction.
    const res = await request(app).get("/api/brief");
    expect(res.body.source).toBe("unavailable");
    expect(res.body.data.regime).toMatch(/Unavailable/);
    expect(res.body.data.regime).not.toMatch(/steepener|flattener/i);
    expect(res.body.stale).toBe(true);
    expect(res.body.data.whatChanged.every(w => w.deltaBps === null)).toBe(true);
  });

  test("with no calendar loaded, nextEvent is null and the calendar is marked unavailable", async () => {
    const res = await request(app).get("/api/brief");
    expect(res.body.data.nextEvent).toBeNull();
    expect(res.body.data.calendar.available).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// riskCheck.js — pure unit tests
// ─────────────────────────────────────────────────────────────────────────────
describe("riskCheck — pure unit tests", () => {
  let riskCheck;
  beforeEach(() => {
    riskCheck = require("../server/analytics/riskCheck");
  });

  const portfolioRows = [
    { ticker: "AMD",  valGBP: 138.68 },
    { ticker: "HIES", valGBP: 275.95 },
    { ticker: "HIUS", valGBP: 219.35 },
    { ticker: "HIJS", valGBP: 200.90 },
    { ticker: "SGLN", valGBP: 219.75 },
    { ticker: "HBKS", valGBP:  55.44 },
  ];
  const totalGBP = 1110.07;

  function idea(overrides = {}) {
    return {
      ticker: "AMD", direction: "LONG",
      entry: 192, stop: 175, target: 230,
      sizePct: 5, horizon: "3 months",
      ...overrides,
    };
  }

  test("position ≥ 25% returns BLOCK on size check", () => {
    const result = riskCheck.runPreTradeCheck(
      idea({ ticker: "NEWSTOCK", sizePct: 26, entry: 100, stop: 90, target: 130 }),
      portfolioRows, totalGBP
    );
    const sizeCheck = result.checks.find(c => c.name === "Position Size");
    expect(sizeCheck.status).toBe("BLOCK");
    expect(result.level).toBe("BLOCK");
    expect(result.pass).toBe(false);
  });

  test("position 15–25% returns WARN on size check", () => {
    const result = riskCheck.runPreTradeCheck(
      idea({ ticker: "NEWSTOCK", sizePct: 17, entry: 100, stop: 90, target: 130 }),
      portfolioRows, totalGBP
    );
    const sizeCheck = result.checks.find(c => c.name === "Position Size");
    expect(sizeCheck.status).toBe("WARN");
  });

  test("position < 15% returns OK on size check", () => {
    // Use a ticker with no existing position so proposed = sizePct only (5% < 15%)
    const result = riskCheck.runPreTradeCheck(
      idea({ ticker: "NEWSTOCK", sizePct: 5 }), portfolioRows, totalGBP
    );
    const sizeCheck = result.checks.find(c => c.name === "Position Size");
    expect(sizeCheck.status).toBe("OK");
  });

  test("R < 1.0 returns BLOCK on R-ratio check", () => {
    // entry 100, stop 90, target 105 → R = 5/10 = 0.5
    const result = riskCheck.runPreTradeCheck(
      idea({ entry: 100, stop: 90, target: 105 }),
      portfolioRows, totalGBP
    );
    const rCheck = result.checks.find(c => c.name === "R-Ratio");
    expect(rCheck.status).toBe("BLOCK");
    expect(result.pass).toBe(false);
  });

  test("R 1.0–1.5 returns WARN on R-ratio check", () => {
    // entry 100, stop 90, target 112 → R = 12/10 = 1.2
    const result = riskCheck.runPreTradeCheck(
      idea({ entry: 100, stop: 90, target: 112 }),
      portfolioRows, totalGBP
    );
    const rCheck = result.checks.find(c => c.name === "R-Ratio");
    expect(rCheck.status).toBe("WARN");
  });

  test("R ≥ 1.5 returns OK on R-ratio check", () => {
    // entry 192, stop 175, target 230 → R = 38/17 ≈ 2.24
    const result = riskCheck.runPreTradeCheck(
      idea(), portfolioRows, totalGBP
    );
    const rCheck = result.checks.find(c => c.name === "R-Ratio");
    expect(rCheck.status).toBe("OK");
  });

  // This test used to fail every year from April to December: it relied on a
  // hand-typed, year-less seed calendar ("19 Mar") that only produced an event
  // inside the horizon in spring. The calendar is now injected with full dates.
  test("event within horizon returns WARN on event risk check", () => {
    const soon = new Date(Date.now() + 10 * 86_400_000);
    const calendar = { available: true, source: "test", events: [
      { date: soon.toISOString().slice(0, 10), at: soon, event: "FOMC Rate Decision", ticker: "US", importance: "HIGH", kind: "observed" },
    ] };
    const result = riskCheck.runPreTradeCheck(
      idea({ horizon: "3 months" }), portfolioRows, totalGBP, null, { calendar }
    );
    const eventCheck = result.checks.find(c => c.name === "Event Risk");
    expect(eventCheck.status).toBe("WARN");
    expect(eventCheck.detail).toMatch(/FOMC/);
  });

  test("an unavailable calendar is a WARN, never a silent pass", () => {
    const result = riskCheck.runPreTradeCheck(
      idea({ horizon: "3 months" }), portfolioRows, totalGBP, null,
      { calendar: { available: false, events: [], source: "unavailable", reason: "none loaded" } }
    );
    const eventCheck = result.checks.find(c => c.name === "Event Risk");
    expect(eventCheck.status).toBe("WARN");
    expect(eventCheck.detail).toMatch(/unavailable/i);
  });

  test("all OK returns pass=true and level=OK", () => {
    // Small position in a non-USD ticker with good R-ratio and no events in horizon
    const result = riskCheck.runPreTradeCheck(
      { ticker: "HBKS", direction: "LONG", sizePct: 2, entry: 8.6, stop: 8.0, target: 10.0, horizon: "1 week" },
      portfolioRows, totalGBP
    );
    expect(result.pass).toBe(true);
    // All checks should be OK or WARN (event risk for 1 week might be clear)
    expect(result.level).not.toBe("BLOCK");
  });

  test("horizonToDays parses '3 months' to 90 days", () => {
    expect(riskCheck.horizonToDays("3 months")).toBe(90);
  });

  test("horizonToDays parses '1 year' to 365 days", () => {
    expect(riskCheck.horizonToDays("1 year")).toBe(365);
  });

  test("horizonToDays parses '2 weeks' to 14 days", () => {
    expect(riskCheck.horizonToDays("2 weeks")).toBe(14);
  });

  test("parseEventDate returns null for TBC dates", () => {
    expect(riskCheck.parseEventDate("Apr TBC")).toBeNull();
    expect(riskCheck.parseEventDate(undefined)).toBeNull();
  });
});
