/**
 * tests/reviewFixes.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Fixes ported from the external review branch (claude/relaxed-brown-8q5ynd)
 * that still applied after the Markets/five-agent rewrite:
 *   1. bulletin notification — AI/headline text can never become shell or script source
 *   2. macro/clients — no fabricated fallback content
 *   3. no presupposed events in prompts or the no-AI narrative
 *   4. no hand-typed economic calendar served as current
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

describe("1. bulletin macOS notification cannot execute headline text", () => {
  let execFile;
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");

  beforeEach(() => {
    jest.resetModules();
    execFile = jest.fn();
    jest.doMock("child_process", () => ({ execFile, exec: jest.fn(() => { throw new Error("exec must not be used"); }) }));
    Object.defineProperty(process, "platform", { value: "darwin" });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", realPlatform);
    jest.dontMock("child_process");
  });

  test("hostile headline is passed as an argv item, never inside the script", () => {
    const { sendMacNotification, NOTIFY_SCRIPT } = require("../server/routes/bulletin")._internal;
    const evil = `Fed "; do shell script "rm -rf ~" --`;
    sendMacNotification(evil, "body 'quoted'");

    expect(execFile).toHaveBeenCalledTimes(1);
    const [bin, args] = execFile.mock.calls[0];
    expect(bin).toBe("osascript");
    expect(args[0]).toBe("-e");
    expect(args[1]).toBe(NOTIFY_SCRIPT);           // script source is constant
    expect(args[1]).not.toContain("rm -rf");
    expect(args[3]).toBe(evil);                     // text arrives verbatim as data
  });

  test("does nothing off macOS", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const { sendMacNotification } = require("../server/routes/bulletin")._internal;
    sendMacNotification("t", "b");
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe("2. macro view / clients never serve fabricated content", () => {
  const request = require("supertest");
  const express = require("express");
  let app, anthropic, macroContext, cache;

  const CTX = {
    facts: {
      dgs10:    { key: "dgs10", label: "10Y UST Nominal", group: "rates", value: 4.37, formatted: "4.37%", source: "FRED", seriesId: "DGS10", asOf: "2026-09-25" },
      dfii10:   { key: "dfii10", label: "10Y Real", group: "rates", value: 1.91, formatted: "1.91%", source: "FRED", seriesId: "DFII10", asOf: "2026-09-25" },
      t10yie:   { key: "t10yie", label: "BEI", group: "rates", value: 2.46, formatted: "2.46%", source: "FRED", seriesId: "T10YIE", asOf: "2026-09-25" },
      hySpread: { key: "hySpread", label: "HY OAS", group: "credit", value: 3.05, formatted: "3.05%", source: "FRED", seriesId: "BAMLH0A0HYM2", asOf: "2026-09-25" },
      t10y2y:   { key: "t10y2y", label: "Curve", group: "rates", value: 0.41, formatted: "0.41%", source: "FRED", seriesId: "T10Y2Y", asOf: "2026-09-25" },
    },
    policyPath: null, missing: [], fetchedAt: "2026-09-28T07:00:00Z",
  };

  beforeEach(() => {
    jest.resetModules();
    jest.doMock("../server/providers/anthropic", () => ({ fetchMacroView: jest.fn(), fetchClientImpact: jest.fn() }));
    jest.doMock("../server/providers/polygon", () => ({ getVolSurface: jest.fn().mockResolvedValue({ vix3m: null, skew: null }) }));
    anthropic    = require("../server/providers/anthropic");
    macroContext = require("../server/providers/macroContext");
    cache        = require("../server/cache");
    cache.clear();
    jest.spyOn(macroContext, "getMacroContext").mockResolvedValue(CTX);
    app = express();
    app.use("/api/macro", require("../server/routes/macro"));
    delete process.env.LOW_COST_MODE;
  });
  afterEach(() => jest.restoreAllMocks());

  test("AI failure → 503 available:false, no seeded view", async () => {
    anthropic.fetchMacroView.mockRejectedValue(Object.assign(new Error("overloaded"), { status: 529 }));
    const res = await request(app).get("/api/macro/view");
    expect(res.status).toBe(503);
    expect(res.body.source).toBe("unavailable");
    expect(res.body.data).toMatchObject({ available: false, reason: "AI_UNAVAILABLE" });
    expect(res.body.data.tradeIdea).toBeUndefined();
  });

  test("LOW_COST_MODE → 503 for clients too, and the AI is never called", async () => {
    process.env.LOW_COST_MODE = "true";
    const res = await request(app).get("/api/macro/clients");
    expect(res.status).toBe(503);
    expect(res.body.data.reason).toBe("LOW_COST_MODE");
    expect(anthropic.fetchClientImpact).not.toHaveBeenCalled();
  });

  test("the model receives the verified FRED block — real values, not hardcoded defaults", async () => {
    anthropic.fetchMacroView.mockResolvedValue({ headline: "h", crossAsset: [] });
    const res = await request(app).get("/api/macro/view");
    expect(res.status).toBe(200);
    const ctxStr = anthropic.fetchMacroView.mock.calls[0][0];
    expect(ctxStr).toMatch(/VERIFIED MARKET DATA/);
    expect(ctxStr).toMatch(/4\.37%/);
    expect(ctxStr).not.toMatch(/10Y nominal: 4\.2%/);
    expect(res.body.data.crossAsset.length).toBeGreaterThan(0);          // rules-based from the real facts
    expect(res.body.data.crossAssetBasis).toMatch(/rules-based from FRED/);
    expect(res.body.data.crossAsset[0].rationale).toMatch(/1\.91%/);
  });

  test("cross-asset matrix is omitted, not invented, when any input is missing", () => {
    const { buildCrossAssetMatrix } = require("../server/routes/macro")._internal;
    expect(buildCrossAssetMatrix({ dgs10: 4.3, dfii10: null, t10y2y: 0.4, hy_spread: 3, t10y_ie: 2.4 })).toEqual([]);
  });

  test("the fallback builders are gone", () => {
    const src = require("fs").readFileSync(require.resolve("../server/routes/macro"), "utf8");
    expect(src).not.toMatch(/function buildMacroViewFallback|function buildClientFallback|function rateVal/);
  });
});

describe("3. no presupposed events — prompts and the no-AI narrative", () => {
  const { generateNarrative } = require("../server/analytics/narrativeEngine");
  // Whole words, case-sensitive where it matters ("ASIC" must not match WEB_SEARCH_BASIC).
  const FORBIDDEN = /\b(Iran|Hormuz|Israel|ASIC|MI450|JGB)\b|Canada\/Mexico|25% tariff|\bmilitary\b|\$6GW/;

  test("with no fetched data the narrative is empty — nothing is back-filled", () => {
    expect(generateNarrative({})).toMatchObject({ events: [], risks: [], econ: [] });
    expect(generateNarrative({ rates: { dgs10: null } }).events).toEqual([]);
  });

  test("cards describe only the fetched figures, dated by observation, never by the clock", () => {
    const n = generateNarrative({ rates: {
      dgs10: { value: 4.37, date: "2026-09-25" },
      hy_spread: { value: 4.6, date: "2026-09-24" },
    } });
    const all = [...n.events, ...n.risks, ...n.econ];
    expect(all.length).toBeGreaterThan(0);
    expect(JSON.stringify(all)).not.toMatch(FORBIDDEN);
    expect(n.events.map(e => e.date).sort()).toEqual(["2026-09-24", "2026-09-25"]);
    expect(n.risks.find(r => /Credit/.test(r.title)).level).toBe("HIGH");
    expect(n.risks.some(r => /Real yields/.test(r.title))).toBe(false);   // DFII10 not fetched → no card
  });

  test("AI prompts carry no fixed risk list or event-laden worked examples", () => {
    const src = require("fs").readFileSync(require.resolve("../server/providers/anthropic"), "utf8");
    const promptText = src.split("\n").filter(l => !/^\s*(\/\/|\*)/.test(l)).join("\n");   // ignore comments
    expect(promptText).not.toMatch(FORBIDDEN);
  });
});

describe("4. no hand-typed economic calendar", () => {
  const request = require("supertest");
  const express = require("express");

  test("when Finnhub has no calendar, the route says unavailable — no typed-in dates", async () => {
    jest.resetModules();
    jest.doMock("../server/providers/finnhub", () => ({
      getMarketNews: jest.fn().mockResolvedValue([]),
      getEarningsCalendar: jest.fn().mockResolvedValue([]),
      getEconomicCalendar: jest.fn().mockResolvedValue([]),
      getCompanyNews: jest.fn(), getNewsSentiment: jest.fn(),
      isConfigured: jest.fn().mockReturnValue(true),
      TTL_NEWS_MS: 1, TTL_CALENDAR_MS: 1,
    }));
    require("../server/cache").clear();
    const app = express();
    app.use("/api/news", require("../server/routes/news"));

    const cal = await request(app).get("/api/news/calendar");
    expect(cal.body.data.economic).toEqual([]);
    expect(cal.body.data.economicSource).toBe("unavailable");
    expect(cal.body.data.economicNote).toMatch(/unavailable/);

    const news = await request(app).get("/api/news");
    expect(news.body.data.economicCalendar).toEqual([]);
    expect(news.body.data.econCalendarSource).toBe("unavailable");
    jest.dontMock("../server/providers/finnhub");
  });

  test("the seed list is gone", () => {
    const src = require("fs").readFileSync(require.resolve("../server/routes/news"), "utf8");
    expect(src).not.toMatch(/MACRO_CALENDAR_SEED|upcomingSeededEvents|FOMC Rate Decision/);
  });
});
