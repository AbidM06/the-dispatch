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
describe("marketsScheduler — single slot (legacy config), weekdays, catch-up", () => {
  const cfg = { time: "14:45", tz: "Europe/London" };
  test("fires at/after 14:45 London on weekdays, once per day", () => {
    const { shouldRun } = require("../server/jobs/marketsScheduler")._internal;
    expect(shouldRun(new Date("2026-09-28T13:44:00Z"), null, cfg)).toBe(false);                    // 14:44 BST
    expect(shouldRun(new Date("2026-09-28T13:45:00Z"), null, cfg)).toBe("2026-09-28@14:45");       // 14:45 BST
    expect(shouldRun(new Date("2026-09-28T19:00:00Z"), null, cfg)).toBe("2026-09-28@14:45");       // catch-up after sleep
    expect(shouldRun(new Date("2026-09-28T19:00:00Z"), "2026-09-28@14:45", cfg)).toBe(false);      // already ran
    expect(shouldRun(new Date("2026-09-28T19:00:00Z"), "2026-09-28", cfg)).toBe(false);            // pre-slot marker = day done
    expect(shouldRun(new Date("2026-10-03T15:00:00Z"), null, cfg)).toBe(false);                    // Saturday
  });
  test("handles GMT after the clocks change", () => {
    const { shouldRun } = require("../server/jobs/marketsScheduler")._internal;
    expect(shouldRun(new Date("2026-12-01T14:44:00Z"), null, cfg)).toBe(false);
    expect(shouldRun(new Date("2026-12-01T14:45:00Z"), null, cfg)).toBeTruthy();
  });
  test("nextRunAt skips the weekend", () => {
    const { nextRunAt } = require("../server/jobs/marketsScheduler")._internal;
    expect(nextRunAt(new Date("2026-10-02T15:00:00Z"), "2026-10-02@14:45", cfg)).toBe("2026-10-05T13:45:00.000Z");
  });
});

