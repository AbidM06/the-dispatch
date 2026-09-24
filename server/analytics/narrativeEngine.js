/**
 * server/analytics/narrativeEngine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Deterministic narrative — events, risks and econ cards computed ONLY from
 * the sourced facts passed in. No API calls, no remembered world.
 *
 * Called when LOW_COST_MODE=true, when the Anthropic budget is exhausted, or
 * when API credits run out.
 *
 * WHAT THIS USED TO DO, AND WHY IT DOES NOT ANY MORE
 *  - Missing rates were back-filled with hardcoded levels (4.13%, 1.82%, 2.35%,
 *    3.00%, 0.59%, 0.7448), so an outage produced confident prose about numbers
 *    nobody had fetched.
 *  - Every card was dated TODAY, whatever the observation date of its inputs.
 *  - Four of seven "risks" were canned world events (a US/Israel–Iran war, a
 *    25% tariff package, an ASIC threat, BoJ exit) re-served as current on
 *    every run. Cards asserted a Meta GPU order, a $9.8B revenue guide and an
 *    oil price inferred from the HY spread.
 *  - A curve LEVEL was narrated as a "bear steepener"; fixed P/E elasticities
 *    ("−15% per 100bp") were stated as fact.
 *
 * Now: every item is kind:"calculated", names the inputs it used with their
 * observation dates, is dated by its OLDEST input, and says nothing the inputs
 * cannot support. Thresholds are labelled as this app's heuristics.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n, decimals = 2) { return Number(n).toFixed(decimals); }
function sign(n) { return n >= 0 ? "+" : ""; }

function classify(value, lowThresh, highThresh) {
  if (value >= highThresh) return "HIGH";
  if (value >= lowThresh)  return "MEDIUM";
  return "LOW";
}

function score(value, lo, hi) {
  return Math.round(Math.max(0, Math.min(100, ((value - lo) / (hi - lo)) * 100)));
}

/** Pull a usable fact out of a Fact, a legacy {value,date} obs, or nothing. */
function asFact(obs, seriesId) {
  if (obs == null) return null;
  if (typeof obs === "number") return null;           // bare numbers carry no date — not usable
  if (obs.kind === "unavailable" || obs.kind === "demo") return null;
  if (!Number.isFinite(obs.value)) return null;
  const observedAt = obs.observedAt || obs.date || obs.asOf || null;
  if (!observedAt) return null;                       // an undated number is not a fact
  return {
    value:      obs.value,
    seriesId:   obs.seriesId || seriesId,
    observedAt: String(observedAt).slice(0, 10),
    source:     obs.source || "FRED",
    freshness:  obs.freshness?.status || null,
  };
}

function ref(f) { return `${f.seriesId} ${f.observedAt}`; }
function oldest(...facts) { return facts.filter(Boolean).map(f => f.observedAt).sort()[0] || null; }
function basis(...facts) { return facts.filter(Boolean).map(f => ({ seriesId: f.seriesId, observedAt: f.observedAt, source: f.source })); }
function staleNote(...facts) {
  const bad = facts.filter(f => f && f.freshness && !["current"].includes(f.freshness));
  return bad.length ? ` Freshness: ${bad.map(f => `${f.seriesId} ${f.freshness}`).join(", ")}.` : "";
}

// ── Context extractor ─────────────────────────────────────────────────────────

function extractFacts(ctx) {
  const rates = ctx.rates ?? {};
  const port  = ctx.portfolio;
  return {
    dgs10:     asFact(rates.dgs10,     "DGS10"),
    dfii10:    asFact(rates.dfii10,    "DFII10"),
    t10yie:    asFact(rates.t10yie,    "T10YIE"),
    hy:        asFact(rates.hy_spread, "BAMLH0A0HYM2"),
    t10y2y:    asFact(rates.t10y2y,    "T10Y2Y"),
    usdgbp:    asFact(ctx.fx?.usdgbp ?? ctx.fx, "USDGBP"),
    // The owner's own positions: unknown is null, never a default book.
    totalPnLPct: Number.isFinite(port?.totalPnLPct) ? port.totalPnLPct : null,
    amdPnlPct:   port?.rows?.find(r => r.ticker === "AMD")?.pnlPct ?? null,
    amdValGBP:   port?.rows?.find(r => r.ticker === "AMD")?.valGBP ?? null,
  };
}

