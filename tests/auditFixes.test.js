/**
 * tests/auditFixes.test.js — D-30: the Codex data-integrity audit (items 2–6).
 * (Item 1, the Brief, is D-28 / tests/brief.test.js; the bulletin's data block is
 * covered in tests/bulletin.test.js.)
 *
 *   2. FRED latest-observation fetch must look past a newest "." row
 *   4. validate() must keep server-added provenance fields (basis)
 *   5. Markets: freshness graded against now; Events/Risk keep the stale flag
 *   6. Research "data as of" = the oldest figure's date, not the generation date
 */
"use strict";

const NOW  = Date.parse("2026-10-20T17:00:00Z");

beforeEach(() => jest.resetModules());

// ── 2. FRED ────────────────────────────────────────────────────────────────────
describe("FRED latest observation (audit item 2)", () => {
  test("asks FRED for several newest rows, so a newest '.' row cannot lose the series", async () => {
    process.env.FRED_API_KEY = "k";
    const calls = [];
    global.fetch = jest.fn(async (url) => {
      calls.push(String(url));
      // what FRED returns for limit>=2: today's row has no value yet, yesterday's does
      return { ok: true, status: 200, json: async () => ({ observations: [
        { date: "2026-10-20", value: "." }, { date: "2026-10-19", value: "4.55" } ] }) };
    });
    const fred = require("../server/providers/fred");
    const o = await fred.getLatestObservation("DGS10");
    expect(o).toMatchObject({ value: 4.55, date: "2026-10-19" });
    const limit = Number(new URL(calls[0]).searchParams.get("limit"));
    expect(limit).toBeGreaterThan(1);                       // limit=1 returned ONLY the "." row
    expect(new URL(calls[0]).searchParams.get("sort_order")).toBe("desc");
  });
});

// ── 4. Schemas ─────────────────────────────────────────────────────────────────
describe("validate() keeps provenance fields (audit item 4)", () => {
  const { schemas, validate } = require("../server/schemas");
  const env = { source: "computed", fetchedAt: "2026-10-20T00:00:00.000Z", stale: false };

  test("events keep `basis`", () => {
    const events = [{ headline: "h", impact: "NEUTRAL", ticker: "MACRO", detail: "d", date: "2026-10-19", basis: "observation" }];
    const r = validate(schemas.EventsResponse, { ...env, data: { events, econ: [] } });
    expect(r.ok).toBe(true);
    expect(r.data.data.events[0].basis).toBe("observation");
  });

  test("risks keep `basis`", () => {
    const risks = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, title: "t", level: "LOW", score: 10, detail: "d", affects: "ALL", basis: "rules-based from FRED" }));
    const r = validate(schemas.RiskResponse, { ...env, data: { risks } });
    expect(r.ok).toBe(true);
    expect(r.data.data.risks[0].basis).toBe("rules-based from FRED");
  });
});

// ── 5. Markets freshness ───────────────────────────────────────────────────────
describe("Markets freshness is graded on read (audit item 5)", () => {
  const exch = (asOf) => ({ id: "ES", ok: true, stale: false, fetchedAt: "2026-10-20T14:45:00Z",
    quote: { value: 5000, asOf, source: "Yahoo Finance" }, freshness: { code: "realtime", label: "Real-time", ageMin: 0 } });
  const daily = { id: "DGS10", ok: true, stale: false, fetchedAt: "2026-10-20T14:45:00Z",
    quote: { value: 4.5, asOf: "2026-10-19", cadence: "daily", source: "FRED" }, freshness: { code: "daily", label: "Daily close" } };

  test("a print fetched at 14:45 is not still 'Real-time' at 17:00; the stored snapshot is untouched", () => {
    const { ageFreshness } = require("../server/markets/service");
    const snap = { generatedAt: "2026-10-20T14:45:00Z", items: [exch("2026-10-20T14:44:30Z"), daily] };
    const aged = ageFreshness(snap, NOW);
    expect(aged.items[0].freshness.code).toBe("closed");
    expect(aged.items[0].freshness.label).toBe("Last trade");
    expect(aged.items[1].freshness.label).toBe("Daily close");       // no age in a daily label
    // even a daily row whose quote lacks `cadence` keeps its grade (only exchange prints are re-graded)
    const noCadence = { ...daily, quote: { value: 4.5, asOf: "2026-10-19", source: "FRED" } };
    expect(ageFreshness({ items: [noCadence] }, NOW).items[0].freshness.label).toBe("Daily close");
    expect(snap.items[0].freshness.label).toBe("Real-time");         // pure: input not mutated
  });

  test("a print less than 2 minutes old still reads Real-time", () => {
    const { ageFreshness } = require("../server/markets/service");
    const aged = ageFreshness({ items: [exch(new Date(NOW - 60_000).toISOString())] }, NOW);
    expect(aged.items[0].freshness.label).toBe("Real-time");
  });

  test("failed items and a missing snapshot pass through", () => {
    const { ageFreshness } = require("../server/markets/service");
    expect(ageFreshness(null)).toBeNull();
    const bad = { id: "X", ok: false, attempted: [] };
    expect(ageFreshness({ items: [bad] }, NOW).items[0]).toBe(bad);
  });

  test("GET /api/markets serves aged labels", async () => {
    const request = require("supertest");
    const markets = require("../server/markets/service");
    jest.spyOn(markets, "getSnapshot").mockReturnValue({ generatedAt: "2026-10-20T14:45:00Z", items: [exch("2026-10-20T14:44:30Z")] });
    const realNow = Date.now; Date.now = () => NOW;
    try {
      const res = await request(require("../server/index")).get("/api/markets");
      expect(res.body.items[0].freshness.label).toBe("Last trade");
    } finally { Date.now = realNow; }
  });
});

