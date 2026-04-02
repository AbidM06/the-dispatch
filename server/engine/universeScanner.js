/**
 * server/engine/universeScanner.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Scans the full Shariah-compliant universe against macro conditions and
 * generates ranked trade candidates based on:
 *   1. Sector-macro alignment (which sectors benefit from current regime)
 *   2. Momentum score from watchlist chg%
 *   3. Shariah compliance (already guaranteed by SHARIAH_UNIVERSE)
 *
 * scanUniverse(ctx) → UniverseCandidate[]
 *
 * Each candidate:
 *   { ticker, name, sector, score, rationale, direction, macroAlignment,
 *     momentumSignal, confidence, shariahStatus }
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const { SHARIAH_UNIVERSE, getShariahStatus } = require("./shariahFilter");

// ── Sector → macro regime alignment map ──────────────────────────────────────
// For each regime condition, which sectors benefit / are hurt.
// Score: +2 = strong tailwind, +1 = mild tailwind, -1 = headwind, -2 = strong headwind

const SECTOR_REGIME_SCORES = {
  // DGS10 > 4.5 — restrictive rates
  ratesRestrictive: {
    "Semiconductors":       -1,
    "Technology":           -1,
    "Cloud Software":       -2,
    "Enterprise SaaS":      -2,
    "Cloud Data":           -2,
    "EV / Clean Energy":    -2,
    "Solar / Clean Energy": -1,
    "Solar Energy":         -1,
    "Cybersecurity":        +1,  // tends to be sticky spend
    "Healthcare":           +1,
    "Pharmaceuticals":      +1,
    "Commodities / Gold":   +2,  // gold benefits from real rates via TIPS
    "EM Equities":          -1,
    "US Equities":          -1,
    "UK Equities":           0,
    "Japan Equities":        0,
    "Renewables":           -1,
    "E-commerce / Cloud":   -1,
    "Social Technology":    -1,
    "Semiconductor Equip":  -1,
  },
  // DFII10 > 1.5 — high real yields
  highRealYields: {
    "Semiconductors":       -2,
    "Technology":           -2,
    "Cloud Software":       -2,
    "Enterprise SaaS":      -2,
    "Cloud Data":           -2,
    "EV / Clean Energy":    -2,
    "Cybersecurity":         0,
    "Healthcare":           +1,
    "Pharmaceuticals":      +1,
    "Commodities / Gold":   +2,
    "EM Equities":          -2,
    "US Equities":          -1,
    "UK Equities":           0,
    "Japan Equities":       -1,
    "Renewables":           -2,
    "Solar / Clean Energy": -2,
    "Solar Energy":         -2,
    "Semiconductor Equip":  -2,
    "E-commerce / Cloud":   -1,
    "Social Technology":    -1,
  },
  // hy_spread > 3.5 — risk-off / credit stress
  creditStress: {
    "Semiconductors":       -2,
    "Technology":           -1,
    "Cloud Software":       -2,
    "Enterprise SaaS":      -1,
    "Cloud Data":           -2,
    "EV / Clean Energy":    -2,
    "Cybersecurity":        +1,
    "Healthcare":           +2,
    "Pharmaceuticals":      +2,
    "Commodities / Gold":   +2,
    "EM Equities":          -2,
    "US Equities":          -1,
    "UK Equities":          -1,
    "Japan Equities":       -1,
    "Renewables":           -1,
    "Solar / Clean Energy": -1,
    "Solar Energy":         -1,
    "Semiconductor Equip":  -2,
    "E-commerce / Cloud":   -1,
    "Social Technology":    -2,
  },
  // t10yie > 2.5 — inflation breakout
  inflationBreakout: {
    "Commodities / Gold":   +2,
    "Healthcare":           +1,
    "Pharmaceuticals":      +1,
    "Renewables":           +1,
    "Solar / Clean Energy": +1,
    "Solar Energy":         +1,
    "Semiconductors":        0,
    "Technology":           -1,
    "Cloud Software":       -1,
    "Enterprise SaaS":      -1,
    "Cloud Data":           -1,
    "EV / Clean Energy":    -1,
    "Cybersecurity":         0,
    "EM Equities":          -1,
    "US Equities":          -1,
    "UK Equities":          +1,
    "Social Technology":    -1,
  },
  // t10y2y < 0 — inverted curve / recession signal
  invertedCurve: {
    "Commodities / Gold":   +2,
    "Healthcare":           +2,
    "Pharmaceuticals":      +2,
    "Cybersecurity":        +1,
    "Semiconductors":       -2,
    "Technology":           -2,
    "Cloud Software":       -2,
    "EV / Clean Energy":    -2,
    "EM Equities":          -2,
    "US Equities":          -2,
    "Social Technology":    -2,
    "E-commerce / Cloud":   -1,
  },
  // t10y2y > 0.5 — steepening curve / growth signal
  steepeningCurve: {
    "Semiconductors":       +2,
    "Technology":           +2,
    "Cloud Software":       +1,
    "Enterprise SaaS":      +1,
    "EV / Clean Energy":    +1,
    "E-commerce / Cloud":   +2,
    "Social Technology":    +1,
    "EM Equities":          +2,
    "Renewables":           +1,
    "Commodities / Gold":    0,
    "Healthcare":            0,
  },
  // dfii10 < 1.0 — low real yields / dovish
  lowRealYields: {
    "Semiconductors":       +2,
    "Technology":           +2,
    "Cloud Software":       +2,
    "Enterprise SaaS":      +2,
    "Cloud Data":           +2,
    "EV / Clean Energy":    +2,
    "Social Technology":    +1,
    "E-commerce / Cloud":   +2,
    "Cybersecurity":        +1,
    "EM Equities":          +1,
    "Commodities / Gold":   -1,
    "Healthcare":            0,
    "Renewables":           +1,
  },
};

/**
 * Compute active regime conditions from current rates.
 */
