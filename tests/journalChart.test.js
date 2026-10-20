/**
 * tests/journalChart.test.js — GET /api/journal/:entryId/chart (D-28, PR 2 of 4).
 * Real daily prices over a range that covers the idea's age, plus the idea's own entry zone, target
 * and stop. Read-only: nothing here calls AI or writes to the Journal.
 */
"use strict";

const request = require("supertest");
const DAY = 86_400_000;

function card(over = {}) {
  return {
    id: "IDEA-" + Math.random().toString(16).slice(2, 12), origin: "news",
    createdAt: new Date(Date.now() - 10 * DAY).toISOString(),
    instrument: "Brent crude", direction: "LONG", headline: "h", horizon: "2-6 weeks",
    entryLow: 99, entryHigh: 101, target: 110, stop: 95, warnings: [], marketId: "BRENT",
    priceAtIdea: { value: 100.5, source: "Yahoo Finance", asOf: new Date().toISOString(), url: "https://finance.yahoo.com/quote/BZ%3DF", freshness: "Delayed" },
    ...over,
  };
}
const HIST = { id: "BRENT", tf: "1d", type: "ohlc", bars: [{ t: 1, o: 1, h: 2, l: 0.5, c: 1.5 }], source: "Yahoo Finance", sourceUrl: "https://finance.yahoo.com/quote/BZ%3DF" };

function setup() {
  jest.resetModules();
  jest.doMock("../server/providers/anthropic", () => ({ fetchAllAnalysis: jest.fn(), fetchTickerExplain: jest.fn(), callClaude: jest.fn() }));
  const journal = require("../server/journal/store");
  journal._reset();
  const markets = require("../server/markets/service");
  const getHistory = jest.spyOn(markets, "getHistory").mockImplementation(async (id, tf) => ({ ...HIST, id, tf }));
  const app = require("../server/index");
  return { app, journal, getHistory };
}

describe("journal idea chart", () => {
  test("chartRange picks the shortest daily range with ~a month of context before the idea", () => {
    jest.resetModules();
    const { chartRange } = require("../server/routes/journal");
    const now = Date.parse("2026-10-20T12:00:00Z");
    const at = (days) => new Date(now - days * DAY).toISOString();
    expect(chartRange(at(0), now)).toBe("1d");
    expect(chartRange(at(150), now)).toBe("1d");          // 6M window = ~180 days ≥ age + 30
    expect(chartRange(at(151), now)).toBe("1y");
    expect(chartRange(at(330), now)).toBe("1y");
    expect(chartRange(at(331), now)).toBe("5y");
    expect(chartRange(at(-3), now)).toBe("1d");           // clock skew: never negative
  });

  test("returns real history + the idea's own levels; range follows the idea's age", async () => {
    const { app, journal, getHistory } = setup();
    const fresh = journal.logIdea(card());
    const mid   = journal.logIdea(card({ createdAt: new Date(Date.now() - 200 * DAY).toISOString() }));
    const old   = journal.logIdea(card({ createdAt: new Date(Date.now() - 500 * DAY).toISOString() }));

    const r = await request(app).get(`/api/journal/${fresh.entryId}/chart`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ entryId: fresh.entryId, tf: "1d", type: "ohlc", source: "Yahoo Finance",
      levels: { entryLow: 99, entryHigh: 101, target: 110, stop: 95, direction: "LONG" } });
    expect(getHistory).toHaveBeenCalledWith("BRENT", "1d", { source: undefined });
    expect((await request(app).get(`/api/journal/${mid.entryId}/chart`)).body.tf).toBe("1y");
    expect((await request(app).get(`/api/journal/${old.entryId}/chart`)).body.tf).toBe("5y");
  });

  test("a dynamic (Polymarket) idea is priced from the history source saved on its card", async () => {
    const { app, journal, getHistory } = setup();
    const src = { provider: "polymarket", tokenId: "tok1" };
    const e = journal.logIdea(card({ marketId: "PM:fed-oct", marketHistory: src }));
    await request(app).get(`/api/journal/${e.entryId}/chart`);
    expect(getHistory).toHaveBeenCalledWith("PM:fed-oct", "1d", { source: src });
  });

  test("plain refusals: unknown entry 404, no instrument 404, incomplete levels 422, no price history → its own status", async () => {
    const { app, journal, getHistory } = setup();
    expect((await request(app).get("/api/journal/JRN-nope/chart")).status).toBe(404);
    const none = journal.logIdea(card({ marketId: null }));
    const r1 = await request(app).get(`/api/journal/${none.entryId}/chart`);
    expect(r1.status).toBe(404);
    expect(r1.body.error).toMatch(/no Markets instrument/);
    const noLevels = journal.logIdea(card({ target: null }));
    const r2 = await request(app).get(`/api/journal/${noLevels.entryId}/chart`);
    expect(r2.status).toBe(422);
    expect(r2.body.error).toMatch(/levels are incomplete/);
    getHistory.mockRejectedValueOnce(Object.assign(new Error("History unavailable for BRENT — yahoo: 403"), { status: 502 }));
    const ok = journal.logIdea(card());
    const r3 = await request(app).get(`/api/journal/${ok.entryId}/chart`);
    expect(r3.status).toBe(502);
    expect(r3.body.error).toMatch(/History unavailable/);
  });

  test("read-only: drawing the chart leaves the Journal entry untouched and intact", async () => {
    const { app, journal } = setup();
    const e = journal.logIdea(card());
    const before = JSON.stringify(journal.getEntry(e.entryId));
    await request(app).get(`/api/journal/${e.entryId}/chart`);
    expect(JSON.stringify(journal.getEntry(e.entryId))).toBe(before);
    expect(journal.getEntry(e.entryId).integrity).toBe("intact");
  });
});
