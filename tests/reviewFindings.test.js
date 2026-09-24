/**
 * tests/reviewFindings.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Regression tests for the findings raised in the external multi-perspective
 * review (docs/review-pack). Test names carry the reviewer's own finding and
 * ledger IDs so a future reader can trace a test back to the claim it settles.
 *
 * Each of these reproduces a defect that shipped. They are written to fail if
 * the defect returns, not merely to exercise the happy path.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const fs   = require("fs");
const path = require("path");

const SERVER = path.join(__dirname, "..", "server");
const read = (rel) => fs.readFileSync(path.join(SERVER, rel), "utf8");

// ─────────────────────────────────────────────────────────────────────────────
describe("F01 — untrusted notification text must never reach a shell", () => {
  const src = read("routes/bulletin.js");

  test("does not build a shell command string from headline text", () => {
    // The original used exec() with a single-quoted osascript string and
    // replaced `"` with `'` — manufacturing the character that ended the quote.
    expect(src).not.toMatch(/exec\(\s*`osascript/);
    expect(src).not.toMatch(/replace\(\/"\/g, "'"\)/);
  });

  test("uses execFile with the text passed as argv, not interpolated", () => {
    expect(src).toMatch(/execFile\(\s*\n?\s*"osascript"/);
    // Script reads its text out of argv, so there is no quoting context to escape.
    expect(src).toMatch(/item 1 of argv/);
    expect(src).toMatch(/item 2 of argv/);
  });

  test("is a no-op off macOS rather than shelling out anyway", () => {
    expect(src).toMatch(/process\.platform !== "darwin"/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("F03a / T06 — bulletin must not silently drop FRED data", () => {
  let bulletin;
  beforeEach(() => {
    jest.resetModules();
    jest.doMock("../server/providers/fred", () => ({
      getAllRates: jest.fn(async () => ({
        // Facts, exactly as getAllRates resolves them
        dgs10:     { seriesId: "DGS10",        value: 4.0,  date: "2026-09-18", source: "FRED" },
        dfii10:    { seriesId: "DFII10",       value: 1.8,  date: "2026-09-18", source: "FRED" },
        t10yie:    { seriesId: "T10YIE",       value: 2.2,  date: "2026-09-18", source: "FRED" },
        hy_spread: { seriesId: "BAMLH0A0HYM2", value: 3.17, date: "2026-09-18", source: "FRED" },
        t10y2y:    { seriesId: "T10Y2Y",       value: 0.4,  date: "2026-09-18", source: "FRED" },
      })),
      getLatestObservation: jest.fn(),
      getRecentHistory: jest.fn(),
    }));
    bulletin = require("../server/routes/bulletin");
  });

  test("returns a populated block for a valid FRED response", async () => {
    const out = await bulletin._fetchMacroContext();
    expect(out).toBeTruthy();                 // was null on every real run
    expect(out).toMatch(/4\.00%/);
  });

  test("converts HY OAS from percent to basis points", async () => {
    const out = await bulletin._fetchMacroContext();
    expect(out).toMatch(/317bp \(3\.17%\)/);  // 3.17% — not "3bps"
  });

  test("each line states its own observation date, not the fetch time", async () => {
    const out = await bulletin._fetchMacroContext();
    const lines = out.split("\n").filter(l => /FRED/.test(l));
    expect(lines).toHaveLength(5);
    for (const l of lines) expect(l).toMatch(/observation date 2026-09-18/);
  });

  test("the prompt no longer stamps today's date on FRED data", () => {
    const src = read("routes/bulletin.js");
    expect(src).not.toMatch(/LIVE MACRO DATA \(FRED, as of \$\{todayStr\(\)\}\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("F04 / T02 — disclosure arrays are enforced, not merely requested", () => {
  let anthropic;
  beforeEach(() => {
    jest.resetModules();
    process.env.ANTHROPIC_API_KEY = "test-key";
    anthropic = require("../server/providers/anthropic");
  });

  test("the exact payload from the review ledger is rejected", () => {
    const V = anthropic.REPORT_VALIDATORS;
    expect(V.equity({ title: "Incomplete", epsOutlook: {} })).toBe(false);
  });

  test("every report type requires estimates[] and unverified[]", () => {
    const V = anthropic.REPORT_VALIDATORS;
    const macro = { title: "t", abstract: ["a"], scenarios: { baseline: {}, stress: {} } };
    expect(V.macro(macro)).toBe(false);
    expect(V.macro({ ...macro, estimates: [], unverified: [] })).toBe(true);
    expect(V.fx({ title: "t", pairViews: [{ pair: "EUR/USD", direction: "LONG" }], risks: ["r"] })).toBe(false);
    expect(V.commodities({ title: "t", keyTakeaways: ["k"], scenarios: {} })).toBe(false);
  });

  test("equity additionally requires its risk surface", () => {
    const V = anthropic.REPORT_VALIDATORS;
    const withDisclosures = { title: "t", epsOutlook: {}, estimates: [], unverified: [] };
    expect(V.equity(withDisclosures)).toBe(false);          // no scenarios/risks
    expect(V.equity({
      ...withDisclosures,
      crossAssetContext: {}, rateSensitivity: {}, scenarios: { bear: {}, bull: {} },
      invalidation: {}, risks: [{ risk: "r" }],
    })).toBe(true);
    // One scenario is not a scenario analysis.
    expect(V.equity({
      ...withDisclosures,
      crossAssetContext: {}, rateSensitivity: {}, scenarios: { base: {} },
      invalidation: {}, risks: [{ risk: "r" }],
    })).toBe(false);
  });

  test("every synchronous branch exits through finalizeResearchReport", () => {
    const src = read("providers/anthropic.js");
    for (const t of ["fx", "rates", "thematic", "equity", "commodities", "macro"]) {
      expect(src).toMatch(new RegExp(`finalizeResearchReport\\("${t}", raw, sources`));
    }
  });

  test("the disclosure contract is stated in the shared prompt rules", () => {
    const src = read("providers/anthropic.js");
    expect(src).toMatch(/DISCLOSURE — required on EVERY report type/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("F03b / T07 — batched reports keep their provenance", () => {
  let batch;
  beforeEach(() => {
    jest.resetModules();
    process.env.ANTHROPIC_API_KEY = "test-key";
    batch = require("../server/providers/anthropicBatch");
  });

  test("web_search_tool_result blocks survive result parsing", async () => {
    const line = JSON.stringify({
      custom_id: "equity",
      result: {
        type: "succeeded",
        message: {
          content: [
            { type: "text", text: '{"title":"T"}' },
            {
              type: "web_search_tool_result",
              content: [
                { type: "web_search_result", url: "https://example.com/a", title: "A" },
              ],
            },
          ],
        },
      },
    });
    global.fetch = jest.fn(async () => ({ ok: true, text: async () => line }));

    const out = await batch.fetchResults("https://results.example");
    expect(out.equity.text).toContain('"title"');
    expect(out.equity.sources).toHaveLength(1);   // was [] — citations unresolvable
    expect(out.equity.sources[0].url).toBe("https://example.com/a");
  });

  test("the batch job no longer hardcodes empty sources with grounded:true", () => {
    const src = fs.readFileSync(path.join(SERVER, "jobs", "researchBatchJob.js"), "utf8");
    expect(src).not.toMatch(/finalizeResearchReport\(type, hit\.text, \[\], true\)/);
    expect(src).toMatch(/finalizeResearchReport\(type, hit\.text, sources,/);
  });

  test("a search-enabled report with no sources is not grounded", () => {
    const anthropic = require("../server/providers/anthropic");
    const raw = JSON.stringify({ title: "t", abstract: ["a"], scenarios: { baseline: {}, stress: {} }, estimates: [], unverified: [] });
    const out = anthropic.finalizeResearchReport("macro", raw, [], { searchEnabled: true, tier: "batch" });
    expect(out.grounded).toBe(false);
    expect(out.grounding.sourcesReturned).toBe(0);
    expect(out.grounding.meaning).toMatch(/does not mean every claim was verified/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("F05 — no fabricated market narrative anywhere in the app", () => {
  const macroSrc = read("routes/macro.js");
  const codeOnly = macroSrc
    .split("\n")
    .filter(l => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*"))
    .join("\n");

  test("the Sales fabricated builders stay deleted", () => {
    expect(codeOnly).not.toMatch(/function buildMacroViewFallback/);
    expect(codeOnly).not.toMatch(/function buildClientFallback/);
  });

  test("no asserted Fed level, scenario probabilities or catalyst calendar", () => {
    expect(codeOnly).not.toMatch(/4\.25-4\.50%/);
    expect(codeOnly).not.toMatch(/probability:\s*60/);
    expect(codeOnly).not.toMatch(/2026-0[45]-\d\d/);
  });

  test("rate helpers carry no invented default levels", () => {
    // rateVal used to take a fallback and return it every single time, because
    // it probed for an `observations` array that getAllRates never returns.
    expect(codeOnly).not.toMatch(/rateVal\([^)]*,\s*4\.2\)/);
    expect(codeOnly).not.toMatch(/dgs10 = 4\.2/);
    expect(codeOnly).toMatch(/function rateVal\(fact\)/);
  });

  test("routes return 503 unavailable instead of inventing a view", () => {
    expect(codeOnly).toMatch(/status\(503\)/);
    expect(codeOnly).toMatch(/unavailablePayload/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("T03 — regime labels describe shape, never an uncomputed direction", () => {
  let buildCtx;
  beforeEach(() => {
    jest.resetModules();
    ({ buildCtx } = require("../server/engine/ideaEngine"));
  });

  test("the ledger's contradictory output no longer occurs", () => {
    const ctx = buildCtx({ t10y2y: 0.8 }, null, null);
    // "Bear steepener + ... + Bear flattener" was the observed result
    expect(ctx.regime).not.toMatch(/steepener/i);
    expect(ctx.regime).not.toMatch(/flattener/i);
  });

  test("an inverted curve is named from its level", () => {
    const ctx = buildCtx({ t10y2y: -0.4 }, null, null);
    expect(ctx.regime).toMatch(/Inverted curve/);
  });

  test("curve change is null while no 2Y history exists", () => {
    const ctx = buildCtx({ t10y2y: 0.8 }, null, null);
    expect(ctx.deltas.t10y2y_d).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("F02 — execution controls cannot be bypassed by their callers", () => {
  // Behavioural now: both callers share executionGate.prepareOrder, so the
  // gate itself is exercised (see tests/dataProvenance.test.js for the full
  // auto-execute path with a mocked broker).
  let gate, now, execPrice, fx;
  beforeEach(() => {
    jest.resetModules();
    process.env.TRADING_ENABLED = "true";
    gate = require("../server/engine/executionGate");
    now = new Date("2026-09-24T15:00:00Z");
    execPrice = { value: 100, executable: true, observedAt: "2026-09-24T14:55:00Z", observedAtPrecision: "timestamp", source: "test quote" };
    fx = { value: 0.8, observedAt: "2026-09-24T08:00:00Z" };
  });
  afterEach(() => { delete process.env.TRADING_ENABLED; });

  test("T04: blocked sizing never degrades to a one-share order", () => {
    const out = gate.prepareOrder({ ticket: { ticker: "AMD", direction: "LONG", stop: 110 },
      priceFact: execPrice, fx, account: { equity: 10000, currency: "USD" }, positions: [], now });
    expect(out.ok).toBe(false);
    expect(out.stage).toBe("sizing");
    expect(out.qty).toBeUndefined();
  });

  test("T05: policy sees the real notional — an oversized order is refused", () => {
    const out = gate.prepareOrder({ ticket: { ticker: "AMD", direction: "LONG", stop: 95 },
      priceFact: execPrice, fx, account: { equity: 100000, currency: "USD" }, positions: [], now });
    expect(out.ok).toBe(false);
    expect(out.stage).toBe("policy");
    expect(out.notionalGBP).toBeGreaterThan(250);
    expect(out.reasons.join(" ")).toMatch(/notional/i);
  });

  test("policy refuses to evaluate with missing inputs instead of assuming zero", () => {
    const policy = require("../server/analytics/executionPolicy");
    const res = policy.checkPolicy({ ticker: "AMD", notionalGBP: 10 });
    expect(res.allowed).toBe(false);
    expect(res.reasons.join(" ")).toMatch(/openPositions, portfolioGBP/);
  });

  test("no invented account equity sizes a real order", () => {
    const out = gate.prepareOrder({ ticket: { ticker: "AMD", direction: "LONG", stop: 95 },
      priceFact: execPrice, fx, account: null, positions: [], now });
    expect(out.ok).toBe(false);
    expect(out.stage).toBe("account");
    expect(read("engine/autoExecute.js")).not.toMatch(/75_000/);
  });

  test("the daily notional cap actually rejects an oversized order", () => {
    const policy = require("../server/analytics/executionPolicy");
    const res = policy.checkPolicy({ ticker: "AMD", notionalGBP: 6000, openPositions: 0, portfolioGBP: 100000 });
    expect(res.allowed).toBe(false);
    expect(res.reasons.join(" ")).toMatch(/notional/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("T01 — freshness is judged on observation date, not cache-write time", () => {
  let cache, checkFreshness;
  beforeEach(() => {
    jest.resetModules();
    cache = require("../server/cache");
    ({ checkFreshness } = require("../server/engine/autoExecute"));
  });

  test("a freshly cached 2020 observation is not fresh", () => {
    cache.set("snapshot:rates", { dgs10: { value: 1.2, date: "2020-01-01", source: "FRED" } }, 60_000);
    const out = checkFreshness();
    expect(out.dataFresh).toBe(false);        // was true
    expect(out.warning).toMatch(/observation/i);
  });

  test("a current observation still passes", () => {
    const today = new Date().toISOString().slice(0, 10);
    cache.set("snapshot:rates", { dgs10: { value: 4.1, date: today, source: "FRED" } }, 60_000);
    expect(checkFreshness().dataFresh).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("spend caps and expensive endpoints", () => {
  test("caps resolve to numbers when the env vars are unset", () => {
    jest.resetModules();
    delete process.env.ANTHROPIC_DAILY_CAP;
    delete process.env.ANTHROPIC_MONTHLY_CAP;
    const budget = require("../server/providers/budget");
    const st = budget.getStatus();
    expect(Number.isFinite(st.daily.cap)).toBe(true);     // was NaN
    expect(Number.isFinite(st.monthly.cap)).toBe(true);
    expect(st.daily.cap).toBe(5);
  });

  test("an explicit cap of 0 is honoured rather than replaced by the default", () => {
    jest.resetModules();
    process.env.ANTHROPIC_DAILY_CAP = "0";
    const budget = require("../server/providers/budget");
    expect(budget.getStatus().daily.cap).toBe(0);
    delete process.env.ANTHROPIC_DAILY_CAP;
  });

  test("the research refresh route is write-guarded", () => {
    expect(read("routes/research.js")).toMatch(/report\/refresh", requireWriteAuth/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("F06 — contested instruments do not generate trade ideas", () => {
  test("the HBKS playbook is held on a qualifying credit signal", () => {
    jest.resetModules();
    const { PLAYBOOKS } = require("../server/engine/playbooks");
    const pb = PLAYBOOKS.find(p => p.id === "breakout-failure");
    expect(pb.trigger({ rates: { hy_spread: 5.0 }, deltas: { hy_spread_d: -25 } })).toBe(false);
  });

  test("no unsourced asset class or beta is asserted for it", () => {
    const src = read("engine/playbooks.js");
    expect(src).not.toMatch(/HBKS \(sukuk\/duration ETF\)/);
    expect(src).not.toMatch(/HBKS beta is 0\.62 —/);
    expect(src).toMatch(/CONTESTED_INSTRUMENTS/);
  });
});
