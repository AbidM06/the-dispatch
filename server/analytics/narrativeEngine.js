/**
 * server/analytics/narrativeEngine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Deterministic narrative generator — produces events, risks, and econ cards
 * from live FRED rates, FX, and portfolio data WITHOUT calling any paid API.
 *
 * Called when:
 *   - LOW_COST_MODE=true (GET and POST /events, /risk)
 *   - Anthropic budget is exhausted (BUDGET_DAILY / BUDGET_MONTHLY)
 *   - DISABLE_AI=true
 *
 * Output format is identical to fetchAllAnalysis() so routes are source-agnostic.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoDate() {
  return new Date().toISOString().slice(0, 10);
}

function fmt(n, decimals = 2) {
  return n.toFixed(decimals);
}

function sign(n) {
  return n >= 0 ? "+" : "";
}

// Classify a numeric value against low/medium/high thresholds (ascending).
function classify(value, lowThresh, highThresh) {
  if (value >= highThresh) return "HIGH";
  if (value >= lowThresh)  return "MEDIUM";
  return "LOW";
}

// Score 0–100 linearly interpolated between lo and hi with clamping.
function score(value, lo, hi) {
  return Math.round(Math.max(0, Math.min(100, ((value - lo) / (hi - lo)) * 100)));
}

// ── Context extractor ─────────────────────────────────────────────────────────

/**
 * Normalise the context object so all generators receive clean scalars.
 */
function extractScalars(ctx) {
  const rates = ctx.rates ?? {};
  const fx    = ctx.fx    ?? {};
  const port  = ctx.portfolio;

  return {
    dgs10:     extractVal(rates.dgs10,     4.13),
    dfii10:    extractVal(rates.dfii10,    1.82),
    t10yie:    extractVal(rates.t10yie,    2.35),
    hy_spread: extractVal(rates.hy_spread, 3.00),
    t10y2y:    extractVal(rates.t10y2y,    0.59),
    usdgbp:    extractFx(fx.usdgbp,        0.7448),
    // Portfolio
    totalGBP:    port?.totalGBP    ?? 1110,
    totalPnLPct: port?.totalPnLPct ?? 1.9,
    amdPnlPct:   port?.rows?.find(r => r.ticker === "AMD")?.pnlPct ?? -8.6,
    amdValGBP:   port?.rows?.find(r => r.ticker === "AMD")?.valGBP ?? 134,
    sgldValGBP:  port?.rows?.find(r => r.ticker === "SGLN")?.valGBP ?? 219,
  };
}

function extractVal(obs, fallback) {
  if (obs && typeof obs.value === "number") return obs.value;
  if (typeof obs === "number") return obs;
  return fallback;
}

function extractFx(obs, fallback) {
  if (obs && typeof obs.value === "number") return obs.value;
  if (typeof obs === "number") return obs;
  return fallback;
}

// ── Events generator ──────────────────────────────────────────────────────────

function generateEvents(s) {
  const d = isoDate();

  // Signal derivations
  const yieldCurveInverted = s.t10y2y < 0;
  const realYieldHigh      = s.dfii10 > 2.0;
  const hyStressed         = s.hy_spread > 4.0;
  const inflationHot       = s.t10yie > 2.5;

  const events = [
    {
      headline: `10Y Treasury at ${fmt(s.dgs10)}% — Fed holds amid tariff-driven inflation`,
      impact:   s.dgs10 > 4.5 ? "BEARISH" : s.dgs10 < 3.8 ? "BULLISH" : "NEUTRAL",
      ticker:   "MACRO",
      date:     d,
      detail:   `Nominal yield ${fmt(s.dgs10)}%; real yield ${fmt(s.dfii10)}%; breakeven ${fmt(s.t10yie)}%. ${realYieldHigh ? "Elevated real rates compress growth multiples (AMD, HIJS)." : "Real yields below 2% provide modest multiple support."}`,
    },
    {
      headline: `Yield curve ${yieldCurveInverted ? "inverted" : `${sign(s.t10y2y)}${fmt(s.t10y2y, 0)}bps`} (10Y-2Y) — ${yieldCurveInverted ? "recession signal active" : "bear steepener in progress"}`,
      impact:   yieldCurveInverted ? "BEARISH" : s.t10y2y > 0.5 ? "NEUTRAL" : "BEARISH",
      ticker:   "MACRO",
      date:     d,
      detail:   `10Y-2Y spread ${sign(s.t10y2y)}${fmt(s.t10y2y)}%. ${yieldCurveInverted ? "Inverted curve historically precedes recession by 12–18 months." : "Steepening driven by long-end supply and tariff inflation expectations."}`,
    },
    {
      headline: `HY OAS at ${fmt(s.hy_spread)}% — ${hyStressed ? "credit stress elevated" : "near cycle tights"}`,
      impact:   hyStressed ? "BEARISH" : s.hy_spread < 2.5 ? "BULLISH" : "NEUTRAL",
      ticker:   "MACRO",
      date:     d,
      detail:   `ICE BofA HY Index OAS ${fmt(s.hy_spread)}%. ${hyStressed ? "Spread widening signals broad risk-off; high-beta names (AMD, HIES) most exposed." : "Tight spreads support risk assets but leave little cushion for a shock."}`,
    },
    {
      headline: `AMD portfolio position ${s.amdPnlPct >= 0 ? "profitable" : `down ${fmt(Math.abs(s.amdPnlPct), 1)}%`} — MI450 demand cycle key`,
      impact:   s.amdPnlPct >= 5 ? "BULLISH" : s.amdPnlPct <= -10 ? "BEARISH" : "NEUTRAL",
      ticker:   "AMD",
      date:     d,
      detail:   `Position valued at £${fmt(s.amdValGBP, 0)} (unrealised ${sign(s.amdPnlPct)}${fmt(s.amdPnlPct, 1)}%). ${s.amdPnlPct < 0 ? "Thesis intact: committed MI450 GPU orders from Meta and OpenAI support $9.8B Q1 guide." : "AMD outperforming; monitor NVIDIA Blackwell shipments for competitive read-through."}`,
    },
    {
      headline: `Breakeven inflation ${fmt(s.t10yie)}% — ${inflationHot ? "tariff pass-through accelerating" : "anchored near 2.3%"}`,
      impact:   inflationHot ? "BEARISH" : s.t10yie < 2.0 ? "BULLISH" : "NEUTRAL",
      ticker:   "MACRO",
      date:     d,
      detail:   `10Y BEI ${fmt(s.t10yie)}%. ${inflationHot ? "Tariff-driven cost push and oil supply disruption risk pushing market inflation expectations above comfort zone." : "Breakeven inflation stable; gives Fed optionality to cut later in 2026."}`,
    },
  ];

  return events.slice(0, 5);
}

