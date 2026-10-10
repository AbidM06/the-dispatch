/**
 * server/analytics/narrativeEngine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Deterministic (no-AI) events / risks / econ cards — built ONLY from dated
 * FRED observations that were actually fetched.
 *
 * Called when AI is off or unavailable (LOW_COST_MODE, budget, billing
 * fallback, AI error). Output shape matches fetchAllAnalysis() so routes are
 * source-agnostic.
 *
 * What it will not do (all of which the previous version did):
 *   - assert events: it stated "active military operations with US
 *     involvement", "25% tariffs enacted", specific GPU orders and JGB levels
 *     as current fact on every run, whatever the news actually was;
 *   - back-fill missing data: an unfetched rate became a hardcoded level and a
 *     missing portfolio became £1,110 with AMD −8.6%, narrated as live;
 *   - date by the clock: every card was stamped today. Cards now carry the
 *     observation date of the figures they describe.
 * If a figure was not fetched, the card that needs it is omitted.
 * Thresholds are rules of thumb, and the text says so.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

function fmt(n, decimals = 2) { return n.toFixed(decimals); }
function sign(n) { return n >= 0 ? "+" : ""; }
function num(v) { return typeof v === "number" && Number.isFinite(v) ? v : null; }

function classify(value, lowThresh, highThresh) {
  if (value >= highThresh) return "HIGH";
  if (value >= lowThresh)  return "MEDIUM";
  return "LOW";
}

function score(value, lo, hi) {
  return Math.round(Math.max(0, Math.min(100, ((value - lo) / (hi - lo)) * 100)));
}

/** A fetched observation as { value, asOf } — or null. Accepts a Fact, { value, date } or a number. */
function obs(o) {
  if (o && num(o.value) !== null) return { value: o.value, asOf: o.asOf || o.date || null };
  return null;
}

function extract(ctx) {
  const r = (ctx && ctx.rates) || {};
  return {
    dgs10:    obs(r.dgs10),
    dfii10:   obs(r.dfii10),
    t10yie:   obs(r.t10yie),
    hySpread: obs(r.hy_spread),
    t10y2y:   obs(r.t10y2y),
  };
}

const SRC = (id, o) => `FRED ${id}${o.asOf ? `, as of ${o.asOf}` : ""}`;

// ── Events: observations only ─────────────────────────────────────────────────
function generateEvents(s) {
  const out = [];
  if (s.dgs10) out.push({
    headline: `10Y Treasury yield ${fmt(s.dgs10.value)}%`,
    impact:   "NEUTRAL",
    ticker:   "MACRO",
    date:     s.dgs10.asOf,
    detail:   `Latest observation (${SRC("DGS10", s.dgs10)}).` +
              (s.dfii10 ? ` Real yield ${fmt(s.dfii10.value)}%.` : "") +
              (s.t10yie ? ` Breakeven ${fmt(s.t10yie.value)}%.` : ""),
    basis:    "observation",
  });
  if (s.t10y2y) out.push({
    headline: `10Y–2Y curve ${sign(s.t10y2y.value)}${fmt(s.t10y2y.value)}pp${s.t10y2y.value < 0 ? " (inverted)" : ""}`,
    impact:   s.t10y2y.value < 0 ? "BEARISH" : "NEUTRAL",
    ticker:   "MACRO",
    date:     s.t10y2y.asOf,
    detail:   `Latest observation (${SRC("T10Y2Y", s.t10y2y)}). An inverted curve has historically preceded US recessions, with long and variable lags — a rule of thumb, not a forecast.`,
    basis:    "observation",
  });
  if (s.hySpread) out.push({
    headline: `US high-yield OAS ${fmt(s.hySpread.value)}%`,
    impact:   s.hySpread.value > 4.0 ? "BEARISH" : "NEUTRAL",
    ticker:   "MACRO",
    date:     s.hySpread.asOf,
    detail:   `Latest observation (${SRC("BAMLH0A0HYM2", s.hySpread)}). Rule of thumb: above ~4% signals credit stress; below ~3% leaves little cushion for a shock.`,
    basis:    "observation",
  });
  if (s.t10yie) out.push({
    headline: `10Y breakeven inflation ${fmt(s.t10yie.value)}%`,
    impact:   "NEUTRAL",
    ticker:   "MACRO",
    date:     s.t10yie.asOf,
    detail:   `Latest observation (${SRC("T10YIE", s.t10yie)}). The market-implied average inflation rate over ten years.`,
    basis:    "observation",
  });
  return out.slice(0, 5);
}

