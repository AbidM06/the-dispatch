/**
 * tests/reportExhibits.test.js - live market charts inside research reports (D-28, PR 4 of 4).
 * The chart set is fixed in code per report type: every exhibit must point at something the app can really draw,
 * and nothing here calls AI or any network.
 */
"use strict";

const request = require("supertest");

beforeEach(() => { jest.resetModules(); });

const TYPES = ["macro", "fx", "rates", "thematic", "equity", "commodities", "sector"];

describe("the fixed exhibit set", () => {
  test("every report type has at least one exhibit; an unknown type has none", () => {
    const { exhibitsFor } = require("../server/research/exhibits");
    for (const t of TYPES) expect(exhibitsFor(t).length).toBeGreaterThan(0);
    expect(exhibitsFor("nonsense")).toEqual([]);
    expect(exhibitsFor(undefined)).toEqual([]);
  });

  test("every instrument an exhibit plots exists in the Markets universe, and none is a prediction market", () => {
    const { exhibitsFor } = require("../server/research/exhibits");
    const { INSTRUMENTS } = require("../server/markets/instruments");
    const byId = new Map(INSTRUMENTS.map(i => [i.id, i]));
    for (const t of TYPES) for (const e of exhibitsFor(t)) {
      const ids = e.kind === "compare" ? e.ids : e.kind === "chart" ? [e.id] : [];
      for (const id of ids) {
        expect(byId.has(id)).toBe(true);
        expect(byId.get(id).group).not.toBe("predictions");
      }
      if (e.kind === "chart") expect(e.item).toMatchObject({ id: e.id, label: byId.get(e.id).label, decimals: byId.get(e.id).decimals });
    }
  });

  test("compare exhibits are ones the compare route accepts (2-4 instruments; spreads only in a shared unit)", () => {
    const { exhibitsFor } = require("../server/research/exhibits");
    const { INSTRUMENTS } = require("../server/markets/instruments");
    const byId = new Map(INSTRUMENTS.map(i => [i.id, i]));
    for (const t of TYPES) for (const e of exhibitsFor(t).filter(x => x.kind === "compare")) {
      expect(e.ids.length).toBeGreaterThanOrEqual(2);
      expect(e.ids.length).toBeLessThanOrEqual(4);
      expect(new Set(e.ids).size).toBe(e.ids.length);
      expect(["1d", "1y", "5y"]).toContain(e.tf);
      if (e.mode === "spread") {
        expect(e.ids).toHaveLength(2);
        const [a, b] = e.ids.map(id => byId.get(id));
        const unit = (i) => i.spreadUnit || i.unit;
        expect(unit(a)).toBeTruthy();
        expect(unit(a)).toBe(unit(b));
      }
    }
  });

  test("macro exhibits name a real catalogue series and carry its label", () => {
    const { exhibitsFor } = require("../server/research/exhibits");
    const { MACRO } = require("../server/markets/views");
    for (const t of TYPES) for (const e of exhibitsFor(t).filter(x => x.kind === "macro")) {
      const def = MACRO.find(m => m.id === e.id);
      expect(def).toBeTruthy();
      expect(e.label).toBe(def.label);
    }
  });

  test("every fact key is a series the verified-data block really carries", () => {
    const { exhibitsFor } = require("../server/research/exhibits");
    const { SERIES } = require("../server/providers/macroContext");
    const keys = new Set(SERIES.map(s => s.key));
    for (const t of TYPES) for (const e of exhibitsFor(t)) for (const k of e.factKeys) expect(keys.has(k)).toBe(true);
  });

  test("no exhibit is chosen by the model: the spec contains no free text from a report", () => {
    const { exhibitsFor } = require("../server/research/exhibits");
    // specs are built from constants only; calling twice yields equal, independent copies
    const a = exhibitsFor("fx"), b = exhibitsFor("fx");
    expect(a).toEqual(b);
    a[0].ids.push("X");
    expect(exhibitsFor("fx")[0].ids).not.toContain("X");
  });
});

describe("verified-data rows and the report payload", () => {
  test("verified rows carry the fact key the exhibits match on", () => {
    const mc = require("../server/providers/macroContext");
    const rows = mc.toMarketDataRows({ facts: {
      dgs10: { key: "dgs10", label: "10Y UST Nominal", group: "rates", formatted: "4.50%", source: "FRED", seriesId: "DGS10", asOf: "2026-10-19" },
    } });
    expect(rows[0].key).toBe("dgs10");
  });

  test("GET /api/research/report serves the exhibits for a stored report, including one written before this change", async () => {
    const store = require("../server/research/reportStore");
    store.save({
      reportId: store.makeReportId("fx", 1), version: 1, reportType: "fx", generatedAt: "2026-10-01T09:00:00Z", dataAsOf: null,
      topic: null, research: { title: "old report, no exhibits field", marketData: [] }, thesisFrame: null,
      institutionalQA: { verdict: "NOT_RUN" }, claims: [], sources: [], corrections: [], meta: {},
    });
    const res = await request(require("../server/index")).get("/api/research/report?type=fx");
    expect(res.status).toBe(200);
    const ex = res.body.data.exhibits;
    expect(ex.map(e => e.kind)).toEqual(["compare", "chart"]);
    expect(ex[0].ids).toEqual(["GBPUSD", "EURUSD", "USDJPY"]);
    expect(ex[1].item.id).toBe("DXY");
  });
});
