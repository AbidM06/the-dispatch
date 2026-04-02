/**
 * server/routes/brief.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GET /api/brief
 *
 * Fully deterministic Daily Brief — zero AI calls.
 * Reads from in-process cache (FRED rates, portfolio data) or falls back to seeds.
 * Synthesises: regime label, what changed, why it matters, actionable setup.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const { Router } = require("express");
const cache      = require("../cache");
const seeds      = require("../../seeds/fallback");
const { loadIdeas } = require("../importers/ideas");

const router = Router();

// ── Reference values for delta computation ────────────────────────────────────
// These represent the prior session baseline (seeds from Mar 9 session).
const PREV_RATES = {
  dgs10:     4.12,
  dfii10:    1.78,
  t10yie:    2.35,
  hy_spread: 3.00,
  t10y2y:    0.59,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoDate() {
  return new Date().toISOString().slice(0, 10);
}

function extractVal(obs, fallback) {
  if (obs && typeof obs.value === "number") return obs.value;
  if (typeof obs === "number") return obs;
  return fallback;
}

function bpsDelta(current, prev) {
  return Math.round((current - prev) * 100);
}

function rateSignal(series, delta) {
  if (series === "hy_spread") return delta > 5 ? "BEARISH" : delta < -5 ? "BULLISH" : "NEUTRAL";
  if (series === "t10y2y")    return "NEUTRAL";
  // Rising nominal/real rates = bearish for equities
  return delta > 5 ? "BEARISH" : delta < -5 ? "BULLISH" : "NEUTRAL";
}

// ── Regime classification ─────────────────────────────────────────────────────

function classifyRegime(r) {
  const labels = [];

  if      (r.t10y2y < 0)    labels.push("Inverted curve");
  else if (r.t10y2y < 0.3)  labels.push("Flat curve");
  else                       labels.push("Bear steepener");

  if      (r.dfii10 > 2.0)  labels.push("High real yields");
  else if (r.dfii10 > 1.5)  labels.push("Elevated real yields");

  if      (r.hy_spread > 4.5) labels.push("Credit stress");
  else if (r.hy_spread > 3.5) labels.push("Risk-off");
  else if (r.hy_spread > 3.0 && r.dfii10 > 1.5) labels.push("Bear flattener");

  if (r.dgs10 > 4.5) labels.push("Rates restrictive");

  return labels.length ? labels.join(" + ") : "Broadly neutral";
}

function regimeDrivers(r) {
  const d = [];
  if (r.dfii10 > 1.5)    d.push(`Real yields ${r.dfii10.toFixed(2)}% (TIPS 10Y)`);
  if (r.hy_spread > 3.0) d.push(`HY OAS ${r.hy_spread.toFixed(2)}%`);
  if (r.t10y2y < 0.3)    d.push(`10Y-2Y spread ${r.t10y2y >= 0 ? "+" : ""}${r.t10y2y.toFixed(2)}%`);
  if (r.t10yie > 2.3)    d.push(`Breakeven inflation ${r.t10yie.toFixed(2)}%`);
  return d;
}

// ── Why it matters ────────────────────────────────────────────────────────────

function buildWhyItMatters(r, portfolioData) {
  const parts = [];

  if (r.dfii10 > 1.5) {
    parts.push(
      `Real yields at ${r.dfii10.toFixed(2)}% mechanically compress growth multiples — AMD's forward P/E is most rate-sensitive in the portfolio.`
    );
  }

  const hyDelta = bpsDelta(r.hy_spread, PREV_RATES.hy_spread);
  if (r.hy_spread > 3.0) {
    parts.push(
      `HY OAS ${hyDelta >= 0 ? "+" : ""}${hyDelta}bps from reference (now ${r.hy_spread.toFixed(2)}%) — risk-off pressure building across all risk assets.`
    );
  }

  if (r.t10y2y < 0) {
    parts.push(`Inverted yield curve is a historically reliable 12–18 month leading recession indicator.`);
  }

  if (portfolioData) {
    const pnl = portfolioData.totalPnLPct ?? 0;
    parts.push(
      `Portfolio ${pnl >= 0 ? "up" : "down"} ${Math.abs(pnl).toFixed(1)}% overall — diversification across HIES/SGLN is working as designed.`
    );
  }

  return parts.join(" ") || "Monitor FRED rates closely; no regime-level stress signals active.";
}

// ── Actionable setup ──────────────────────────────────────────────────────────

function buildActionableSetup(r) {
  const setups = [];

  // SGLN — safe haven gold
  if (r.hy_spread > 3.0 || r.dfii10 > 1.5) {
    setups.push({
      ticker:    "SGLN",
      direction: "HOLD",
      rationale: `Gold remains primary hedge in risk-off / high-real-yield regime. Negative beta (−0.08) earns its keep passively.`,
    });
  }

  // AMD — rate-sensitive growth
  if (r.dfii10 > 1.8) {
    setups.push({
      ticker:    "AMD",
      direction: "MONITOR",
      rationale: `Real yields at ${r.dfii10.toFixed(2)}% are a structural multiple headwind. Add on confirmed dovish FOMC signal or real yield pullback below 1.6%.`,
    });
  } else {
    setups.push({
      ticker:    "AMD",
      direction: "ACCUMULATE",
      rationale: `Real yield headwind easing (${r.dfii10.toFixed(2)}%). Q1 earnings Apr 22 is the next key catalyst. MI450 committed order pipeline supports the thesis.`,
    });
  }

  // HBKS — sukuk / duration
  if (r.t10y2y < 0.3) {
    setups.push({
      ticker:    "HBKS",
      direction: "HOLD",
      rationale: `Sukuk offers duration + defensive characteristics in flat/inverted curve environment. Maintain weighting.`,
    });
  }

  // HIES — EM equity
  if (r.hy_spread > 3.5) {
    setups.push({
      ticker:    "HIES",
      direction: "TRIM",
      rationale: `EM risk-off: HY spread widening typically leads EM equity weakness. Consider partial trim on further spread widening above 4%.`,
    });
  }

  return setups;
}

// ── GET /api/brief ─────────────────────────────────────────────────────────────
router.get("/", (req, res) => {
  // Rates: cache → seeds
  const cachedRates = cache.get("snapshot:rates");
  const source      = cachedRates ? "cache" : "seeded";
  const fetchedAt   = cachedRates
    ? (cache.getWithMeta("snapshot:rates")?.fetchedAt ?? new Date().toISOString())
    : seeds.SEED_DATE;
  const stale = !cachedRates;

  const rawRates = cachedRates || {
    dgs10:     seeds.RATES_SEED.dgs10,
    dfii10:    seeds.RATES_SEED.dfii10,
    t10yie:    seeds.RATES_SEED.t10yie,
    hy_spread: seeds.RATES_SEED.hy_spread,
    t10y2y:    seeds.RATES_SEED.t10y2y,
  };

  const rates = {
    dgs10:     extractVal(rawRates.dgs10,     seeds.RATES_SEED.dgs10.value),
    dfii10:    extractVal(rawRates.dfii10,    seeds.RATES_SEED.dfii10.value),
    t10yie:    extractVal(rawRates.t10yie,    seeds.RATES_SEED.t10yie.value),
    hy_spread: extractVal(rawRates.hy_spread, seeds.RATES_SEED.hy_spread.value),
    t10y2y:    extractVal(rawRates.t10y2y,    seeds.RATES_SEED.t10y2y.value),
  };

  const portfolioData = cache.get("portfolio:data");

  // What changed vs reference
  const whatChanged = [
    { series: "DGS10",  label: "10Y Treasury",       current: rates.dgs10,     prev: PREV_RATES.dgs10,     deltaBps: bpsDelta(rates.dgs10,     PREV_RATES.dgs10),     signal: rateSignal("dgs10",     bpsDelta(rates.dgs10,     PREV_RATES.dgs10)) },
    { series: "DFII10", label: "Real Yield (TIPS)",   current: rates.dfii10,    prev: PREV_RATES.dfii10,    deltaBps: bpsDelta(rates.dfii10,    PREV_RATES.dfii10),    signal: rateSignal("dfii10",    bpsDelta(rates.dfii10,    PREV_RATES.dfii10)) },
    { series: "T10YIE", label: "Breakeven Inflation", current: rates.t10yie,    prev: PREV_RATES.t10yie,    deltaBps: bpsDelta(rates.t10yie,    PREV_RATES.t10yie),    signal: rateSignal("t10yie",    bpsDelta(rates.t10yie,    PREV_RATES.t10yie)) },
    { series: "HY OAS", label: "HY Credit Spread",    current: rates.hy_spread, prev: PREV_RATES.hy_spread, deltaBps: bpsDelta(rates.hy_spread, PREV_RATES.hy_spread), signal: rateSignal("hy_spread", bpsDelta(rates.hy_spread, PREV_RATES.hy_spread)) },
    { series: "T10Y2Y", label: "Yield Curve (10-2Y)", current: rates.t10y2y,    prev: PREV_RATES.t10y2y,   deltaBps: bpsDelta(rates.t10y2y,   PREV_RATES.t10y2y),   signal: rateSignal("t10y2y",   bpsDelta(rates.t10y2y,   PREV_RATES.t10y2y)) },
  ];

  // Open ideas count
  const store     = loadIdeas();
  const openIdeas = store.ideas.filter(i => i.status === "OPEN").length;

  // Next upcoming event
  const allEvents = [...seeds.MACRO_CAL, ...seeds.EARNINGS_CAL];
  const today     = new Date();
  const upcoming  = allEvents
    .map(ev => {
      if (!ev.date || ev.date.includes("TBC")) return null;
      try {
        const d = new Date(`${ev.date} ${today.getFullYear()}`);
        if (isNaN(d.getTime())) return null;
        return d >= today ? { ...ev, _date: d } : null;
      } catch (_) { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => a._date - b._date);

  const nextEvent = upcoming[0]
    ? { date: upcoming[0].date, event: upcoming[0].event, ticker: upcoming[0].ticker, importance: upcoming[0].importance }
    : null;

  res.json({
    source,
    fetchedAt,
    stale,
    data: {
      date:            isoDate(),
      regime:          classifyRegime(rates),
      regimeDrivers:   regimeDrivers(rates),
      whatChanged,
      whyItMatters:    buildWhyItMatters(rates, portfolioData),
      actionableSetup: buildActionableSetup(rates),
      openIdeas,
      nextEvent,
    },
  });
});

module.exports = router;
