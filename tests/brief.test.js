/**
 * tests/brief.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GET /api/brief — deterministic daily brief, built ONLY from the Markets
 * snapshot (D-02: no seeds, no hardcoded baselines, no typed-in calendar).
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const fs      = require("fs");
const path    = require("path");
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

// A Markets item the way service.js builds it.
function item(id, value, prevValue, extra = {}) {
  return {
    id, ok: true, stale: false, group: "rates",
    quote: { value, prevValue, change: prevValue == null ? null : value - prevValue,
             asOf: "2026-10-19T00:00:00.000Z", source: "FRED", sourceUrl: `https://fred.stlouisfed.org/series/${id}` },
    freshness: { code: "closed", label: "Daily close" },
    ...extra,
  };
}

function snapshot(items) {
  return { version: 1, generatedAt: "2026-10-20T07:45:00.000Z", items };
}

// Values deliberately unlike any old seed so a leak would be obvious.
const FULL = () => snapshot([
  item("US10Y",  4.62, 4.55),
  item("REAL10", 2.10, 2.05),
  item("BEI10",  2.52, 2.50),
  item("HYOAS",  3.17, 3.00),
  item("T10Y2Y", -0.20, -0.18),
]);

let app, markets;

function setSnapshot(snap) {
  jest.spyOn(markets, "getSnapshot").mockReturnValue(snap);
}

beforeEach(() => {
  jest.resetModules();
  mockProviders();
  app = require("../server/index");
  markets = require("../server/markets/service");
});

afterEach(() => jest.restoreAllMocks());

describe("GET /api/brief", () => {
  test("no Markets snapshot → 503 available:false with a reason, nothing invented", async () => {
    setSnapshot(null);
    const res = await request(app).get("/api/brief");
    expect(res.status).toBe(503);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toMatch(/Markets snapshot/i);
    expect(res.body.data).toBeUndefined();
  });

  test("snapshot with none of the five rate series → 503 available:false", async () => {
    setSnapshot(snapshot([item("SPX", 5000, 4990, { group: "equities" })]));
    const res = await request(app).get("/api/brief");
    expect(res.status).toBe(503);
    expect(res.body.available).toBe(false);
  });

  test("full snapshot → 200, figures and deltas come from the snapshot", async () => {
    setSnapshot(FULL());
    const res = await request(app).get("/api/brief");
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.stale).toBe(false);
    expect(res.body.fetchedAt).toBe("2026-10-20T07:45:00.000Z");

    const rows = res.body.data.whatChanged;
    expect(rows.map(r => r.series)).toEqual(["DGS10", "DFII10", "T10YIE", "HY OAS", "T10Y2Y"]);
    const dgs10 = rows.find(r => r.series === "DGS10");
    expect(dgs10.current).toBe(4.62);
    expect(dgs10.prev).toBe(4.55);
    expect(dgs10.deltaBps).toBe(7);
    expect(dgs10.source).toBe("FRED");
    expect(dgs10.asOf).toBe("2026-10-19T00:00:00.000Z");
    expect(dgs10.sourceUrl).toMatch(/fred\.stlouisfed\.org/);
    // HY OAS is a percent figure: 3.17 vs 3.00 is +17bps, not "3bps".
    expect(rows.find(r => r.series === "HY OAS").deltaBps).toBe(17);
    expect(rows.find(r => r.series === "HY OAS").signal).toBe("BEARISH");
    expect(res.body.data.missing).toEqual([]);
    expect(res.body.data.oldestAsOf).toBe("2026-10-19T00:00:00.000Z");
  });

  test("regime and prose are computed from the snapshot values", async () => {
    setSnapshot(FULL());
    const { data } = (await request(app).get("/api/brief")).body;
    expect(data.regime).toContain("Inverted curve");
    expect(data.regime).toContain("High real yields");
    expect(data.regimeDrivers).toContain("Real yields 2.10% (TIPS 10Y)");
    expect(data.whyItMatters).toContain("2.10%");
    expect(data.whyItMatters).toContain("+17bps vs previous close");
    // No holdings, no portfolio, no stale advice.
    expect(data.whyItMatters).not.toMatch(/AMD|portfolio/i);
    expect(data.actionableSetup).toBeUndefined();
  });

  test("a series Markets lacks is reported unavailable, never back-filled", async () => {
    setSnapshot(snapshot([
      item("US10Y", 4.62, 4.55),
      item("REAL10", 1.20, 1.25),
      item("BEI10", 2.10, 2.10),
      item("T10Y2Y", 0.50, 0.50),
      { id: "HYOAS", ok: false, attempted: [{ provider: "fred", error: "boom" }] },
    ]));
    const { body } = await request(app).get("/api/brief");
    const hy = body.data.whatChanged.find(r => r.series === "HY OAS");
    expect(hy.available).toBe(false);
    expect(hy.current).toBeNull();
    expect(hy.deltaBps).toBeNull();
    expect(body.data.missing).toEqual(["HY OAS"]);
    // With a series missing the Brief must not claim "no stress signals" and must not
    // label the credit leg of the regime at all.
    expect(body.data.regime).not.toMatch(/Risk-off|Credit stress|Bear flattener/);
    expect(body.data.whyItMatters).toBeNull();
  });

  test("prose from the series that exist is still shown; nothing is said about the missing one", async () => {
    setSnapshot(snapshot([
      { id: "US10Y", ok: false, attempted: [] },
      item("REAL10", 2.10, 2.05), item("BEI10", 2.0, 2.0),
      item("HYOAS", 2.8, 2.8), item("T10Y2Y", 0.4, 0.4),
    ]));
    const { data } = (await request(app).get("/api/brief")).body;
    expect(data.missing).toEqual(["DGS10"]);
    expect(data.whyItMatters).toBe("Real yields at 2.10% mechanically compress growth equity multiples.");
    expect(data.regime).not.toMatch(/Rates restrictive/);
  });

  test("calm figures with everything present: no-stress sentence, not invented drivers", async () => {
    setSnapshot(snapshot([
      item("US10Y", 4.0, 4.0), item("REAL10", 1.0, 1.0), item("BEI10", 2.0, 2.0),
      item("HYOAS", 2.8, 2.8), item("T10Y2Y", 0.4, 0.4),
    ]));
    const { data } = (await request(app).get("/api/brief")).body;
    expect(data.whyItMatters).toBe("No regime-level stress signals in the latest figures.");
    expect(data.regimeDrivers).toEqual([]);
    expect(data.missing).toEqual([]);
  });

  test("a row with no previous value has no delta (not 0)", async () => {
    setSnapshot(snapshot([
      item("US10Y", 4.62, null), item("REAL10", 2.1, 2.05), item("BEI10", 2.5, 2.5),
      item("HYOAS", 3.17, 3.0), item("T10Y2Y", 0.1, 0.1),
    ]));
    const row = (await request(app).get("/api/brief")).body.data.whatChanged.find(r => r.series === "DGS10");
    expect(row.available).toBe(true);
    expect(row.deltaBps).toBeNull();
    expect(row.signal).toBeNull();
  });

  test("a figure Markets flagged stale is flagged stale in the Brief", async () => {
    const snap = FULL();
    snap.items[0] = item("US10Y", 4.62, 4.55, { stale: true, staleSince: "2026-10-15T07:45:00.000Z" });
    setSnapshot(snap);
    const { body } = await request(app).get("/api/brief");
    expect(body.stale).toBe(true);
    const row = body.data.whatChanged.find(r => r.series === "DGS10");
    expect(row.stale).toBe(true);
    expect(row.staleSince).toBe("2026-10-15T07:45:00.000Z");
  });

  test("nextEvent is explicitly unavailable when no calendar is stored — no typed-in calendar", async () => {
    setSnapshot(FULL());
    jest.spyOn(require("../server/markets/calendar"), "getCalendar").mockReturnValue({ available: false, reason: "Economic calendar unavailable - not fetched yet." });
    const { nextEvent } = (await request(app).get("/api/brief")).body.data;
    expect(nextEvent.available).toBe(false);
    expect(nextEvent.reason).toMatch(/calendar/i);
    expect(nextEvent.date).toBeUndefined();
  });

  describe("nextEvent comes from the stored FRED calendar (D-31)", () => {
    const EV = (extra = {}) => ({
      key: "cpi", date: "2026-10-24", event: "CPI (consumer prices)", release: "Consumer Price Index",
      previous: [{ label: "CPI inflation (YoY)", value: 2.9, period: "2026-09", text: "CPI inflation (YoY) 2.9% (2026-09)", sourceUrl: "https://fred.stlouisfed.org/series/CPIAUCSL" }],
      source: "FRED", sourceUrl: "https://www.bls.gov/cpi/", ...extra,
    });
    const stored = (over = {}) => jest.spyOn(require("../server/markets/calendar"), "getCalendar").mockReturnValue({
      available: true, source: "FRED", generatedAt: "2026-10-21T07:45:00.000Z", stale: false,
      events: [EV(), EV({ key: "gdp", date: "2026-10-29", event: "GDP", previous: [] })],
      missing: [{ key: "fomc", label: "FOMC decision", reason: "FRED has no release with this name" }], ...over,
    });

    test("the soonest event, with its previous reading, source, and what FRED does not list", async () => {
      setSnapshot(FULL()); stored();
      const { nextEvent } = (await request(app).get("/api/brief")).body.data;
      expect(nextEvent).toMatchObject({
        available: true, date: "2026-10-24", name: "CPI (consumer prices)", source: "FRED", stale: false,
        missing: ["FOMC decision"],
      });
      expect(nextEvent.previous[0].text).toBe("CPI inflation (YoY) 2.9% (2026-09)");
    });

    test("a stale calendar is flagged", async () => {
      setSnapshot(FULL()); stored({ stale: true });
      expect((await request(app).get("/api/brief")).body.data.nextEvent.stale).toBe(true);
    });

    test("a stored calendar with nothing in the next 90 days is 'unavailable' with the reason, not an old date", async () => {
      setSnapshot(FULL()); stored({ events: [] });
      const { nextEvent } = (await request(app).get("/api/brief")).body.data;
      expect(nextEvent.available).toBe(false);
      expect(nextEvent.reason).toMatch(/no release in the next 90 days/);
    });

    test("an available next event matches the response schema", async () => {
      setSnapshot(FULL()); stored();
      const { body } = await request(app).get("/api/brief");
      const { schemas, validate } = require("../server/schemas");
      expect(validate(schemas.BriefResponse, body).ok).toBe(true);
    });
  });

  test("the response matches its schema", async () => {
    setSnapshot(FULL());
    const { body } = await request(app).get("/api/brief");
    const { schemas, validate } = require("../server/schemas");
    expect(validate(schemas.BriefResponse, body).ok).toBe(true);
  });
});

describe("Brief has no seed data (D-02)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server", "routes", "brief.js"), "utf8");

  test("brief.js does not import the seeds or carry hardcoded baselines / calendars", () => {
    expect(src).not.toMatch(/seeds\/fallback/);
    expect(src).not.toMatch(/PREV_RATES|RATES_SEED|MACRO_CAL|EARNINGS_CAL|SEED_DATE/);
  });

  test("brief.js carries no holdings advice", () => {
    expect(src).not.toMatch(/SGLN|HBKS|HIES|\bAMD\b|MI450|ACCUMULATE/);
  });
});