// ── Risks: only what the data can measure ─────────────────────────────────────
function generateRisks(s) {
  const out = [];
  if (s.dfii10) out.push({
    title:   `Real yields at ${fmt(s.dfii10.value)}%`,
    level:   classify(s.dfii10.value, 1.2, 1.8),
    score:   score(s.dfii10.value, 0.5, 2.5),
    date:    s.dfii10.asOf,
    detail:  `10Y TIPS yield (${SRC("DFII10", s.dfii10)}). Higher real yields weigh on long-duration assets (growth equities, long bonds, gold). Level bands are rules of thumb.`,
    affects: "Growth equities, duration, gold",
  });
  if (s.hySpread) out.push({
    title:   `Credit spreads (HY OAS ${fmt(s.hySpread.value)}%)`,
    level:   classify(s.hySpread.value, 3.5, 4.5),
    score:   score(s.hySpread.value, 2.0, 6.0),
    date:    s.hySpread.asOf,
    detail:  `ICE BofA US High Yield OAS (${SRC("BAMLH0A0HYM2", s.hySpread)}). Wider spreads mean the market is charging more for default risk.`,
    affects: "Credit, equities",
  });
  if (s.t10y2y) out.push({
    title:   `Curve shape (10Y–2Y ${sign(s.t10y2y.value)}${fmt(s.t10y2y.value)}pp)`,
    level:   s.t10y2y.value < 0 ? "HIGH" : s.t10y2y.value < 0.25 ? "MEDIUM" : "LOW",
    score:   score(-s.t10y2y.value, -1.5, 1.0),
    date:    s.t10y2y.asOf,
    detail:  `${SRC("T10Y2Y", s.t10y2y)}. A flat or inverted curve squeezes bank margins and has historically been a recession warning.`,
    affects: "Banks, cyclicals, rates",
  });
  if (s.t10yie) out.push({
    title:   `Inflation expectations (10Y BEI ${fmt(s.t10yie.value)}%)`,
    level:   classify(s.t10yie.value, 2.4, 2.8),
    score:   score(s.t10yie.value, 1.5, 3.2),
    date:    s.t10yie.asOf,
    detail:  `${SRC("T10YIE", s.t10yie)}. Expectations drifting well above ~2.5% make it harder for the Fed to ease.`,
    affects: "Nominal bonds, rate-sensitive equities",
  });
  return out.map((r, i) => ({ id: i + 1, ...r, basis: "rules-based from FRED" }));
}

// ── Econ cards ────────────────────────────────────────────────────────────────
const CARD_STYLE = [
  { label: "MACRO THEME",    color: "#c8392b", bg: "rgba(200,57,43,.08)", border: "rgba(200,57,43,.2)" },
  { label: "RATES ANALYSIS", color: "#1a3a5c", bg: "rgba(26,58,92,.15)",  border: "rgba(88,166,255,.2)" },
  { label: "CREDIT",         color: "#2c6e49", bg: "rgba(44,110,73,.08)", border: "rgba(63,185,80,.2)" },
];

function generateEcon(s) {
  const cards = [];
  const facts = [s.dgs10, s.dfii10, s.t10yie, s.t10y2y, s.hySpread].filter(Boolean);
  if (!facts.length) return cards;
  const asOf = facts.map(f => f.asOf).filter(Boolean).sort()[0] || null;   // oldest input — freshness of the card

  cards.push({
    title: "No AI analysis available — data snapshot only",
    body:  "AI generation is off or unavailable, so this panel shows measured figures and rule-of-thumb readings only. " +
           "No events or news are described here; use Refresh once AI is available for a sourced narrative.",
    date:  asOf,
  });
  if (s.dgs10 || s.dfii10 || s.t10y2y) cards.push({
    title: "Rates",
    body:  [
      s.dgs10  && `10Y nominal ${fmt(s.dgs10.value)}% (${SRC("DGS10", s.dgs10)}).`,
      s.dfii10 && `10Y real ${fmt(s.dfii10.value)}% (${SRC("DFII10", s.dfii10)}).`,
      s.t10yie && `Breakeven ${fmt(s.t10yie.value)}% (${SRC("T10YIE", s.t10yie)}).`,
      s.t10y2y && `10Y–2Y ${sign(s.t10y2y.value)}${fmt(s.t10y2y.value)}pp${s.t10y2y.value < 0 ? ", inverted" : ""} (${SRC("T10Y2Y", s.t10y2y)}).`,
    ].filter(Boolean).join(" "),
    date:  asOf,
  });
  if (s.hySpread) cards.push({
    title: "Credit",
    body:  `US HY OAS ${fmt(s.hySpread.value)}% (${SRC("BAMLH0A0HYM2", s.hySpread)}). ` +
           (s.hySpread.value > 4.0 ? "Above the ~4% level usually read as stress." : "Below the ~4% level usually read as stress."),
    date:  s.hySpread.asOf,
  });

  return cards.map((c, i) => ({ id: i + 1, ...CARD_STYLE[i], ...c, basis: "rules-based from FRED" }));
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * generateNarrative(context) → { events, risks, econ, analysisMode }
 *
 * @param {{ rates }} context  rates: { dgs10, dfii10, t10yie, hy_spread, t10y2y },
 *   each a Fact / { value, date } / number. Missing entries produce fewer cards,
 *   never invented ones.
 */
function generateNarrative(context) {
  const s = extract(context || {});
  return {
    events:       generateEvents(s),
    risks:        generateRisks(s),
    econ:         generateEcon(s),
    analysisMode: "deterministic",
  };
}

module.exports = { generateNarrative };
