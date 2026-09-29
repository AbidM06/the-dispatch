/**
 * tests/sonnetOnly.test.js — D-19: quality over availability.
 * A Sonnet job is never quietly redone on Haiku (or on OpenAI unless its key is
 * set); it fails with a plain-English reason. FX and Rates drafts use Sonnet.
 */
"use strict";

function setup({ failWith, openaiKey = false } = {}) {
  jest.resetModules();
  if (openaiKey) process.env.OPENAI_API_KEY = "sk-test"; else delete process.env.OPENAI_API_KEY;
  const calls = [];
  jest.doMock("../server/providers/claudeTransport", () => ({
    send: jest.fn(async (body) => {
      calls.push(body.model);
      if (failWith && body.model !== "claude-haiku-4-5") { const e = new Error("Overloaded"); e.status = failWith; throw e; }
      return { content: [{ type: "text", text: "ok" }] };
    }),
    currentContext: () => ({}),
    runWithContext: (_c, fn) => fn(),
  }));
  jest.doMock("../server/providers/budget", () => ({ checkAndIncrement: jest.fn(), getStatus: () => ({}) }));
  const openaiCalls = [];
  jest.doMock("../server/providers/openai", () => ({ callOpenAI: jest.fn(async () => { openaiCalls.push(1); throw new Error("no"); }) }));
  const anthropic = require("../server/providers/anthropic");
  return { anthropic, calls, openaiCalls };
}

afterEach(() => { delete process.env.OPENAI_API_KEY; });

describe("no silent Haiku stand-in for Sonnet", () => {
  test("an overloaded Sonnet call fails with a plain reason — Haiku is never called", async () => {
    const { anthropic, calls } = setup({ failWith: 529 });
    await expect(anthropic.callClaude("s", "u", 100, anthropic.MODEL_SONNET)).rejects.toMatchObject({
      code: "SONNET_UNAVAILABLE", status: 529,
      message: expect.stringMatching(/overloaded .*529.*No report was produced, and no lower-quality model was used/),
    });
    expect(calls).not.toContain("claude-haiku-4-5");
  });

  test("research drafts: Sonnet → unavailable (no Haiku; no OpenAI without a key)", async () => {
    const { anthropic, calls, openaiCalls } = setup({ failWith: 500 });
    await expect(anthropic.callWithFallbackSourced("s", "u", 100)).rejects.toMatchObject({ code: "SONNET_UNAVAILABLE" });
    expect(calls).toEqual([anthropic.MODEL_SONNET]);
    expect(openaiCalls).toHaveLength(0);
  });

  test("the OpenAI tier still runs when its key is set, and the Sonnet reason is what surfaces", async () => {
    const { anthropic, calls, openaiCalls } = setup({ failWith: 429, openaiKey: true });
    await expect(anthropic.callWithFallbackSourced("s", "u", 100)).rejects.toMatchObject({
      code: "SONNET_UNAVAILABLE", message: expect.stringMatching(/rate limit/) });
    expect(openaiCalls).toHaveLength(1);
    expect(calls).not.toContain("claude-haiku-4-5");
  });

  test("Haiku-by-design calls are untouched", async () => {
    const { anthropic, calls } = setup({});
    await anthropic.callClaude("s", "u", 100);
    expect(calls).toEqual(["claude-haiku-4-5"]);
  });

  test("FX and Rates drafts are written by Sonnet", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "../server/providers/anthropic.js"), "utf8");
    expect(src.match(/callClaudeSourced\(system, prompt, 4000, MODEL_SONNET\)/g)).toHaveLength(2);
    expect(src).not.toMatch(/Tier 3: Claude Haiku/);
  });
});

describe("reviewer steps (llm.callAgent) fail with a plain reason too", () => {
  test("a 529 on the red team names the step and never falls back", async () => {
    jest.resetModules();
    const calls = [];
    jest.doMock("../server/providers/claudeTransport", () => ({
      send: jest.fn(async (body) => { calls.push(body.model); const e = new Error("Overloaded"); e.status = 529; throw e; }),
      currentContext: () => ({}), runWithContext: (_c, fn) => fn(),
    }));
    jest.doMock("../server/providers/budget", () => ({ checkAndIncrement: jest.fn(), isApiFallback: () => false, getStatus: () => ({}) }));
    const llm = require("../server/research/llm");
    await expect(llm.callAgent("redteam", "s", "u")).rejects.toMatchObject({
      code: "SONNET_UNAVAILABLE", message: expect.stringMatching(/overloaded .*The red team step could not run, and no lower-quality model was used/) });
    expect(calls).toEqual([llm.MODEL_SONNET]);
  });

  test("the QA reason names each reviewer that failed and why", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "../server/research/orchestrator.js"), "utf8");
    expect(src).toMatch(/Reviewers could not run — QA NOT RUN\. /);
    expect(src).not.toMatch(/budget or API failure/);
  });
});

describe("reviewers retry once on a temporary failure (owner, D-19)", () => {
  const load = () => { jest.resetModules(); return require("../server/research/orchestrator")._internal; };
  const err = (status, msg = "x") => Object.assign(new Error(msg), { status });

  test("a 529 is retried once and can then succeed", async () => {
    const { safeReview } = load();
    let n = 0;
    const r = await safeReview("red-team", async () => { if (++n === 1) throw err(529); return "ok"; });
    expect(r).toMatchObject({ ok: true, out: "ok", retried: true });
    expect(n).toBe(2);
  });

  test("two failures → NOT_RUN with the reason, and no third attempt", async () => {
    const { safeReview } = load();
    let n = 0;
    const r = await safeReview("red-team", async () => { n++; throw err(529, "Claude Sonnet … overloaded"); });
    expect(n).toBe(2);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/^failed twice \(retried once\) — Claude Sonnet … overloaded/) });
  });

  test("budget, billing and bad-request errors are not retried", async () => {
    const { safeReview, isTransient } = load();
    let n = 0;
    await safeReview("auditor", async () => { n++; throw Object.assign(new Error("cap"), { code: "BUDGET_DAILY" }); });
    expect(n).toBe(1);
    expect(isTransient(err(400))).toBe(false);
    expect(isTransient(err(402))).toBe(false);
    expect(isTransient(err(503))).toBe(true);
    expect(isTransient(new Error("request timed out"))).toBe(true);
  });
});