const RULE = "Level thresholds are this app's heuristics, not market-standard definitions.";

// ── Events (level readings, not news) ────────────────────────────────────────

function generateEvents(s) {
  const events = [];

  if (s.dgs10) {
    const realPart = s.dfii10 ? ` Real yield ${fmt(s.dfii10.value)}% (${ref(s.dfii10)}).` : " Real yield unavailable.";
    const beiPart  = s.t10yie ? ` Breakeven ${fmt(s.t10yie.value)}% (${ref(s.t10yie)}).` : " Breakeven unavailable.";
    events.push({
      headline: `10Y Treasury ${fmt(s.dgs10.value)}% (FRED observation ${s.dgs10.observedAt})`,
      impact:   "NEUTRAL",
      ticker:   "MACRO",
      date:     oldest(s.dgs10, s.dfii10, s.t10yie),
      detail:   `Nominal 10Y ${fmt(s.dgs10.value)}% (${ref(s.dgs10)}).${realPart}${beiPart} A level reading, not a change: no prior-period comparison is made here.${staleNote(s.dgs10, s.dfii10, s.t10yie)}`,
      kind:     "calculated",
      basis:    basis(s.dgs10, s.dfii10, s.t10yie),
    });
  }

  if (s.t10y2y) {
    const inverted = s.t10y2y.value < 0;
    const bp = Math.round(s.t10y2y.value * 100);
    events.push({
      headline: `10Y–2Y curve ${sign(bp)}${bp}bp — ${inverted ? "inverted" : s.t10y2y.value < 0.3 ? "flat" : "positively sloped"} (level, ${s.t10y2y.observedAt})`,
      impact:   inverted ? "BEARISH" : "NEUTRAL",
      ticker:   "MACRO",
      date:     s.t10y2y.observedAt,
      // Steepener/flattener need the CHANGE in both legs; a level cannot say
      // which leg moved or in which direction.
      detail:   `10Y–2Y spread ${sign(s.t10y2y.value)}${fmt(s.t10y2y.value)}pp (${ref(s.t10y2y)}). This is a curve LEVEL. Whether the curve is steepening or flattening, and whether the long or short end is driving it, requires yield changes that are not computed here.${staleNote(s.t10y2y)}`,
      kind:     "calculated",
      basis:    basis(s.t10y2y),
    });
  }

  if (s.hy) {
    const bp = Math.round(s.hy.value * 100);  // FRED publishes BAMLH0A0HYM2 in percent
    events.push({
      headline: `US HY OAS ${bp}bp (${fmt(s.hy.value)}%, observation ${s.hy.observedAt})`,
      impact:   s.hy.value > 4.5 ? "BEARISH" : "NEUTRAL",
      ticker:   "MACRO",
      date:     s.hy.observedAt,
      detail:   `ICE BofA US High Yield OAS ${fmt(s.hy.value)}% = ${bp}bp (${ref(s.hy)}). ${s.hy.value > 4.5 ? "Above this app's 450bp stress threshold." : "Below this app's 450bp stress threshold."} ${RULE}${staleNote(s.hy)}`,
      kind:     "calculated",
      basis:    basis(s.hy),
    });
  }

  if (s.t10yie) {
    events.push({
      headline: `10Y breakeven inflation ${fmt(s.t10yie.value)}% (observation ${s.t10yie.observedAt})`,
      impact:   "NEUTRAL",
      ticker:   "MACRO",
      date:     s.t10yie.observedAt,
      // A breakeven is a market-implied 10-year average (plus risk premia). It
      // is not a CPI print, and without a release and a consensus figure it
      // says nothing about an "above-consensus" inflation surprise.
      detail:   `10Y breakeven ${fmt(s.t10yie.value)}% (${ref(s.t10yie)}): the nominal–TIPS yield gap, a market-implied average over ten years that also carries inflation-risk and liquidity premia. It is not a CPI release and cannot indicate a surprise versus consensus.${staleNote(s.t10yie)}`,
      kind:     "calculated",
      basis:    basis(s.t10yie),
    });
  }

  if (s.amdPnlPct != null && s.amdValGBP != null) {
    events.push({
      headline: `AMD position ${sign(s.amdPnlPct)}${fmt(s.amdPnlPct, 1)}% unrealised`,
      impact:   "NEUTRAL",
      ticker:   "AMD",
      date:     null,
      detail:   `Position valued at £${fmt(s.amdValGBP, 0)} from the loaded portfolio snapshot.`,
      kind:     "calculated",
      basis:    [{ seriesId: "portfolio-snapshot", observedAt: null, source: "Trading 212 import" }],
    });
  }

  return events;
}

