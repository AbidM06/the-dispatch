/**
 * server/demoMode.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Hand-entered fixtures (seeds/fallback.js) are demonstration data: prices,
 * events, risks and calendars typed in on one day in March 2026. They used to
 * be served whenever a provider failed, labelled "seeded" at best and relabelled
 * "cache" or "ai" at worst, and they fed current-market reports and signals.
 *
 * They are now served ONLY when DEMO_MODE=true, always tagged kind:"demo", and
 * never passed to the idea engine, research prompts or execution. Outside demo
 * mode a missing provider produces an explicit unavailable state.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

function isDemoMode() {
  return process.env.DEMO_MODE === "true";
}

const DEMO_BANNER = "DEMO MODE — hand-entered demonstration data from March 2026. Not market observations. Not used for signals or execution.";

module.exports = { isDemoMode, DEMO_BANNER };