// ── Risks generator ───────────────────────────────────────────────────────────

function generateRisks(s) {
  const d = isoDate();

  return [
    {
      id:     1,
      title:  "US/Israel-Iran War Escalation",
      level:  "HIGH",
      score:  85,
      date:   d,
      detail: "Active military operations with US involvement. Oil supply disruption risk; Strait of Hormuz passage threatened. Stagflationary shock (higher oil + tariffs + slower growth) remains the most hostile macro scenario.",
      affects: "HIES, SGLN, AMD, HIUS",
    },
    {
      id:     2,
      title:  "US Tariff Escalation (25% Canada/Mexico)",
      level:  "HIGH",
      score:  80,
      date:   d,
      detail: `25% tariffs on Canada/Mexico enacted. Supply chain repricing across semiconductors and consumer goods. CPI breakeven at ${fmt(s.t10yie)}% — inflation re-acceleration risk pushing Fed cut timeline back.`,
      affects: "HIUS, AMD, HIES",
    },
    {
      id:     3,
      title:  "AMD ASIC Competitive Threat",
      level:  "HIGH",
      score:  75,
      date:   d,
      detail: "Custom AI chips from hyperscalers displacing merchant silicon. MI450 demand from Meta ($6GW) and OpenAI ($6GW) provides committed revenue, but margin risk from ASIC displacement is structural.",
      affects: "AMD only",
    },
    {
      id:     4,
      title:  `Rising Real Yields (${fmt(s.dfii10)}%)`,
      level:  classify(s.dfii10, 1.2, 1.8),
      score:  score(s.dfii10, 0.5, 2.5),
      date:   d,
      detail: `Real yield (TIPS 10Y) at ${fmt(s.dfii10)}%. ${s.dfii10 > 2.0 ? "Above 2% real yields historically compress growth P/E multiples by 10–15%." : "Real yields below 2% are broadly supportive of risk assets."} AMD and HIJS most exposed.`,
      affects: "AMD, HIUS, HIJS",
    },
    {
      id:     5,
      title:  "EM Currency / Dollar Stress",
      level:  s.usdgbp > 0.80 ? "HIGH" : s.usdgbp > 0.75 ? "MEDIUM" : "LOW",
      score:  score(s.usdgbp, 0.65, 0.90) * 0.8 | 0,
      date:   d,
      detail: `USD/GBP at ${fmt(s.usdgbp, 4)}. ${s.usdgbp > 0.80 ? "Strong dollar pressures EM currencies; Korean Won and EM basket drag on HIES NAV in GBP terms." : "USD broadly stable; EM currency impact on HIES manageable."} Samsung/SK Hynix earnings in KRW create FX drag.`,
      affects: "HIES",
    },
    {
      id:     6,
      title:  "Credit Spread Widening",
      level:  classify(s.hy_spread, 3.5, 4.5),
      score:  score(s.hy_spread, 2.0, 6.0),
      date:   d,
      detail: `HY OAS at ${fmt(s.hy_spread)}%. ${s.hy_spread > 4.0 ? "Spread widening in progress — broad equity de-rating risk across all positions." : "Spreads near cycle tights leaving little buffer for a negative surprise."} Risk-off episode could cause rapid 100–200bps widening.`,
      affects: "All positions",
    },
    {
      id:     7,
      title:  "Japan Yield Curve Control Exit",
      level:  "LOW",
      score:  32,
      date:   d,
      detail: `BoJ normalisation continues. JGB 10Y above 1.5%. Rising Japanese rates reduce relative attractiveness of HIJS holdings and could trigger JPY carry unwind.`,
      affects: "HIJS",
    },
  ];
}

