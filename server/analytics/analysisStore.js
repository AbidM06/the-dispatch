/**
 * server/analytics/analysisStore.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared storage for the events / risk / econ analysis caches.
 *
 * The defect this fixes: the LOW_COST and budget-fallback paths wrote their
 * DETERMINISTIC narrative into the same cache keys the AI path uses, as a bare
 * array. The next GET found a cache hit and labelled it `analysisMode: "ai"`,
 * `source: "cache"` — computed text relabelled as AI analysis on first read.
 *
 * Entries now carry how they were produced, and that label survives the cache.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const cache = require("../cache");
const seeds = require("../../seeds/fallback");
const { isDemoMode, DEMO_BANNER } = require("../demoMode");

/** Store items with the mode that produced them ("ai" | "deterministic"). */
function storeAnalysis(key, items, analysisMode, ttl, extra = {}) {
  cache.set(key, { __analysis: true, items, analysisMode, generatedAt: new Date().toISOString(), ...extra }, ttl);
}

/**
 * readAnalysis — { items, analysisMode, fetchedAt, stale } or null.
 * Pre-fix entries (bare arrays) have no recorded origin; they are reported as
 * "unknown", not assumed to be AI.
 */
function readAnalysis(key, { allowExpired = false } = {}) {
  if (!allowExpired && !cache.has(key)) return null;
  const meta = cache.getWithMeta(key);
  if (!meta) return null;
  const v = meta.value;
  if (v && v.__analysis) {
    return { items: v.items, analysisMode: v.analysisMode, inputs: v.inputs, fetchedAt: meta.fetchedAt, stale: meta.stale };
  }
  return { items: v, analysisMode: "unknown", fetchedAt: meta.fetchedAt, stale: meta.stale };
}

/** Envelope source for an analysis mode. Deterministic output is computed. */
function sourceFor(analysisMode) {
  return analysisMode === "deterministic" ? "computed" : "cache";
}

/**
 * fallback — what to serve when there is no analysis at all.
 * Demo fixtures only in DEMO_MODE; otherwise an explicit empty/unavailable.
 */
function fallback(kind) {
  if (isDemoMode()) {
    const items =
      kind === "risks"  ? seeds.RISKS_SEED  :
      kind === "events" ? seeds.EVENTS_SEED :
      kind === "econ"   ? seeds.ECON_SEED   : [];
    return { items, source: "demo", analysisMode: "demo", fetchedAt: seeds.SEED_DATE, stale: true, reason: DEMO_BANNER };
  }
  return {
    items: [],
    source: "unavailable",
    analysisMode: "unavailable",
    fetchedAt: null,
    stale: true,
    reason: "No analysis has been generated yet. Refresh to generate one; nothing is shown in its place.",
  };
}

/**
 * narrativeContext — inputs for the deterministic narrative. Facts from the
 * combined snapshot cache, or null. Never seed rates: a narrative built on
 * hand-typed March 2026 levels and dated today is the failure being removed.
 */
function narrativeContext() {
  const snap = cache.get("snapshot:data");
  return {
    rates:     snap?.rates ?? null,
    fx:        snap?.fx ?? null,
    portfolio: cache.get("portfolio:data") || null,
    freshness: snap?.meta?.freshness ?? null,
  };
}

module.exports = { storeAnalysis, readAnalysis, sourceFor, fallback, narrativeContext };
