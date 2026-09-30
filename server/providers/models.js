/**
 * server/providers/models.js — which Claude models the app uses.
 *
 * One setting for every Sonnet job (research pipeline, interrogation chat,
 * idea cards, the Sonnet report types): SONNET_MODEL in .env. Haiku jobs
 * (extraction, events/risk, explains) are unaffected. A per-role variable
 * (RESEARCH_LEAD_MODEL, IDEAS_MODEL, …) still overrides a single job.
 *
 * Read once at start-up, like the rest of .env — restart after changing it.
 * Default stays on Sonnet 5 until the owner has compared receipts (HANDOFF).
 */
"use strict";

const DEFAULT_SONNET = "claude-sonnet-5-5";   // owner switched 2026-09-29 (D-17)
const HAIKU          = "claude-haiku-4-5";

function sonnetModel() {
  return (process.env.SONNET_MODEL || "").trim() || DEFAULT_SONNET;
}

// Forced tool use (tool_choice "any"/"tool") is a 400 on Sonnet 5.5 and the
// other newest models: "tool_choice: type "tool" and "any" are not supported
// for this model." Only models known to accept it are forced; every other model
// (including any future one) gets tool_choice auto plus a prompt instruction.
const FORCED_TOOL_CHOICE_OK = new Set([HAIKU, "claude-sonnet-5"]);
function supportsForcedToolChoice(model) {
  return FORCED_TOOL_CHOICE_OK.has(model);
}
const SEARCH_FIRST_INSTRUCTION =
  "\n\nUse the web_search tool before you answer: search for current figures and news rather than relying on memory.";

/**
 * searchRequest — the tools / tool_choice / system for a call that must search.
 * Forced where the model allows it; otherwise auto + an explicit instruction.
 */
function searchRequest(model, system, tool) {
  if (supportsForcedToolChoice(model)) return { system, tools: [tool], tool_choice: { type: "any" } };
  return { system: `${system || ""}${SEARCH_FIRST_INSTRUCTION}`, tools: [tool] };
}

module.exports = { sonnetModel, DEFAULT_SONNET, HAIKU, supportsForcedToolChoice, searchRequest, SEARCH_FIRST_INSTRUCTION };