// ── Econ cards generator ──────────────────────────────────────────────────────

function generateEcon(s) {
  const d    = isoDate();
  const oilWord = s.hy_spread > 4.0 ? "above $95" : "around $85–90";
  const ratesVerb = s.dgs10 > 4.5 ? "surged" : s.dgs10 < 3.8 ? "rallied" : "held";
  const amdDir  = s.amdPnlPct >= 0 ? "outperforming" : "under pressure";

  return [
    {
      id:     1,
      label:  "MACRO THEME",
      color:  "#c8392b",
      bg:     "rgba(200,57,43,.08)",
      border: "rgba(200,57,43,.2)",
      date:   d,
      title:  "Stagflation Triangle: Oil, Tariffs & Slower Growth",
      body:   `The macro backdrop is characterised by three simultaneous headwinds: oil ${oilWord} on Middle East supply disruption, 25% tariffs on Canada/Mexico supply chains, and softening consumer demand. The 10Y BEI at ${fmt(s.t10yie)}% shows markets pricing in tariff pass-through, while the ${fmt(s.t10y2y)}bps yield curve spread reflects the Fed's policy bind. SGLN (gold, £${fmt(s.sgldValGBP, 0)}) remains the primary portfolio hedge in this environment. Portfolio total ${s.totalPnLPct >= 0 ? "up" : "down"} ${fmt(Math.abs(s.totalPnLPct), 1)}% — diversification is working.`,
    },
    {
      id:     2,
      label:  "RATES ANALYSIS",
      color:  "#1a3a5c",
      bg:     "rgba(26,58,92,.15)",
      border: "rgba(88,166,255,.2)",
      date:   d,
      title:  `Yield Curve & Real Rates: Bear ${s.t10y2y > 0 ? "Steepener" : "Flattener"} in Progress`,
      body:   `10Y Treasury ${ratesVerb} to ${fmt(s.dgs10)}%; real yield ${fmt(s.dfii10)}%; breakeven inflation ${fmt(s.t10yie)}%. The 10Y-2Y spread of ${sign(s.t10y2y)}${fmt(s.t10y2y)}% reflects${s.t10y2y < 0 ? " an inverted curve — historically a 12–18 month leading recession indicator." : " a gradually normalising curve as the Fed holds rates."} Real yields at ${fmt(s.dfii10)}% ${s.dfii10 > 2.0 ? "mechanically compress growth multiples — AMD P/E sensitivity to real rates is approximately −15% per 100bps." : "remain supportive of equities; below the 2% level that historically triggers multiple compression."} HY OAS ${fmt(s.hy_spread)}% — ${s.hy_spread > 4.0 ? "widening signals deteriorating credit conditions" : "near tights; credit markets broadly unconcerned"}.`,
    },
    {
      id:     3,
      label:  "EQUITY DEEP DIVE",
      color:  "#2c6e49",
      bg:     "rgba(44,110,73,.08)",
      border: "rgba(63,185,80,.2)",
      date:   d,
      title:  `AMD: ${amdDir === "outperforming" ? "Momentum Builds" : "Thesis Under Test"} on MI450 Cycle`,
      body:   `AMD position ${amdDir} (${sign(s.amdPnlPct)}${fmt(s.amdPnlPct, 1)}%, £${fmt(s.amdValGBP, 0)} current value). Core bull thesis rests on committed GPU demand: Meta $6GW MI450 order and OpenAI $6GW previously announced. Q1 2026 guide $9.8B ±$300M was below elevated buy-side expectations but above the $9.0–9.5B floor needed to maintain bull sentiment. Key upside catalysts: TSMC N2 ramp H2 2026, hyperscaler April capex commentary, and MI500 roadmap reveal. Real yields at ${fmt(s.dfii10)}% remain the primary valuation headwind — every 50bps rise in real yields historically corresponds to roughly −10% compression in AMD's forward P/E multiple.`,
    },
  ];
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * generateNarrative(context) → { events, risks, econ, analysisMode }
 *
 * @param {{ rates, fx, portfolio }} context
 *   - rates:     FRED rates object { dgs10, dfii10, t10yie, hy_spread, t10y2y }
 *   - fx:        FX object { usdgbp }
 *   - portfolio: portfolio payload from cache (optional; null falls back to seed values)
 *
 * @returns {{ events: Array, risks: Array, econ: Array, analysisMode: "deterministic" }}
 */
function generateNarrative(context) {
  const s = extractScalars(context || {});
  return {
    events:       generateEvents(s),
    risks:        generateRisks(s),
    econ:         generateEcon(s),
    analysisMode: "deterministic",
  };
}

module.exports = { generateNarrative };
