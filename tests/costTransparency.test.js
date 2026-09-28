/**
 * tests/costTransparency.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Cost transparency, the USD budget, the Claude transport (receipts + batch
 * mode), the deterministic FRED fact check, and the red-team log.
 *
 * All HTTP is mocked via global.fetch — no real network calls, no real spend.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const aiCost     = require("../server/providers/aiCost");
const budget     = require("../server/providers/budget");
const transport  = require("../server/providers/claudeTransport");
const factCheck  = require("../server/research/factCheck");
const redTeamLog = require("../server/research/redTeamLog");

const mockFetch = jest.fn();
global.fetch = mockFetch;

function jsonRes(body, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}
function textRes(text) {
  return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
}
function message(usage, text = "{}", model = "claude-sonnet-5") {
  return { model, content: [{ type: "text", text }], usage };
}

beforeEach(() => {
  mockFetch.mockReset();
  budget._reset();
  redTeamLog._reset();
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.ANTHROPIC_DAILY_CAP;
  delete process.env.ANTHROPIC_MONTHLY_CAP;
  delete process.env.ANTHROPIC_MONTHLY_CAP_MODE;
  delete process.env.RESEARCH_CONFIRM_ABOVE_USD;
});

// ══════════════════════════════════════════════════════════════════════════════
describe("aiCost.priceCall — dollars from real usage", () => {
  test("Sonnet 5: $2/M input, $10/M output", () => {
    const p = aiCost.priceCall({ model: "claude-sonnet-5", usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } });
    expect(p.priced).toBe(true);
    expect(p.usd).toBeCloseTo(12, 6);
  });

  test("Haiku 4.5 (dated id normalised): $1/M input, $5/M output", () => {
    const p = aiCost.priceCall({ model: "claude-haiku-4-5-20251001", usage: { input_tokens: 500_000, output_tokens: 100_000 } });
    expect(p.usd).toBeCloseTo(0.5 + 0.5, 6);
  });

  test("cache writes cost 1.25x input, cache reads 0.1x", () => {
    const p = aiCost.priceCall({ model: "claude-sonnet-5", usage: { cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 } });
    expect(p.usd).toBeCloseTo(2 * 1.25 + 2 * 0.1, 6);
  });

  test("web searches are $10 per 1,000", () => {
    const p = aiCost.priceCall({ model: "claude-sonnet-5", usage: { server_tool_use: { web_search_requests: 3 } } });
    expect(p.webSearches).toBe(3);
    expect(p.usd).toBeCloseTo(0.03, 6);
  });

  test("batch halves token cost but not search cost, and reports the saving", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 0, server_tool_use: { web_search_requests: 2 } };
    const sync  = aiCost.priceCall({ model: "claude-sonnet-5", usage });
    const batch = aiCost.priceCall({ model: "claude-sonnet-5", usage, batch: true });
    expect(sync.usd).toBeCloseTo(2.02, 6);
    expect(batch.usd).toBeCloseTo(1.02, 6);
    expect(batch.batchSavingsUSD).toBeCloseTo(1, 6);
  });

  test("an unknown model is UNPRICED — never silently $0", () => {
    const p = aiCost.priceCall({ model: "openai:gpt-4o", usage: { input_tokens: 999 } });
    expect(p.priced).toBe(false);
    expect(p.usd).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe("budget — caps are USD, not call counts", () => {
  test("unset caps default to $5/day and $20/month, monthly in warn mode (not NaN, not off)", () => {
    const s = budget.getStatus();
    expect(s.currency).toBe("USD");
    expect(s.daily.cap).toBe(5);
    expect(s.monthly.cap).toBe(20);
    expect(s.monthly.mode).toBe("warn");
    expect(s.monthly.overCap).toBe(false);
  });

  test("monthly cap in warn mode: over $20 is flagged but never blocks", () => {
    process.env.ANTHROPIC_DAILY_CAP = "0";   // isolate the monthly dimension
    aiCost.record(aiCost.priceCall({ model: "claude-sonnet-5", usage: { output_tokens: 2_100_000 } }));   // $21
    expect(() => budget.checkAndIncrement()).not.toThrow();
    expect(budget.getStatus().monthly).toMatchObject({ overCap: true, mode: "warn", remaining: 0 });
  });

  test("monthly cap in block mode stops calls", () => {
    process.env.ANTHROPIC_DAILY_CAP = "0";
    process.env.ANTHROPIC_MONTHLY_CAP_MODE = "block";
    aiCost.record(aiCost.priceCall({ model: "claude-sonnet-5", usage: { output_tokens: 2_100_000 } }));
    let err;
    try { budget.checkAndIncrement(); } catch (e) { err = e; }
    expect(err.code).toBe("BUDGET_MONTHLY");
  });

  test("many cheap calls do not trip the cap; dollars do", () => {
    const cheap = aiCost.priceCall({ model: "claude-haiku-4-5", usage: { input_tokens: 1000, output_tokens: 100 } });
    for (let i = 0; i < 20; i++) aiCost.record(cheap);
    expect(() => budget.checkAndIncrement()).not.toThrow();   // 20 calls, ~$0.03

    aiCost.record(aiCost.priceCall({ model: "claude-sonnet-5", usage: { output_tokens: 600_000 } }));   // $6
    let err;
    try { budget.checkAndIncrement(); } catch (e) { err = e; }
    expect(err.code).toBe("BUDGET_DAILY");
    expect(err.message).toMatch(/\$6\.\d\d of \$5\.00/);
  });

  test("a cap of 0 disables that dimension", () => {
    process.env.ANTHROPIC_DAILY_CAP = "0";
    aiCost.record(aiCost.priceCall({ model: "claude-sonnet-5", usage: { output_tokens: 600_000 } }));
    expect(() => budget.checkAndIncrement()).not.toThrow();
  });

  test("getStatus reports calls, searches and unpriced calls alongside dollars", () => {
    aiCost.record(aiCost.priceCall({ model: "claude-sonnet-5", usage: { input_tokens: 10_000, server_tool_use: { web_search_requests: 2 } } }));
    aiCost.record(aiCost.priceCall({ model: "openai:gpt-4o" }));
    const d = budget.getStatus().daily;
    expect(d.calls).toBe(2);
    expect(d.webSearches).toBe(2);
    expect(d.unpricedCalls).toBe(1);
    expect(d.used).toBeCloseTo(0.04, 2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe("claudeTransport — receipts and batch mode", () => {
  const BODY = { model: "claude-sonnet-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }] };

  test("a synchronous call is priced onto the open receipt under its role", async () => {
    mockFetch.mockResolvedValueOnce(jsonRes(message({ input_tokens: 100_000, output_tokens: 10_000, server_tool_use: { web_search_requests: 1 } })));
    const receipt = aiCost.newReceipt();
    await transport.runWithContext({ receipt }, () => transport.send(BODY, { role: "redteam" }));

    expect(receipt.calls).toBe(1);
    expect(receipt.byRole.redteam.webSearches).toBe(1);
    expect(receipt.totalUSD).toBeCloseTo(0.2 + 0.1 + 0.01, 6);
    expect(aiCost.spendSummary().today.calls).toBe(1);
  });

  test("nested context inherits the receipt and sets the role", async () => {
    mockFetch.mockResolvedValueOnce(jsonRes(message({ input_tokens: 1000 })));
    const receipt = aiCost.newReceipt();
    await transport.runWithContext({ receipt }, () =>
      transport.runWithContext({ role: "draft" }, () => transport.send(BODY)));
    expect(Object.keys(receipt.byRole)).toEqual(["draft"]);
  });

  test("batch mode submits a one-request batch and prices it at 50%", async () => {
    const msg = message({ input_tokens: 1_000_000, output_tokens: 0 });
    mockFetch
      .mockResolvedValueOnce(jsonRes({ id: "batch_1" }))                                       // submit
      .mockResolvedValueOnce(jsonRes({ processing_status: "ended", results_url: "https://r" })) // poll
      .mockResolvedValueOnce(textRes(JSON.stringify({ custom_id: "x", result: { type: "succeeded", message: msg } })));

    const receipt = aiCost.newReceipt();
    const json = await transport.runWithContext({ receipt, batch: true }, () => transport.send(BODY, { role: "auditor" }));

    expect(json.content[0].text).toBe("{}");
    expect(mockFetch.mock.calls[0][0]).toMatch(/\/v1\/messages\/batches$/);
    const submitted = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(submitted.requests[0].params).toEqual(BODY);          // full request passed through
    expect(receipt.byRole.auditor.batched).toBe(1);
    expect(receipt.totalUSD).toBeCloseTo(1, 6);                  // $2 × 50%
    expect(receipt.batchSavingsUSD).toBeCloseTo(1, 6);
  });

  test("a batch that fails falls back to a synchronous call at full rate", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonRes({ error: { message: "bad" } }, 400))                       // submit fails (not retried)
      .mockResolvedValueOnce(jsonRes(message({ input_tokens: 1_000_000 })));                    // sync
    const receipt = aiCost.newReceipt();
    await transport.runWithContext({ receipt, batch: true }, () => transport.send(BODY, { role: "chair" }));
    expect(mockFetch.mock.calls[1][0]).toMatch(/\/v1\/messages$/);
    expect(receipt.byRole.chair.batched).toBe(0);
    expect(receipt.totalUSD).toBeCloseTo(2, 6);
  });

  test("finalizeReceipt rounds for display", () => {
    const r = aiCost.newReceipt();
    aiCost.addToReceipt(r, "x", "claude-sonnet-5", aiCost.priceCall({ model: "claude-sonnet-5", usage: { input_tokens: 12_345 } }));
    expect(aiCost.finalizeReceipt(r).totalUSD).toBe(0.0247);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe("estimateReport — measured when possible, labelled when assumed", () => {
  test("no history → the stated default, labelled an assumption", () => {
    const e = aiCost.estimateReport("macro", []);
    expect(e.basis).toBe("assumption");
    expect(e.estimateUSD).toBe(aiCost.DEFAULT_ESTIMATE_USD);
  });

  test("history → average of real synchronous receipts; batched runs excluded", () => {
    const rec = (usd, batched = 0) => ({ meta: { cost: { totalUSD: usd, unpricedCalls: 0, byRole: { draft: { batched } } } } });
    const e = aiCost.estimateReport("macro", [rec(0.5), rec(0.7), rec(0.2, 1)]);
    expect(e.basis).toBe("measured");
    expect(e.estimateUSD).toBe(0.6);
    expect(e.lowUSD).toBe(0.5);
    expect(e.highUSD).toBe(0.7);
  });

  test("confirm threshold defaults to 0 (always ask) and is configurable", () => {
    expect(aiCost.confirmThresholdUSD()).toBe(0);
    process.env.RESEARCH_CONFIRM_ABOVE_USD = "1.5";
    expect(aiCost.confirmThresholdUSD()).toBe(1.5);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe("factCheck — settles claims about verified FRED series in code", () => {
  const fact = (key, id, value, formatted) => ({ key, label: key, value, formatted, seriesId: id, asOf: "2026-09-25" });
  const ctx = { facts: {
    dgs10: fact("dgs10", "DGS10", 4.12, "4.12%"),
    dfii10: fact("dfii10", "DFII10", 1.9, "1.90%"),
    brent: fact("brent", "DCOILBRENTEU", 84.3, "$84.30/bbl"),
  } };
  const claim = (statement, classification = "FACT") => ({
    claimId: `C-${statement.length}-${classification}`, statement, classification,
    agentsAgreeing: [], agentsDisagreeing: [], notes: "", confidence: 0.6, verificationStatus: "NOT_CHECKED",
  });

  test("a matching level is VERIFIED with a real FRED source link", () => {
    const c = claim("The 10-year Treasury yield stands at 4.12%");
    const r = factCheck.checkClaims([c], ctx);
    expect(c.verificationStatus).toBe("VERIFIED");
    expect(c.asOf).toBe("2026-09-25");
    expect(r.sources[0].url).toBe("https://fred.stlouisfed.org/series/DGS10");
    expect(r.sources[0].supportsClaims).toEqual([c.claimId]);
  });

  test("a wrong level is CONFLICTING_DATA with both figures in the notes", () => {
    const c = claim("The US 10Y yield is 4.6%");
    factCheck.checkClaims([c], ctx);
    expect(c.verificationStatus).toBe("CONFLICTING_DATA");
    expect(c.notes).toMatch(/states 4\.6.*4\.12%/);
  });

  test("real yield is not mistaken for the nominal yield", () => {
    const c = claim("The 10-year real yield (TIPS) is 1.9%");
    factCheck.checkClaims([c], ctx);
    expect(c.verificationStatus).toBe("VERIFIED");
    expect(c.notes).toMatch(/DFII10/);
  });

  test.each([
    ["changes", "The 10-year yield rose 15bp to 4.12%"],
    ["forecasts by wording", "Brent will reach $95"],
    ["two series in one claim", "Brent and WTI are $84 and $80"],
    ["past dates", "The 10-year yield was 4.8% in March"],
  ])("leaves %s to the auditor", (_label, statement) => {
    const c = claim(statement);
    const r = factCheck.checkClaims([c], ctx);
    expect(r.settledIds).toEqual([]);
    expect(c.verificationStatus).toBe("NOT_CHECKED");
  });

  test("never touches a claim classified as a forecast", () => {
    const c = claim("10Y yield 4.12%", "FORECAST");
    expect(factCheck.checkClaims([c], ctx).settledIds).toEqual([]);
  });

  test("no macro context → nothing settled", () => {
    expect(factCheck.checkClaims([claim("The 10-year Treasury yield stands at 4.12%")], null).settledIds).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe("redTeamLog — warnings kept for later scoring", () => {
  const report = {
    reportId: "RPT-macro-x-v1", reportType: "macro", thesisFrame: { timeHorizon: "3m" },
    institutionalQA: { agentVerdicts: { redTeam: {
      verdict: "SURVIVES_WITH_DAMAGE", counterThesis: "growth holds",
      challenges: [{ challenge: "curve already priced", severity: "HIGH", evidenceBased: true }],
      losesMoney: "carry bleed",
    } } },
  };

  test("records each warning with an empty outcome", () => {
    const entry = redTeamLog.recordFromReport(report);
    expect(entry.warnings).toHaveLength(2);
    expect(entry.warnings[0]).toMatchObject({ severity: "HIGH", evidenceBased: true, outcome: null });
    expect(redTeamLog.list()[0].reportId).toBe("RPT-macro-x-v1");
  });

  test("outcomes are appended, never edited in, and merged on read", () => {
    redTeamLog.recordFromReport(report);
    redTeamLog.append({ type: "outcome", warningId: "RPT-macro-x-v1-W1", happened: true, scoredAt: "2026-12-28" });
    expect(redTeamLog.list()[0].warnings[0].outcome.happened).toBe(true);
  });

  test("a red team that did not run logs nothing", () => {
    expect(redTeamLog.recordFromReport({ institutionalQA: { agentVerdicts: { redTeam: { verdict: "NOT_RUN" } } } })).toBeNull();
  });
});

describe("factCheck — dates", () => {
  const ctx = { facts: { dgs10: { key: "dgs10", label: "10Y", value: 4.62, formatted: "4.62%", seriesId: "DGS10", asOf: "2026-08-24" } } };
  const claim = (statement, asOf = null) => ({ claimId: "C1", statement, classification: "FACT", asOf,
    agentsAgreeing: [], agentsDisagreeing: [], notes: "", confidence: 0.6, verificationStatus: "NOT_CHECKED" });

  test("an 'as of' date near the observation is fine — the date is not read as a level", () => {
    const c = claim("US 10Y yield was 4.62% as of 2026-08-22", "2026-08-22");
    expect(factCheck.checkClaims([c], ctx).settledIds).toEqual(["C1"]);
    expect(c.verificationStatus).toBe("VERIFIED");
  });

  test("a claim dated weeks away is left to the auditor", () => {
    const c = claim("US 10Y yield was 4.10% as of 2026-06-30", "2026-06-30");
    expect(factCheck.checkClaims([c], ctx).settledIds).toEqual([]);
  });

  test("an earlier year is left to the auditor", () => {
    expect(factCheck.checkClaims([claim("The 10-year Treasury yield hit 5% in 2023")], ctx).settledIds).toEqual([]);
  });
});