// ── Risks (threshold readings on sourced levels only) ─────────────────────────

function generateRisks(s) {
  const risks = [];
  let id = 1;

  if (s.dfii10) {
    risks.push({
      id: id++,
      title:  `Real yield level ${fmt(s.dfii10.value)}%`,
      level:  classify(s.dfii10.value, 1.2, 1.8),
      score:  score(s.dfii10.value, 0.5, 2.5),
      date:   s.dfii10.observedAt,
      detail: `10Y TIPS yield ${fmt(s.dfii10.value)}% (${ref(s.dfii10)}). Higher real yields raise the discount rate applied to long-duration cash flows; how much that moves any given valuation is not estimated here. ${RULE}${staleNote(s.dfii10)}`,
      affects: "Long-duration equity exposure",
      kind:   "calculated",
      basis:  basis(s.dfii10),
    });
  }

  if (s.hy) {
    const bp = Math.round(s.hy.value * 100);
    risks.push({
      id: id++,
      title:  `Credit spread level ${bp}bp`,
      level:  classify(s.hy.value, 3.5, 4.5),
      score:  score(s.hy.value, 2.0, 6.0),
      date:   s.hy.observedAt,
      detail: `US HY OAS ${bp}bp (${ref(s.hy)}). A level, not a trend: no widening or tightening is asserted without a prior observation. ${RULE}${staleNote(s.hy)}`,
      affects: "Risk assets broadly",
      kind:   "calculated",
      basis:  basis(s.hy),
    });
  }

  if (s.t10y2y) {
    risks.push({
      id: id++,
      title:  `Curve shape: ${s.t10y2y.value < 0 ? "inverted" : s.t10y2y.value < 0.3 ? "flat" : "positively sloped"}`,
      level:  s.t10y2y.value < 0 ? "HIGH" : s.t10y2y.value < 0.3 ? "MEDIUM" : "LOW",
      score:  s.t10y2y.value < 0 ? 70 : s.t10y2y.value < 0.3 ? 45 : 20,
      date:   s.t10y2y.observedAt,
      detail: `10Y–2Y ${sign(s.t10y2y.value)}${fmt(s.t10y2y.value)}pp (${ref(s.t10y2y)}). Inversion has preceded past US recessions, with long and variable lags and false signals; it is not a timing tool. ${RULE}${staleNote(s.t10y2y)}`,
      affects: "Macro backdrop",
      kind:   "calculated",
      basis:  basis(s.t10y2y),
    });
  }

  if (s.usdgbp) {
    risks.push({
      id: id++,
      title:  `USD/GBP ${fmt(s.usdgbp.value, 4)}`,
      level:  "LOW",
      score:  20,
      date:   s.usdgbp.observedAt,
      detail: `GBP per USD ${fmt(s.usdgbp.value, 4)} (${s.usdgbp.source}, observed ${s.usdgbp.observedAt}). USD-denominated holdings are reported in GBP at this rate; the level itself is not scored as a risk.${staleNote(s.usdgbp)}`,
      affects: "USD-denominated holdings (GBP reporting)",
      kind:   "calculated",
      basis:  basis(s.usdgbp),
    });
  }

  return risks;
}

