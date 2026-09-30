/**
 * tests/freshData.test.js — D-20: research reports start from current prices.
 * FRED's weekly-published oil series once handed a report $114.89 Brent while the
 * market traded ~$99. Newer Markets prices now replace older FRED values (labelled),
 * anything older than 2 trading days is flagged STALE, and every report refreshes
 * Markets first.
 */
"use strict";

const mc = () => require("../server/providers/macroContext");
const NOW = Date.parse("2026-09-29T10:00:00Z");    // a Tuesday

function fredCtx() {
  return {
    facts: {
      brent:  { key: "brent", label: "Brent Crude", group: "commodity", value: 114.89, formatted: "$114.89/bbl", source: "FRED", seriesId: "DCOILBRENTEU", url: "https://fred.stlouisfed.org/series/DCOILBRENTEU", asOf: "2026-09-22" },
      dgs10:  { key: "dgs10", label: "10Y UST Nominal", group: "rates", value: 5.17, formatted: "5.17%", source: "FRED", seriesId: "DGS10", asOf: "2026-09-25" },
      dfii10: { key: "dfii10", label: "10Y UST Real (TIPS)", group: "rates", value: 2.83, formatted: "2.83%", source: "FRED", seriesId: "DFII10", asOf: "2026-09-25" },
      eurusd: { key: "eurusd", label: "EUR/USD", group: "fx", value: 1.14, formatted: "1.1400", source: "FRED", seriesId: "DEXUSEU", asOf: "2026-09-25" },
    },
    missing: [], fetchedAt: "2026-09-29T09:59:00Z", sources: ["FRED"], policyPath: null,
  };
}
const quote = (value, asOf, extra = {}) => ({ value, asOf, source: "Yahoo Finance", sourceDetail: "ICE via Yahoo Finance", sourceUrl: "https://finance.yahoo.com/quote/BZ%3DF", ...extra });
const snap = (items) => ({ generatedAt: "2026-09-29T09:58:00Z", items });

beforeEach(() => jest.resetModules());

test("a newer Markets price replaces the older FRED value, labelled with its own source and time", () => {
  const ctx = mc().withMarkets(fredCtx(), snap([{ id: "BRENT", ok: true, stale: false, label: "Brent crude", quote: quote(98.85, "2026-09-29T09:14:00Z") }]), NOW);
  expect(ctx.facts.brent).toMatchObject({ value: 98.85, formatted: "$98.85/bbl", source: "Yahoo Finance", asOf: "2026-09-29T09:14:00Z", stale: false,
    replaced: { source: "FRED", seriesId: "DCOILBRENTEU", value: 114.89, asOf: "2026-09-22" } });
  expect(ctx.overlaid).toEqual(["brent"]);
  expect(ctx.sources).toEqual(["FRED", "Yahoo Finance"]);
});

test("the cached FRED context is never mutated", () => {
  const base = fredCtx();
  mc().withMarkets(base, snap([{ id: "BRENT", ok: true, quote: quote(98.85, "2026-09-29T09:14:00Z") }]), NOW);
  expect(base.facts.brent.value).toBe(114.89);
});

test("FRED stays when Markets is older, stale, failed, or implausibly far off", () => {
  const m = mc();
  const older  = m.withMarkets(fredCtx(), snap([{ id: "BRENT", ok: true, quote: quote(99, "2026-09-20T09:00:00Z") }]), NOW);
  const stale  = m.withMarkets(fredCtx(), snap([{ id: "BRENT", ok: true, stale: true, quote: quote(99, "2026-09-29T09:00:00Z") }]), NOW);
  const failed = m.withMarkets(fredCtx(), snap([{ id: "BRENT", ok: false }]), NOW);
  const units  = m.withMarkets(fredCtx(), snap([{ id: "US10Y", ok: true, quote: quote(51.7, "2026-09-29T09:00:00Z") }]), NOW);   // e.g. ^TNX ×10
  for (const c of [older, stale, failed]) expect(c.facts.brent.source).toBe("FRED");
  expect(units.facts.dgs10.source).toBe("FRED");
});

