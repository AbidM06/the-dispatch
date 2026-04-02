/**
 * server/routes/scenario.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GET  /api/scenario          — seeded scenarios with portfolio P&L impact
 * POST /api/scenario/custom   — custom shock (equity %, rates bps, FX %)
 *
 * Phase 5 — per-factor contributions:
 *   POST /api/scenario/custom now returns factor decomposition per position:
 *     { equityImpactGBP, ratesImpactGBP, fxImpactGBP, totalImpactGBP }
 *   Response also includes `assumptions` (the input factors + BETAS/RATE_DURATION used).
 *
 * Impact calculation
 * ──────────────────
 * Named scenarios (bear/base/bull):
 *   Each scenario in seeds carries explicit per-ticker return shocks.
 *   positionImpactGBP = currentValGBP × shock[ticker]
 *
 * Custom shock:
 *   equityMktDelta (decimal, e.g. -0.10 = -10%):
 *     equityImpactGBP ≈ valGBP × beta[ticker] × equityMktDelta
 *
 *   ratesDelta (basis points, e.g. +50 = rates rise 50bps):
 *     ratesImpactGBP  ≈ valGBP × rateDuration[ticker] × (ratesDelta / 100)
 *
 *   fxDelta (decimal, e.g. -0.05 = USD weakens 5% vs GBP):
 *     fxImpactGBP     ≈ valGBP × usdExposureFraction[ticker] × fxDelta
 *     (USD positions lose GBP value when USD weakens)
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const { Router } = require("express");
const seeds = require("../../seeds/fallback");
const { loadSnapshot } = require("../importers/t212");

const router = Router();

// ── Position value helpers ────────────────────────────────────────────────────

/**
 * Compute current GBP value of each position using seeded prices.
 * Returns a map: { ticker → { valGBP, shares, currency } }
 */
function seedPositionValues() {
  const usdgbp = seeds.FX_SEED.usdgbp.value;
  const vals   = {};

  for (const pos of seeds.POSITIONS_SEED) {
    const priceEntry = seeds.PRICES_SEED[pos.ticker];
    if (!priceEntry) continue;

    const price = priceEntry.price;

    let valGBP;
    if (pos.currency === "USD") {
      valGBP = price * pos.shares * usdgbp;
    } else {
      valGBP = price * pos.shares;
    }
    vals[pos.ticker] = { valGBP, shares: pos.shares, currency: pos.currency };
  }
  return vals;
}

/**
 * Apply per-ticker total return shocks to position values.
 * Used for named scenarios.
 */
function applyShocks(posVals, shocks) {
  const rows = [];
  let totalCurrent = 0;
  let totalImpact  = 0;

  for (const [ticker, pos] of Object.entries(posVals)) {
    const shock      = shocks[ticker] ?? 0;
    const impactGBP  = pos.valGBP * shock;
    const newValGBP  = pos.valGBP + impactGBP;
    totalCurrent    += pos.valGBP;
    totalImpact     += impactGBP;
    rows.push({
      ticker,
      currentValGBP: +pos.valGBP.toFixed(2),
      shockPct:      +(shock * 100).toFixed(1),
      impactGBP:     +impactGBP.toFixed(2),
      newValGBP:     +newValGBP.toFixed(2),
    });
  }

  return {
    rows,
    totalCurrentGBP: +totalCurrent.toFixed(2),
    totalImpactGBP:  +totalImpact.toFixed(2),
    totalNewGBP:     +(totalCurrent + totalImpact).toFixed(2),
    impactPct:       totalCurrent ? +((totalImpact / totalCurrent) * 100).toFixed(2) : 0,
  };
}

// ── Rate duration proxy (approx equity impact per 100bps) ─────────────────────
// Negative = rising rates hurt (growth / USD-heavy). Positive = rate hedge.
const RATE_DURATION = {
  AMD:  -0.12,  // high-growth, rate-sensitive
  HIES: -0.06,  // EM mixed — less rate sensitive
  HIUS: -0.10,  // US large-cap growth
  HIJS: -0.07,  // Japan growth
  SGLN: -0.05,  // Gold: rising real rates weigh on gold
  HBKS: -0.04,  // Sukuk: rate-sensitive but partially hedged
};

/**
 * Apply factor-decomposed shocks to position values.
 * Returns per-position { equityImpactGBP, ratesImpactGBP, fxImpactGBP, totalImpactGBP }
 * plus portfolio totals.
 */