describe("Events/Risk read the Markets snapshot with stale flags intact (audit item 5)", () => {
  const item = (id, value, extra = {}) => ({ id, ok: true, stale: false, fetchedAt: "2026-10-20T07:45:00Z",
    quote: { value, asOf: "2026-10-19", source: "FRED" }, freshness: { label: "Daily close" }, ...extra });

  test("a rate Markets carried forward is stale in the context; missing series are absent, not zero", () => {
    const markets = require("../server/markets/service");
    const ctx = markets.narrativeContext({ items: [
      item("US10Y", 4.5, { stale: true, staleSince: "2026-10-14T07:45:00Z" }),
      item("HYOAS", 3.17),
      { id: "REAL10", ok: false, attempted: [] },
    ] });
    expect(ctx.rates.dgs10).toMatchObject({ value: 4.5, stale: true, staleSince: "2026-10-14T07:45:00Z" });
    expect(ctx.rates.hy_spread).toMatchObject({ value: 3.17, stale: false });
    expect(ctx.rates.dfii10).toBeUndefined();
  });

  test("no snapshot → empty context (never seeds)", () => {
    const markets = require("../server/markets/service");
    expect(markets.narrativeContext(null).rates).toEqual({});
  });

  test("the no-AI cards say STALE, and name the real source of a Yahoo-served 10Y", () => {
    const { generateNarrative } = require("../server/analytics/narrativeEngine");
    const n = generateNarrative({ rates: {
      dgs10: { value: 4.5, date: "2026-10-14", source: "Yahoo Finance", stale: true },
      hy_spread: { value: 3.17, date: "2026-10-19", source: "FRED" },
    } });
    const tenY = n.events.find(e => /10Y Treasury/.test(e.headline));
    expect(tenY.detail).toMatch(/Yahoo Finance, as of 2026-10-14 — STALE/);
    expect(tenY.detail).not.toMatch(/FRED DGS10/);               // it was not a FRED figure
    const hy = n.events.find(e => /high-yield/.test(e.headline));
    expect(hy.detail).toMatch(/FRED BAMLH0A0HYM2, as of 2026-10-19/);
    expect(hy.detail).not.toMatch(/STALE/);
  });
});

describe("every figure on a combined event card is dated and STALE-flagged (Codex review of PR #9)", () => {
  test("a fresh 10Y with a carried-forward real yield and breakeven: the secondary figures say STALE", () => {
    const { generateNarrative } = require("../server/analytics/narrativeEngine");
    const n = generateNarrative({ rates: {
      dgs10:  { value: 4.5,  date: "2026-10-19", source: "FRED" },
      dfii10: { value: 1.91, date: "2026-10-14", source: "FRED", stale: true },
      t10yie: { value: 2.46, date: "2026-10-14", source: "FRED", stale: true },
    } });
    const tenY = n.events.find(e => /10Y Treasury/.test(e.headline));
    expect(tenY.detail).toMatch(/Real yield 1\.91% \(FRED DFII10, as of 2026-10-14 — STALE/);
    expect(tenY.detail).toMatch(/Breakeven 2\.46% \(FRED T10YIE, as of 2026-10-14 — STALE/);
    expect(tenY.detail).toMatch(/Latest observation \(FRED DGS10, as of 2026-10-19\)\./);   // the fresh one is not flagged
  });
});

// ── 6. Research "data as of" ───────────────────────────────────────────────────
describe("research data-as-of is the oldest figure, not the generation date (audit item 6)", () => {
  test("oldestFigureDate: earliest date among rows, timestamps trimmed, null when none", () => {
    const { oldestFigureDate } = require("../server/providers/macroContext");
    expect(oldestFigureDate([{ asOf: "2026-10-19" }, { asOf: "2026-10-14" }, { asOf: "2026-10-20T09:14:00Z" }])).toBe("2026-10-14");
    expect(oldestFigureDate([{ asOf: null }, {}])).toBeNull();
    expect(oldestFigureDate([])).toBeNull();
    expect(oldestFigureDate(undefined)).toBeNull();
  });
});