describe("marketsScheduler — default 07:45 + 14:45 London", () => {
  const { shouldRun, nextRunAt, cfg, parseTimes } = require("../server/jobs/marketsScheduler")._internal;
  const two = { times: ["07:45", "14:45"], tz: "Europe/London" };

  test("defaults to the pre-LSE and post-NYSE-open slots", () => {
    delete process.env.MARKETS_REFRESH_TIMES;
    delete process.env.MARKETS_REFRESH_TIME;
    expect(cfg().times).toEqual(["07:45", "14:45"]);
  });

  test("each slot fires once", () => {
    expect(shouldRun(new Date("2026-09-28T06:44:00Z"), null, two)).toBe(false);                         // 07:44 BST
    expect(shouldRun(new Date("2026-09-28T06:45:00Z"), null, two)).toBe("2026-09-28@07:45");
    expect(shouldRun(new Date("2026-09-28T10:00:00Z"), "2026-09-28@07:45", two)).toBe(false);            // between slots
    expect(shouldRun(new Date("2026-09-28T13:45:00Z"), "2026-09-28@07:45", two)).toBe("2026-09-28@14:45");
    expect(shouldRun(new Date("2026-09-28T16:00:00Z"), "2026-09-28@14:45", two)).toBe(false);
  });

  test("asleep through both slots → ONE catch-up for the latest, not two", () => {
    expect(shouldRun(new Date("2026-09-28T18:00:00Z"), "2026-09-25@14:45", two)).toBe("2026-09-28@14:45");
    expect(shouldRun(new Date("2026-09-28T18:01:00Z"), "2026-09-28@14:45", two)).toBe(false);
  });

  test("nextRunAt finds the afternoon slot, then Monday morning after Friday", () => {
    expect(nextRunAt(new Date("2026-09-28T08:00:00Z"), "2026-09-28@07:45", two)).toBe("2026-09-28T13:45:00.000Z");
    expect(nextRunAt(new Date("2026-10-02T15:00:00Z"), "2026-10-02@14:45", two)).toBe("2026-10-05T06:45:00.000Z");
  });

  test("MARKETS_REFRESH_TIMES is parsed, validated and sorted", () => {
    expect(parseTimes("14:45, 07:45,bad,25:00,07:45")).toEqual(["07:45", "14:45"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("longer ranges + compare/overlay — real closes on shared dates only", () => {
  // Daily bars at 20:00Z starting Mon 21 Sep 2026; `closes[i]` null = that day absent.
  const DAYS = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-28"];
  function dailyYahoo(symbol, closes) {
    const rows = closes.map((c, i) => [epoch(DAYS[i] + "T20:00:00Z"), c]).filter(r => r[1] != null);
    return { chart: { result: [{
      meta: { symbol, currency: "USD", regularMarketPrice: rows[rows.length - 1][1], regularMarketTime: rows[rows.length - 1][0] },
      timestamp: rows.map(r => r[0]),
      indicators: { quote: [{ open: rows.map(r => r[1]), high: rows.map(r => r[1]), low: rows.map(r => r[1]), close: rows.map(r => r[1]) }] },
    }] } };
  }
  const series = {
    "CL=F": [100, 102, 101, 103, 104, 105],
    "BZ=F": [50, 50, 51, null, 53, 54],          // 24 Sep missing
    "GC=F": [2000, 2010, 2020, 2030, 2040, 2050],
    "^TNX": [4.0, 4.1, 4.2, 4.3, 4.4, 4.5],
  };
  const urls = [];
  const savedBrent = series["BZ=F"].slice();
  // FRED daily observations on the same 6 days (HYOAS etc.), so FRED-only series can overlap.
  const fredDaily = (url) => {
    const id = new URL(url).searchParams.get("series_id");
    return { status: 200, body: fredObsBody(DAYS.map((d, i) => [d, id === "T10Y2Y" && i === 0 ? -0.2 : 3 + i * 0.1])) };
  };
  beforeEach(() => {
    urls.length = 0;
    series["BZ=F"] = savedBrent.slice();
    global.fetch = makeFetch((url) => {
      if (url.includes("/fred/series/observations")) return fredDaily(url);
      if (url.includes("finance.yahoo.com")) {
        urls.push(url);
        const sym = decodeURIComponent(url.split("/chart/")[1].split("?")[0]);
        if (series[sym]) return { status: 200, body: dailyYahoo(sym, series[sym]) };
      }
      return null;
    });
  });

  test("1y and 5y ask Yahoo for the longer DAILY window; Daily/Hourly are unchanged", async () => {
    const markets = require("../server/markets/service");
    await markets.getHistory("GOLD", "5y");
    await markets.getHistory("GOLD", "1y");
    await markets.getHistory("GOLD", "1d");
    await markets.getHistory("GOLD", "1h");
    const q = urls.map(u => u.split("?")[1]);
    expect(q).toEqual(expect.arrayContaining(["interval=1d&range=5y", "interval=1d&range=1y", "interval=1d&range=6mo", "interval=60m&range=1mo"]));
    await expect(markets.getHistory("GOLD", "10y")).resolves.toMatchObject({ tf: "1d" });   // unknown → default, as before
  });

  test("Polymarket 1Y / 5Y are trimmed to the window (not lifetime history under a 1Y label), with a note when the market is younger", async () => {
    const DAY = 86400, now = Math.floor(NOW / 1000);
    global.fetch = makeFetch((url) => url.includes("clob.polymarket.com")
      ? { status: 200, body: { history: [
          { t: now - 800 * DAY, p: 0.2 }, { t: now - 400 * DAY, p: 0.25 },     // older than 1 year
          { t: now - 200 * DAY, p: 0.3 }, { t: now - 10 * DAY, p: 0.4 }] } }
      : null);
    const markets = require("../server/markets/service");
    await markets.refresh("manual");
    const id = markets.getSnapshot().items.find(i => i.group === "predictions").id;
    const y1 = await markets.getHistory(id, "1y");
    expect(y1.points.map(p => p.v)).toEqual([30, 40]);                 // only the last 365 days
    expect(y1.note).toBeUndefined();                                    // history covers the whole year
    const y5 = await markets.getHistory(id, "5y");
    expect(y5.points).toHaveLength(4);
    expect(y5.note).toMatch(/Market history starts .* shorter than 5 years/);
    const all = await markets.getHistory(id, "1d");                     // unchanged behaviour
    expect(all.points).toHaveLength(4);
  });

  test("rebased: every series starts at 100 on the first shared day; a day missing from one series is dropped from all, and counted", async () => {
    const markets = require("../server/markets/service");
    const c = await markets.getComparison(["WTI", "BRENT"], "1y", "rebased");
    expect(c.sharedDays).toBe(5);                                   // 24 Sep dropped
    expect(c.from).toBe("2026-09-21");
    expect(c.series.map(x => x.points.length)).toEqual([5, 5]);
    expect(c.series[0].points[0].v).toBe(100);
    expect(c.series[1].points[0].v).toBe(100);
    expect(c.series[0].points[1].v).toBe(102);                      // 102 / 100
    expect(c.series[1].points[3].v).toBe(106);                      // 53 / 50 on 25 Sep (23 Sep is index 2)
    expect(c.legs.find(l => l.id === "WTI").dropped).toBe(1);       // WTI had 6 days, 5 shared
    expect(c.legs.find(l => l.id === "BRENT").dropped).toBe(0);
    expect(c.legs[0]).toMatchObject({ first: 100, last: 105, lastDate: "2026-09-28", source: "Yahoo Finance" });
    expect(c.note).toMatch(/nothing is filled or interpolated/);
  });

  test("spread: WTI − Brent in USD/bbl on shared days", async () => {
    const markets = require("../server/markets/service");
    const c = await markets.getComparison(["WTI", "BRENT"], "1y", "spread");
    expect(c.series).toHaveLength(1);
    expect(c.series[0]).toMatchObject({ label: "WTI crude − Brent crude", unit: "USD/bbl" });
    expect(c.series[0].points.map(p => p.v)).toEqual([50, 52, 50, 51, 51]);
  });

  test("refuses what would be misleading: meaningless spread, wrong count, unknown id, prediction market, bad range", async () => {
    const markets = require("../server/markets/service");
    await expect(markets.getComparison(["GOLD", "WTI"], "1y", "spread")).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/not a meaningful spread/) });
    await expect(markets.getComparison(["US10Y", "GOLD"], "1y", "spread")).rejects.toMatchObject({ status: 422 });
    await expect(markets.getComparison(["WTI"], "1y")).rejects.toMatchObject({ status: 400 });
    await expect(markets.getComparison(["WTI", "WTI"], "1y")).rejects.toMatchObject({ status: 400 });
    await expect(markets.getComparison(["WTI", "BRENT", "GOLD", "US10Y", "SPX"], "1y")).rejects.toMatchObject({ status: 400 });
    await expect(markets.getComparison(["WTI", "NOPE"], "1y")).rejects.toMatchObject({ status: 404, message: expect.stringMatching(/NOPE/) });
    await expect(markets.getComparison(["WTI", "BRENT"], "1h")).rejects.toMatchObject({ status: 400 });
    await expect(markets.getComparison(["WTI", "BRENT"], "1y", "ratio")).rejects.toMatchObject({ status: 400 });
  });

  test("rates in the same unit may be spread; a series at or below zero cannot be rebased to 100", async () => {
    const markets = require("../server/markets/service");
    const ok = await markets.getComparison(["US10Y", "HYOAS"], "1y", "spread");
    expect(ok.series[0].unit).toBe("%");
    // T10Y2Y starts at -0.2 in the FRED mock above.
    await expect(markets.getComparison(["T10Y2Y", "US10Y"], "1y", "rebased")).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/Can't rebase to 100: T10Y2Y/) });
  });

  test("every range is cut to its window for every source: 6M really is six months (FRED defaults to a year or more)", async () => {
    // FRED-only series with data from Dec 2025 (≈ 9 months before NOW) as well as the last two weeks.
    const old = [["2025-12-01", 3], ["2026-02-01", 3.1], ["2026-03-27", 3.2], ["2026-03-30", 3.3], ["2026-04-01", 3.4]];
    global.fetch = makeFetch((url) => url.includes("/fred/series/observations")
      ? { status: 200, body: fredObsBody(old.concat(DAYS.map((d, i) => [d, 3.5 + i * 0.1]))) }
      : null);
    const markets = require("../server/markets/service");
    const m6 = await markets.getComparison(["HYOAS", "IGOAS"], "1d", "rebased");
    expect(m6.from).toBe("2026-03-30");                              // NOW is 28 Sep 2026 → window starts 28 Mar
    expect(m6.sharedDays).toBe(2 + DAYS.length);                      // 30 Mar, 1 Apr + the 6 September days
    const y1 = await markets.getComparison(["HYOAS", "IGOAS"], "1y", "rebased");
    expect(y1.from).toBe("2025-12-01");                              // a year back still includes Dec 2025
  });

  test("too few shared days is refused, not padded", async () => {
    series["BZ=F"] = [null, null, null, null, 53, 54];     // restored in beforeEach
    const markets = require("../server/markets/service");
    await expect(markets.getComparison(["WTI", "BRENT"], "1y")).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/Too little overlap to compare: only 2 shared days/) });
  });

  test("GET /compare: 200 with data, 4xx with a plain message", async () => {
    jest.mock("../server/providers/anthropic", () => ({ fetchAllAnalysis: jest.fn(), fetchTickerExplain: jest.fn(), callClaude: jest.fn() }));
    const app = require("../server/index");
    const ok = await request(app).get("/api/markets/compare?ids=WTI,BRENT&tf=1y&mode=spread");
    expect(ok.status).toBe(200);
    expect(ok.body.series[0].points).toHaveLength(5);
    const bad = await request(app).get("/api/markets/compare?ids=GOLD&tf=1y");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/between 2 and 4/);
    const nope = await request(app).get("/api/markets/compare?ids=GOLD,WTI&mode=spread");
    expect(nope.status).toBe(422);
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
    expect(r1.body.schedule.times).toEqual(["07:45", "14:45"]);
    expect(r1.body.schedule.time).toBe("07:45 & 14:45");
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
