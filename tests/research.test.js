/**
 * tests/research.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Covers the cross-asset context layer, provenance handling, the batch adapter,
 * and the guarantee that a failed report is reported as unavailable rather than
 * replaced with fabricated content.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const mockFetch = jest.fn();
global.fetch = mockFetch;

function mockResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

/** A FRED observations payload for one series. */
function fredObs(value, date = "2026-09-09") {
  return { observations: [{ date, value: String(value) }] };
}

beforeEach(() => {
  mockFetch.mockReset();
  jest.resetModules();
  process.env.FRED_API_KEY = "test-fred-key";
  delete process.env.LOW_COST_MODE;
});

// ─────────────────────────────────────────────────────────────────────────────
describe("macroContext — cross-asset fact layer", () => {
  let macroContext;
  beforeEach(() => {
    macroContext = require("../server/providers/macroContext");
    require("../server/cache").clear?.();
  });

  test("returns every series as a Fact carrying its own source and date", async () => {
    // One response per series, in SERIES order.
    const values = [4.80, 1.85, 2.38, 0.40, 4.40, 4.33, 2.67, 97.73, 93.10, 18.2, 1.0850];
    values.forEach(v => mockFetch.mockResolvedValueOnce(mockResponse(fredObs(v))));

    const ctx = await macroContext.getMacroContext({ force: true });

    expect(ctx.facts.brent.value).toBe(97.73);
    expect(ctx.facts.brent.source).toBe("FRED");
    expect(ctx.facts.brent.seriesId).toBe("DCOILBRENTEU");
    expect(ctx.facts.brent.asOf).toBe("2026-09-09");
    expect(ctx.facts.brent.formatted).toBe("$97.73/bbl");
    // The two series the equity report was previously blind to.
    expect(ctx.facts.vix).toBeDefined();
    expect(ctx.facts.dgs10.formatted).toBe("4.80%");
  });

  test("a failed series is recorded in `missing` rather than silently dropped", async () => {
    // Series are requested in SERIES order, so the 8th call is Brent. FRED marks a
    // gap with "." — a non-retryable data condition, unlike a 5xx which withRetry
    // would retry past.
    mockFetch.mockResolvedValue(mockResponse(fredObs(4.5)));
    for (let i = 0; i < 7; i++) mockFetch.mockResolvedValueOnce(mockResponse(fredObs(4.5)));
    mockFetch.mockResolvedValueOnce(mockResponse({ observations: [{ date: "2026-09-09", value: "." }] }));

    const ctx = await macroContext.getMacroContext({ force: true });
    expect(ctx.missing).toContain("DCOILBRENTEU");
    expect(ctx.facts.brent).toBeUndefined();
    // A partial context is still usable — the other ten facts survive.
    expect(Object.keys(ctx.facts).length).toBeGreaterThan(5);
  });

  test("toPromptBlock refuses to invent values when nothing was fetched", () => {
    const block = macroContext.toPromptBlock({ facts: {}, missing: [], policyPath: null });
    expect(block).toMatch(/unavailable this run/i);
    expect(block).toMatch(/Do not substitute remembered values/i);
  });

  test("toPromptBlock instructs the model not to re-search verified figures", () => {
    const ctx = {
      facts: { brent: { key:"brent", label:"Brent Crude", group:"commodity", formatted:"$97.73/bbl", source:"FRED", seriesId:"DCOILBRENTEU", asOf:"2026-09-09" } },
      missing: [], policyPath: null,
    };
    const block = macroContext.toPromptBlock(ctx);
    expect(block).toContain("$97.73/bbl");
    expect(block).toContain("DCOILBRENTEU");
    expect(block).toMatch(/Do NOT web_search for them/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("derivePolicyPath — labelled proxy, never a probability", () => {
  let macroContext;
  beforeEach(() => { macroContext = require("../server/providers/macroContext"); });

  const facts = (dgs2, dff) => ({
    dgs2: { value: dgs2, asOf: "2026-09-09" },
    dff:  { value: dff,  asOf: "2026-09-09" },
  });

  test("2Y well above funds reads as a tightening bias", () => {
    const pp = macroContext.derivePolicyPath(facts(4.90, 4.33));
    expect(pp.direction).toBe("TIGHTENING BIAS");
    expect(pp.gapBp).toBe(57);
  });

  test("2Y well below funds reads as an easing bias", () => {
    const pp = macroContext.derivePolicyPath(facts(3.80, 4.33));
    expect(pp.direction).toBe("EASING BIAS");
  });

  test("a gap inside the noise band reads as neutral", () => {
    const pp = macroContext.derivePolicyPath(facts(4.40, 4.33));
    expect(pp.direction).toBe("NEUTRAL / HOLD");
  });

  test("always self-identifies as a proxy and disclaims being FedWatch", () => {
    const pp = macroContext.derivePolicyPath(facts(4.90, 4.33));
    expect(pp.isProxy).toBe(true);
    expect(pp.source).toBe("DERIVED");
    expect(pp.caveat).toMatch(/not a market-implied probability/i);
    expect(pp.caveat).toMatch(/FedWatch/i);
  });

  test("returns null rather than guessing when an input series is missing", () => {
    expect(macroContext.derivePolicyPath({ dgs2: { value: 4.9 } })).toBeNull();
    expect(macroContext.derivePolicyPath({})).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("provenance — citations survive to the client", () => {
  let anthropic;
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    anthropic = require("../server/providers/anthropic");
  });

  const sources = [
    { url: "https://reuters.com/oil",  title: "Brent tops $97", pageAge: "2 hours" },
    { url: "https://fred.example/gdp", title: "GDP release",    pageAge: null },
  ];

  test("a cite tag resolves to the source it references and the markup is removed", () => {
    const raw = 'Brent is at <cite index="0-2">$97.73</cite> today.';
    const { text, cited } = anthropic.parseCiteTags(raw, sources);
    expect(text).toBe("Brent is at $97.73 today.");
    expect(cited).toHaveLength(1);
    expect(cited[0].url).toBe("https://reuters.com/oil");
  });

  test("both cite delimiter forms are handled", () => {
    // Observed in the wild as `<cite ...>` and `(cite ...>`. Handling only one
    // leaves the other's opening tag rendered as visible markup in the report.
    const angle = "Brent at " + String.fromCharCode(60) + 'cite index="0-2">$97.73</cite> now.';
    const paren = "Brent at " + String.fromCharCode(40) + 'cite index="0-2">$97.73</cite> now.';
    for (const raw of [angle, paren]) {
      const { text, cited } = anthropic.parseCiteTags(raw, sources);
      expect(text).toBe("Brent at $97.73 now.");
      expect(cited).toHaveLength(1);
    }
  });

  test("an out-of-range cite index is not guessed at, and the claim is flagged", () => {
    // Silently dropping the marker left the claim looking as supported as its
    // neighbours. It is now kept visibly unresolved and counted.
    const { text, cited, unresolved } = anthropic.parseCiteTags('Value is <cite index="9-0">X</cite>.', sources);
    expect(text).toBe("Value is X [citation unresolved].");
    expect(cited).toHaveLength(0);
    expect(unresolved).toBe(1);
  });

  test("attachProvenance walks nested structures and reports only cited sources", () => {
    const report = {
      title: 'Oil at <cite index="0-0">$97.73</cite>',
      nested: { list: ['plain text', 'GDP per <cite index="1-1">the release</cite>'] },
      count: 42,
    };
    const { clean, citedSources, allSources } = anthropic.attachProvenance(report, sources);

    expect(clean.title).toBe("Oil at $97.73");
    expect(clean.nested.list[1]).toBe("GDP per the release");
    expect(clean.count).toBe(42);                 // non-strings pass through untouched
    expect(citedSources).toHaveLength(2);
    expect(allSources).toHaveLength(2);
  });

  test("an uncited source is available but not presented as backing a claim", () => {
    const { citedSources, allSources } = anthropic.attachProvenance(
      { title: 'Oil at <cite index="0-0">$97.73</cite>' }, sources);
    expect(citedSources.map(s => s.url)).toEqual(["https://reuters.com/oil"]);
    expect(allSources).toHaveLength(2);           // the second was searched but never cited
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("web search tool variant is matched to the model", () => {
  let anthropic;
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    anthropic = require("../server/providers/anthropic");
  });

  test("Sonnet 5 gets the dynamic-filtering tool", () => {
    expect(anthropic.webSearchTool("claude-sonnet-5").type).toBe("web_search_20260209");
  });

  test("Haiku 4.5 keeps the basic tool it supports", () => {
    expect(anthropic.webSearchTool("claude-haiku-4-5").type).toBe("web_search_20250305");
  });

  test("model ids carry no date suffix", () => {
    expect(anthropic.MODEL).toBe("claude-haiku-4-5");
    expect(anthropic.MODEL_SONNET).toBe("claude-sonnet-5");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("research report specs", () => {
  let anthropic;
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    anthropic = require("../server/providers/anthropic");
  });

  const TYPES = ["macro", "fx", "rates", "thematic", "equity", "commodities"];

  test("every report type builds a spec without calling the API", async () => {
    for (const t of TYPES) {
      const spec = await anthropic.buildResearchSpec("CTX", "", t);
      expect(spec.reportType).toBe(t);
      expect(spec.system).toBeTruthy();
      expect(spec.prompt).toBeTruthy();
      expect(spec.maxTokens).toBeGreaterThan(0);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("every report type receives the cross-asset context — including macro and equity", async () => {
    for (const t of TYPES) {
      const spec = await anthropic.buildResearchSpec("SENTINEL_CONTEXT_MARKER", "", t);
      expect(spec.prompt).toContain("SENTINEL_CONTEXT_MARKER");
    }
  });

  test("every report type carries the shared accuracy rules", async () => {
    for (const t of TYPES) {
      const spec = await anthropic.buildResearchSpec("CTX", "", t);
      expect(spec.system).toMatch(/ACCURACY RULES/);
      expect(spec.system).toMatch(/There is no fourth category/);
    }
  });

  test("the equity schema asks for the cross-asset and scenario analysis it used to omit", async () => {
    const spec = await anthropic.buildResearchSpec("CTX", "", "equity");
    for (const field of ["crossAssetContext", "rateSensitivity", "scenarios", "risks", "invalidation", "estimates", "unverified"]) {
      expect(spec.prompt).toContain(field);
    }
    expect(spec.prompt).toMatch(/energyChannel/);
    expect(spec.prompt).toMatch(/policyChannel/);
  });

  test("the equity schema no longer seeds concrete example figures", async () => {
    const spec = await anthropic.buildResearchSpec("CTX", "", "equity");
    // The old template's worked examples reliably showed up in output verbatim.
    expect(spec.prompt).not.toContain("e.g. 46% of index EPS growth");
    expect(spec.prompt).not.toContain("<e.g. $275>");
    expect(spec.prompt).not.toContain("<e.g. $310>");
  });

  test("extractJSON preserves citations for research, strips them elsewhere", () => {
    const payload = JSON.stringify({ note: 'Oil at ' + String.fromCharCode(40) + 'cite index="0-0">$97.73</cite> today' });

    // Default: clean prose, no markup left behind.
    const stripped = anthropic.extractJSON(payload, "object");
    expect(stripped.note).toBe("Oil at $97.73 today");

    // Research: markup intact so the citation can still be resolved to a source.
    // Regression guard — the closing tag used to be removed unconditionally here,
    // which orphaned the opener and made every citation unresolvable downstream.
    const preserved = anthropic.extractJSON(payload, "object", { preserveCitations: true });
    expect(preserved.note).toContain("</cite>");
    expect(preserved.note).toMatch(/index="0-0"/);
  });

  test("finalizeResearchReport rejects a report missing its required shape", () => {
    expect(() => anthropic.finalizeResearchReport("equity", '{"title":"x"}')).toThrow(/failed its contract/);
    expect(() => anthropic.finalizeResearchReport("equity", "not json at all")).toThrow();
  });

  test("finalizeResearchReport attaches provenance and marks grounding", () => {
    // Equity now requires its analytical containers AND the disclosure arrays,
    // so a usable fixture has to carry them.
    const raw = JSON.stringify({
      title: "T",
      epsOutlook: { year2026: {} },
      crossAssetContext: { synthesis: "s" },
      rateSensitivity: { note: "n" },
      scenarios: { bear: {}, base: {}, bull: {} },
      invalidation: { conditions: [] },
      risks: [{ risk: "r" }],
      estimates: [],
      unverified: [],
    });
    // searchEnabled:false (e.g. the OpenAI tier): a tier with no search cannot
    // be grounded, whatever sources array it is handed.
    const out = anthropic.finalizeResearchReport("equity", raw, [{ url: "https://x.com", title: "X" }], false);
    expect(out.reportType).toBe("equity");
    expect(out.grounded).toBe(false);
    expect(out.grounding.searchEnabled).toBe(false);
    expect(out.allSources).toHaveLength(1);
    expect(out.generatedAt).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("batch adapter", () => {
  let batch;
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    batch = require("../server/providers/anthropicBatch");
  });

  test("submitBatch maps requests to custom_id + params", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ id: "batch_123" }));
    const id = await batch.submitBatch([
      { customId: "equity", system: "S", prompt: "P", maxTokens: 8000, model: "claude-sonnet-5" },
    ]);
    expect(id).toBe("batch_123");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.requests[0].custom_id).toBe("equity");
    expect(body.requests[0].params.model).toBe("claude-sonnet-5");
    expect(body.requests[0].params.max_tokens).toBe(8000);
    expect(body.requests[0].params.messages[0].content).toBe("P");
  });

  test("submitBatch refuses an empty submission", async () => {
    await expect(batch.submitBatch([])).rejects.toThrow(/no requests/i);
  });

  test("results are keyed by custom_id, since order is not guaranteed", async () => {
    const jsonl = [
      JSON.stringify({ custom_id: "fx",     result: { type: "succeeded", message: { content: [{ type: "text", text: "FX_BODY" }] } } }),
      JSON.stringify({ custom_id: "equity", result: { type: "succeeded", message: { content: [{ type: "text", text: "EQ_BODY" }] } } }),
    ].join("\n");
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: async () => jsonl });

    const out = await batch.fetchResults("https://example.com/results");
    expect(out.equity.text).toBe("EQ_BODY");
    expect(out.fx.text).toBe("FX_BODY");
  });

  test("a per-request failure is surfaced without losing its siblings", async () => {
    const jsonl = [
      JSON.stringify({ custom_id: "fx",     result: { type: "errored", error: { message: "overloaded" } } }),
      JSON.stringify({ custom_id: "equity", result: { type: "succeeded", message: { content: [{ type: "text", text: "EQ" }] } } }),
    ].join("\n");
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: async () => jsonl });

    const out = await batch.fetchResults("https://example.com/results");
    expect(out.fx.error).toBe("overloaded");
    expect(out.fx.text).toBeNull();
    expect(out.equity.text).toBe("EQ");
  });

  test("runBatch resolves null on failure so the caller can fall back", async () => {
    mockFetch.mockResolvedValue(mockResponse({ error: { message: "nope" } }, 400));
    await expect(batch.runBatch([{ customId: "x", system: "s", prompt: "p", maxTokens: 10, model: "m" }]))
      .resolves.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("no fabricated fallback reports exist", () => {
  test("the seed report builders are gone from the research route", () => {
    const raw = require("fs").readFileSync(require("path").join(__dirname, "../server/routes/research.js"), "utf8");
    // Comments explain why the seeds were removed and legitimately quote them;
    // it is executable code that must be free of fabricated content.
    const code = raw.split("\n").filter(l => !l.trim().startsWith("//")).join("\n");

    for (const gone of ["buildFallbackForType", "buildEquityFallback", "buildCommoditiesFallback", "buildFxFallback", "buildThematicFallback", "buildRatesFallback"]) {
      expect(code).not.toContain(gone);
    }
    // The specific fabrications that made this necessary.
    expect(code).not.toMatch(/Strait of Hormuz/);
    expect(code).not.toMatch(/17mb\/d/);
    expect(code).not.toMatch(/\$81\/bbl/);
    expect(code).not.toMatch(/epsLevel/);
  });

  test("LOW_COST_MODE yields an explicit unavailable result, not seeded prose", async () => {
    process.env.LOW_COST_MODE = "true";
    jest.resetModules();
    const research = require("../server/routes/research.js");
    const out = await research.generateReport("equity");
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("LOW_COST_MODE");
    expect(out.report).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("generateReport — end to end", () => {
  test("a successful report carries verified data, the policy proxy and sources", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    jest.resetModules();

    const report = {
      title: 'S&P 500 Outlook',
      epsOutlook: { year2026: { epsLevel: 'REDACTED_FOR_TEST' } },
      crossAssetContext: { synthesis: 'Oil at (cite index="0-0">$97.73</cite> is a headwind.' },
      // The rest of the equity contract. The previous fixture carried only the
      // three fields above and was accepted, because the synchronous path never
      // ran the validators the batch path used.
      rateSensitivity: { note: 'n' },
      scenarios: { bear: {}, base: {}, bull: {} },
      risks: [{ risk: 'r' }],
      invalidation: { conditions: ['c'] },
      estimates: [],
      unverified: [],
    };

    // FRED for every macro series, then the Anthropic response.
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes("stlouisfed")) {
        return mockResponse({ observations: [{ date: "2026-09-09", value: "4.50" }] });
      }
      return mockResponse({
        content: [
          { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://reuters.com/oil", title: "Brent tops $97" }] },
          { type: "text", text: JSON.stringify(report) },
        ],
      });
    });

    const research = require("../server/routes/research.js");
    const out = await research.generateReport("equity");

    expect(out.ok).toBe(true);
    // Verified, server-fetched figures travel with the report.
    expect(Array.isArray(out.report.marketData)).toBe(true);
    expect(out.report.marketData.length).toBeGreaterThan(0);
    expect(out.report.marketData[0].source).toBe("FRED");
    // The policy proxy is present and still labelled as a proxy.
    expect(out.report.policyPath.isProxy).toBe(true);
    // Citations resolved to a real URL and the markup is gone from the prose.
    expect(out.report.crossAssetContext.synthesis).toBe("Oil at $97.73 is a headwind.");
    expect(out.report.citedSources[0].url).toBe("https://reuters.com/oil");
    expect(out.report.grounded).toBe(true);
    expect(out.report.grounding.resolvedCitations).toBe(1);
    // dataAsOf is the OBSERVATION span, not the time the context was fetched.
    expect(out.report.dataAsOf.oldestObservation).toBe("2026-09-09");
    expect(out.report.dataAsOf.retrievedAt).toBeTruthy();
  });

  test("the synchronous path rejects a report missing its contract fields", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    jest.resetModules();
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes("stlouisfed")) {
        return mockResponse({ observations: [{ date: "2026-09-09", value: "4.50" }] });
      }
      return mockResponse({ content: [{ type: "text", text: JSON.stringify({ title: "T", epsOutlook: {} }) }] });
    });
    const research = require("../server/routes/research.js");
    const out = await research.generateReport("equity");
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("REPORT_SCHEMA_INVALID");
    expect(out.detail).toMatch(/estimates/);
  });

  test("an AI failure produces an unavailable result rather than a substitute report", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    jest.resetModules();

    global.fetch = jest.fn(async (url) => {
      if (String(url).includes("stlouisfed")) {
        return mockResponse({ observations: [{ date: "2026-09-09", value: "4.50" }] });
      }
      return mockResponse({ error: { message: "insufficient credit balance" } }, 402);
    });

    const research = require("../server/routes/research.js");
    const out = await research.generateReport("equity");

    expect(out.ok).toBe(false);
    expect(out.report).toBeUndefined();
    expect(out.detail).toBeTruthy();
  });
});