function getActiveConditions(rates) {
  const conditions = [];
  if (rates.dgs10 > 4.5)                                    conditions.push("ratesRestrictive");
  if (rates.dfii10 > 1.5)                                   conditions.push("highRealYields");
  if (rates.dfii10 < 1.0)                                   conditions.push("lowRealYields");
  if (rates.hy_spread > 3.5)                                conditions.push("creditStress");
  if (rates.t10yie > 2.5)                                   conditions.push("inflationBreakout");
  if (rates.t10y2y < 0)                                     conditions.push("invertedCurve");
  if (rates.t10y2y > 0.5)                                   conditions.push("steepeningCurve");
  return conditions;
}

/**
 * Score a sector against current macro conditions.
 * Returns a numeric score: positive = macro tailwind, negative = headwind.
 */
function scoreSector(sector, activeConditions) {
  let total = 0;
  for (const cond of activeConditions) {
    const map = SECTOR_REGIME_SCORES[cond] ?? {};
    total += map[sector] ?? 0;
  }
  return total;
}

/**
 * Get momentum score for a ticker from watchlist (if available).
 * Returns score -2 to +2.
 */
function getMomentumScore(ticker, watchlist) {
  const item = watchlist[ticker];
  if (!item || item.chg == null) return 0;
  const chg = item.chg;
  if (chg > 3)       return 2;
  if (chg > 1)       return 1;
  if (chg > -1)      return 0;
  if (chg > -3)      return -1;
  return -2;
}

/**
 * Build rationale string for a candidate.
 */