function applyFactorShocks(posVals, { equityMktDelta, ratesDelta, fxDelta }) {
  const rows = [];
  let totalCurrent = 0;
  let totalEquity  = 0;
  let totalRates   = 0;
  let totalFx      = 0;

  for (const [ticker, pos] of Object.entries(posVals)) {
    const beta       = seeds.BETAS[ticker]     ?? 1;
    const rateDur    = RATE_DURATION[ticker]    ?? -0.08;
    const usdExpFrac = (seeds.CCY_EXP[ticker]?.USD ?? 0) / 100;

    const equityImpactGBP = pos.valGBP * beta       * equityMktDelta;
    const ratesImpactGBP  = pos.valGBP * rateDur    * (ratesDelta / 100);
    const fxImpactGBP     = pos.valGBP * usdExpFrac * fxDelta;
    const totalImpactGBP  = equityImpactGBP + ratesImpactGBP + fxImpactGBP;
    const newValGBP        = pos.valGBP + totalImpactGBP;

    totalCurrent += pos.valGBP;
    totalEquity  += equityImpactGBP;
    totalRates   += ratesImpactGBP;
    totalFx      += fxImpactGBP;

    rows.push({
      ticker,
      currentValGBP:     +pos.valGBP.toFixed(2),
      // Factor contributions
      equityImpactGBP:   +equityImpactGBP.toFixed(2),
      ratesImpactGBP:    +ratesImpactGBP.toFixed(2),
      fxImpactGBP:       +fxImpactGBP.toFixed(2),
      totalImpactGBP:    +totalImpactGBP.toFixed(2),
      newValGBP:         +newValGBP.toFixed(2),
      // Inputs used per ticker
      beta:              +beta.toFixed(3),
      rateDuration:      +rateDur.toFixed(3),
      usdExposurePct:    +(usdExpFrac * 100).toFixed(1),
    });
  }

  const totalImpactGBP = totalEquity + totalRates + totalFx;

  return {
    rows,
    totalCurrentGBP:   +totalCurrent.toFixed(2),
    totalEquityImpact: +totalEquity.toFixed(2),
    totalRatesImpact:  +totalRates.toFixed(2),
    totalFxImpact:     +totalFx.toFixed(2),
    totalImpactGBP:    +totalImpactGBP.toFixed(2),
    totalNewGBP:       +(totalCurrent + totalImpactGBP).toFixed(2),
    impactPct:         totalCurrent ? +((totalImpactGBP / totalCurrent) * 100).toFixed(2) : 0,
  };
}

/**
 * Build position values from T212 snapshot if available, else use seeds.
 * Returns { posVals, sourcePositions }.
 */
function getPositionValues() {
  const snapshot = loadSnapshot();
  if (snapshot && Array.isArray(snapshot.positions) && snapshot.positions.length > 0) {
    const usdgbp = snapshot.usdgbpAtImport ?? seeds.FX_SEED.usdgbp.value;
    const vals = {};
    for (const pos of snapshot.positions) {
      vals[pos.ticker] = {
        valGBP:   pos.snapshotValueGBP_total ?? (pos.shares * (pos.snapshotPriceNative ?? 0) * (pos.currency === "USD" ? usdgbp : 1)),
        shares:   pos.shares,
        currency: pos.currency,
      };
    }
    return { posVals: vals, sourcePositions: "snapshot" };
  }
  return { posVals: seedPositionValues(), sourcePositions: "seeded" };
}

// ── GET /api/scenario ─────────────────────────────────────────────────────────
router.get("/", (req, res) => {
  const { posVals, sourcePositions } = getPositionValues();

  const scenarios = seeds.SCENARIOS.map(sc => {
    const impact = applyShocks(posVals, sc.shocks);
    return {
      id:     sc.id,
      label:  sc.label,
      name:   sc.name,
      desc:   sc.desc,
      prob:   sc.prob,
      color:  sc.color,
      bg:     sc.bg,
      border: sc.border,
      impact,
    };
  });

  res.json({
    source:    "seeded",
    fetchedAt: seeds.SEED_DATE,
    stale:     true,
    data:      { scenarios, sourcePositions },
  });
});

// ── POST /api/scenario/custom ─────────────────────────────────────────────────
router.post("/custom", (req, res) => {
  const {
    equityMktDelta = 0,
    ratesDelta     = 0,
    fxDelta        = 0,
    label          = "Custom Scenario",
  } = req.body || {};

  const eq = parseFloat(equityMktDelta);
  const rd = parseFloat(ratesDelta);
  const fx = parseFloat(fxDelta);

  if (isNaN(eq) || isNaN(rd) || isNaN(fx)) {
    return res.status(400).json({ error: "equityMktDelta, ratesDelta, fxDelta must be numbers" });
  }
  if (Math.abs(eq) > 1)   return res.status(400).json({ error: "equityMktDelta must be between -1 and 1" });
  if (Math.abs(rd) > 500) return res.status(400).json({ error: "ratesDelta must be between -500 and +500 bps" });
  if (Math.abs(fx) > 0.5) return res.status(400).json({ error: "fxDelta must be between -0.5 and +0.5" });

  const { posVals, sourcePositions } = getPositionValues();
  const impact  = applyFactorShocks(posVals, { equityMktDelta: eq, ratesDelta: rd, fxDelta: fx });

  const parts = [];
  if (eq !== 0) parts.push(`equity mkt ${eq > 0 ? "+" : ""}${(eq * 100).toFixed(0)}%`);
  if (rd !== 0) parts.push(`rates ${rd > 0 ? "+" : ""}${rd}bps`);
  if (fx !== 0) parts.push(`USD/GBP ${fx > 0 ? "+" : ""}${(fx * 100).toFixed(0)}%`);

  res.json({
    source:    "computed",
    fetchedAt: new Date().toISOString(),
    stale:     false,
    data: {
      label,
      description: parts.length ? parts.join(", ") : "No shocks applied",
      inputs: { equityMktDelta: eq, ratesDeltaBps: rd, fxDelta: fx },
      assumptions: {
        betas:        seeds.BETAS,
        rateDurations: RATE_DURATION,
        ccyExp:        seeds.CCY_EXP,
        note: "Equity impact = valGBP × beta × equityMktDelta. Rates impact = valGBP × rateDuration × (ratesDeltaBps/100). FX impact = valGBP × usdExposureFraction × fxDelta.",
      },
      impact,
      sourcePositions,
    },
  });
});

module.exports = router;
