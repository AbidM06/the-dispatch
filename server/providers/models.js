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

const DEFAULT_SONNET = "claude-sonnet-5";
const HAIKU          = "claude-haiku-4-5";

function sonnetModel() {
  return (process.env.SONNET_MODEL || "").trim() || DEFAULT_SONNET;
}

module.exports = { sonnetModel, DEFAULT_SONNET, HAIKU };
