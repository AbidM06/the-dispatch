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
    test("monthly series — a normal between-release age is not stale", () => {
      const monthly = { ...card().priceAtIdea, asOf: "2026-08-14T12:30:00.000Z", freshness: "Monthly data", cadence: "monthly" };
      const r = referenceFrom(card({ priceAtIdea: monthly }));
      expect(r).toMatchObject({ status: "ok", cadence: "monthly" });
      const labelOnly = { ...monthly }; delete labelOnly.cadence;          // cards logged before cadence was recorded
      expect(referenceFrom(card({ priceAtIdea: labelOnly })).status).toBe("ok");
    });
    test("monthly series — the upstream stale flag still counts", () => {
      const p = { ...card().priceAtIdea, asOf: "2026-08-14T12:30:00.000Z", freshness: "stale", cadence: "monthly" };
      expect(referenceFrom(card({ priceAtIdea: p })).status).toBe("stale");
    });
    test("daily series — the age cutoff still applies", () => {
      const p = { ...card().priceAtIdea, asOf: "2026-09-18T20:00:00.000Z", freshness: "Daily close", cadence: "daily" };
      expect(referenceFrom(card({ priceAtIdea: p })).status).toBe("stale");
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
    // mixed units: the longest duration named decides, not the first unit found
    ["2 weeks to 3 months", "swing"], ["3 months to 1 year", "strategic"], ["1 week-6 months", "strategic"],
    ["6 to 9 months", "strategic"], ["10-year yield, over 2 weeks", "tactical"],
    // hyphenated durations (Codex review) — but a bond tenor is never a horizon
    ["6-month", "strategic"], ["1-year", "strategic"], ["2-week", "tactical"], ["3-month view", "swing"],
    ["2-3-month", "swing"], ["10-year yield", "undeclared"], ["2y swap over 1 month", "swing"],
    ["6-month hold on the 2-year note", "strategic"], ["1 month, 10-year real yields", "swing"],
    // multi-leg rates phrases: every maturity in the chain is the instrument's
    ["2-year vs 10-year yields, 6-month horizon", "strategic"], ["2y/10y curve steepener over 3 months", "swing"],
    ["2-year and 5-year notes for 1 month", "swing"], ["3 months vs 6 months", "strategic"],
    // comma baskets join only compactly written tenors; a worded duration stays a horizon
    ["2-year, 10-year and 30-year yields over 6 months", "strategic"], ["2y, 5y, 10y swaps, 2 weeks", "tactical"],
    // instrument nouns as written on a desk (Codex review: "Treasury" never matched)
    ["10-year Treasury, 6-month horizon", "strategic"], ["10y Treasuries over 3 months", "swing"],
    ["2-year T-note, 1 month", "swing"], ["3-month T-bill, 2 weeks", "tactical"], ["5-year TIPS for 3 months", "swing"],
    ["10-year Bund vs 10-year gilt, 1 month", "swing"], ["2-year German Schatz, 1 month", "swing"],
    ["10-year JGB yields, 6 months", "strategic"], ["10-year OAT-Bund spread over 3 months", "swing"],
    ["2-year €STR, 1 month", "swing"], ["2-year ESTR, 1 month", "swing"],
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

  test("the reference time is the OBSERVATION time, not the provider's publish time", async () => {
    const app = setup();
    const markets = require("../server/markets/service");
    markets.getSnapshot.mockReturnValue({
      generatedAt: CREATED,
      items: [{ id: "BRENT", label: "Brent crude", group: "commodities", ok: true, unit: null,
        quote: { value: 100.5, asOf: "2026-09-25T00:00:00.000Z", releasedAt: "2026-09-28T08:00:00.000Z", cadence: "daily",
                 source: "FRED", sourceUrl: "https://fred.stlouisfed.org/series/DCOILBRENTEU" },
        freshness: { label: "Daily close" } }],
    });
    const gen = await request(app).post("/api/ideas/news").send({});
    const e = (await request(app).get("/api/journal/" + gen.body.idea.journalEntryId)).body.entry;
    expect(e.reference).toMatchObject({ asOf: "2026-09-25T00:00:00.000Z", releasedAt: "2026-09-28T08:00:00.000Z", cadence: "daily" });
  });

  test("dismissing the card does not remove the Journal entry", async () => {
    const app = setup();
    const gen = await request(app).post("/api/ideas/news").send({});
    await request(app).delete("/api/ideas/" + gen.body.idea.id);
    const one = await request(app).get("/api/journal/" + gen.body.idea.journalEntryId);
    expect(one.status).toBe(200);
    expect(one.body.entry.integrity).toBe("intact");
  });

  test("dismissing a pre-Journal card logs it first, even if the Journal was never opened", async () => {
    const app = setup();
    const old = card({ id: "IDEA-prejournal" });
    require("../server/ideas/store").add(old);          // a card from before the Journal existed
    const journal = require("../server/journal/store");
    expect(journal.findEntryByIdea(old.id)).toBeNull();
    expect((await request(app).delete("/api/ideas/" + old.id)).status).toBe(200);
    const e = journal.findEntryByIdea(old.id);
    expect(e).toMatchObject({ backfilled: true, integrity: "intact" });
    expect(e.idea.target).toBe(110);
  });

  test("startup backfill logs every stored card; a failed run retries", () => {
    setup();
    const ideaStore = require("../server/ideas/store");
    const journal = require("../server/journal/store");
    const migrate = require("../server/journal/migrate");
    ideaStore.add(card({ id: "IDEA-a" })); ideaStore.add(card({ id: "IDEA-b" }));
    const spy = jest.spyOn(journal, "backfill").mockImplementationOnce(() => { throw new Error("disk full"); });
    jest.spyOn(console, "warn").mockImplementation(() => {});
    migrate.ensureBackfilled();                          // fails…
    expect(journal.findEntryByIdea("IDEA-a")).toBeNull();
    migrate.ensureBackfilled();                          // …and is retried, not marked done
    expect(spy).toHaveBeenCalledTimes(2);
    expect(journal.findEntryByIdea("IDEA-a")).not.toBeNull();
    expect(journal.findEntryByIdea("IDEA-b")).not.toBeNull();
  });

  test("the server runs the backfill at startup", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "../server/index.js"), "utf8");
    expect(src).toMatch(/journal\/migrate"\)\.ensureBackfilled\(\)/);
  });

  test("a sealed idea stays sealed in the Journal (client)", () => {
    const html = require("fs").readFileSync(require("path").join(__dirname, "../client/index.html"), "utf8");
    const journalView = html.slice(html.indexOf("const row = (e) =>"), html.indexOf("The idea, exactly as generated"));
    expect(journalView).toMatch(/sealedIdeas\.includes\(e\.ideaId\)/);
    expect(journalView).toMatch(/SealedIdeaCard\(/);
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
