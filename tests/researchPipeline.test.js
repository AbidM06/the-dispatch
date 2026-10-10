/**
 * tests/researchPipeline.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Five-agent research pipeline + interrogation tests.
 *
 * Layers covered:
 *   - claimLedger: normalization, audit merge, hard-fail detection, dedup
 *   - sourceRegistry: URL validation, dedup, tier inference, staleness
 *   - qualityGate: composite score, hard fails, probability sums, adjudication
 *   - orchestrator: agent sequence, parallel reviewers, reviewer failure,
 *     revision loop, max-round + call-cap enforcement, budget degradation
 *   - reportStore: versioning, corrections audit trail
 *   - interrogator: conversation pinning, corrections persistence,
 *     non-sycophancy prompt directives
 *   - API: envelope compat, sector type, LOW_COST_MODE, interrogate
 *     validation/auth, missing report, versioned conversations
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const request = require("supertest");

// ── Mock all external providers (never hit real APIs) ─────────────────────────
jest.mock("../server/providers/fred", () => ({
  getAllRates:      jest.fn().mockResolvedValue({}),
  getRecentHistory: jest.fn().mockResolvedValue({ observations: [] }),
}));
jest.mock("../server/providers/eia", () => ({
  getPriceHistory: jest.fn().mockResolvedValue([]),
  getLatestPrices: jest.fn().mockResolvedValue(null),
}));
jest.mock("../server/providers/anthropic", () => {
  const actual = jest.requireActual("../server/providers/anthropic");
  return {
    ...actual,
    fetchResearchReport: jest.fn(),
    fetchAllAnalysis:    jest.fn(),
    fetchTickerExplain:  jest.fn(),
    generatePitch:       jest.fn(),
    callClaude:          jest.fn(),
  };
});
jest.mock("../server/research/llm", () => {
  const actual = jest.requireActual("../server/research/llm");
  return { ...actual, callAgent: jest.fn() };
});
// Providers used by unrelated routes loaded via server/index.js
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
  TTL_NEWS_MS: 1800000, TTL_CALENDAR_MS: 3600000,
}));

const anthropicMock = require("../server/providers/anthropic");
const llmMock       = require("../server/research/llm");
const cache         = require("../server/cache");
const budget        = require("../server/providers/budget");

const ledger    = require("../server/research/claimLedger");
const registry  = require("../server/research/sourceRegistry");
const gate      = require("../server/research/qualityGate");
const store     = require("../server/research/reportStore");
const orch      = require("../server/research/orchestrator");
const interro   = require("../server/research/interrogator");

let app;
beforeAll(() => { app = require("../server/index"); });

// ── Fixtures ──────────────────────────────────────────────────────────────────
const DRAFT = {
  reportType: "macro",
  title: "Test Macro Report", subtitle: "sub", date: "2026-08-25",
  abstract: ["a", "b", "c", "d"],
  scenarios: {
    baseline: { label: "Baseline", probability: "60%", narrative: "n" },
    stress:   { label: "Stress",   probability: "40%", narrative: "n" },
  },
  generatedAt: "2026-08-25T10:00:00.000Z",
};

const EXTRACTION = {
  centralQuestion: "Q", thesis: "T", consensusView: "C", variantPerception: "V",
  transmissionMechanism: "M", whatIsPriced: "P", timeHorizon: "3m",
  claims: [
    { statement: "US 10Y yield was 4.62% as of 2026-08-22", classification: "FACT", materiality: "HIGH", confidence: 0.9, asOf: "2026-08-22" },
    { statement: "We expect the Fed to cut 50bp over 12 months", classification: "FORECAST", materiality: "HIGH", confidence: 0.6 },
    { statement: "HY OAS at 2.84% is tight vs history", classification: "FACT", materiality: "MEDIUM", confidence: 0.8 },
  ],
  sources: [
    { title: "H.15 Selected Interest Rates", publisher: "Federal Reserve", url: "https://www.federalreserve.gov/releases/h15/", sourceType: "PRIMARY" },
  ],
  assumptions: ["assumption-1"], uncertainties: ["uncertainty-1"],
  invalidationConditions: ["10Y above 5.25% for a month"],
};

const AUDIT_OK = {
  verdicts: [
    { claimId: "CLM-001", verificationStatus: "VERIFIED", confidence: 0.95, notes: "matches FRED",
      sources: [{ title: "DGS10 series", publisher: "FRED", url: "https://fred.stlouisfed.org/series/DGS10", dataAsOf: "2026-08-22" }] },
    { claimId: "CLM-002", verificationStatus: "FORECAST", confidence: 0.6, notes: "basis disclosed" },
    { claimId: "CLM-003", verificationStatus: "VERIFIED", confidence: 0.9, notes: "" },
  ],
  dataQualityFlags: [], overallAssessment: "sound", verdict: "SOUND", confidence: "HIGH",
};

const RED_OK = {
  counterThesis: "Growth reaccelerates", contradictoryEvidence: [],
  hiddenAssumptions: [], omittedVariables: [],
  consensusChallenge: "", pricingChallenge: "", catalystChallenge: "", baseRateChallenge: "",
  losesMoney: "carry bleed", challenges: [{ challenge: "x", severity: "LOW", evidenceBased: false }],
  verdict: "SURVIVES_SCRUTINY", verdictRationale: "solid", confidence: "MEDIUM",
};

const PM_OK = {
  marketPricing: { whatIsPriced: "some", whatIsNotPriced: "some", alphaCondition: "x", isDifferentiated: true, evidence: "OIS" },
  transmissionMechanism: { chain: ["a", "b"], strongLinks: ["a"], weakLinks: ["b"] },
  tradeExpression: { cleanest: "long duration", alternative: "", hedge: "", horizon: "3m", keyRisks: [], unattractiveIf: "" },
  portfolioConsiderations: {}, thesisVsTrade: "GOOD_THESIS_GOOD_TRADE",
  crossAssetImplications: [], verdict: "INVESTABLE", verdictRationale: "clean", confidence: "HIGH",
};

function chairOutput(overrides = {}) {
  const dims = {};
  for (const d of gate.SCORE_DIMENSIONS) dims[d] = 90;
  return {
    status: "APPROVED", statusRationale: "good",
    dimensionScores: dims, adjudications: [], materialDisagreements: [],
    unresolvedQuestions: [], strongestCounterargument: "counter", keyCaveat: "caveat",
    checklistGaps: [], revisionInstructions: "",
    agentVerdictSummary: { dataAuditor: "ok", redTeam: "ok", crossAssetPM: "ok" },
    ...overrides,
  };
}

/** Wire llm.callAgent to route responses by role. */
function mockAgents({ extraction = EXTRACTION, audit = AUDIT_OK, red = RED_OK, pm = PM_OK, chair = chairOutput(), revised = null } = {}) {
  llmMock.callAgent.mockImplementation(async (role, _sys, _user) => {
    if (role === "extract")   return JSON.stringify(extraction);
    if (role === "auditor")   { if (audit instanceof Error) throw audit; return JSON.stringify(audit); }
    if (role === "redteam")   { if (red   instanceof Error) throw red;   return JSON.stringify(red); }
    if (role === "portfolio") { if (pm    instanceof Error) throw pm;    return JSON.stringify(pm); }
    if (role === "chair")     { if (chair instanceof Error) throw chair; return JSON.stringify(typeof chair === "function" ? chair() : chair); }
    if (role === "lead")      return JSON.stringify(revised || { ...DRAFT, title: "Revised Report" });
    if (role === "chat")      return JSON.stringify({ answer: "test answer", stance: "SUPPORTED", confidence: "HIGH", evidenceUsed: [], usedWebSearch: false, newEvidence: [], corrections: [], keyTakeaway: "tk" });
    throw new Error("unexpected role " + role);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  cache.clear();
  budget._reset();
  store._reset();
  interro._reset();
  delete process.env.LOW_COST_MODE;
  delete process.env.DISABLE_AI;
  delete process.env.RESEARCH_MULTI_AGENT;
  delete process.env.RESEARCH_MAX_VALIDATION_ROUNDS;
  delete process.env.RESEARCH_MAX_AGENT_CALLS;
  delete process.env.RESEARCH_MIN_QA_SCORE;
  delete process.env.DISPATCH_ADMIN_KEY;
  anthropicMock.fetchResearchReport.mockResolvedValue({ ...DRAFT });
});

// ══════════════════════════════════════════════════════════════════════════════
describe("claimLedger", () => {
  test("normalizes, ids, clamps confidence, dedupes", () => {
    const claims = ledger.normalizeClaims([
      { statement: "A", classification: "FACT", materiality: "HIGH", confidence: 95 },
      { statement: "A", classification: "FACT", materiality: "HIGH" },           // dup
      { statement: "B", classification: "WRONG", materiality: "NOPE" },          // repaired
      { statement: "" },                                                          // dropped
      null,
    ]);
    expect(claims).toHaveLength(2);
    expect(claims[0].claimId).toBe("CLM-001");
    expect(claims[0].confidence).toBe(0.95);
    expect(claims[1].classification).toBe("INFERENCE");
    expect(claims[1].materiality).toBe("MEDIUM");
    expect(claims[1].verificationStatus).toBe("NOT_CHECKED");
  });

  test("applyAuditVerdicts merges statuses and dissent tracking", () => {
    const claims = ledger.normalizeClaims(EXTRACTION.claims);
    ledger.applyAuditVerdicts(claims, [
      { claimId: "CLM-001", verificationStatus: "VERIFIED", confidence: 0.99 },
      { claimId: "CLM-003", verificationStatus: "UNSUPPORTED", notes: "no source found" },
      { claimId: "CLM-999", verificationStatus: "VERIFIED" }, // unknown id ignored
    ]);
    expect(claims[0].verificationStatus).toBe("VERIFIED");
    expect(claims[0].agentsAgreeing).toContain("data_auditor");
    expect(claims[2].verificationStatus).toBe("UNSUPPORTED");
    expect(claims[2].agentsDisagreeing).toContain("data_auditor");
    expect(claims[2].notes).toMatch(/no source found/);
  });

  test("unsupportedMaterialClaims flags only HIGH-materiality FACTs", () => {
    const claims = ledger.normalizeClaims([
      { statement: "A", classification: "FACT", materiality: "HIGH", verificationStatus: "UNSUPPORTED" },
      { statement: "B", classification: "FORECAST", materiality: "HIGH", verificationStatus: "UNSUPPORTED" },
      { statement: "C", classification: "FACT", materiality: "LOW", verificationStatus: "UNSUPPORTED" },
    ]);
    const bad = ledger.unsupportedMaterialClaims(claims);
    expect(bad).toHaveLength(1);
    expect(bad[0].statement).toBe("A");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe("sourceRegistry", () => {
  test("validates URLs, infers tiers, dedupes", () => {
    const sources = registry.registerSources([
      { title: "H.15", publisher: "Federal Reserve", url: "https://www.federalreserve.gov/releases/h15/" },
      { title: "H.15", publisher: "Federal Reserve", url: "https://www.federalreserve.gov/releases/h15/" }, // dup
      { title: "Story", publisher: "Reuters", url: "not-a-url" },
      { title: "Fake", publisher: "X", url: "https://example.com/foo" }, // placeholder domain rejected
    ], "lead");
    expect(sources).toHaveLength(3);
    expect(sources[0].sourceTier).toBe(1);
    expect(sources[1].sourceTier).toBe(2);
    expect(sources[1].url).toBeNull();
    expect(sources[2].url).toBeNull(); // example.com rejected as placeholder
  });

  test("marks stale sources by dataAsOf age", () => {
    const old = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const s = registry.registerSources([{ title: "Old", publisher: "FRED", dataAsOf: old }], "lead");
    expect(s[0].stale).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe("qualityGate", () => {
  const goodClaims = () => ledger.normalizeClaims(EXTRACTION.claims).map(c => ({ ...c, verificationStatus: "VERIFIED" }));

  test("APPROVED report with high scores passes", () => {
    const v = gate.adjudicate({ research: DRAFT, claims: goodClaims(), sources: [], chairOutput: chairOutput() });
    expect(v.status).toBe("APPROVED");
    expect(v.score).toBe(90);
    expect(v.hardFailures).toHaveLength(0);
  });

  test("score below threshold forces REVISION_REQUIRED", () => {
    const dims = {};
    for (const d of gate.SCORE_DIMENSIONS) dims[d] = 70;
    const v = gate.adjudicate({ research: DRAFT, claims: goodClaims(), sources: [], chairOutput: chairOutput({ dimensionScores: dims }) });
    expect(v.score).toBe(70);
    expect(v.status).toBe("REVISION_REQUIRED");
  });

  test("unsupported material claim hard-fails regardless of score", () => {
    const claims = goodClaims();
    claims[0].verificationStatus = "UNSUPPORTED";
    const v = gate.adjudicate({ research: DRAFT, claims, sources: [], chairOutput: chairOutput() });
    expect(v.status).toBe("REVISION_REQUIRED");
    expect(v.hardFailures.map(f => f.rule)).toContain("UNSUPPORTED_MATERIAL_CLAIM");
  });

  test("scenario probabilities far from 100% hard-fail", () => {
    const research = { ...DRAFT, scenarios: {
      bear: { probability: "30%" }, base: { probability: "60%" }, bull: { probability: "40%" },
    }};
    const v = gate.adjudicate({ research, claims: goodClaims(), sources: [], chairOutput: chairOutput() });
    expect(v.hardFailures.map(f => f.rule)).toContain("SCENARIO_PROBABILITY_SUM");
  });

  test("dangling source reference hard-fails (fabrication guard)", () => {
    const claims = goodClaims();
    claims[0].sourceIds = ["SRC-404"];
    const v = gate.adjudicate({ research: DRAFT, claims, sources: [], chairOutput: chairOutput() });
    expect(v.hardFailures.map(f => f.rule)).toContain("DANGLING_SOURCE_REFERENCE");
  });

  test("chair REJECTED is terminal", () => {
    const v = gate.adjudicate({ research: DRAFT, claims: goodClaims(), sources: [], chairOutput: chairOutput({ status: "REJECTED" }) });
    expect(v.status).toBe("REJECTED");
  });

  test("RESEARCH_MIN_QA_SCORE is configurable", () => {
    process.env.RESEARCH_MIN_QA_SCORE = "95";
    const v = gate.adjudicate({ research: DRAFT, claims: goodClaims(), sources: [], chairOutput: chairOutput() });
    expect(v.status).toBe("REVISION_REQUIRED"); // 90 < 95
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe("orchestrator", () => {
  test("runs full five-agent sequence and publishes APPROVED report", async () => {
    mockAgents();
    const report = await orch.runPipeline({ type: "macro", topic: "", ratesContext: "ctx" });

    expect(anthropicMock.fetchResearchReport).toHaveBeenCalledTimes(1);
    const roles = llmMock.callAgent.mock.calls.map(c => c[0]);
    expect(roles).toEqual(expect.arrayContaining(["extract", "auditor", "redteam", "portfolio", "chair"]));
    expect(roles.filter(r => r === "lead")).toHaveLength(0); // no revision needed

    expect(report.reportId).toMatch(/^RPT-macro-/);
    expect(report.version).toBe(1);
    expect(report.institutionalQA.status).toBe("APPROVED");
    expect(report.institutionalQA.score).toBe(90);
    expect(report.claims.length).toBe(3);
    expect(report.claims[0].verificationStatus).toBe("VERIFIED");
    // Auditor's FRED source registered and linked
    expect(report.sources.some(s => s.contributedBy === "data_auditor")).toBe(true);
    expect(report.institutionalQA.agentVerdicts.redTeam.verdict).toBe("SURVIVES_SCRUTINY");
  });

  test("extraction failure still runs red team + PM; auditor honestly NOT_RUN", async () => {
    llmMock.callAgent.mockImplementation(async (role) => {
      if (role === "extract")   return "{{{ truncated garbage";
      if (role === "auditor")   throw new Error("should not be called without a ledger");
      if (role === "redteam")   return JSON.stringify(RED_OK);
      if (role === "portfolio") return JSON.stringify(PM_OK);
      if (role === "chair")     return JSON.stringify(chairOutput());
      throw new Error("unexpected role " + role);
    });
    const report = await orch.runPipeline({ type: "macro" });
    const roles = llmMock.callAgent.mock.calls.map(c => c[0]);
    expect(roles).not.toContain("auditor");
    expect(roles).toEqual(expect.arrayContaining(["redteam", "portfolio", "chair"]));
    expect(report.institutionalQA.status).toBe("APPROVED_WITH_CAVEATS"); // QA still ran, but claims went unaudited
    expect(report.institutionalQA.unreviewed).toEqual([expect.stringMatching(/^Data auditor: claim extraction unavailable/)]);
    expect(report.institutionalQA.agentVerdicts.dataAuditor.verdict).toBe("NOT_RUN");
    expect(report.institutionalQA.agentVerdicts.dataAuditor.reason).toMatch(/extraction unavailable/i);
    expect(report.claims).toHaveLength(0);
  });

  test("reviewer failure is disclosed as NOT_RUN, not fatal", async () => {
    mockAgents({ red: new Error("redteam exploded") });
    const report = await orch.runPipeline({ type: "macro" });
    expect(report.institutionalQA.agentVerdicts.redTeam.verdict).toBe("NOT_RUN");
    expect(report.institutionalQA.agentVerdicts.dataAuditor.verdict).toBe("SOUND");
    // QA still ran (chair + other reviewers ok), but a partly unreviewed report
    // never reads as a clean APPROVED — it names who did not run and why.
    expect(report.institutionalQA.status).toBe("APPROVED_WITH_CAVEATS");
    expect(report.institutionalQA.unreviewed).toEqual([expect.stringMatching(/^Red team: .*redteam exploded/)]);
  });

  test("all reviewers ran → clean APPROVED, nothing listed as unreviewed", async () => {
    mockAgents();
    const report = await orch.runPipeline({ type: "macro" });
    expect(report.institutionalQA.status).toBe("APPROVED");
    expect(report.institutionalQA.unreviewed).toEqual([]);
    expect(report.meta.models.lead).toMatch(/^claude-sonnet/);
  });

  test("a draft from the OpenAI tier (grounded: false) is attributed to OpenAI, not Sonnet", async () => {
    anthropicMock.fetchResearchReport.mockResolvedValue({ ...DRAFT, grounded: false });
    mockAgents();
    const report = await orch.runPipeline({ type: "macro" });
    expect(report.meta.models.lead).toMatch(/^openai:/);
  });

  test("an OpenAI draft stays ungrounded and attributed to OpenAI after a Sonnet revision", async () => {
    anthropicMock.fetchResearchReport.mockResolvedValue({ ...DRAFT, grounded: false });
    mockAgents({ audit: { ...AUDIT_OK, verdicts: [{ claimId: "CLM-001", verificationStatus: "UNSUPPORTED", notes: "cannot verify" }] } });
    const report = await orch.runPipeline({ type: "macro" });
    expect(report.institutionalQA.revisionRounds).toBe(1);
    expect(report.research.title).toBe("Revised Report");
    expect(report.research.grounded).toBe(false);
    expect(report.meta.models.lead).toMatch(/^openai:/);
  });

  test("a failed re-score after a revision marks the revised report NOT_RUN, never the old verdict", async () => {
    let chairCalls = 0;
    mockAgents({
      audit: { ...AUDIT_OK, verdicts: [{ claimId: "CLM-001", verificationStatus: "UNSUPPORTED", notes: "cannot verify" }] },
      chair: () => { if (++chairCalls > 1) throw Object.assign(new Error("Claude Sonnet overloaded"), { status: 529 }); return chairOutput(); },
    });
    const report = await orch.runPipeline({ type: "macro" });
    expect(report.research.title).toBe("Revised Report");
    expect(report.institutionalQA.status).toBe("NOT_RUN");
    expect(report.institutionalQA.reason).toMatch(/re-score after revision round 1 failed — .*Claude Sonnet overloaded/);
  });

  test("a failed IC chair's reason is shown in the NOT_RUN reason", async () => {
    mockAgents({ chair: Object.assign(new Error("Claude Sonnet overloaded (Anthropic error 529)"), { status: 529 }) });
    const report = await orch.runPipeline({ type: "macro" });
    expect(report.institutionalQA.status).toBe("NOT_RUN");
    expect(report.institutionalQA.reason).toMatch(/^IC Chair could not run — QA NOT RUN\. failed twice \(retried once\) — Claude Sonnet overloaded/);
  });

  test("revision loop triggers on hard fail then re-scores", async () => {
    // First chair call approves but a material claim is UNSUPPORTED -> hard fail -> revision
    const audit = {
      ...AUDIT_OK,
      verdicts: [{ claimId: "CLM-001", verificationStatus: "UNSUPPORTED", notes: "cannot verify" }],
    };
    mockAgents({ audit });
    const report = await orch.runPipeline({ type: "macro" });

    const roles = llmMock.callAgent.mock.calls.map(c => c[0]);
    expect(roles.filter(r => r === "lead")).toHaveLength(1);   // one revision
    expect(roles.filter(r => r === "chair")).toHaveLength(2);  // score + re-score
    expect(report.institutionalQA.revisionRounds).toBe(1);
    expect(report.research.title).toBe("Revised Report");
    expect(report.institutionalQA.status).toBe("APPROVED");
  });

  test("max validation rounds enforced (no infinite loop)", async () => {
    process.env.RESEARCH_MAX_VALIDATION_ROUNDS = "2";
    process.env.RESEARCH_MAX_AGENT_CALLS = "20";
    // Chair always demands revision
    mockAgents({ chair: () => chairOutput({ status: "REVISION_REQUIRED", revisionInstructions: "fix" }) });
    const report = await orch.runPipeline({ type: "macro" });
    const roles = llmMock.callAgent.mock.calls.map(c => c[0]);
    expect(roles.filter(r => r === "lead")).toHaveLength(2);   // capped at 2 rounds
    expect(report.institutionalQA.status).toBe("REVISION_REQUIRED"); // honest terminal state
  });

  test("call cap prevents reviewers from running and QA discloses it", async () => {
    process.env.RESEARCH_MAX_AGENT_CALLS = "2"; // draft + extract only
    mockAgents();
    const report = await orch.runPipeline({ type: "macro" });
    const roles = llmMock.callAgent.mock.calls.map(c => c[0]);
    expect(roles).toEqual(["extract"]); // no reviewers, no chair (cap hit)
    expect(report.institutionalQA.status).toBe("NOT_RUN");
    expect(report.institutionalQA.reason).toMatch(/unavailable|NOT RUN/i);
  });

  describe("Codex review on #10: retries count against the call cap", () => {
    const overloaded = () => Object.assign(new Error("Claude Sonnet overloaded"), { status: 529 });
    const actualCalls = () => 1 + llmMock.callAgent.mock.calls.length;   // draft + agent calls

    test("a retry is charged to callsUsed", async () => {
      mockAgents({ red: overloaded() });
      const report = await orch.runPipeline({ type: "macro" });
      expect(llmMock.callAgent.mock.calls.filter(c => c[0] === "redteam")).toHaveLength(2);
      expect(report.meta.callsUsed).toBe(actualCalls());
      expect(report.meta.callsUsed).toBeLessThanOrEqual(8);
    });

    test("no retry when it would take the chair's slot; the reason says so", async () => {
      process.env.RESEARCH_MAX_AGENT_CALLS = "6";   // draft, extract, 3 reviewers, chair
      mockAgents({ red: overloaded() });
      const report = await orch.runPipeline({ type: "macro" });
      const roles = llmMock.callAgent.mock.calls.map(c => c[0]);
      expect(roles.filter(r => r === "redteam")).toHaveLength(1);
      expect(roles).toContain("chair");
      expect(report.meta.callsUsed).toBe(6);
      expect(actualCalls()).toBe(6);
      expect(report.institutionalQA.unreviewed).toEqual([expect.stringMatching(/^Red team: .*not retried: the call cap was reached/)]);
    });
  });

  test("budget exhaustion mid-run degrades gracefully", async () => {
    llmMock.callAgent.mockImplementation(async (role) => {
      if (role === "extract") return JSON.stringify(EXTRACTION);
      const err = new Error("daily budget exhausted");
      err.code = "BUDGET_DAILY";
      throw err;
    });
    const report = await orch.runPipeline({ type: "macro" });
    expect(report.institutionalQA.status).toBe("NOT_RUN");
    expect(report.reportId).toBeTruthy(); // report still published + versioned
  });

  test("version increments per type", async () => {
    mockAgents();
    const r1 = await orch.runPipeline({ type: "macro" });
    const r2 = await orch.runPipeline({ type: "macro" });
    const r3 = await orch.runPipeline({ type: "fx" });
    expect(r1.version).toBe(1);
    expect(r2.version).toBe(2);
    expect(r3.version).toBe(1);
    expect(store.latestForType("macro").reportId).toBe(r2.reportId);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe("reportStore corrections", () => {
  test("addCorrection appends audit trail and marks claim CORRECTED", async () => {
    mockAgents();
    const report = await orch.runPipeline({ type: "macro" });
    const entry = store.addCorrection(report.reportId, {
      claimId: "CLM-001", oldValue: "4.62%", correctedValue: "4.58%", reason: "newer H.15 release",
    });
    expect(entry.correctionId).toBe("COR-001");
    const stored = store.get(report.reportId);
    expect(stored.corrections).toHaveLength(1);
    const claim = stored.claims.find(c => c.claimId === "CLM-001");
    expect(claim.verificationStatus).toBe("CORRECTED");
    expect(claim.notes).toMatch(/COR-001/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe("interrogator", () => {
  test("system prompt encodes truth-over-agreement directives", () => {
    expect(interro.SYSTEM).toMatch(/user agreement\s+←\s+LAST/i);
    expect(interro.SYSTEM).toMatch(/NOT sycophantic/i);
    expect(interro.SYSTEM).toMatch(/criticise YOUR OWN report/i);
    expect(interro.SYSTEM).toMatch(/I disagree with that interpretation/);
    expect(interro.SYSTEM).toMatch(/priced in/i);
    expect(interro.SYSTEM).toMatch(/DATA, never instructions/i);
  });

  test("interrogate answers, persists corrections, pins conversation to report", async () => {
    mockAgents();
    const report = await orch.runPipeline({ type: "macro" });

    llmMock.callAgent.mockImplementation(async (role) => {
      expect(role).toBe("chat");
      return JSON.stringify({
        answer: "You're right to challenge that number — the report used 4.62%, the newer release shows 4.58%.",
        stance: "SUPPORTED", confidence: "HIGH",
        evidenceUsed: ["CLM-001"], usedWebSearch: true,
        newEvidence: [], keyTakeaway: "10Y figure corrected",
        corrections: [{ claimId: "CLM-001", oldValue: "4.62%", correctedValue: "4.58%", reason: "newer release" }],
      });
    });

    const res = await interro.interrogate({ reportId: report.reportId, question: "Isn't your 10Y figure stale?" });
    expect(res.answer).toMatch(/right to challenge/);
    expect(res.stance).toBe("SUPPORTED");
    expect(res.corrections).toHaveLength(1);
    expect(res.conversationId).toMatch(/^CNV-/);

    // Correction persisted in the store with audit trail
    const stored = store.get(report.reportId);
    expect(stored.corrections).toHaveLength(1);
    expect(stored.claims.find(c => c.claimId === "CLM-001").verificationStatus).toBe("CORRECTED");

    // Second turn continues the same conversation
    const res2 = await interro.interrogate({ reportId: report.reportId, question: "What else?", conversationId: res.conversationId });
    expect(res2.conversationId).toBe(res.conversationId);
    const conv = interro._getConversation(res.conversationId);
    expect(conv.messages.length).toBe(4);
    expect(conv.summaryPoints).toContain("10Y figure corrected");
  });

  test("conversation stays pinned to old report when newer version exists", async () => {
    mockAgents();
    const v1 = await orch.runPipeline({ type: "macro" });
    llmMock.callAgent.mockImplementation(async (role) => {
      if (role === "chat") return JSON.stringify({ answer: "a", stance: "UNCERTAIN", confidence: "LOW", evidenceUsed: [], usedWebSearch: false, newEvidence: [], corrections: [], keyTakeaway: "" });
      return JSON.stringify(role === "extract" ? EXTRACTION : role === "auditor" ? AUDIT_OK : role === "redteam" ? RED_OK : role === "portfolio" ? PM_OK : chairOutput());
    });
    const first = await interro.interrogate({ reportId: v1.reportId, question: "q1" });

    mockAgents(); // regen agent wiring for a v2 run
    await orch.runPipeline({ type: "macro" }); // publish v2

    llmMock.callAgent.mockImplementation(async () => JSON.stringify({ answer: "still v1", stance: "UNCERTAIN", confidence: "LOW", evidenceUsed: [], usedWebSearch: false, newEvidence: [], corrections: [], keyTakeaway: "" }));
    const second = await interro.interrogate({ reportId: v1.reportId, question: "q2", conversationId: first.conversationId });
    expect(second.reportId).toBe(v1.reportId);          // not silently swapped
    expect(second.newerReportAvailable).toBe(true);      // but disclosed
  });

  test("missing report → 404-coded error", async () => {
    await expect(interro.interrogate({ reportId: "RPT-none", question: "q" }))
      .rejects.toMatchObject({ status: 404 });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Generation is POST-only (behind the cost confirm); GET never spends.
function generate(type) {
  return request(app).post("/api/research/report/refresh").send({ type, confirm: true });
}

describe("API — /api/research", () => {
  test("GET /report never generates — 404 NOT_GENERATED and no AI call when nothing exists", async () => {
    mockAgents();
    const res = await request(app).get("/api/research/report?type=macro");
    expect(res.status).toBe(404);
    expect(res.body.data).toMatchObject({ available: false, reason: "NOT_GENERATED" });
    expect(anthropicMock.fetchResearchReport).not.toHaveBeenCalled();
    expect(llmMock.callAgent).not.toHaveBeenCalled();
  });

  test("GET /report serves the latest stored report after the cache is gone (e.g. restart)", async () => {
    mockAgents();
    const gen = await generate("macro");
    cache.clear();
    const res = await request(app).get("/api/research/report?type=macro");
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("stored");
    expect(res.body.data.reportId).toBe(gen.body.data.reportId);
    expect(res.body.data.costReceipt).toMatchObject({ currency: "USD" });
  });

  test("POST /report/refresh returns envelope with QA attached (multi-agent)", async () => {
    mockAgents();
    const res = await generate("macro");
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("live");
    expect(res.body.data.title).toBe("Test Macro Report");
    expect(res.body.data.reportId).toMatch(/^RPT-macro-/);
    expect(res.body.data.institutionalQA.status).toBe("APPROVED");
    expect(res.body.data.claimsCount).toBe(3);

    // Second GET served from cache
    const res2 = await request(app).get("/api/research/report?type=macro");
    expect(res2.body.source).toBe("cache");
    expect(res2.body.data.reportId).toBe(res.body.data.reportId);
  });

  test("sector is a valid report type end-to-end", async () => {
    mockAgents();
    anthropicMock.fetchResearchReport.mockResolvedValue({ ...DRAFT, reportType: "sector", sectorName: "Semis", title: "Sector Test" });
    const res = await generate("sector");
    expect(res.status).toBe(200);
    expect(res.body.data.reportType).toBe("sector");
    expect(anthropicMock.fetchResearchReport).toHaveBeenCalledWith(expect.any(String), "", "sector");
  });

  test("LOW_COST_MODE returns an honest 503 — never a fabricated report", async () => {
    process.env.LOW_COST_MODE = "true";
    const res = await generate("macro");
    expect(res.status).toBe(503);
    expect(res.body.source).toBe("unavailable");
    expect(res.body.data.available).toBe(false);
    expect(res.body.data.reason).toBe("LOW_COST_MODE");
  });

  test("RESEARCH_MULTI_AGENT=false uses single call, QA honestly NOT_RUN, still interrogable", async () => {
    process.env.RESEARCH_MULTI_AGENT = "false";
    const res = await generate("macro");
    expect(res.status).toBe(200);
    expect(llmMock.callAgent).not.toHaveBeenCalled();
    expect(res.body.data.reportId).toMatch(/^RPT-macro-/);
    expect(res.body.data.institutionalQA.status).toBe("NOT_RUN");
    expect(res.body.data.institutionalQA.reason).toMatch(/disabled/i);
  });

  test("GET /report/:id/qa and /sources return full detail; 404 for unknown", async () => {
    mockAgents();
    const gen = await generate("macro");
    const id  = gen.body.data.reportId;

    const qa = await request(app).get(`/api/research/report/${id}/qa`);
    expect(qa.status).toBe(200);
    expect(qa.body.claims).toHaveLength(3);
    expect(qa.body.institutionalQA.agentVerdicts.icChair.status).toBe("APPROVED");

    const src = await request(app).get(`/api/research/report/${id}/sources`);
    expect(src.status).toBe(200);
    expect(src.body.sources.length).toBeGreaterThan(0);
    expect(src.body.sources[0].sourceId).toMatch(/^SRC-/);

    const missing = await request(app).get("/api/research/report/RPT-none/qa");
    expect(missing.status).toBe(404);
  });

  test("POST /interrogate validates payload (missing, oversized, malformed)", async () => {
    const bad1 = await request(app).post("/api/research/interrogate").send({});
    expect(bad1.status).toBe(400);

    const bad2 = await request(app).post("/api/research/interrogate")
      .send({ reportId: "RPT-x", question: "x".repeat(2001) });
    expect(bad2.status).toBe(400);

    const bad3 = await request(app).post("/api/research/interrogate")
      .send({ reportId: "RPT-x", question: 42 });
    expect(bad3.status).toBe(400);
  });

  test("POST /interrogate on missing report → 404; LOW_COST_MODE → 503 transparent state", async () => {
    const notFound = await request(app).post("/api/research/interrogate")
      .send({ reportId: "RPT-none", question: "hello" });
    expect(notFound.status).toBe(404);

    process.env.LOW_COST_MODE = "true";
    const unavailable = await request(app).post("/api/research/interrogate")
      .send({ reportId: "RPT-none", question: "hello" });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.aiStatus).toBe("UNAVAILABLE");
  });

  test("POST /interrogate happy path via HTTP", async () => {
    mockAgents();
    const gen = await generate("macro");
    const id  = gen.body.data.reportId;

    llmMock.callAgent.mockImplementation(async () => JSON.stringify({
      answer: "I disagree with that interpretation — the evidence shows X.",
      stance: "CONTRADICTED", confidence: "HIGH",
      evidenceUsed: ["CLM-002"], usedWebSearch: false, newEvidence: [], corrections: [], keyTakeaway: "",
    }));

    const res = await request(app).post("/api/research/interrogate")
      .send({ reportId: id, question: "Yields are definitely going to 6%." });
    expect(res.status).toBe(200);
    expect(res.body.stance).toBe("CONTRADICTED");
    expect(res.body.answer).toMatch(/disagree/);
    expect(res.body.conversationId).toMatch(/^CNV-/);
  });

  test("write-auth guards refresh + interrogate when DISPATCH_ADMIN_KEY set", async () => {
    process.env.DISPATCH_ADMIN_KEY = "sekrit";
    const r1 = await request(app).post("/api/research/report/refresh").send({ type: "macro" });
    expect(r1.status).toBe(401);
    const r2 = await request(app).post("/api/research/interrogate").send({ reportId: "x", question: "q" });
    expect(r2.status).toBe(401);

    mockAgents();
    const ok = await request(app).post("/api/research/report/refresh")
      .set("x-dispatch-key", "sekrit").send({ type: "macro", confirm: true });
    expect(ok.status).toBe(200);
  });

  test("GET /report/progress returns stage labels during/after a run", async () => {
    mockAgents();
    await generate("macro");
    const res = await request(app).get("/api/research/report/progress?type=macro");
    expect(res.status).toBe(200);
    expect(res.body.progress.stage).toBe("done");
    expect(res.body.progress.label).toBe("Complete");
  });

  test("GET /report/versions reflects the latest published version", async () => {
    mockAgents();
    await generate("macro");
    const res = await request(app).get("/api/research/report/versions?type=macro");
    expect(res.status).toBe(200);
    expect(res.body.latest.version).toBe(1);
    expect(res.body.latest.qaStatus).toBe("APPROVED");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Cross-asset facts in the pipeline, cost receipts, confirm-before-refresh,
// red-team log, batch job.
// ══════════════════════════════════════════════════════════════════════════════
describe("orchestrator — verified facts, fact check, receipt", () => {
  const redTeamLog = require("../server/research/redTeamLog");
  const MACRO = {
    facts: { dgs10: { key: "dgs10", label: "10Y UST Nominal", group: "rates", value: 4.62, unit: "%", formatted: "4.62%", source: "FRED", seriesId: "DGS10", asOf: "2026-08-24" } },
    policyPath: null, missing: [], fetchedAt: "2026-08-25T06:00:00Z",
  };
  beforeEach(() => redTeamLog._reset());

  test("claims about FRED series are settled in code; the auditor only sees the rest", async () => {
    mockAgents();
    const report = await orch.runPipeline({ type: "macro", macroCtx: MACRO });

    const clm1 = report.claims.find(c => c.claimId === "CLM-001");
    expect(clm1.agentsAgreeing).toContain("fact_check");
    expect(report.meta.factCheck).toEqual([expect.objectContaining({ claimId: "CLM-001", seriesId: "DGS10", matches: true })]);
    expect(report.sources.some(s => s.url === "https://fred.stlouisfed.org/series/DGS10" && s.supportsClaims.includes("CLM-001"))).toBe(true);

    const auditCall = llmMock.callAgent.mock.calls.find(c => c[0] === "auditor");
    // (the auditor's JSON template itself mentions "CLM-001", so match on wording)
    expect(auditCall[2]).not.toMatch(/US 10Y yield was 4\.62%/);
    expect(auditCall[2]).toMatch(/We expect the Fed to cut 50bp/);
    expect(auditCall[2]).toMatch(/VERIFIED MARKET DATA/);
  });

  test("every reviewer receives the verified data block", async () => {
    mockAgents();
    await orch.runPipeline({ type: "macro", macroCtx: MACRO });
    for (const role of ["redteam", "portfolio", "chair"]) {
      const call = llmMock.callAgent.mock.calls.find(c => c[0] === role);
      expect(call[2]).toMatch(/10Y UST Nominal: 4\.62%/);
    }
  });

  test("the published report carries a cost receipt and logs the red team's warnings", async () => {
    mockAgents();
    const report = await orch.runPipeline({ type: "macro", macroCtx: MACRO });
    expect(report.meta.cost).toMatchObject({ currency: "USD", totalUSD: expect.any(Number) });
    expect(redTeamLog.list()[0].reportId).toBe(report.reportId);
  });
});

describe("API — cost estimate and confirm-before-refresh", () => {
  test("GET /report/estimate states its basis and today's spend", async () => {
    const res = await request(app).get("/api/research/report/estimate?type=fx");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: "fx", basis: "assumption", estimateUSD: expect.any(Number) });
    expect(res.body.spend.currency).toBe("USD");
  });

  test("POST /report/refresh without confirm returns 409 with the estimate and spends nothing", async () => {
    mockAgents();
    const res = await request(app).post("/api/research/report/refresh").send({ type: "macro" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("confirmation_required");
    expect(res.body.estimateUSD).toBeGreaterThan(0);
    expect(anthropicMock.fetchResearchReport).not.toHaveBeenCalled();
  });

  test("an estimate under RESEARCH_CONFIRM_ABOVE_USD runs without confirm", async () => {
    process.env.RESEARCH_CONFIRM_ABOVE_USD = "5";
    mockAgents();
    const res = await request(app).post("/api/research/report/refresh").send({ type: "macro" });
    delete process.env.RESEARCH_CONFIRM_ABOVE_USD;
    expect(res.status).toBe(200);
    expect(res.body.data.costReceipt).toMatchObject({ currency: "USD" });
  });

  test("GET /spend reports the USD ledger and caps", async () => {
    const res = await request(app).get("/api/research/spend");
    expect(res.status).toBe(200);
    expect(res.body.budget.daily).toHaveProperty("cap");
  });
});

describe("researchBatchJob — full pipeline in batch mode", () => {
  test("generates each scheduled type through generateReport with batch: true", async () => {
    const research = require("../server/routes/research");
    const job = require("../server/jobs/researchBatchJob");
    process.env.RESEARCH_BATCH_TYPES = "macro,fx,bogus";
    const spy = jest.spyOn(research, "generateReport").mockResolvedValue({
      ok: true, report: { title: "t" }, record: { meta: { cost: { totalUSD: 0.3 } } },
    });
    const status = await job.runBatchRefresh({ force: true });
    delete process.env.RESEARCH_BATCH_TYPES;

    expect(spy.mock.calls.map(c => [c[0], c[2]])).toEqual([["macro", { batch: true }], ["fx", { batch: true }]]);
    expect(status.generated).toEqual(["macro", "fx"]);
    expect(status.costUSD).toBe(0.6);
    expect(cache.get("research:report:fx")).toEqual({ title: "t" });
    spy.mockRestore();
  });
});