test("figures older than 2 trading days are flagged stale (weekends don't count)", () => {
  const m = mc();
  expect(m.tradingDaysSince("2026-09-25", NOW)).toBe(2);        // Fri → Mon, Tue
  expect(m.tradingDaysSince("2026-09-22", NOW)).toBe(5);
  const ctx = m.withMarkets(fredCtx(), snap([]), NOW);
  expect(ctx.facts.brent).toMatchObject({ stale: true, ageTradingDays: 5 });
  expect(ctx.facts.dgs10.stale).toBe(false);
  expect(ctx.stale).toEqual(["brent"]);
});

test("the prompt marks STALE figures as last-known and asks for a search; rows carry the flag", () => {
  const m = mc();
  const ctx = m.withMarkets(fredCtx(), snap([]), NOW);
  const block = m.toPromptBlock(ctx);
  expect(block).toMatch(/Brent Crude: \$114\.89\/bbl \[FRED DCOILBRENTEU, as of 2026-09-22\] — STALE \(5 trading days old\): this is the last KNOWN value/);
  expect(block).toMatch(/never present it as the current level/);
  expect(block).not.toMatch(/10Y UST Nominal: 5\.17% .*STALE/);
  const rows = m.toMarketDataRows(ctx);
  expect(rows.find(r => r.label === "Brent Crude")).toMatchObject({ stale: true, url: expect.stringMatching(/fred\.stlouisfed/) });
});

test("the fact check never judges a claim against a stale figure, and cites the real source", () => {
  const { checkClaims } = require("../server/research/factCheck");
  const m = mc();
  const claim = () => ({ claimId: "CLM-001", classification: "FACT", statement: "Brent crude trades at $99 per barrel.", agentsAgreeing: [], agentsDisagreeing: [] });
  const staleCtx = m.withMarkets(fredCtx(), snap([]), NOW);
  const r1 = checkClaims([claim()], staleCtx);
  expect(r1.settledIds).toEqual([]);                           // not wrongly "conflicting"
  const fresh = m.withMarkets(fredCtx(), snap([{ id: "BRENT", ok: true, quote: quote(98.85, "2026-09-29T09:14:00Z") }]), NOW);
  const c = claim();
  const r2 = checkClaims([c], fresh);
  expect(r2.settledIds).toEqual(["CLM-001"]);
  expect(c.verificationStatus).toBe("VERIFIED");
  expect(c.notes).toMatch(/matches Yahoo Finance/);
  expect(r2.sources[0]).toMatchObject({ publisher: "Yahoo Finance", url: expect.stringMatching(/finance\.yahoo\.com/) });
});

test("every report refreshes Markets first (through the shared helper)", async () => {
  process.env.RESEARCH_REFRESH_MARKETS = "on";
  try {
    jest.resetModules();
    const refresh = jest.fn(async () => ({}));
    jest.doMock("../server/jobs/refreshMarkets", () => ({ refreshMarkets: refresh }));
    jest.doMock("../server/research/orchestrator", () => ({
      multiAgentEnabled: () => true, setStage: jest.fn(),
      runPipeline: jest.fn(async () => { throw Object.assign(new Error("stop here"), { code: "SONNET_UNAVAILABLE" }); }),
    }));
    const research = require("../server/routes/research");
    const out = await research.generateReport("macro");
    expect(refresh).toHaveBeenCalledWith("research");
    expect(out).toMatchObject({ ok: false, reason: "SONNET_UNAVAILABLE" });
  } finally { delete process.env.RESEARCH_REFRESH_MARKETS; }
});

