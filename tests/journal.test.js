/**
 * tests/journal.test.js — Journal stage 1 (D-14, D-16): immutable logging of
 * every generated idea, explicit reference-price status, horizon buckets,
 * watch / pitch / manual-price events, backfill, and no edit/delete routes.
 */
"use strict";

const request = require("supertest");

const CREATED = "2026-09-28T09:00:00.000Z";
function card(over = {}) {
  return {
    id: "IDEA-" + Math.random().toString(16).slice(2, 12), origin: "news", createdAt: CREATED,
    instrument: "Brent crude", direction: "LONG", headline: "h", horizon: "2-6 weeks",
    entryLow: 99, entryHigh: 101, target: 110, stop: 95, warnings: [],
    marketId: "BRENT", marketsSnapshotAt: "2026-09-28T08:55:00.000Z",
    priceAtIdea: { value: 100.5, source: "Yahoo Finance", asOf: "2026-09-28T08:50:00.000Z", url: "https://finance.yahoo.com/quote/BZ%3DF", freshness: "Delayed ~10 min" },
    ...over,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
describe("journal store", () => {
  let journal;
  beforeEach(() => {
    jest.resetModules();
    journal = require("../server/journal/store");
    journal._reset();
  });

  test("logs a frozen copy with a hash; integrity reads 'intact'", () => {
    const c = card();
    const e = journal.logIdea(c);
    expect(e.entryId).toMatch(/^JRN-/);
    expect(e.ideaId).toBe(c.id);
    expect(e.integrity).toBe("intact");
    c.target = 999;                                  // mutating the caller's object…
    expect(journal.getEntry(e.entryId).idea.target).toBe(110);   // …does not touch the record
  });

  test("an idea edited on disk after logging reads as MODIFIED", () => {
    const fs = require("fs"), os = require("os"), path = require("path");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jrn-")), "journal.jsonl");
    process.env.JOURNAL_PATH = file;
    try {
      jest.resetModules();
      const j = require("../server/journal/store");
      const e = j.logIdea(card());
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"target":110', '"target":150'));
      expect(j.getEntry(e.entryId).integrity).toBe("MODIFIED");
    } finally {
      delete process.env.JOURNAL_PATH;
    }
  });

  test("logging the same idea twice returns the same entry (no duplicate)", () => {
    const c = card();
    const a = journal.logIdea(c), b = journal.logIdea(c);
    expect(b.entryId).toBe(a.entryId);
    expect(journal.list()).toHaveLength(1);
  });

  describe("reference price status is always explicit", () => {
    const { referenceFrom } = require("../server/journal/store")._internal;
    test("ok — fresh Markets value, with source, time and link", () => {
      expect(referenceFrom(card())).toMatchObject({ status: "ok", value: 100.5, source: "Yahoo Finance", url: expect.stringMatching(/^https:/) });
    });
    test("missing — instrument not in the snapshot", () => {
      expect(referenceFrom(card({ priceAtIdea: null, marketId: null }))).toMatchObject({ status: "missing", value: null });
    });
    test("stale — flagged stale by the Markets service", () => {
      expect(referenceFrom(card({ priceAtIdea: { ...card().priceAtIdea, freshness: "stale" } })).status).toBe("stale");
    });
    test("stale — older than the threshold at generation time", () => {
      const r = referenceFrom(card({ priceAtIdea: { ...card().priceAtIdea, asOf: "2026-09-18T20:00:00.000Z" } }));
      expect(r.status).toBe("stale");
      expect(r.reason).toMatch(/days old/);
    });
    test("unknown — backfilled card with no recorded freshness", () => {
      const p = { ...card().priceAtIdea }; delete p.freshness;
      expect(referenceFrom(card({ priceAtIdea: p }), { backfilled: true }).status).toBe("unknown");
    });
  });

  test.each([
    ["1-3 days", "tactical"], ["2 weeks", "tactical"], ["2-6 weeks", "swing"], ["2–4 weeks", "swing"],
    ["3 months", "swing"], ["6-12 months", "strategic"], ["1 year", "strategic"],
    ["until the Fed meets", "undeclared"], ["", "undeclared"], ["5 years", "undeclared"],
  ])("horizon %p → %s", (raw, category) => {
    expect(journal._internal.horizonFrom(raw).category).toBe(category);
  });

  test("watch / pitch / manual price are appended events; the original is untouched", () => {
    const e = journal.logIdea(card());
    journal.setWatch(e.entryId, true);
    journal.addPitch(e.entryId, "Long Brent: supply tight into winter", { beforeReveal: true });
    journal.addManualPrice(e.entryId, 101.2, "would have bought at the open");
    const after = journal.getEntry(e.entryId);
    expect(after.watched).toBe(true);
    expect(after.pitches).toEqual([expect.objectContaining({ beforeReveal: true, text: expect.stringMatching(/Long Brent/) })]);
    expect(after.manualPrices[0]).toMatchObject({ price: 101.2 });
    expect(after.reference.value).toBe(100.5);       // manual price never replaces the reference
    expect(after.integrity).toBe("intact");
    journal.setWatch(e.entryId, false);
    expect(journal.getEntry(e.entryId).watched).toBe(false);
  });

  test("validation: empty pitch, bad price, unknown entry", () => {
    const e = journal.logIdea(card());
    expect(() => journal.addPitch(e.entryId, "  ", { beforeReveal: false })).toThrow(/required/);
    expect(() => journal.addManualPrice(e.entryId, -3)).toThrow(/positive/);
    expect(() => journal.setWatch("JRN-nope", true)).toThrow(/not found/);
  });

  test("list: newest first, filters by watched and origin", () => {
    const a = journal.logIdea(card({ createdAt: "2026-09-27T09:00:00.000Z", origin: "research" }));
    const b = journal.logIdea(card({ createdAt: "2026-09-28T09:00:00.000Z" }));
    journal.setWatch(a.entryId, true);
    expect(journal.list().map(e => e.entryId)).toEqual([b.entryId, a.entryId]);
    expect(journal.list({ watched: true }).map(e => e.entryId)).toEqual([a.entryId]);
    expect(journal.list({ origin: "news" }).map(e => e.entryId)).toEqual([b.entryId]);
  });

  test("backfill logs earlier ideas once, flagged backfilled", () => {
    const cards = [card(), card()];
    expect(journal.backfill(cards)).toBe(2);
    expect(journal.backfill(cards)).toBe(0);
    expect(journal.list().every(e => e.backfilled)).toBe(true);
  });

  test("persists to an append-only JSONL file that survives a reload", () => {
    const fs = require("fs"), os = require("os"), path = require("path");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jrn-")), "journal.jsonl");
    process.env.JOURNAL_PATH = file;
    try {
      jest.resetModules();
      const j1 = require("../server/journal/store");
      const e = j1.logIdea(card());
      j1.setWatch(e.entryId, true);
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);                       // one line per event, never rewritten
      jest.resetModules();
      const j2 = require("../server/journal/store");
      expect(j2.getEntry(e.entryId)).toMatchObject({ watched: true, integrity: "intact" });
    } finally {
      delete process.env.JOURNAL_PATH;
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe("journal routes + every generated idea is logged", () => {
  function setup() {
    jest.resetModules();
    jest.doMock("../server/providers/anthropic", () => ({ fetchAllAnalysis: jest.fn(), fetchTickerExplain: jest.fn(), callClaude: jest.fn() }));
    jest.doMock("../server/research/llm", () => ({
      callAgent: jest.fn(async () => JSON.stringify({
        instrument: "Brent crude", marketId: "BRENT", assetClass: "commodities", direction: "LONG",
        expression: "Buy Brent", headline: "Supply keeps Brent bid", thesis: "Tight prompt supply.",
        catalyst: "Inventory data", entryLow: 99, entryHigh: 101, target: 110, stop: 95,
        horizon: "2-6 weeks", confidence: 60, keyRisks: ["Demand"], invalidation: "Close below 95", basedOn: ["N1", "M:BRENT"],
      })),
      modelForRole: () => "test-model",
      newUsageTracker: () => ({ calls: 0, inputTokens: 0, outputTokens: 0, byRole: {} }),
    }));
    jest.doMock("../server/providers/finnhub", () => ({
      getMarketNews: jest.fn(async () => [{ id: 1, headline: "Oil inventories fall", source: "Reuters", url: "https://example.com/a", datetime: CREATED }]),
      getCompanyNews: jest.fn(async () => []), getEarningsCalendar: jest.fn(async () => []), getEconomicCalendar: jest.fn(async () => []),
      getNewsSentiment: jest.fn(async () => null), isConfigured: () => true, TTL_NEWS_MS: 60000, TTL_CALENDAR_MS: 60000,
    }));
    const markets = require("../server/markets/service");
    jest.spyOn(markets, "getSnapshot").mockReturnValue({
      generatedAt: CREATED,
      items: [{ id: "BRENT", label: "Brent crude", group: "commodities", ok: true, unit: null,
        quote: { value: 100.5, changePct: 1, asOf: CREATED, releasedAt: CREATED, source: "Yahoo Finance", sourceUrl: "https://finance.yahoo.com/quote/BZ%3DF" },
        freshness: { label: "Delayed ~10 min" } }],
    });
    require("../server/journal/store")._reset();
    require("../server/ideas/store")._reset();
    return require("../server/index");
  }

  test("generating an idea writes it to the Journal and links the card to the entry", async () => {
    const app = setup();
    const gen = await request(app).post("/api/ideas/news").send({});
    expect(gen.status).toBe(200);
    expect(gen.body.idea.journalEntryId).toMatch(/^JRN-/);

    const list = await request(app).get("/api/journal");
    expect(list.body.entries).toHaveLength(1);
    const e = list.body.entries[0];
    expect(e.ideaId).toBe(gen.body.idea.id);
    expect(e.reference).toMatchObject({ status: "ok", value: 100.5, source: "Yahoo Finance" });
    expect(e.horizon.category).toBe("swing");
  });

  test("dismissing the card does not remove the Journal entry", async () => {
    const app = setup();
    const gen = await request(app).post("/api/ideas/news").send({});
    await request(app).delete("/api/ideas/" + gen.body.idea.id);
    const one = await request(app).get("/api/journal/" + gen.body.idea.journalEntryId);
    expect(one.status).toBe(200);
    expect(one.body.entry.integrity).toBe("intact");
  });

  test("watch, pitch and manual price via HTTP", async () => {
    const app = setup();
    const gen = await request(app).post("/api/ideas/news").send({});
    const id = gen.body.idea.journalEntryId;
    expect((await request(app).post(`/api/journal/${id}/watch`).send({ watched: true })).body.entry.watched).toBe(true);
    expect((await request(app).post(`/api/journal/${id}/pitch`).send({ text: "my view", beforeReveal: true })).body.entry.pitches[0].beforeReveal).toBe(true);
    expect((await request(app).post(`/api/journal/${id}/manual-price`).send({ price: "abc" })).status).toBe(400);
    expect((await request(app).get("/api/journal?watched=true")).body.entries).toHaveLength(1);
    expect((await request(app).post("/api/journal/JRN-nope/watch").send({})).status).toBe(404);
  });

  test("there is no way to edit or delete a Journal entry", async () => {
    const app = setup();
    const gen = await request(app).post("/api/ideas/news").send({});
    const id = gen.body.idea.journalEntryId;
    for (const method of ["delete", "put", "patch"]) {
      const r = await request(app)[method]("/api/journal/" + id).send({ idea: { target: 1 } });
      expect(r.status).toBe(404);
    }
    expect((await request(app).get("/api/journal/" + id)).body.entry.idea.target).toBe(110);
  });
});
