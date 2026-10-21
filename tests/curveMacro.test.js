/**
 * tests/curveMacro.test.js - yield-curve snapshot + macro series views (D-28, PR 3 of 4).
 * All FRED HTTP is mocked. Nothing here calls AI or any paid API.
 */
"use strict";

const request = require("supertest");

const NOW = new Date("2026-10-20T10:00:00Z");           // Tuesday; FRED's latest H.15 print is Monday 19 Oct

/** Weekdays from `from` to `to` inclusive, as YYYY-MM-DD. */
function weekdays(from, to, skip = []) {
  const out = [];
  for (let t = Date.parse(from + "T00:00:00Z"); t <= Date.parse(to + "T00:00:00Z"); t += 86_400_000) {
    const d = new Date(t);
    const s = d.toISOString().slice(0, 10);
    if (d.getUTCDay() % 6 && !skip.includes(s)) out.push(s);
  }
  return out;
}
const obsBody = (rows) => ({ observations: rows.map(([date, v]) => ({ date, value: String(v) })) });

// ── curve fixtures ───────────────────────────────────────────────────────────
const BASE = { DGS1MO: 4.30, DGS3MO: 4.25, DGS6MO: 4.15, DGS1: 4.00, DGS2: 4.00, DGS3: 4.05, DGS5: 4.15, DGS7: 4.30, DGS10: 4.50, DGS20: 4.80, DGS30: 4.90 };
function curveFetch({ failSeries = [], skipDates = [], end = "2026-10-19" } = {}) {
  return jest.fn(async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/series/observations")) {
      const id = u.searchParams.get("series_id");
      if (failSeries.includes(id)) return { ok: false, status: 500, json: async () => ({}) };
      // DGS2 was 25bp higher before 20 Sep 2026, so the 2s10s spread changed over the last month.
      const rows = weekdays("2024-01-01", end, skipDates).map(d => [d, id === "DGS2" && d < "2026-09-20" ? BASE[id] + 0.25 : BASE[id]]);
      return { ok: true, status: 200, json: async () => obsBody(rows) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

beforeEach(() => {
  jest.resetModules();
  process.env.FRED_API_KEY = "test";
});

describe("yield curve", () => {
  test("latest curve + 1 week / 1 month / 1 year earlier, each on the date it really is from", async () => {
    global.fetch = curveFetch();
    const views = require("../server/markets/views");
    const c = await views.buildYieldCurve(NOW);
    expect(c.latestDate).toBe("2026-10-19");
    expect(c.curves.map(x => x.key)).toEqual(["today", "1w", "1m", "1y"]);
    expect(c.curves[0].date).toBe("2026-10-19");
    expect(c.curves[1].date).toBe("2026-10-12");
    expect(c.curves[2].date).toBe("2026-09-18");           // 19 Sep is a Saturday -> Friday 18th, a real print
    expect(c.curves[3].date).toBe("2025-10-17");           // 19 Oct 2025 is a Sunday -> Friday 17th
    expect(c.maturities.map(m => m.label)).toEqual(["1M", "3M", "6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "20Y", "30Y"]);
    expect(c.curves[0].points.find(p => p.maturity === "10Y")).toMatchObject({ v: 4.5, years: 10 });
    expect(c.maturities.find(m => m.label === "10Y").sourceUrl).toBe("https://fred.stlouisfed.org/series/DGS10");
    expect(c.stale).toBe(false);
  });

  test("spreads are computed from the same observations, in basis points, and labelled as computed", async () => {
    global.fetch = curveFetch();
    const c = await require("../server/markets/views").buildYieldCurve(NOW);
    const s210 = c.spreads.find(s => s.key === "2s10s");
    expect(s210.values).toEqual({ today: 50, "1w": 50, "1m": 25, "1y": 25 });   // 10Y 4.50 - 2Y 4.00 (4.25 before 20 Sep)
    expect(s210.computed).toMatch(/computed from FRED DGS10 and DGS2/);
    expect(c.spreads.find(s => s.key === "3m10y").values.today).toBe(25);         // 4.50 - 4.25
    expect(c.spreads.find(s => s.key === "5s30s").values.today).toBe(75);         // 4.90 - 4.15
  });

  test("month arithmetic clamps to the end of the shorter month (31 Mar - 1 month is 28 Feb, not 3 Mar)", () => {
    const { monthsBefore } = require("../server/markets/views");
    expect(monthsBefore("2026-03-31", 1)).toBe("2026-02-28");
    expect(monthsBefore("2026-05-31", 1)).toBe("2026-04-30");
    expect(monthsBefore("2024-03-31", 1)).toBe("2024-02-29");       // leap year
    expect(monthsBefore("2024-02-29", 12)).toBe("2023-02-28");      // a year before a leap day
    expect(monthsBefore("2026-10-19", 1)).toBe("2026-09-19");       // ordinary days unchanged
    expect(monthsBefore("2026-01-31", 2)).toBe("2025-11-30");
  });

  test("the 1-month-earlier curve for a 31 March latest date is the end of February, not 3 March", async () => {
    global.fetch = curveFetch({ end: "2026-03-31" });
    const c = await require("../server/markets/views").buildYieldCurve(new Date("2026-04-01T10:00:00Z"));
    expect(c.latestDate).toBe("2026-03-31");
    expect(c.curves.find(x => x.key === "1m").date).toBe("2026-02-27");   // 28 Feb 2026 is a Saturday -> Friday 27th
    expect(c.curves.find(x => x.key === "1y").date).toBe("2025-03-31");
  });

  test("a market holiday (no print) falls back to the previous real date, never an invented one", async () => {
    global.fetch = curveFetch({ skipDates: ["2026-10-12"] });
    const c = await require("../server/markets/views").buildYieldCurve(NOW);
    expect(c.curves[1].date).toBe("2026-10-09");
  });

  test("a maturity that fails is named and left out; the rest still plot", async () => {
    global.fetch = curveFetch({ failSeries: ["DGS20"] });
    const c = await require("../server/markets/views").buildYieldCurve(NOW);
    expect(c.missing).toEqual([expect.objectContaining({ label: "20Y", series: "DGS20" })]);
    expect(c.maturities.map(m => m.label)).not.toContain("20Y");
    expect(c.curves[0].points).toHaveLength(10);
  });

  test("too few maturities is refused with a plain message", async () => {
    global.fetch = curveFetch({ failSeries: ["DGS1MO", "DGS3MO", "DGS6MO", "DGS1", "DGS2", "DGS3", "DGS5", "DGS7"] });
    await expect(require("../server/markets/views").buildYieldCurve(NOW)).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/too few maturities/) });
  });

  test("an old latest curve is flagged stale", async () => {
    global.fetch = curveFetch();
    const c = await require("../server/markets/views").buildYieldCurve(new Date("2026-10-19T10:00:00Z"));   // data end 19 Oct: same day, fresh
    expect(c.stale).toBe(false);
    const old = await require("../server/markets/views").buildYieldCurve(new Date("2026-10-25T10:00:00Z"));
    expect(old.stale).toBe(true);
  });
});

// ── macro fixtures ───────────────────────────────────────────────────────────
function monthly(from, n, f) {                          // first-of-month dates
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1 + i, 1));
    return [d.toISOString().slice(0, 10), f(i)];
  });
}
function macroFetch({ series = {}, releaseDates = ["2026-09-04", "2026-10-02"], releaseFail = false, calls = [] } = {}) {
  return jest.fn(async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith("/series/observations")) {
      const id = u.searchParams.get("series_id");
      return { ok: true, status: 200, json: async () => obsBody(series[id] || []) };
    }
    if (u.pathname.endsWith("/series/release")) {
      if (releaseFail) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ releases: [{ id: 50, name: "Employment Situation", link: "https://www.bls.gov/ces/" }] }) };
    }
    if (u.pathname.endsWith("/release/dates")) {
      if (releaseFail) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ release_dates: releaseDates.map(date => ({ release_id: 50, date })) }) };
    }
    if (u.pathname.endsWith("/series")) return { ok: true, status: 200, json: async () => ({ seriess: [{ title: "Test series" }] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

describe("macro series", () => {
  test("period helpers: month and quarter ends and labels", () => {
    const { periodEnd, periodLabel } = require("../server/markets/views");
    expect(periodEnd("2026-08-01", "M")).toBe("2026-08-31");
    expect(periodEnd("2026-02-01", "M")).toBe("2026-02-28");
    expect(periodEnd("2026-04-01", "Q")).toBe("2026-06-30");
    expect(periodLabel("2026-04-01", "Q")).toBe("2026 Q2");
    expect(periodLabel("2026-08-01", "M")).toBe("2026-08");
  });

  test("each print is paired with the first release date AFTER its period ended", () => {
    const { pairReleaseDates } = require("../server/markets/views");
    const obs = [{ date: "2026-07-01", v: 1 }, { date: "2026-08-01", v: 2 }, { date: "2026-09-01", v: 3 }];
    const out = pairReleaseDates(obs, ["2026-08-07", "2026-09-04", "2026-10-02"], "M");
    expect(out.map(o => o.published)).toEqual(["2026-08-07", "2026-09-04", "2026-10-02"]);
    // Nothing published after the period -> null, never a guess.
    expect(pairReleaseDates([{ date: "2026-10-01", v: 4 }], ["2026-10-02"], "M")[0].published).toBeNull();
  });

  test("payrolls: monthly change in thousands, with the published date of each print", async () => {
    const levels = monthly("2025-08-01", 14, i => 159_000 + i * 100);           // +100k a month, Aug 2025 .. Sep 2026
    global.fetch = macroFetch({ series: { PAYEMS: levels }, releaseDates: ["2026-09-04", "2026-08-07"] });             // no October release in the calendar yet
    const views = require("../server/markets/views");
    const def = views.MACRO.find(m => m.id === "payrolls");
    const m = await views.buildMacro(def, "1y", NOW);
    expect(m.style).toBe("bars");
    expect(m.latest).toMatchObject({ period: "2026-09", value: 100 });
    expect(m.latest.published).toBeNull();                                     // Sep print is not yet in the release calendar
    const aug = m.prints.find(p => p.period === "2026-08");
    expect(aug).toMatchObject({ value: 100, published: "2026-09-04" });         // August data, first Friday of September
    expect(m.release).toMatchObject({ available: true, name: "Employment Situation" });
    expect(m.note).toMatch(/inferred from the release calendar/);
  });

  test("CPI year-on-year needs the year before: the first plotted month is a real change", async () => {
    const idx = monthly("2024-09-01", 26, i => 300 * Math.pow(1.003, i));          // +0.3% a month
    global.fetch = macroFetch({ series: { CPIAUCSL: idx } });
    const views = require("../server/markets/views");
    const m = await views.buildMacro(views.MACRO.find(m => m.id === "cpi"), "1y", NOW);
    expect(m.unit).toBe("%");
    expect(m.latest.value).toBeCloseTo((Math.pow(1.003, 12) - 1) * 100, 2);
    expect(m.points[0].t).toBeGreaterThanOrEqual(Math.floor(Date.parse("2025-10-20") / 1000) - 40 * 86400);
  });

  test("an unavailable release calendar degrades: the series still plots, the gap is stated", async () => {
    global.fetch = macroFetch({ series: { UNRATE: monthly("2025-10-01", 12, i => 4 + i * 0.01) }, releaseFail: true });
    const views = require("../server/markets/views");
    const m = await views.buildMacro(views.MACRO.find(m => m.id === "unrate"), "1y", NOW);
    expect(m.points.length).toBeGreaterThan(5);
    expect(m.release.available).toBe(false);
    expect(m.latest.published).toBeNull();
    expect(m.note).toMatch(/Release dates are unavailable/);
  });

  test("a daily series (fed funds) has no release dates and never asks FRED for any", async () => {
    const calls = [];
    const daily = weekdays("2025-10-20", "2026-10-19").map(d => [d, 4.33]);
    global.fetch = macroFetch({ series: { DFF: daily }, calls });
    const views = require("../server/markets/views");
    const m = await views.buildMacro(views.MACRO.find(m => m.id === "fedfunds"), "1y", NOW);
    expect(m.release).toBeNull();
    expect(m.note).toMatch(/no discrete release dates/);
    expect(calls.some(u => /series\/release|release\/dates/.test(u))).toBe(false);
  });

  test("quarterly GDP growth is labelled by quarter", async () => {
    const q = [["2025-07-01", 2.1], ["2025-10-01", 1.4], ["2026-01-01", 1.8], ["2026-04-01", 2.4], ["2026-07-01", 2.9]];
    global.fetch = macroFetch({ series: { A191RL1Q225SBEA: q }, releaseDates: ["2025-10-30", "2026-01-29", "2026-04-29", "2026-07-30", "2026-10-29"] });
    const views = require("../server/markets/views");
    const m = await views.buildMacro(views.MACRO.find(m => m.id === "gdp"), "5y", NOW);
    expect(m.prints[0]).toMatchObject({ period: "2026 Q3", value: 2.9, published: "2026-10-29" });
    expect(m.prints.find(p => p.period === "2026 Q2")).toMatchObject({ published: "2026-07-30" });
  });

  test("empty result is a plain 404 message, not an empty chart", async () => {
    global.fetch = macroFetch({ series: { UNRATE: [] } });
    const views = require("../server/markets/views");
    await expect(views.buildMacro(views.MACRO.find(m => m.id === "unrate"), "1y", NOW)).rejects.toMatchObject({ status: 404, message: expect.stringMatching(/No Unemployment rate observations/) });
  });
});

describe("routes", () => {
  function app() {
    jest.doMock("../server/providers/anthropic", () => ({ fetchAllAnalysis: jest.fn(), fetchTickerExplain: jest.fn(), callClaude: jest.fn() }));
    return require("../server/index");
  }

  test("GET /macro lists the catalogue; /macro/:id validates id and range; /curve serves the curve", async () => {
    global.fetch = curveFetch();
    const a = app();
    const list = await request(a).get("/api/markets/macro");
    expect(list.status).toBe(200);
    expect(list.body.groups.map(g => g.id)).toEqual(["inflation", "labour", "growth", "policy"]);
    expect(list.body.series.map(s => s.id)).toEqual(["cpi", "corecpi", "pce", "unrate", "payrolls", "gdp", "fedfunds"]);
    expect((await request(a).get("/api/markets/macro/nope")).status).toBe(404);
    const badRange = await request(a).get("/api/markets/macro/cpi?range=3y");
    expect(badRange.status).toBe(400);
    expect(badRange.body.error).toMatch(/Range must be one of/);
    const curve = await request(a).get("/api/markets/curve");
    expect(curve.status).toBe(200);
    expect(curve.body.source).toBe("FRED");
    expect(curve.body.curves[0].key).toBe("today");
  });
});