describe("Codex review on #11", () => {
  test("Brent and WTI from the same venue keep separate ids and links in the fact check", () => {
    const { checkClaims } = require("../server/research/factCheck");
    const base = fredCtx();
    base.facts.wti = { key: "wti", label: "WTI Crude", group: "commodity", value: 110, formatted: "$110.00/bbl", source: "FRED", seriesId: "DCOILWTICO", asOf: "2026-09-22" };
    const venue = { sourceDetail: "NY Mercantile via Yahoo Finance" };
    const ctx = mc().withMarkets(base, snap([
      { id: "BRENT", ok: true, quote: quote(98.85, "2026-09-29T09:14:00Z", { ...venue, sourceUrl: "https://finance.yahoo.com/quote/BZ%3DF" }) },
      { id: "WTI",   ok: true, quote: quote(95.10, "2026-09-29T09:14:00Z", { ...venue, sourceUrl: "https://finance.yahoo.com/quote/CL%3DF" }) },
    ]), NOW);
    expect(ctx.facts.brent.seriesId).toBe("BRENT");
    expect(ctx.facts.wti.seriesId).toBe("WTI");
    expect(mc().toMarketDataRows(ctx).find(r => r.label === "WTI Crude").detail).toBe("NY Mercantile via Yahoo Finance");
    const claims = [
      { claimId: "CLM-001", classification: "FACT", statement: "Brent crude trades at $98.85 per barrel.", agentsAgreeing: [], agentsDisagreeing: [] },
      { claimId: "CLM-002", classification: "FACT", statement: "WTI crude trades at $95.10 per barrel.", agentsAgreeing: [], agentsDisagreeing: [] },
    ];
    const r = checkClaims(claims, ctx);
    expect(r.settledIds).toEqual(["CLM-001", "CLM-002"]);
    expect(r.sources.map(s => s.url).sort()).toEqual(["https://finance.yahoo.com/quote/BZ%3DF", "https://finance.yahoo.com/quote/CL%3DF"]);
  });

  test("a FRED series that failed is supplied by a fresh Markets quote and leaves UNAVAILABLE", () => {
    const base = fredCtx();
    delete base.facts.brent;
    base.missing = ["DCOILBRENTEU", "VIXCLS"];
    const ctx = mc().withMarkets(base, snap([{ id: "BRENT", ok: true, quote: quote(98.85, "2026-09-29T09:14:00Z") }]), NOW);
    expect(ctx.facts.brent).toMatchObject({ value: 98.85, label: "Brent Crude", group: "commodity", source: "Yahoo Finance", replaced: null, stale: false });
    expect(ctx.missing).toEqual(["VIXCLS"]);
    expect(mc().toPromptBlock(ctx)).toMatch(/UNAVAILABLE THIS RUN: VIXCLS\./);
    // No quote → still missing, never invented.
    const none = mc().withMarkets(base, snap([]), NOW);
    expect(none.facts.brent).toBeUndefined();
    expect(none.missing).toEqual(["DCOILBRENTEU", "VIXCLS"]);
  });

  test("the policy proxy is marked stale when DGS2 or DFF is stale", () => {
    const m = mc();
    const base = fredCtx();
    base.facts.dgs2 = { key: "dgs2", label: "2Y UST", group: "rates", value: 4.0, formatted: "4.00%", source: "FRED", seriesId: "DGS2", asOf: "2026-09-21" };
    base.facts.dff  = { key: "dff", label: "Effective Fed Funds", group: "rates", value: 4.5, formatted: "4.50%", source: "FRED", seriesId: "DFF", asOf: "2026-09-25" };
    base.policyPath = m.derivePolicyPath(base.facts);
    const ctx = m.withMarkets(base, snap([]), NOW);
    expect(ctx.policyPath).toMatchObject({ direction: "EASING BIAS", stale: true, staleNote: expect.stringMatching(/^STALE: built from DGS2, more than 2 trading days old/) });
    expect(m.toPromptBlock(ctx)).toMatch(/STALE: built from DGS2.*Do not present this direction as current\./);
    // Fresh inputs → no stale mark.
    base.facts.dgs2.asOf = "2026-09-25";
    expect(m.withMarkets(base, snap([]), NOW).policyPath.stale).toBeUndefined();
  });
});
