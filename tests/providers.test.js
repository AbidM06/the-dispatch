/**
 * tests/providers.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Unit tests for provider adapters.
 * Uses global fetch mock — no real HTTP requests made.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

// ── Mock fetch globally before any require ────────────────────────────────────
const mockFetch = jest.fn();
global.fetch = mockFetch;

// ── Helper: build a mock Response ─────────────────────────────────────────────
function mockResponse(body, status = 200) {
  return {
    ok:   status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

// ── Reset mock between tests ───────────────────────────────────────────────────
beforeEach(() => {
  mockFetch.mockReset();
  jest.resetModules(); // ensure fresh module state per test
});

// ─────────────────────────────────────────────────────────────────────────────
// FRED adapter
// ─────────────────────────────────────────────────────────────────────────────
describe("FRED provider", () => {
  let fred;
  beforeEach(() => {
    process.env.FRED_API_KEY = "test-fred-key";
    fred = require("../server/providers/fred");
  });

  test("getLatestObservation returns parsed value", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({
      observations: [
        { date: "2026-03-05", value: "4.13" },
      ],
    }));

    const result = await fred.getLatestObservation("DGS10");
    expect(result).toMatchObject({
      seriesId: "DGS10",
      value:    4.13,
      date:     "2026-03-05",
      source:   "FRED",
    });
  });

  test("getLatestObservation skips missing values ('.')", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({
      observations: [
        { date: "2026-03-06", value: "." },
        { date: "2026-03-05", value: "4.13" },
      ],
    }));

    const result = await fred.getLatestObservation("DGS10");
    expect(result.value).toBe(4.13);
    expect(result.date).toBe("2026-03-05");
  });

  test("getLatestObservation throws when no observations", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ observations: [] }));
    await expect(fred.getLatestObservation("DGS10")).rejects.toThrow("No observations");
  });

  test("getAllRates returns null fields on partial failure", async () => {
    // DGS10 succeeds, all others fail
    mockFetch
      .mockResolvedValueOnce(mockResponse({ observations: [{ date: "2026-03-05", value: "4.13" }] }))
      .mockRejectedValue(new Error("Network error"));

    const rates = await fred.getAllRates();
    expect(rates.dgs10).not.toBeNull();
    expect(rates.dgs10.value).toBe(4.13);
    expect(rates.dfii10).toBeNull();
    expect(rates.t10yie).toBeNull();
  });

  test("getRecentHistory returns ascending observations", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({
      observations: [
        { date: "2026-03-05", value: "4.13" },
        { date: "2026-03-04", value: "4.10" },
        { date: "2026-03-03", value: "4.08" },
      ],
    }));

    const result = await fred.getRecentHistory("DGS10", 3);
    expect(result.observations).toHaveLength(3);
    // Should be ascending (reversed from desc FRED order)
    expect(result.observations[0].date).toBe("2026-03-03");
    expect(result.observations[2].date).toBe("2026-03-05");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic cite-tag stripper
// ─────────────────────────────────────────────────────────────────────────────
describe("Anthropic cite-tag stripping", () => {
  // We test the behaviour indirectly via fetchAllAnalysis by injecting
  // a response that contains cite tags in the body fields.
  let anthropic;
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    anthropic = require("../server/providers/anthropic");
  });

  test("fetchAllAnalysis strips <cite> tags from econ body and title", async () => {
    const payload = {
      events: Array.from({ length: 5 }, (_, i) => ({
        headline: `Headline <cite index="${i}">with cite</cite>`,
        impact: "NEUTRAL", ticker: "MACRO", date: "2026-03-11",
        detail: `Detail <cite index="0">cited text</cite> end.`,
      })),
      risks: Array.from({ length: 7 }, (_, i) => ({
        id: i + 1, title: `Risk <cite index="0">title</cite>`,
        level: "LOW", score: 20, date: "2026-03-11",
        detail: `Detail with <cite index="1-2">embedded cite</cite> here.`,
        affects: "MACRO",
      })),
      econ: [
        { id: 1, label: "MACRO THEME", color: "#c8392b", bg: "rgba(200,57,43,.08)", border: "rgba(200,57,43,.2)",
          date: "2026-03-11", title: "Title <cite index=\"0\">cited</cite>",
          body: "First sentence. <cite index=\"0-3\">Cited content here.</cite> Third sentence." },
        { id: 2, label: "RATES ANALYSIS", color: "#1a3a5c", bg: "rgba(26,58,92,.15)", border: "rgba(88,166,255,.2)",
          date: "2026-03-11", title: "Rates title", body: "Clean body." },
        { id: 3, label: "EQUITY DEEP DIVE", color: "#2c6e49", bg: "rgba(44,110,73,.08)", border: "rgba(63,185,80,.2)",
          date: "2026-03-11", title: "Equity title", body: "Equity body." },
      ],
    };

    mockFetch.mockResolvedValueOnce(mockResponse({
      content: [{ type: "text", text: JSON.stringify(payload) }],
    }));

    const result = await anthropic.fetchAllAnalysis();

    // econ body should have tags stripped, inner text preserved
    expect(result.econ[0].body).not.toMatch(/<cite/);
    expect(result.econ[0].body).toContain("Cited content here.");
    expect(result.econ[0].title).not.toMatch(/<cite/);
    expect(result.econ[0].title).toContain("cited");

    // events detail should be clean
    expect(result.events[0].detail).not.toMatch(/<cite/);
    expect(result.events[0].detail).toContain("cited text");

    // risks detail should be clean
    expect(result.risks[0].detail).not.toMatch(/<cite/);
    expect(result.risks[0].detail).toContain("embedded cite");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic macro-view JSON parsing robustness
// ─────────────────────────────────────────────────────────────────────────────
describe("Anthropic fetchMacroView JSON parsing", () => {
  let anthropic;
  const macroPayload = {
    headline: "Real yields are elevated <cite index=\"0\">source</cite> while growth softens.",
    regimeLabel: "Bear Flattener / Risk-Off",
    scenarios: {
      base: {
        probability: 55,
        title: "Sticky Inflation / Slow Growth",
        narrative: "Inflation cools slowly <cite index=\"1\">cited</cite> and policy stays restrictive.",
        keyAssets: "USD, quality equities, short duration",
      },
      bull: {
        probability: 25,
        title: "Disinflation Relief",
        narrative: "Core inflation decelerates and duration rallies.",
        keyAssets: "Long duration, EMFX, cyclicals",
      },
      bear: {
        probability: 20,
        title: "Policy Error / Credit Stress",
        narrative: "Credit spreads widen and unemployment rises.",
        keyAssets: "USTs, gold, defensives",
      },
    },
    crossAsset: [
      { asset: "US Treasuries (Long Duration)", signal: "BULLISH", rationale: "Growth is slowing and real yields are restrictive." },
      { asset: "TIPS / Real Assets", signal: "NEUTRAL", rationale: "Breakevens are range-bound after recent inflation prints." },
      { asset: "IG Credit", signal: "NEUTRAL", rationale: "Spreads are stable but issuance remains elevated." },
      { asset: "HY Credit", signal: "BEARISH", rationale: "Default risk rises if financing costs stay high." },
      { asset: "US Equities (Growth)", signal: "NEUTRAL", rationale: "Valuations are rich versus real-rate backdrop." },
      { asset: "US Equities (Value/Cyclical)", signal: "BEARISH", rationale: "PMI momentum is softening." },
      { asset: "EM Equities", signal: "NEUTRAL", rationale: "China policy support offsets USD headwind." },
      { asset: "USD (DXY)", signal: "BULLISH", rationale: "Rate differentials continue to support dollar carry." },
      { asset: "Gold", signal: "BULLISH", rationale: "Geopolitical risk and central bank demand remain supportive." },
      { asset: "Commodities", signal: "NEUTRAL", rationale: "Demand uncertainty balances supply constraints." },
    ],
    centralBank: {
      fed: "Fed is likely on hold and reactive to labour-market softening.",
      boe: "BoE remains cautious with services inflation still elevated.",
      ecb: "ECB is easing gradually as growth stays weak.",
    },
    catalysts: [
      { event: "US CPI", date: "2026-04-10", impact: "Hot print would push real yields up and pressure duration assets." },
      { event: "FOMC", date: "2026-05-07", impact: "Dovish dots would support risk and weaken USD." },
      { event: "NFP", date: "2026-04-04", impact: "Weak payrolls would accelerate repricing toward cuts." },
    ],
    morningNote: "Position for quality while the policy path remains state-dependent {growth scare still live.",
  };

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    anthropic = require("../server/providers/anthropic");
  });

  test("parses macro JSON wrapped in extra text/markdown and strips cite tags", async () => {
    const wrapped = [
      "Morning note draft:",
      "```json",
      JSON.stringify(macroPayload, null, 2),
      "```",
      "End of draft.",
    ].join("\n");

    mockFetch.mockResolvedValueOnce(mockResponse({
      content: [{ type: "text", text: wrapped }],
    }));

    const result = await anthropic.fetchMacroView("rates context");
    expect(result.headline).not.toMatch(/<cite/);
    expect(result.scenarios.base.narrative).not.toMatch(/<cite/);
    expect(result.crossAsset).toHaveLength(10);
  });

  test("recovers from truncated macro JSON by repairing missing closing braces", async () => {
    const truncated = JSON.stringify(macroPayload).slice(0, -1); // drop final }

    mockFetch.mockResolvedValueOnce(mockResponse({
      content: [{ type: "text", text: truncated }],
    }));

    const result = await anthropic.fetchMacroView("rates context");
    expect(result.headline).toContain("Real yields are elevated");
    expect(result.scenarios.base.title).toBe("Sticky Inflation / Slow Growth");
    expect(result.crossAsset).toHaveLength(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Alpha Vantage adapter
// ─────────────────────────────────────────────────────────────────────────────
describe("Alpha Vantage provider", () => {
  let av;
  beforeEach(() => {
    process.env.ALPHA_VANTAGE_API_KEY = "test-av-key";
    av = require("../server/providers/alphaVantage");
  });

  test("getQuote returns parsed price", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({
      "Global Quote": {
        "05. price":            "192.43",
        "09. change":           "-7.02",
        "10. change percent":   "-3.52%",
        "06. volume":           "54320000",
        "07. latest trading day": "2026-03-06",
      },
    }));

    const q = await av.getQuote("AMD");
    expect(q.sym).toBe("AMD");
    expect(q.price).toBeCloseTo(192.43);
    expect(q.chgPct).toBeCloseTo(-3.52);
    expect(q.source).toBe("Alpha Vantage");
  });

  test("getQuote throws on rate limit Note", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({
      Note: "Thank you for using Alpha Vantage! Our standard API call frequency is 5 calls per minute.",
    }));
    await expect(av.getQuote("AMD")).rejects.toThrow("rate limit");
  });

  test("getQuote throws on Error Message", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ "Error Message": "Invalid API call" }));
    await expect(av.getQuote("AMD")).rejects.toThrow("Alpha Vantage error");
  });

  test("getFxRate returns parsed rate", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({
      "Realtime Currency Exchange Rate": {
        "1. From_Currency Code": "USD",
        "3. To_Currency Code":   "GBP",
        "5. Exchange Rate":      "0.7921",
        "6. Last Refreshed":     "2026-03-07 16:00:01",
      },
    }));

    const fx = await av.getFxRate("USD", "GBP");
    expect(fx.rate).toBeCloseTo(0.7921);
    expect(fx.fromCurrency).toBe("USD");
    expect(fx.toCurrency).toBe("GBP");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cache utility
// ─────────────────────────────────────────────────────────────────────────────
describe("TTLCache", () => {
  let TTLCache;
  beforeEach(() => {
    TTLCache = require("../server/cache");
    TTLCache.clear(); // reset singleton state
  });

  test("set and get returns value before expiry", () => {
    TTLCache.set("k", "v", 60_000);
    expect(TTLCache.get("k")).toBe("v");
  });

  test("get returns null after TTL expires", async () => {
    TTLCache.set("k", "v", 0); // 0ms TTL — immediately expired
    await new Promise(r => setTimeout(r, 5));
    expect(TTLCache.get("k")).toBeNull();
  });

  test("getWithMeta returns stale: true after expiry", () => {
    TTLCache.set("k", "v", 0);
    return new Promise(resolve => setTimeout(() => {
      const meta = TTLCache.getWithMeta("k");
      expect(meta).not.toBeNull();
      expect(meta.stale).toBe(true);
      expect(meta.value).toBe("v");
      resolve();
    }, 5));
  });

  test("has returns true for fresh key, false for missing key", () => {
    TTLCache.set("fresh", "v", 60_000);
    expect(TTLCache.has("fresh")).toBe(true);
    expect(TTLCache.has("missing")).toBe(false);
  });

  test("delete removes key", () => {
    TTLCache.set("k", "v", 60_000);
    TTLCache.delete("k");
    expect(TTLCache.has("k")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Retry utility
// ─────────────────────────────────────────────────────────────────────────────
describe("retry utilities", () => {
  let retry;
  beforeEach(() => {
    retry = require("../server/retry");
  });

  test("withRetry succeeds on first attempt", async () => {
    const fn = jest.fn().mockResolvedValue("ok");
    const result = await retry.withRetry(fn, { attempts: 3 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("withRetry retries on failure and succeeds", async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue("ok");
    const result = await retry.withRetry(fn, { attempts: 3, baseMs: 1, shouldRetry: () => true });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("withRetry throws after max attempts", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("persistent failure"));
    await expect(retry.withRetry(fn, { attempts: 2, baseMs: 1 })).rejects.toThrow("persistent failure");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("withRetry aborts early when shouldRetry returns false", async () => {
    const authErr = Object.assign(new Error("Unauthorized"), { status: 401 });
    const fn = jest.fn().mockRejectedValue(authErr);
    await expect(retry.withRetry(fn, { attempts: 3, baseMs: 1, shouldRetry: (e) => e.status !== 401 }))
      .rejects.toThrow("Unauthorized");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("isRetryable: AbortError is retryable", () => {
    const err = Object.assign(new Error("abort"), { name: "AbortError" });
    expect(retry.isRetryable(err)).toBe(true);
  });

  test("isRetryable: 401 is not retryable", () => {
    const err = Object.assign(new Error("auth"), { status: 401 });
    expect(retry.isRetryable(err)).toBe(false);
  });

  test("isRetryable: 429 is retryable", () => {
    const err = Object.assign(new Error("rate limit"), { status: 429 });
    expect(retry.isRetryable(err)).toBe(true);
  });

  test("isRetryable: 500 is retryable", () => {
    const err = Object.assign(new Error("server err"), { status: 500 });
    expect(retry.isRetryable(err)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Polygon.io adapter
// Uses /v2/aggs/ticker/{sym}/range/1/day/{from}/{to} (free-tier endpoint).
// One fetch call per symbol — tests must mock once per requested ticker.
// ─────────────────────────────────────────────────────────────────────────────
describe("Polygon provider", () => {
  let polygon;
  beforeEach(() => {
    process.env.POLYGON_API_KEY = "test-poly-key";
    polygon = require("../server/providers/polygon");
  });

  /**
   * Build a Polygon /v2/aggs daily-aggregates response.
   * bars should be in descending order: [latestDay, prevDay].
   */
  function aggsResponse(sym, bars) {
    return {
      ticker:       sym,
      status:       "OK",
      resultsCount: bars.length,
      results:      bars,
    };
  }

  /** Build a single daily bar object. */
  function bar(closePrice, epochMs) {
    return {
      t:  epochMs || new Date("2026-03-06T05:00:00Z").getTime(),
      o:  closePrice * 0.99,
      h:  closePrice * 1.01,
      l:  closePrice * 0.98,
      c:  closePrice,
      v:  4_000_000,
      vw: closePrice,
      n:  50_000,
    };
  }

  test("getSnapshots returns parsed quotes for all tickers", async () => {
    // Two separate fetch calls — one per ticker (parallel via Promise.allSettled)
    mockFetch
      .mockResolvedValueOnce(mockResponse(aggsResponse("NVDA", [
        bar(175.00, new Date("2026-03-06T05:00:00Z").getTime()),  // latest
        bar(177.00, new Date("2026-03-05T05:00:00Z").getTime()),  // prev
      ])))
      .mockResolvedValueOnce(mockResponse(aggsResponse("MSFT", [
        bar(405.00, new Date("2026-03-06T05:00:00Z").getTime()),
        bar(404.00, new Date("2026-03-05T05:00:00Z").getTime()),
      ])));

    const results = await polygon.getSnapshots(["NVDA", "MSFT"]);
    expect(results).toHaveLength(2);

    const nvda = results.find(r => r.sym === "NVDA");
    expect(nvda.sym).toBe("NVDA");
    expect(nvda.price).toBeCloseTo(175.00, 1);
    // chgPct = (175 - 177) / 177 * 100 ≈ -1.13
    expect(nvda.chgPct).toBeCloseTo((175 - 177) / 177 * 100, 1);
    expect(nvda.source).toBe("Polygon.io");
    expect(nvda.date).toBe("2026-03-06");
  });

  test("getSnapshots returns chgPct 0 when only one bar is available (no prev day)", async () => {
    // Only one result returned (e.g. first day of trading or very recent listing)
    mockFetch.mockResolvedValueOnce(mockResponse(aggsResponse("TSLA", [
      bar(300.00, new Date("2026-03-06T05:00:00Z").getTime()),
    ])));

    const results = await polygon.getSnapshots(["TSLA"]);
    expect(results[0].price).toBeCloseTo(300.00, 1);
    expect(results[0].chgPct).toBe(0);
  });

  test("getSnapshots skips tickers that return Polygon ERROR status (graceful degradation)", async () => {
    // ERROR from a single ticker — Promise.allSettled should swallow it
    // and return an empty array rather than throwing.
    mockFetch.mockResolvedValueOnce(mockResponse({
      status: "ERROR",
      error:  "Your plan does not include this endpoint.",
    }));
    const results = await polygon.getSnapshots(["NVDA"]);
    expect(results).toHaveLength(0);
  });

  test("getSnapshots throws when POLYGON_API_KEY not set", async () => {
    delete process.env.POLYGON_API_KEY;
    polygon = require("../server/providers/polygon");
    await expect(polygon.getSnapshots(["NVDA"])).rejects.toThrow("POLYGON_API_KEY not configured");
  });

  test("getSnapshots filters out non-POLYGON_PEERS symbols without calling fetch", async () => {
    // AMD is not in POLYGON_PEERS — filtered before any API call
    const results = await polygon.getSnapshots(["AMD"]);
    expect(results).toHaveLength(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("POLYGON_PEERS set contains expected peer symbols", () => {
    expect(polygon.POLYGON_PEERS.has("NVDA")).toBe(true);
    expect(polygon.POLYGON_PEERS.has("MSFT")).toBe(true);
    expect(polygon.POLYGON_PEERS.has("TSLA")).toBe(true);
    expect(polygon.POLYGON_PEERS.has("AMD")).toBe(false);  // AMD stays on AV
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3: webhook provider
// ─────────────────────────────────────────────────────────────────────────────
describe("Phase 3: webhook provider", () => {
  it("is a no-op when WEBHOOK_URL not set", async () => {
    delete process.env.WEBHOOK_URL;
    const { fireWebhook } = require("../server/providers/webhook");
    // Should not throw
    await expect(fireWebhook("test.event", { foo: "bar" })).resolves.toBeUndefined();
  });

  it("fires POST when WEBHOOK_URL is set", async () => {
    process.env.WEBHOOK_URL = "http://fake-webhook.test/hook";
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    const { fireWebhook } = require("../server/providers/webhook");
    await fireWebhook("idea.pending", { count: 1 });
    expect(global.fetch).toHaveBeenCalled();
    // Verify the first arg is the URL
    const callArgs = global.fetch.mock.calls[0];
    expect(callArgs[0]).toBe("http://fake-webhook.test/hook");
    delete process.env.WEBHOOK_URL;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Finnhub provider
// ─────────────────────────────────────────────────────────────────────────────
describe("Finnhub provider", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.FINNHUB_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.FINNHUB_API_KEY;
  });

  it("getMarketNews returns mapped articles", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: 1, headline: "Fed holds rates", summary: "FOMC holds at 4.25%", source: "Reuters",
          url: "https://reuters.com/1", datetime: 1741900000, related: "FOMC" },
        { id: 2, headline: "AMD beats estimates", summary: "AMD Q1 strong", source: "Bloomberg",
          url: "https://bloomberg.com/2", datetime: 1741800000, related: "AMD" },
      ],
    });
    const finnhub = require("../server/providers/finnhub");
    const news = await finnhub.getMarketNews("general", 5);
    expect(news.length).toBe(2);
    expect(news[0].headline).toBe("Fed holds rates");
    expect(news[0].source).toBe("Reuters");
    expect(typeof news[0].datetime).toBe("string");
  });

  it("getMarketNews returns empty array when not configured", async () => {
    delete process.env.FINNHUB_API_KEY;
    const finnhub = require("../server/providers/finnhub");
    await expect(finnhub.getMarketNews()).rejects.toThrow("FINNHUB_API_KEY not configured");
  });

  it("getEarningsCalendar returns mapped calendar items", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        earningsCalendar: [
          { symbol: "AMD", date: "2026-04-22", epsEstimate: 0.68, revenueEstimate: 9800000000, hour: "amc" },
          { symbol: "MSFT", date: "2026-04-23", epsEstimate: 3.20, revenueEstimate: 68000000000, hour: "amc" },
        ],
      }),
    });
    const finnhub = require("../server/providers/finnhub");
    const cal = await finnhub.getEarningsCalendar(45);
    expect(Array.isArray(cal)).toBe(true);
    expect(cal[0].ticker).toBe("AMD");
    expect(cal[0].epsEstimate).toBe(0.68);
  });

  it("isConfigured returns false when key not set", () => {
    delete process.env.FINNHUB_API_KEY;
    const finnhub = require("../server/providers/finnhub");
    expect(finnhub.isConfigured()).toBe(false);
  });

  it("isConfigured returns true when key is set", () => {
    process.env.FINNHUB_API_KEY = "test-key";
    const finnhub = require("../server/providers/finnhub");
    expect(finnhub.isConfigured()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// News endpoint tests
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /api/news", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.FINNHUB_API_KEY = "test-key";
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    });
  });

  it("returns 200 with headlines array", async () => {
    const app = require("../server/index");
    const request = require("supertest");
    const res = await request(app).get("/api/news");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.headlines)).toBe(true);
  });

  it("GET /api/news/calendar returns earnings and economic arrays", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ earningsCalendar: [], economicCalendar: [] }),
    });
    const app = require("../server/index");
    const request = require("supertest");
    const res = await request(app).get("/api/news/calendar");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.earnings)).toBe(true);
    expect(Array.isArray(res.body.data.economic)).toBe(true);
  });

  it("GET /api/news/:ticker returns articles and sentiment fields", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    });
    const app = require("../server/index");
    const request = require("supertest");
    const res = await request(app).get("/api/news/AMD");
    expect(res.status).toBe(200);
    expect(res.body.data.ticker).toBe("AMD");
    expect(Array.isArray(res.body.data.articles)).toBe(true);
  });
});