function buildRationale(ticker, info, macroScore, momentumScore, activeConditions, rates) {
  const parts = [];

  if (macroScore >= 2) {
    parts.push(`${info.sector} sector has strong macro tailwinds in the current regime (macro score: +${macroScore}).`);
  } else if (macroScore > 0) {
    parts.push(`${info.sector} sector has mild macro support in current conditions.`);
  } else if (macroScore < 0) {
    parts.push(`${info.sector} faces macro headwinds — consider as a defensive/hedge position only.`);
  }

  if (activeConditions.includes("highRealYields") && macroScore > 0) {
    parts.push(`Real yields at ${rates.dfii10.toFixed(2)}% are elevated but ${info.sector} tends to be resilient.`);
  }
  if (activeConditions.includes("creditStress") && macroScore > 0) {
    parts.push(`HY spread widening (${rates.hy_spread.toFixed(2)}%) signals risk-off — ${info.sector} benefits from flight-to-quality.`);
  }
  if (activeConditions.includes("inflationBreakout") && macroScore > 0) {
    parts.push(`Breakeven inflation at ${rates.t10yie.toFixed(2)}% supports ${info.sector} as an inflation hedge.`);
  }
  if (momentumScore > 0) {
    parts.push(`Positive price momentum confirms macro thesis alignment.`);
  }

  if (info.note) parts.push(`Note: ${info.note}`);
  if (info.index) parts.push(`Shariah index: ${info.index}.`);

  return parts.join(" ") || `${ticker} (${info.sector}) — aligned with current macro regime.`;
}

/**
 * Scan the full Shariah universe and rank candidates by macro alignment + momentum.
 *
 * @param {object} ctx  Engine context (has .rates, .watchlist, .regime)
 * @param {object} opts { minScore: number, maxResults: number, excludeTickers: string[] }
 * @returns {UniverseCandidate[]}
 */
function scanUniverse(ctx, opts = {}) {
  const {
    minScore     = 0,   // minimum combined score to include
    maxResults   = 10,
    excludeTickers = [],
  } = opts;

  const rates     = ctx.rates;
  const watchlist = ctx.watchlist ?? {};
  const excluded  = new Set(excludeTickers.map(t => t.toUpperCase()));

  const activeConditions = getActiveConditions(rates);

  const candidates = [];

  for (const [ticker, info] of SHARIAH_UNIVERSE.entries()) {
    if (excluded.has(ticker)) continue;

    const macroScore    = scoreSector(info.sector, activeConditions);
    const momentumScore = getMomentumScore(ticker, watchlist);
    const totalScore    = macroScore + momentumScore;

    if (totalScore < minScore) continue;

    const direction = totalScore >= 0 ? "LONG" : null; // never SHORT — Shariah
    if (!direction) continue;

    // Confidence: base 45 + (score × 8), capped 30–85
    const confidence = Math.min(Math.max(45 + totalScore * 8, 30), 85);

    const rationale = buildRationale(ticker, info, macroScore, momentumScore, activeConditions, rates);

    const currentPrice = watchlist[ticker]?.price ?? null;

    candidates.push({
      ticker,
      name:           info.name,
      sector:         info.sector,
      shariahIndex:   info.index,
      score:          totalScore,
      macroScore,
      momentumScore,
      direction,
      confidence,
      rationale,
      macroAlignment: activeConditions,
      currentPrice,
      chgPct:         watchlist[ticker]?.chg ?? null,
      inPortfolio:    false, // caller sets this
    });
  }

  // Sort by score desc, then confidence desc
  candidates.sort((a, b) => b.score - a.score || b.confidence - a.confidence);

  return candidates.slice(0, maxResults);
}

/**
 * Mark which candidates are already in the portfolio.
 * @param {UniverseCandidate[]} candidates
 * @param {string[]} portfolioTickers
 * @returns {UniverseCandidate[]}
 */
function markPortfolioOverlap(candidates, portfolioTickers) {
  const held = new Set(portfolioTickers.map(t => t.toUpperCase()));
  return candidates.map(c => ({ ...c, inPortfolio: held.has(c.ticker) }));
}

module.exports = { scanUniverse, markPortfolioOverlap, getActiveConditions, scoreSector };
