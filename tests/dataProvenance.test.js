/**
 * tests/dataProvenance.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Regression tests for the data accuracy, freshness and provenance audit.
 *
 * Grouped by the eight defect classes the audit set out to close:
 *   1. An old observation fetched now remains old through cache and UI payloads
 *   2. Seeded / unavailable data cannot become live through caching
 *   3. Bulletin macro context accepts real Fact-shaped inputs, keeps units/dates
 *   4. Batch and synchronous research paths carry equivalent provenance
 *   5. Incomplete report schemas fail explicitly
 *   6. Curve labels require the correct change inputs
 *   7. Blocked sizing produces no order
 *   8. Actual sized notional above the configured cap produces no order
 *
 * The broker (Alpaca), the idea log and every market-data provider are mocked.
 * Sizing, policy, freshness and schema logic run for real. No network, no
 * orders, no broker contact.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const request = require("supertest");

jest.mock("../server/providers/fred", () => {
  const actual = jest.requireActual("../server/providers/fred");
  return { ...actual, getAllRates: jest.fn(), getRecentHistory: jest.fn(), getLatestObservation: jest.fn() };
});
jest.mock("../server/providers/alphaVantage", () => ({
  getQuotes: jest.fn(), getFxRate: jest.fn(), getQuote: jest.fn(),
  AV_SUPPORTED: new Set(["AMD"]),
  _getBudget: jest.fn(() => ({ date: null, count: 0, limit: 20 })), _resetBudget: jest.fn(),
}));
jest.mock("../server/providers/polygon", () => ({
  getSnapshots: jest.fn(), getTnxYield: jest.fn().mockResolvedValue(null),
  getVolSurface: jest.fn().mockResolvedValue({ vix3m: null, skew: null }),
  POLYGON_PEERS: new Set(["NVDA", "MSFT", "TSLA", "MU", "AMAT", "LRCX"]),
}));
jest.mock("../server/providers/finnhub", () => ({
  getMarketNews: jest.fn().mockResolvedValue([]), getCompanyNews: jest.fn().mockResolvedValue([]),
  getEarningsCalendar: jest.fn().mockResolvedValue([]), getEconomicCalendar: jest.fn().mockResolvedValue([]),
  getNewsSentiment: jest.fn().mockResolvedValue(null), isConfigured: jest.fn().mockReturnValue(false),
  TTL_NEWS_MS: 1_800_000, TTL_CALENDAR_MS: 3_600_000,
}));
jest.mock("../server/providers/alpaca", () => ({
  isSupported:          jest.fn(t => ["AMD", "NVDA", "MSFT", "TSLA", "MU", "AMAT", "LRCX"].includes(t)),
  isConfigured:         jest.fn().mockReturnValue(true),
  isAutoExecuteEnabled: jest.fn().mockReturnValue(true),
  placeOrder:           jest.fn(async () => ({ id: "order-1" })),
  placeBracketOrder:    jest.fn(),
  getPositions:         jest.fn(async () => []),
  getOpenOrders:        jest.fn(async () => []),
  getAccount:           jest.fn(async () => ({ equity: "10000", currency: "USD" })),
  getSummary:           jest.fn(async () => null),
  getMaxOrdersPerRun:   jest.fn().mockReturnValue(3),
}));
jest.mock("../server/importers/ideaLog", () => ({
  appendToLog: jest.fn(), readLog: jest.fn(() => []),
  appendIdeasLog: jest.fn(), readIdeasLog: jest.fn(() => []),
  appendSignalsLog: jest.fn(), readSignalsLog: jest.fn(() => []),
  appendExecutionLog: jest.fn(), readExecutionLog: jest.fn(() => []),
}));

const fred     = require("../server/providers/fred");
const av       = require("../server/providers/alphaVantage");
const poly     = require("../server/providers/polygon");
const alpaca   = require("../server/providers/alpaca");
const cache    = require("../server/cache");
const seeds    = require("../seeds/fallback");

const TODAY = new Date().toISOString().slice(0, 10);

function obs(seriesId, value, date) {
  return { seriesId, value, date, observedAt: date, observedAtPrecision: "date",
           retrievedAt: new Date().toISOString(), unit: "percent", profile: "fred-daily", kind: "observed", source: "FRED" };
}
function allRates(date, overrides = {}) {
  return {
    dgs10:     obs("DGS10", 4.1, date),
    dfii10:    obs("DFII10", 1.9, date),
    t10yie:    obs("T10YIE", 2.2, date),
    hy_spread: obs("BAMLH0A0HYM2", 3.17, date),
    t10y2y:    obs("T10Y2Y", 0.5, date),
    ...overrides,
  };
}
function okJson(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

let app;
beforeAll(() => {
  process.env.FRED_API_KEY = "k";
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.PORT = "0";
  app = require("../server/index");
});

beforeEach(() => {
  cache.clear();
  jest.clearAllMocks();
  delete process.env.DEMO_MODE;
  delete process.env.LOW_COST_MODE;
  fred.getRecentHistory.mockResolvedValue({ seriesId: "X", observations: [], source: "FRED" });
  av.getQuotes.mockResolvedValue([]);
  poly.getSnapshots.mockResolvedValue([]);
  // ExchangeRate-API: the provider's own update time is the observation time.
  global.fetch = jest.fn(async (url) => {
    if (String(url).includes("open.er-api.com")) {
      return okJson({ rates: { GBP: 0.74 }, time_last_update_unix: 1758240000 }); // 2025-09-19T00:00:00Z
    }
    throw new Error(`unexpected fetch ${url}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("1 — an old observation fetched now stays old", () => {
  test("snapshot facts keep the observation date and are judged stale on it", async () => {
    fred.getAllRates.mockResolvedValue(allRates("2020-01-02"));
    const res = await request(app).get("/api/snapshot");
    const d = res.body.data.rates.dgs10;
    expect(d.observedAt).toBe("2020-01-02");
    expect(d.freshness.status).toBe("stale");
    // Retrieval is recent — and is reported separately, not as the date.
    expect(Date.now() - new Date(d.retrievedAt).getTime()).toBeLessThan(60_000);
    expect(res.body.stale).toBe(true);
    expect(res.body.freshness.oldestObservation.observedAt).toBe("2020-01-02");
  });

  test("a second read served from cache is still old — the cache does not refresh the date", async () => {
    fred.getAllRates.mockResolvedValue(allRates("2020-01-02"));
    await request(app).get("/api/snapshot");
    fred.getAllRates.mockClear();
    const res = await request(app).get("/api/snapshot");
    expect(fred.getAllRates).not.toHaveBeenCalled();            // served from cache
    expect(res.body.components["rates.dgs10"].source).toBe("cache");
    expect(res.body.data.rates.dgs10.observedAt).toBe("2020-01-02");
    expect(res.body.data.rates.dgs10.freshness.status).toBe("stale");
  });

  test("the combined snapshot cache keeps provenance for downstream consumers", async () => {
    fred.getAllRates.mockResolvedValue(allRates("2020-01-02"));
    await request(app).get("/api/snapshot");
    const combined = cache.get("snapshot:data");
    expect(combined.rates.dgs10.observedAt).toBe("2020-01-02");
    expect(combined.rates.dgs10.freshness.status).toBe("stale");
    expect(combined.meta.freshness.status).toBeDefined();
    expect(combined.meta.components["rates.dgs10"]).toBeDefined();
  });

  test("overall freshness reports the OLDEST component, not the newest", async () => {
    const recent = Math.floor(Date.now() / 1000) - 3600;   // FX updated an hour ago
    global.fetch = jest.fn(async () => okJson({ rates: { GBP: 0.74 }, time_last_update_unix: recent }));
    fred.getAllRates.mockResolvedValue(allRates(TODAY, { hy_spread: obs("BAMLH0A0HYM2", 3.17, "2026-01-05") }));
    const res = await request(app).get("/api/snapshot");
    expect(res.body.freshness.oldestObservation).toEqual({ component: "rates.hy_spread", observedAt: "2026-01-05" });
    expect(res.body.freshness.mixedObservationDates).toBe(true);
  });

  test("FX observation time is the provider's update time, not our fetch time", async () => {
    fred.getAllRates.mockResolvedValue(allRates(TODAY));
    const res = await request(app).get("/api/snapshot");
    const fx = res.body.data.fx.usdgbp;
    expect(fx.observedAt).toBe("2025-09-19T00:00:00.000Z");
    expect(fx.retrievedAt).not.toBe(fx.observedAt);
    expect(fx.freshness.status).toBe("stale");
  });

  test("intl prices and RSI history are part of the summary, as unavailable", async () => {
    fred.getAllRates.mockResolvedValue(allRates(TODAY));
    const res = await request(app).get("/api/snapshot");
    expect(res.body.components.intl.freshness.status).toBe("unavailable");
    expect(res.body.components.rsiHistory.freshness.status).toBe("unavailable");
    expect(res.body.freshness.unavailable).toEqual(expect.arrayContaining(["intl", "rsiHistory"]));
    expect(res.body.data.intl).toEqual([]);
  });

  test("macro context re-judges freshness at read time", () => {
    const { reassess, buildFact, SERIES } = require("../server/providers/macroContext");
    const spec = SERIES.find(s => s.id === "DGS10");
    const fact = buildFact(spec, { value: 4, date: "2026-09-18", observedAt: "2026-09-18", profile: "fred-daily" },
                           new Date("2026-09-18T20:00:00Z"));
    expect(fact.freshness.status).toBe("current");
    const later = reassess({ facts: { dgs10: fact } }, new Date("2026-10-15T12:00:00Z"));
    expect(later.facts.dgs10.freshness.status).toBe("stale");
    expect(later.facts.dgs10.asOf).toBe("2026-09-18");
  });

  test("expected publication lag is 'lagging', not a provider failure", () => {
    const { assessFreshness } = require("../server/provenance");
    // Brent via FRED publishes weekly batches: 5 business days old is normal lag.
    const fr = assessFreshness({ observedAt: "2026-09-17", profile: "fred-daily-weekly-release", kind: "observed" },
                               new Date("2026-09-24T12:00:00Z"));
    expect(fr.status).toBe("current");
    // A daily series one weekend + holiday behind is lagging, not stale.
    const daily = assessFreshness({ observedAt: "2026-09-18", profile: "fred-daily", kind: "observed" },
                                  new Date("2026-09-22T12:00:00Z"));
    expect(daily.status).toBe("lagging");
  });

  test("auto-execution freshness rejects a newly cached old observation", () => {
    const { checkFreshness } = require("../server/engine/autoExecute");
    cache.set("snapshot:rates", allRates("2020-01-02"), 60_000);
    expect(checkFreshness().dataFresh).toBe(false);
  });

  test("FRED recovers the latest VALID value when the newest rows are '.'", async () => {
    const real = jest.requireActual("../server/providers/fred");
    global.fetch = jest.fn(async () => okJson({ observations: [
      { date: "2026-09-22", value: "." }, { date: "2026-09-21", value: "." }, { date: "2026-09-18", value: "4.12" },
    ] }));
    const out = await real.getLatestObservation("DGS10");
    expect(out.value).toBe(4.12);
    expect(out.observedAt).toBe("2026-09-18");
    expect(out.skippedMissing).toBe(2);
    expect(String(global.fetch.mock.calls[0][0])).toMatch(/limit=10/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("2 — seeded or unavailable data cannot become live through caching", () => {
  test("provider failure yields unavailable facts, never seed values", async () => {
    fred.getAllRates.mockRejectedValue(new Error("FRED down"));
    global.fetch = jest.fn(async () => { throw new Error("offline"); });
    av.getFxRate.mockRejectedValue(new Error("AV down"));
    const res = await request(app).get("/api/snapshot");
    expect(res.body.data.rates.dgs10.value).toBeNull();
    expect(res.body.data.rates.dgs10.kind).toBe("unavailable");
    expect(JSON.stringify(res.body.data.rates)).not.toContain(String(seeds.RATES_SEED.dgs10.value));
    expect(res.body.data.fx.usdgbp.value).toBeNull();
  });

  test("a second failed read is still unavailable — nothing seeded was cached", async () => {
    fred.getAllRates.mockRejectedValue(new Error("FRED down"));
    await request(app).get("/api/snapshot");
    expect(cache.get("snapshot:rates")).toBeNull();
    const res = await request(app).get("/api/snapshot");
    expect(res.body.data.rates.dgs10.kind).toBe("unavailable");
    expect(res.body.source).not.toBe("cache");
  });

  test("an all-empty FRED response is a failure, not a cached 'live' fetch", async () => {
    fred.getAllRates.mockResolvedValue({ dgs10: null, dfii10: null, t10yie: null, hy_spread: null, t10y2y: null });
    const res = await request(app).get("/api/snapshot");
    expect(cache.get("snapshot:rates")).toBeNull();
    expect(res.body.components["rates.dgs10"].source).toBe("unavailable");
  });

  test("DEMO_MODE fixtures are labelled demo and never written to the shared cache", async () => {
    process.env.DEMO_MODE = "true";
    fred.getAllRates.mockRejectedValue(new Error("FRED down"));
    const res = await request(app).get("/api/snapshot");
    expect(res.body.demoMode).toBe(true);
    expect(res.body.data.rates.dgs10.kind).toBe("demo");
    expect(res.body.data.rates.dgs10.freshness.status).toBe("demo");
    expect(cache.get("snapshot:data")).toBeNull();
    expect(cache.get("snapshot:rates")).toBeNull();
  });

  test("the engine builds no signals from seed levels when rates are missing", () => {
    const { buildCtx, generateIdeas } = require("../server/engine/ideaEngine");
    const ctx = buildCtx(null, null, null, { ratesHistory: [], hyHistory: [], fx: null });
    expect(ctx.rates.dgs10).toBeNull();
    expect(ctx.dataQuality.ratesComplete).toBe(false);
    expect(ctx._usdgbp).toBeNull();
    expect(generateIdeas(ctx)).toEqual([]);
  });

  test("the engine never compares a live level with seed history", () => {
    const { buildCtx } = require("../server/engine/ideaEngine");
    const ctx = buildCtx(allRates(TODAY), null, null, { ratesHistory: [], hyHistory: [], fx: null });
    expect(ctx.deltas.dgs10_d).toBeNull();           // no history → no delta, not live − Feb 2026 seed
    const withHist = buildCtx(allRates(TODAY), null, null, {
      ratesHistory: [{ m: "2026-09-01", y10: 4.0, real: 1.8, bei: 2.2 }, { m: "2026-09-18", y10: 4.1, real: 1.9, bei: 2.2 }],
      hyHistory: [], fx: null,
    });
    expect(withHist.deltas.dgs10_d).toBe(10);
    expect(withHist.deltas.windows.dgs10).toEqual({ from: "2026-09-01", to: "2026-09-18", observations: 2 });
  });

  test("an idea for an instrument with no price feed carries null levels, not a typed-in price", () => {
    const { PLAYBOOKS } = require("../server/engine/playbooks");
    const hot = PLAYBOOKS.find(p => p.id === "hot-cpi");
    const t = hot.template({ rates: { t10yie: 2.6 }, ratesAsOf: {}, watchlist: {}, portfolio: { rows: [], weights: {} } });
    expect(t.entry).toBeNull();
    expect(t.stop).toBeNull();
    expect(t.priceBasis.available).toBe(false);
    expect(t.entryLogic).toMatch(/No sourced price/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("3 — bulletin macro context from real Fact shapes", () => {
  test("mixed observation dates stay visible", async () => {
    fred.getAllRates.mockResolvedValue(allRates("2026-09-18", { hy_spread: obs("BAMLH0A0HYM2", 3.05, "2026-09-17") }));
    const bulletin = require("../server/routes/bulletin");
    const out = await bulletin._fetchMacroContext();
    expect(out).toMatch(/305bp \(3\.05%\).*observation date 2026-09-17/);
    expect(out).toMatch(/Observation dates differ: 2026-09-17 to 2026-09-18/);
  });

  test("a fact with no date says so instead of borrowing today's", async () => {
    fred.getAllRates.mockResolvedValue({ dgs10: { seriesId: "DGS10", value: 4.1, source: "FRED" } });
    const bulletin = require("../server/routes/bulletin");
    const out = await bulletin._fetchMacroContext();
    expect(out).toMatch(/observation date not supplied/);
    expect(out).not.toContain(TODAY);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("4 — batch and synchronous research carry equivalent provenance", () => {
  const LT = "\x3c";
  const report = {
    title: "T", abstract: ["a"], scenarios: { baseline: {}, stress: {} },
    mainChannel: `Spreads widened ${LT}cite index="0-0">40bp${LT}/cite> and ${LT}cite index="7-0">more${LT}/cite>.`,
    estimates: [{ figure: "x" }], unverified: [],
  };
  const sources = [{ url: "https://example.com/a", title: "A" }];

  test("same grounding, citations and unresolved markers on both paths", async () => {
    const anthropic = require("../server/providers/anthropic");

    // Synchronous path: through fetchResearchReport with the API mocked.
    global.fetch = jest.fn(async () => okJson({ content: [
      { type: "web_search_tool_result", content: [{ type: "web_search_result", url: sources[0].url, title: "A" }] },
      { type: "text", text: JSON.stringify(report) },
    ] }));
    const sync = await anthropic.fetchResearchReport("ctx", "", "macro");

    // Batch path: the same raw text and sources through the batch exit.
    const batch = anthropic.finalizeResearchReport("macro", JSON.stringify(report), sources, { searchEnabled: true, tier: "batch" });

    for (const r of [sync, batch]) {
      expect(r.grounded).toBe(true);
      expect(r.grounding.sourcesReturned).toBe(1);
      expect(r.grounding.resolvedCitations).toBe(1);
      expect(r.grounding.unresolvedCitations).toBe(1);
      expect(r.citedSources.map(s => s.url)).toEqual(["https://example.com/a"]);
      expect(r.mainChannel).toBe("Spreads widened 40bp and more [citation unresolved].");
    }
    expect(Object.keys(sync.grounding).sort()).toEqual(Object.keys(batch.grounding).sort());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("5 — incomplete report schemas fail explicitly", () => {
  const { validateResearchReport } = require("../server/schemas");
  const complete = {
    fx:          { title: "t", pairViews: [{ pair: "EUR/USD", direction: "LONG" }], risks: ["r"] },
    rates:       { title: "t", thePuzzle: "p", catalysts: ["c"] },
    thematic:    { title: "t", keyThemes: ["k"], predictions: ["p"] },
    equity:      { title: "t", epsOutlook: {}, crossAssetContext: {}, rateSensitivity: {}, scenarios: { bear: {}, bull: {} }, risks: ["r"], invalidation: "i" },
    commodities: { title: "t", keyTakeaways: ["k"], scenarios: {} },
    macro:       { title: "t", abstract: ["a"], scenarios: { baseline: {}, stress: {} } },
  };
  const disclosures = { estimates: [], unverified: [] };

  test.each(Object.keys(complete))("%s: complete passes; missing disclosures fail by name", (type) => {
    expect(validateResearchReport(type, { ...complete[type], ...disclosures }).ok).toBe(true);
    const bad = validateResearchReport(type, complete[type]);
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(" ")).toMatch(/estimates/);
    expect(bad.errors.join(" ")).toMatch(/unverified/);
  });

  test("finalizeResearchReport throws a coded error naming the missing fields", () => {
    const anthropic = require("../server/providers/anthropic");
    let err;
    try { anthropic.finalizeResearchReport("macro", JSON.stringify({ title: "t", abstract: ["a"] })); } catch (e) { err = e; }
    expect(err.code).toBe("REPORT_SCHEMA_INVALID");
    expect(err.issues.join(" ")).toMatch(/scenarios/);
  });

  test("macro scenarios need both a baseline and a stress case", () => {
    const r = validateResearchReport("macro", { ...complete.macro, scenarios: { baseline: {} }, ...disclosures });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/stress/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("6 — curve labels require change inputs", () => {
  const { classifyLevels, curveMove } = require("../server/analytics/regime");

  test("no direction without both legs' changes", () => {
    expect(curveMove(null, 10)).toBeNull();
    expect(curveMove(10, null)).toBeNull();
  });

  test("the four moves are named from which leg moved and how", () => {
    expect(curveMove(5, 20)).toBe("Bear steepener");     // long end up faster
    expect(curveMove(20, 5)).toBe("Bear flattener");     // short end up faster
    expect(curveMove(-20, -5)).toBe("Bull steepener");   // short end down faster
    expect(curveMove(-5, -20)).toBe("Bull flattener");   // long end down faster
    expect(curveMove(10, 12)).toBe("Curve slope little changed");
  });

  test("a positive curve LEVEL is never labelled a steepener or flattener", () => {
    const { regime } = classifyLevels({ dgs10: 4.6, dfii10: 1.9, t10yie: 2.6, hy_spread: 3.6, t10y2y: 0.8 });
    expect(regime).toMatch(/Positively sloped curve/);
    expect(regime).not.toMatch(/steepen|flatten/i);
  });

  test("missing inputs are named, not read as zero", () => {
    const { regime, missing } = classifyLevels({ dgs10: 4.1 });
    expect(missing).toEqual(["dfii10", "t10yie", "hy_spread", "t10y2y"]);
    expect(regime).not.toMatch(/Flat curve/);            // null < 0.3 must not read as flat
  });

  test("the deterministic narrative describes levels, not moves or CPI surprises", () => {
    const { generateNarrative } = require("../server/analytics/narrativeEngine");
    const n = generateNarrative({ rates: allRates("2026-09-18"), fx: null });
    const text = JSON.stringify(n);
    expect(text).not.toMatch(/bear steepener in progress|above-consensus|Iran|MI450/i);
    expect(n.events.every(e => e.date === "2026-09-18")).toBe(true);
  });

  test("scanner conditions ignore missing rates", () => {
    const { getActiveConditions } = require("../server/engine/universeScanner");
    expect(getActiveConditions({ dgs10: null, dfii10: null, t10yie: null, hy_spread: null, t10y2y: null })).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("7 & 8 — execution fails closed (mocked broker, real sizing and policy)", () => {
  const policy = require("../server/analytics/executionPolicy");
  let autoExecuteIdeas, recordSpy;

  const quote = (price, minsAgo = 2) => async () => ({
    value: price, executable: true, observedAtPrecision: "timestamp",
    observedAt: new Date(Date.now() - minsAgo * 60_000).toISOString(), source: "test quote",
  });
  const fx = { value: 0.8, observedAt: new Date().toISOString() };
  const ticket = (over = {}) => ({ id: "t1", ticker: "AMD", direction: "LONG", stop: 95, engineDecision: "allowed", playbook: "p", ...over });

  beforeEach(() => {
    process.env.TRADING_ENABLED = "true";
    process.env.AUTO_APPROVE_PAPER = "true";
    process.env.MAX_NOTIONAL_GBP_PER_DAY = "250";
    cache.set("snapshot:rates", allRates(TODAY), 60_000);   // rates freshness passes
    recordSpy = jest.spyOn(policy, "recordTrade").mockImplementation(() => {});
    jest.spyOn(policy, "getState").mockReturnValue({ date: TODAY, tradesPlaced: 0, notionalGBP: 0, tickers: {} });
    ({ autoExecuteIdeas } = require("../server/engine/autoExecute"));
  });
  afterEach(() => {
    delete process.env.TRADING_ENABLED;
    delete process.env.AUTO_APPROVE_PAPER;
    delete process.env.MAX_NOTIONAL_GBP_PER_DAY;
    jest.restoreAllMocks();
  });

  test("7: blocked sizing (stop above price) sends no order", async () => {
    const out = await autoExecuteIdeas([ticket({ stop: 110 })], {}, {}, { getExecutablePrice: quote(100), fx });
    expect(alpaca.placeOrder).not.toHaveBeenCalled();
    expect(out.orders).toEqual([]);
    expect(out.skipped[0].stage).toBe("sizing");
  });

  test("8: a sized notional above the daily cap sends no order", async () => {
    // $10,000 equity = £8,000 at 0.80. 0.5% risk = £40; risk per share
    // ($100 − $95) × 0.80 = £4 → 10 shares, then the 8% position cap (£640 at
    // £80 a share) → 8 shares = £640 notional — above a £250 daily cap.
    const out = await autoExecuteIdeas([ticket()], {}, {}, { getExecutablePrice: quote(100), fx });
    expect(alpaca.placeOrder).not.toHaveBeenCalled();
    expect(out.skipped[0].stage).toBe("policy");
    expect(out.skipped[0].reason).toMatch(/notional cap/i);
  });

  test("a daily close is not an executable price — no order", async () => {
    const ctx = { watchlist: { AMD: { price: 100, date: TODAY, source: "Alpha Vantage" } } };
    const out = await autoExecuteIdeas([ticket()], ctx, {}, { fx });
    expect(alpaca.placeOrder).not.toHaveBeenCalled();
    expect(out.skipped[0].stage).toBe("price");
    expect(out.skipped[0].reason).toMatch(/not an executable quote/);
  });

  test("a quote older than the freshness limit is rejected", async () => {
    const out = await autoExecuteIdeas([ticket()], {}, {}, { getExecutablePrice: quote(100, 45), fx });
    expect(alpaca.placeOrder).not.toHaveBeenCalled();
    expect(out.skipped[0].stage).toBe("price");
  });

  test("account failure blocks — no invented equity", async () => {
    alpaca.getAccount.mockRejectedValueOnce(new Error("broker down"));
    const out = await autoExecuteIdeas([ticket()], {}, {}, { getExecutablePrice: quote(100), fx });
    expect(alpaca.placeOrder).not.toHaveBeenCalled();
    expect(out.skipped[0].stage).toBe("account");
  });

  test("positions failure blocks — exposure caps cannot be evaluated", async () => {
    alpaca.getPositions.mockRejectedValueOnce(new Error("broker down"));
    const out = await autoExecuteIdeas([ticket()], {}, {}, { getExecutablePrice: quote(100), fx });
    expect(alpaca.placeOrder).not.toHaveBeenCalled();
    expect(out.skipped[0].stage).toBe("positions");
  });

  test("missing FX blocks a USD order — no 0.7558 default", async () => {
    const out = await autoExecuteIdeas([ticket()], {}, {}, { getExecutablePrice: quote(100), fx: null });
    expect(alpaca.placeOrder).not.toHaveBeenCalled();
    expect(out.skipped[0].stage).toBe("fx");
  });

  test("existing exposure counts toward the single-ticker cap", async () => {
    process.env.MAX_NOTIONAL_GBP_PER_DAY = "5000";
    // $2,000 held = £1,600; + £640 new = £2,240 = 28% of £8,000 > 20% cap.
    alpaca.getPositions.mockResolvedValueOnce([{ symbol: "AMD", market_value: "2000" }]);
    const out = await autoExecuteIdeas([ticket()], {}, {}, { getExecutablePrice: quote(100), fx });
    expect(alpaca.placeOrder).not.toHaveBeenCalled();
    expect(out.skipped[0].reason).toMatch(/Single ticker cap/);
  });

  test("positive control: valid inputs within every cap place exactly the sized order", async () => {
    process.env.MAX_NOTIONAL_GBP_PER_DAY = "5000";
    const out = await autoExecuteIdeas([ticket()], {}, {}, { getExecutablePrice: quote(100), fx });
    expect(alpaca.placeOrder).toHaveBeenCalledTimes(1);
    const [sym, side, qty] = alpaca.placeOrder.mock.calls[0];
    // Sizing from the EXECUTABLE price, converted with the dated FX rate:
    // 8 shares × £80 = £640 (see the arithmetic in test 8).
    expect([sym, side, qty]).toEqual(["AMD", "buy", 8]);
    expect(out.orders[0].notionalGBP).toBe(640);
    expect(recordSpy).toHaveBeenCalledWith("AMD", 640);
  });

  test("SHORT tickets are refused before any sizing", async () => {
    const out = await autoExecuteIdeas([ticket({ direction: "SHORT" })], {}, {}, { getExecutablePrice: quote(100), fx });
    expect(alpaca.placeOrder).not.toHaveBeenCalled();
    expect(out.skipped[0].stage).toBe("direction");
  });
});
