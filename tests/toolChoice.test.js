/**
 * tests/toolChoice.test.js — Sonnet 5.5 rejects forced tool use with a 400
 * ("tool_choice: type "tool" and "any" are not supported for this model.").
 * Searches are forced only on models that accept it; others get tool_choice
 * auto plus an explicit search instruction in the system prompt.
 */
"use strict";

function setup(sonnetModel) {
  jest.resetModules();
  if (sonnetModel) process.env.SONNET_MODEL = sonnetModel; else delete process.env.SONNET_MODEL;
  const bodies = [];
  jest.doMock("../server/providers/claudeTransport", () => ({
    send: jest.fn(async (body) => { bodies.push(body); return { content: [{ type: "text", text: "{}" }] }; }),
    currentContext: () => ({}),
    runWithContext: (_c, fn) => fn(),
  }));
  jest.doMock("../server/providers/budget", () => ({ checkAndIncrement: jest.fn(), isApiFallback: () => false, getStatus: () => ({}) }));
  return { bodies };
}

afterEach(() => { delete process.env.SONNET_MODEL; });

test("research drafts on Sonnet 5.5 send no forced tool_choice, and ask for a search in the system prompt", async () => {
  const { bodies } = setup();                       // default = claude-sonnet-5-5
  const anthropic = require("../server/providers/anthropic");
  await anthropic.callWithFallbackSourced("SYSTEM", "u", 100);
  expect(bodies[0].model).toBe("claude-sonnet-5-5");
  expect(bodies[0].tool_choice).toBeUndefined();
  expect(bodies[0].tools).toHaveLength(1);
  expect(bodies[0].system).toMatch(/^SYSTEM\n\nUse the web_search tool before you answer/);
});

test("Sonnet 5 still forces the search (it accepts it)", async () => {
  const { bodies } = setup("claude-sonnet-5");
  const anthropic = require("../server/providers/anthropic");
  await anthropic.callWithFallbackSourced("SYSTEM", "u", 100);            // Sonnet 5
  expect(bodies[0].tool_choice).toEqual({ type: "any" });
  expect(bodies[0].system).toBe("SYSTEM");
});

test("Haiku 5.5 (the Haiku jobs) is never forced: auto + the search instruction; Haiku 4.5 still forces", async () => {
  const { bodies } = setup();
  const anthropic = require("../server/providers/anthropic");
  await anthropic.callClaude("SYSTEM", "u", 100);                         // Haiku by design
  expect(bodies[0].model).toBe("claude-haiku-5-5");
  expect(bodies[0].tool_choice).toBeUndefined();
  expect(bodies[0].system).toMatch(/Use the web_search tool before you answer/);
  const models = require("../server/providers/models");
  expect(models.supportsForcedToolChoice("claude-haiku-4-5")).toBe(true);
});

test("reviewer calls with search: 'force' on Sonnet 5.5 use auto + the instruction; 'auto' search is unchanged", async () => {
  const { bodies } = setup();
  const llm = require("../server/research/llm");
  await llm.callAgent("redteam", "SYS", "u", { search: "force" });
  await llm.callAgent("chat", "SYS", "u", { search: "auto" });
  expect(bodies[0].tool_choice).toBeUndefined();
  expect(bodies[0].system).toMatch(/Use the web_search tool before you answer/);
  expect(bodies[1].tool_choice).toBeUndefined();
  expect(bodies[1].system).toBe("SYS");
  expect(bodies[1].tools).toHaveLength(1);
});

test("an unknown future model gets the safe form (never forced)", () => {
  jest.resetModules();
  const models = require("../server/providers/models");
  expect(models.supportsForcedToolChoice("claude-sonnet-6")).toBe(false);
  expect(models.searchRequest("claude-sonnet-6", "S", { type: "x" }).tool_choice).toBeUndefined();
});
