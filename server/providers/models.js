/**
 * server/providers/models.js — which Claude models the app uses.
 *
 * One setting for every Sonnet job (research pipeline, interrogation chat,
 * idea cards, the Sonnet report types): SONNET_MODEL in .env. Haiku jobs
 * (extraction, events/risk, explains) all use HAIKU below. A per-role variable
 * (RESEARCH_LEAD_MODEL, IDEAS_MODEL, …) still overrides a single job.
 *
 * Read once at start-up, like the rest of .env — restart after changing it.
 * Default stays on Sonnet 5 until the owner has compared receipts (HANDOFF).
 */
"use strict";

const DEFAULT_SONNET = "claude-sonnet-5-5";   // owner switched 2026-09-29 (D-17)
const OPUS           = "claude-opus-5-5";    // red team + IC chair only (D-27)
const HAIKU          = "claude-haiku-5-5";   // owner switched from Haiku 4.5 on 2026-10-20 (D-26)

function sonnetModel() {
  return (process.env.SONNET_MODEL || "").trim() || DEFAULT_SONNET;
}

// Forced tool use (tool_choice "any"/"tool") is a 400 on Sonnet 5.5 and the
// other newest models: "tool_choice: type "tool" and "any" are not supported
// for this model." Only models known to accept it are forced; every other model
// (including any future one) gets tool_choice auto plus a prompt instruction.
// Haiku 5.5 is deliberately absent: its docs say it accepts forcing, but that has not been
// tried against the live API, and a 400 would take down every search call. It gets the safe
// auto + instruction path. Haiku 4.5 stays listed so a rollback behaves as before.
const FORCED_TOOL_CHOICE_OK = new Set(["claude-haiku-4-5", "claude-sonnet-5"]);
function supportsForcedToolChoice(model) {
  return FORCED_TOOL_CHOICE_OK.has(model);
}
// Haiku 5.x thinks by default (adaptive, medium effort) and thinking counts toward max_tokens, so a
// cap sized for Haiku 4.5 (900-1,000 on several jobs) can be used up before any answer is written.
// Every Haiku 5.x call gets this much extra room. It is a ceiling, not a charge: only tokens the
// model actually produces are billed.
const HAIKU_THINKING_HEADROOM = 4000;
function maxTokensFor(model, requested) {
  return /^claude-haiku-5/.test(String(model)) ? requested + HAIKU_THINKING_HEADROOM : requested;
}

/** Model ran out of max_tokens before writing any text (thinking can do this) — say so plainly. */
function outOfRoomError(model, text, stopReason) {
  if (stopReason !== "max_tokens" || String(text).trim()) return null;
  const e = new Error(`${model} used its whole token limit thinking and wrote no answer (stop_reason max_tokens). Try again; if it repeats, the limit for this step needs raising.`);
  e.code = "MAX_TOKENS_NO_TEXT";
  return e;
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

module.exports = { sonnetModel, DEFAULT_SONNET, OPUS, HAIKU, maxTokensFor, outOfRoomError, HAIKU_THINKING_HEADROOM, supportsForcedToolChoice, searchRequest, SEARCH_FIRST_INSTRUCTION };
