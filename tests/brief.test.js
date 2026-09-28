/**
 * tests/brief.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GET /api/brief — deterministic daily brief (kept from the former phase1 suite
 * when the trade-ideas / execution engine was removed).
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const request = require("supertest");

function mockProviders() {
  jest.mock("../server/providers/fred", () => ({
    getAllRates:       jest.fn(),
    getRecentHistory: jest.fn(),
    getLatestObservation: jest.fn(),
  }));
  jest.mock("../server/providers/anthropic", () => ({
    fetchAllAnalysis:    jest.fn(),
    fetchTickerExplain:  jest.fn(),
    callClaude:          jest.fn(),
  }));
}

let app;

beforeEach(() => {
  jest.resetModules();
  mockProviders();
  app = require("../server/index");
});

describe("GET /api/brief", () => {
  test("returns 200 with expected shape", async () => {
    const res = await request(app).get("/api/brief");
    expect(res.status).toBe(200);
    expect(res.body.source).toMatch(/cache|seeded/);
    expect(res.body.data.regime).toBeTruthy();
    expect(Array.isArray(res.body.data.whatChanged)).toBe(true);
    expect(Array.isArray(res.body.data.actionableSetup)).toBe(true);
    expect(typeof res.body.data.whyItMatters).toBe("string");
  });

  test("whatChanged contains 5 rate series", async () => {
    const res = await request(app).get("/api/brief");
    expect(res.body.data.whatChanged).toHaveLength(5);
    const series = res.body.data.whatChanged.map(w => w.series);
    expect(series).toContain("DGS10");
    expect(series).toContain("HY OAS");
  });

  test("regime label uses seed rates when cache is empty", async () => {
    // Seeds have dfii10=1.85, hy_spread=3.17, t10y2y=0.51
    // Expected regime: "Bear steepener + Elevated real yields + Bear flattener"
    const res = await request(app).get("/api/brief");
    expect(res.body.data.regime).toBeTruthy();
    expect(res.body.stale).toBe(true); // seeded data is always stale
  });

  test("nextEvent is the earliest upcoming event", async () => {
    const res = await request(app).get("/api/brief");
    // FOMC is 19 Mar — should be the next event from today (Mar 14)
    if (res.body.data.nextEvent) {
      expect(res.body.data.nextEvent.date).toBeTruthy();
      expect(res.body.data.nextEvent.importance).toBeTruthy();
    }
  });
});
