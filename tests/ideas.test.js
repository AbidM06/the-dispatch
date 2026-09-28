/**
 * tests/ideas.test.js — on-demand idea cards (News + Research). The model call
 * is mocked; we test context/citation handling, validation and the routes.
 */
"use strict";

const request = require("supertest");

const mockHeadlines = [
  { id: 101, headline: "Oil jumps as Hormuz traffic stalls", summary: "Brent up 3%", source: "Reuters", url: "https://example.com/oil", datetime: "2026-09-28T08:00:00.000Z" },
  { id: 102, headline: "Gold slides as yields climb", summary: "", source: "CNBC", url: "https://example.com/gold", datetime: "2026-09-28T07:00:00.000Z" },
];

function goodIdea(over = {}) {
  return {
    instrument: "Brent crude (Dec)", marketId: "BRENT", assetClass: "commodities", direction: "LONG",
    expression: "Buy Brent Dec futures", headline: "Supply shock keeps Brent bid",
    thesis: "Shipping disruption tightens prompt supply.", catalyst: "Hormuz traffic data",
    entryLow: 99, entryHigh: 101, target: 110, stop: 95, horizon: "2-4 weeks", confidence: 60,
    keyRisks: ["Ceasefire holds"], invalidation: "Close below 95",
    basedOn: ["N1", "M:BRENT", "X99"], ...over,
  };
}

let callAgent;
function setup(modelReply) {
  jest.resetModules();
  jest.mock("../server/providers/anthropic", () => ({ fetchAllAnalysis: jest.fn(), fetchTickerExplain: jest.fn(), callClaude: jest.fn() }));
  jest.mock("../server/research/llm", () => ({
    callAgent: jest.fn(),
    modelForRole: () => "test-model",
    newUsageTracker: () => ({ calls: 0, inputTokens: 0, outputTokens: 0, byRole: {} }),
  }));
  jest.mock("../server/providers/finnhub", () => ({
    getMarketNews: jest.fn(async () => mockHeadlines), getCompanyNews: jest.fn(async () => []),
    getEarningsCalendar: jest.fn(async () => []), getEconomicCalendar: jest.fn(async () => []),
    getNewsSentiment: jest.fn(async () => null), isConfigured: () => true, TTL_NEWS_MS: 60000, TTL_CALENDAR_MS: 60000,
  }));
  const markets = require("../server/markets/service");
  // Inject a snapshot directly (no network)
  jest.spyOn(markets, "getSnapshot").mockReturnValue({
    generatedAt: "2026-09-28T09:00:00.000Z",
    items: [{ id: "BRENT", label: "Brent crude", group: "commodities", ok: true, unit: null,
      quote: { value: 100.5, changePct: 3.5, asOf: "2026-09-28T08:50:00.000Z", releasedAt: "2026-09-28T08:50:00.000Z", source: "Yahoo Finance", sourceUrl: "https://finance.yahoo.com/quote/BZ%3DF" },
      freshness: { label: "Delayed ~10 min" } }],
  });
  callAgent = require("../server/research/llm").callAgent;
  callAgent.mockImplementation(typeof modelReply === "function" ? modelReply : async () => "Here you go:\n" + JSON.stringify(modelReply));
  return require("../server/index");
}

describe("POST /api/ideas/news", () => {
  test("builds a card whose sources resolve to real inputs only", async () => {
    const app = setup(goodIdea());
    const res = await request(app).post("/api/ideas/news").send({});
    expect(res.status).toBe(200);
    const c = res.body.idea;
    expect(c.id).toMatch(/^IDEA-/);
    expect(c.origin).toBe("news");
    expect(c.basedOn.map(b => b.ref)).toEqual(["N1", "M:BRENT"]);
    expect(c.basedOn[0].url).toBe("https://example.com/oil");
    expect(c.basedOn[1].publisher).toBe("Yahoo Finance");
    expect(c.warnings.join(" ")).toMatch(/Ignored 1 citation/);
    expect(c.priceAtIdea.value).toBe(100.5);
    expect(c.riskReward).toBeCloseTo(10 / 5, 2);
    // prompt contained the market provenance and no web search
    const [role, , user, opts] = callAgent.mock.calls[0];
    expect(role).toBe("ideas");
    expect(opts.search).toBe(false);
    expect(user).toContain("[M:BRENT] Brent crude");
    expect(user).toContain("Yahoo Finance");
  });

  test("focus headline is marked in the prompt; unknown headline → 404", async () => {
    const app = setup(goodIdea());
    await request(app).post("/api/ideas/news").send({ headlineId: 102 });
    expect(callAgent.mock.calls[0][2]).toMatch(/\[N2\] ◀ FOCUS/);
    const r = await request(app).post("/api/ideas/news").send({ headlineId: 999 });
    expect(r.status).toBe(404);
  });

  test("allows SHORT ideas and flags inconsistent levels", async () => {
    const app = setup(goodIdea({ direction: "SHORT" })); // levels are LONG-shaped
    const res = await request(app).post("/api/ideas/news").send({});
    expect(res.status).toBe(200);
    expect(res.body.idea.direction).toBe("SHORT");
    expect(res.body.idea.warnings.join(" ")).toMatch(/not consistent for a SHORT/);
  });

  test("rejects output that fails the schema", async () => {
    const app = setup({ instrument: "X" });
    const res = await request(app).post("/api/ideas/news").send({});
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/validation/);
  });

  test("budget cap → 503 with aiStatus UNAVAILABLE", async () => {
    const app = setup(async () => { const e = new Error("Daily budget cap reached"); e.code = "BUDGET_DAILY"; throw e; });
    const res = await request(app).post("/api/ideas/news").send({});
    expect(res.status).toBe(503);
    expect(res.body.aiStatus).toBe("UNAVAILABLE");
  });
});

describe("POST /api/ideas/research + history", () => {
  test("404 when no report exists", async () => {
    const app = setup(goodIdea());
    const res = await request(app).post("/api/ideas/research").send({ type: "commodities" });
    expect(res.status).toBe(404);
  });

  test("uses the report and its SRC ids; card saved to history and deletable", async () => {
    const app = setup(goodIdea({ basedOn: ["REPORT", "SRC-001", "M:BRENT"] }));
    const rs = require("../server/research/reportStore");
    rs.save({ reportId: "RPT-commodities-x-v1", version: 1, reportType: "commodities", generatedAt: "2026-09-28T08:00:00Z",
      research: { title: "Oil tightness" }, thesisFrame: { thesis: "Tight" },
      sources: [{ sourceId: "SRC-001", title: "EIA weekly", publisher: "EIA", url: "https://eia.gov/x", publishedAt: "2026-09-25" }] });
    const res = await request(app).post("/api/ideas/research").send({ reportId: "RPT-commodities-x-v1" });
    expect(res.status).toBe(200);
    const c = res.body.idea;
    expect(c.origin).toBe("research");
    expect(c.context.reportId).toBe("RPT-commodities-x-v1");
    expect(c.basedOn.map(b => b.ref)).toEqual(["REPORT", "SRC-001", "M:BRENT"]);
    expect(c.basedOn[1].url).toBe("https://eia.gov/x");

    const list = await request(app).get("/api/ideas?origin=research");
    expect(list.body.ideas.map(i => i.id)).toContain(c.id);
    const del = await request(app).delete("/api/ideas/" + c.id);
    expect(del.status).toBe(200);
    const after = await request(app).get("/api/ideas?origin=research");
    expect(after.body.ideas.map(i => i.id)).not.toContain(c.id);
  });
});
