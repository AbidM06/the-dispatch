/**
 * tests/markets.test.js — Markets panel: sources, provenance, fallbacks,
 * stale carry-forward, scheduler timing and routes. All HTTP is mocked.
 */
"use strict";

const request = require("supertest");

const NOW = Date.parse("2026-09-28T13:46:00Z");          // Mon 14:46 London (BST)
const epoch = (iso) => Math.floor(Date.parse(iso) / 1000);

function yahooBody(symbol, price, timeIso, pct = 1, extra = {}) {
  return {
    chart: { result: [{
      meta: { symbol, currency: "USD", exchangeName: "X", fullExchangeName: "TestEx",
              regularMarketPrice: price, regularMarketTime: epoch(timeIso),
              regularMarketChangePercent: pct, exchangeTimezoneName: "America/New_York", ...extra },
      timestamp: [epoch("2026-09-25T20:00:00Z"), epoch(timeIso)],
      indicators: { quote: [{ open: [1, 2], high: [2, 3], low: [0.5, 1.5], close: [1.5, price] }] },
    }] },
  };
}

function fredObsBody(values) {
  return { observations: values.map(([date, value]) => ({ date, value: String(value) })) };
}

/** Build a fetch mock; `overrides(url)` may return {status, body} to customise. */
function makeFetch(overrides = () => null) {
  return jest.fn(async (url) => {
    const o = overrides(url);
    if (o) return { ok: o.status < 400, status: o.status, json: async () => o.body };
    if (url.includes("finance.yahoo.com")) {
      const sym = decodeURIComponent(url.split("/chart/")[1].split("?")[0]);
      return { ok: true, status: 200, json: async () => yahooBody(sym, 100, new Date(NOW - 60_000).toISOString()) };
    }
    if (url.includes("/fred/series/observations")) {
      const id = new URL(url).searchParams.get("series_id");
      if (id === "CPIAUCSL") {
        const rows = [];
        for (let m = 0; m < 14; m++) {
          const d = new Date(Date.UTC(2025, 6 + m, 1));
          rows.push([d.toISOString().slice(0, 10), 300 + m]);
        }
        return { ok: true, status: 200, json: async () => fredObsBody(rows.reverse()) };
      }
      return { ok: true, status: 200, json: async () => fredObsBody([["2026-09-25", 2.9], ["2026-09-24", 2.8]]) };
    }
    if (url.includes("/fred/series?")) {
      return { ok: true, status: 200, json: async () => ({ seriess: [{ title: "Test series", frequency_short: "D", last_updated: "2026-09-26 08:01:03-05" }] }) };
    }
    if (url.includes("gamma-api.polymarket.com")) {
      return { ok: true, status: 200, json: async () => ([{
        id: "e1", title: "Fed Decision in October?", slug: "fed-oct", volume24hr: 1000,
        markets: [{ active: true, closed: false, slug: "fed-no-change", question: "No change in October?",
                    outcomePrices: '["0.33","0.67"]', outcomes: '["Yes","No"]', clobTokenIds: '["tok1","tok2"]',
                    volume24hr: 900, oneDayPriceChange: 0.02, updatedAt: "2026-09-28T13:40:00Z" }],
      }]) };
    }
    if (url.includes("clob.polymarket.com")) {
      return { ok: true, status: 200, json: async () => ({ history: [{ t: 1, p: 0.3 }, { t: 2, p: 0.33 }] }) };
    }
    if (url.includes("finnhub.io")) {
      return { ok: true, status: 200, json: async () => ({ c: 50, pc: 49, t: epoch("2026-09-28T13:45:00Z") }) };
    }
    if (url.includes("frankfurter")) {
      return { ok: true, status: 200, json: async () => ({ rates: { "2026-09-25": { USD: 1.3 }, "2026-09-26": { USD: 1.31 } } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate", "setTimeout", "setInterval", "clearInterval", "clearTimeout"] });
  process.env.FRED_API_KEY = "test";
  process.env.FINNHUB_API_KEY = "test";
  delete process.env.MARKETS_SNAPSHOT_PATH;
  global.fetch = makeFetch();
});
afterEach(() => { jest.useRealTimers(); });

// ─────────────────────────────────────────────────────────────────────────────
describe("sources — normalisation & provenance", () => {
  test("parseFredTimestamp converts FRED's offset format to ISO", () => {
    const { _internal } = require("../server/markets/sources");
    expect(_internal.parseFredTimestamp("2026-09-25 08:01:03-05")).toBe("2026-09-25T13:01:03.000Z");
    expect(_internal.parseFredTimestamp("garbage")).toBeNull();
  });

  test("YoY transform compares with the same month a year earlier", () => {
    const { _internal } = require("../server/markets/sources");
    const out = _internal.applyTransform([
      { date: "2025-08-01", v: 100 }, { date: "2026-08-01", v: 103 },
    ], { transform: "yoy" });
    expect(out).toHaveLength(1);
    expect(out[0].v).toBeCloseTo(3);
  });

  test("Yahoo quote carries venue, exchange print time and a checkable URL", async () => {
    const { _internal } = require("../server/markets/sources");
    const q = await _internal.yahooQuote({ symbol: "GC=F" });
    expect(q.source).toBe("Yahoo Finance");
    expect(q.sourceDetail).toBe("TestEx via Yahoo Finance");
    expect(q.sourceUrl).toContain("GC%3DF");
    expect(q.releasedAt).toBe(new Date(NOW - 60_000).toISOString());
    expect(q.cadence).toBe("tick");
    expect(q.changePct).toBeCloseTo(1, 3);
  });

  test("FRED quote reports observation date and publication time separately", async () => {
    const { _internal } = require("../server/markets/sources");
    const q = await _internal.fredQuote({ provider: "fred", series: "BAMLH0A0HYM2" });
    expect(q.value).toBe(2.9);
    expect(q.asOfDate).toBe("2026-09-25");
    expect(q.releasedAt).toBe("2026-09-26T13:01:03.000Z");
    expect(q.cadence).toBe("daily");
    expect(q.sourceUrl).toBe("https://fred.stlouisfed.org/series/BAMLH0A0HYM2");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("service — freshness, fallbacks, stale carry-forward", () => {
  test("classifyFreshness measures delay from the print time", () => {
    const { classifyFreshness } = require("../server/markets/service");
    const at = new Date(NOW).toISOString();
    expect(classifyFreshness({ cadence: "tick", asOf: new Date(NOW - 60_000).toISOString() }, at).code).toBe("realtime");
    const d = classifyFreshness({ cadence: "tick", asOf: new Date(NOW - 10 * 60_000).toISOString() }, at);
    expect(d.code).toBe("delayed"); expect(d.label).toBe("Delayed ~10 min");
    expect(classifyFreshness({ cadence: "tick", asOf: "2026-09-25T20:00:00Z" }, at).code).toBe("closed");
    expect(classifyFreshness({ cadence: "monthly" }, at).label).toBe("Monthly data");
  });

  test("refresh builds every group with provenance on every item", async () => {
    const markets = require("../server/markets/service");
    const snap = await markets.refresh("manual");
    expect(snap.trigger).toBe("manual");
    expect(snap.summary.failed).toBe(0);
    const groups = new Set(snap.items.map(i => i.group));
    for (const g of ["fx", "rates", "equities", "commodities", "crypto", "macro", "predictions"]) expect(groups.has(g)).toBe(true);
    for (const it of snap.items) {
      expect(it.quote.source).toBeTruthy();
      expect(it.quote.sourceUrl).toMatch(/^https:\/\//);
      expect(it.quote.releasedAt || it.quote.asOf).toBeTruthy();
      expect(it.fetchedAt).toBeTruthy();
      expect(it.freshness.label).toBeTruthy();
    }
    const pm = snap.items.find(i => i.group === "predictions");
    expect(pm.quote.value).toBe(33);
    expect(pm.quote.change).toBe(2);
    const cpi = snap.items.find(i => i.id === "USCPI");
    expect(cpi.freshness.code).toBe("daily"); // mock FRED says frequency D
  });

  test("falls back to the next source when the primary fails", async () => {
    global.fetch = makeFetch(url => url.includes("chart/AMD") ? { status: 500, body: {} } : null);
    const markets = require("../server/markets/service");
    const snap = await markets.refresh("manual");
    const amd = snap.items.find(i => i.id === "AMD");
    expect(amd.ok).toBe(true);
    expect(amd.fallbackUsed).toBe(true);
    expect(amd.quote.source).toBe("Finnhub");
    expect(amd.attempted[0].provider).toBe("yahoo");
    expect(snap.summary.fallbacks).toContain("AMD");
  });

  test("keeps the previous value, flagged stale, when every source fails", async () => {
    const markets = require("../server/markets/service");
    const first = await markets.refresh("manual");
    global.fetch = makeFetch(url => url.includes("chart/GC%3DF") ? { status: 500, body: {} } : null);
    const second = await markets.refresh("manual");
    const gold = second.items.find(i => i.id === "GOLD");
    expect(gold.stale).toBe(true);
    expect(gold.staleSince).toBe(first.items.find(i => i.id === "GOLD").fetchedAt);
    expect(second.summary.stale).toBeGreaterThanOrEqual(1);
  });

  test("writes the legacy snapshot:rates / snapshot:data keys for Events/Risk/Brief", async () => {
    const markets = require("../server/markets/service");
    const cache = require("../server/cache");
    await markets.refresh("manual");
    const rates = cache.get("snapshot:rates");
    expect(rates.hy_spread.value).toBe(2.9);
    expect(rates.dgs10.value).toBe(100);
    const data = cache.get("snapshot:data");
    expect(data.fx.pair).toBe("USDGBP");
    expect(data.watchlist.find(w => w.sym === "AMD")).toBeTruthy();
  });

  test("concurrent refresh calls share one run", async () => {
    const markets = require("../server/markets/service");
    const [a, b] = await Promise.all([markets.refresh("manual"), markets.refresh("manual")]);
    expect(a).toBe(b);
  });

  test("history: Yahoo candles, FRED line, Polymarket line, unknown → 404", async () => {
    const markets = require("../server/markets/service");
    await markets.refresh("manual");
    const gold = await markets.getHistory("GOLD", "1d");
    expect(gold.type).toBe("ohlc");
    expect(gold.bars.length).toBe(2);
    const hy = await markets.getHistory("HYOAS", "1d");
    expect(hy.type).toBe("line");
    const pmId = markets.getSnapshot().items.find(i => i.group === "predictions").id;
    const pm = await markets.getHistory(pmId, "1d");
    expect(pm.points[1].v).toBe(33);
    await expect(markets.getHistory("NOPE", "1d")).rejects.toMatchObject({ status: 404 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("marketsScheduler — 14:45 London, weekdays, catch-up", () => {
  const cfg = { time: "14:45", tz: "Europe/London" };
  test("fires at/after 14:45 London on weekdays, once per day", () => {
    const { shouldRun } = require("../server/jobs/marketsScheduler")._internal;
    expect(shouldRun(new Date("2026-09-28T13:44:00Z"), null, cfg)).toBe(false);          // 14:44 BST
    expect(shouldRun(new Date("2026-09-28T13:45:00Z"), null, cfg)).toBe(true);           // 14:45 BST
    expect(shouldRun(new Date("2026-09-28T19:00:00Z"), null, cfg)).toBe(true);           // catch-up after sleep
    expect(shouldRun(new Date("2026-09-28T19:00:00Z"), "2026-09-28", cfg)).toBe(false);  // already ran today
    expect(shouldRun(new Date("2026-10-03T15:00:00Z"), null, cfg)).toBe(false);          // Saturday
  });
  test("handles GMT after the clocks change", () => {
    const { shouldRun } = require("../server/jobs/marketsScheduler")._internal;
    expect(shouldRun(new Date("2026-12-01T14:44:00Z"), null, cfg)).toBe(false);
    expect(shouldRun(new Date("2026-12-01T14:45:00Z"), null, cfg)).toBe(true);
  });
  test("nextRunAt skips the weekend", () => {
    const { nextRunAt } = require("../server/jobs/marketsScheduler")._internal;
    expect(nextRunAt(new Date("2026-10-02T15:00:00Z"), "2026-10-02", cfg)).toBe("2026-10-05T13:45:00.000Z");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("/api/markets routes", () => {
  let app;
  beforeEach(() => {
    jest.mock("../server/providers/anthropic", () => ({ fetchAllAnalysis: jest.fn(), fetchTickerExplain: jest.fn(), callClaude: jest.fn() }));
    app = require("../server/index");
  });

  test("GET builds a snapshot on first load, then serves it without refetching", async () => {
    const r1 = await request(app).get("/api/markets");
    expect(r1.status).toBe(200);
    expect(r1.body.trigger).toBe("first-load");
    expect(r1.body.schedule.time).toBe("14:45");
    const calls = global.fetch.mock.calls.length;
    const r2 = await request(app).get("/api/markets");
    expect(r2.body.generatedAt).toBe(r1.body.generatedAt);
    expect(global.fetch.mock.calls.length).toBe(calls);
  });

  test("POST /refresh runs a manual refresh; a repeat within 60s is skipped", async () => {
    const r1 = await request(app).post("/api/markets/refresh").send({});
    expect(r1.status).toBe(200);
    expect(r1.body.trigger).toBe("manual");
    const r2 = await request(app).post("/api/markets/refresh").send({});
    expect(r2.body.skipped).toBeTruthy();
  });

  test("GET /history/:id returns 404 for unknown instruments", async () => {
    const r = await request(app).get("/api/markets/history/NOPE?tf=1d");
    expect(r.status).toBe(404);
  });
});