// ── Econ cards ────────────────────────────────────────────────────────────────

function generateEcon(s) {
  const cards = [];
  const rateFacts = [s.dgs10, s.dfii10, s.t10yie, s.t10y2y].filter(Boolean);

  if (rateFacts.length) {
    const parts = [];
    if (s.dgs10)  parts.push(`10Y nominal ${fmt(s.dgs10.value)}% (${s.dgs10.observedAt})`);
    if (s.dfii10) parts.push(`10Y real ${fmt(s.dfii10.value)}% (${s.dfii10.observedAt})`);
    if (s.t10yie) parts.push(`10Y breakeven ${fmt(s.t10yie.value)}% (${s.t10yie.observedAt})`);
    if (s.t10y2y) parts.push(`10Y–2Y ${sign(s.t10y2y.value)}${fmt(s.t10y2y.value)}pp (${s.t10y2y.observedAt})`);
    const dates = new Set(rateFacts.map(f => f.observedAt));
    cards.push({
      id: 1, label: "RATES — LEVELS", color: "#1a3a5c", bg: "rgba(26,58,92,.15)", border: "rgba(88,166,255,.2)",
      date:  oldest(...rateFacts),
      title: "Treasury levels (FRED end-of-day observations)",
      body:  `${parts.join("; ")}.${dates.size > 1 ? " Observation dates differ across series." : ""} Nominal ≈ real + breakeven by construction. These are levels; no direction of travel is implied, and no curve steepening or flattening is inferred from a single spread level.${staleNote(...rateFacts)}`,
      kind:  "calculated",
      basis: basis(...rateFacts),
    });
  }

  if (s.hy) {
    cards.push({
      id: 2, label: "CREDIT — LEVEL", color: "#c8392b", bg: "rgba(200,57,43,.08)", border: "rgba(200,57,43,.2)",
      date:  s.hy.observedAt,
      title: `HY OAS ${Math.round(s.hy.value * 100)}bp`,
      body:  `ICE BofA US HY OAS ${fmt(s.hy.value)}% (${ref(s.hy)}). Spread levels summarise compensation for default and liquidity risk. This card makes no claim about whether credit leads equities or by how long.${staleNote(s.hy)}`,
      kind:  "calculated",
      basis: basis(s.hy),
    });
  }

  cards.push({
    id: 3, label: "WHAT THIS VIEW CANNOT SAY", color: "#2c6e49", bg: "rgba(44,110,73,.08)", border: "rgba(63,185,80,.2)",
    date:  null,
    title: "Limits of a deterministic, level-only read",
    body:  "Generated without AI or news. It does not know current events, policy decisions, CPI releases or consensus forecasts, and it does not compute changes over time. Treat it as a dated table of levels, not a market commentary.",
    kind:  "calculated",
    basis: [],
  });

  return cards;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * generateNarrative(context) → { events, risks, econ, analysisMode, inputs }
 *
 * @param {{ rates, fx, portfolio }} context  rates/fx are Facts from the
 *   snapshot. Missing or undated inputs are skipped — never defaulted.
 */
function generateNarrative(context) {
  const s = extractFacts(context || {});
  const used = [s.dgs10, s.dfii10, s.t10yie, s.hy, s.t10y2y, s.usdgbp].filter(Boolean);
  return {
    events:       generateEvents(s),
    risks:        generateRisks(s),
    econ:         generateEcon(s),
    analysisMode: "deterministic",
    inputs:       basis(...used),
    unavailableInputs: ["DGS10", "DFII10", "T10YIE", "BAMLH0A0HYM2", "T10Y2Y", "USDGBP"]
                         .filter(id => !used.some(f => f.seriesId === id)),
  };
}

module.exports = { generateNarrative };
