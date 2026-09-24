/**
 * server/routes/brief.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GET /api/brief
 *
 * Fully deterministic Daily Brief — zero AI calls, computed from cached FRED
 * facts only.
 *
 * Removed, and why:
 *  - PREV_RATES: a hardcoded "prior session" (Mar 9 2026) that every
 *    "what changed" delta was measured against, forever. Deltas now come from
 *    the FRED history the snapshot fetched, between two dated observations.
 *  - Seed rates when the cache was empty: the brief rendered March 2026 levels
 *    under today's date. Missing data is now reported as missing.
 *  - "Bear steepener" from a curve level and "Bear flattener" from spreads.
 *  - Canned rationales (AMD catalysts and order pipeline, gold's beta, HBKS as
 *    sukuk, "reliable 12–18 month" recession lead).
 *  - A next-event lookup on the year-less seed calendar.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const { Router } = require("express");
const cache      = require("../cache");
const { loadIdeas } = require("../importers/ideas");
const { classifyLevels, curveMove } = require("../analytics/regime");
const { getCalendar } = require("../analytics/eventCalendar");

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoDate() {
  return new Date().toISOString().slice(0, 10);
}

function factOf(obs) {
  if (!obs || typeof obs !== "object" || !Number.isFinite(obs.value)) return null;
  return { value: obs.value, observedAt: obs.observedAt || obs.date || null, seriesId: obs.seriesId || null,
           freshness: obs.freshness?.status || null };
}

/**
 * deltaFromHistory — change between the two most recent observations in a
 * FRED history, with both dates. null when history is missing or too short.
 */
function deltaFromHistory(points, key) {
  const valid = (points || []).filter(p => Number.isFinite(p?.[key]));
  if (valid.length < 2) return null;
  const cur = valid[valid.length - 1], prev = valid[valid.length - 2];
  return { deltaBps: Math.round((cur[key] - prev[key]) * 100), from: prev.m, to: cur.m, fromValue: prev[key], toValue: cur[key] };
}

function rateSignal(series, deltaBps) {
  if (deltaBps == null) return "UNAVAILABLE";
  if (series === "t10y2y") return "NEUTRAL";
  return deltaBps > 5 ? "RISING" : deltaBps < -5 ? "FALLING" : "LITTLE CHANGED";
}

function regimeDrivers(r) {
  const d = [];
  if (r.dfii10)    d.push(`Real yield ${r.dfii10.value.toFixed(2)}% (DFII10, ${r.dfii10.observedAt})`);
  if (r.hy_spread) d.push(`HY OAS ${Math.round(r.hy_spread.value * 100)}bp (BAMLH0A0HYM2, ${r.hy_spread.observedAt})`);
  if (r.t10y2y)    d.push(`10Y–2Y ${r.t10y2y.value >= 0 ? "+" : ""}${r.t10y2y.value.toFixed(2)}pp (T10Y2Y, ${r.t10y2y.observedAt})`);
  if (r.t10yie)    d.push(`10Y breakeven ${r.t10yie.value.toFixed(2)}% (T10YIE, ${r.t10yie.observedAt})`);
  return d;
}

function buildWhyItMatters(r, changes, portfolioData) {
  const parts = [];
  if (r.dfii10) {
    parts.push(`Real yields at ${r.dfii10.value.toFixed(2)}% set the discount rate on long-duration cash flows; this brief does not estimate a valuation sensitivity.`);
  }
  const hy = changes.hy_spread;
  if (r.hy_spread && hy) {
    parts.push(`HY OAS ${hy.deltaBps >= 0 ? "+" : ""}${hy.deltaBps}bp between ${hy.from} and ${hy.to} (now ${Math.round(r.hy_spread.value * 100)}bp).`);
  }
  if (r.t10y2y && r.t10y2y.value < 0) {
    parts.push("The curve is inverted. Inversion has preceded past US recessions, with long, variable lags and false signals; it is not a timing tool.");
  }
  if (Number.isFinite(portfolioData?.totalPnLPct)) {
    const pnl = portfolioData.totalPnLPct;
    parts.push(`Portfolio ${pnl >= 0 ? "up" : "down"} ${Math.abs(pnl).toFixed(1)}% overall (loaded portfolio snapshot).`);
  }
  return parts.join(" ") || "Rate data unavailable — nothing to summarise.";
}

// ── GET /api/brief ─────────────────────────────────────────────────────────────
router.get("/", (req, res) => {
  // Facts from the combined snapshot (with provenance) or the raw FRED cache.
  const snap     = cache.get("snapshot:data");
  const rawMeta  = cache.getWithMeta("snapshot:rates");
  const rawRates = snap?.rates || rawMeta?.value || null;

  const r = {
    dgs10:     factOf(rawRates?.dgs10),
    dfii10:    factOf(rawRates?.dfii10),
    t10yie:    factOf(rawRates?.t10yie),
    hy_spread: factOf(rawRates?.hy_spread),
    t10y2y:    factOf(rawRates?.t10y2y),
  };
  const available = Object.values(r).filter(Boolean);
  const source    = available.length === 0 ? "unavailable" : available.length < 5 ? "partial" : "cache";

  // Changes from real, dated FRED history (DGS10/DFII10/T10YIE and HY only —
  // there is no 2Y history, so curve CHANGE and direction are unavailable).
  const rh = cache.getWithMeta("snapshot:ratesHistory")?.value || [];
  const hh = cache.getWithMeta("snapshot:hyHistory")?.value || [];
  const changes = {
    dgs10:     deltaFromHistory(rh, "y10"),
    dfii10:    deltaFromHistory(rh, "real"),
    t10yie:    deltaFromHistory(rh, "bei"),
    hy_spread: deltaFromHistory(hh, "oas"),
    t10y2y:    null,
  };

  const row = (series, label, key) => ({
    series, label,
    current:    r[key]?.value ?? null,
    observedAt: r[key]?.observedAt ?? null,
    prev:       changes[key]?.fromValue ?? null,
    prevDate:   changes[key]?.from ?? null,
    deltaBps:   changes[key]?.deltaBps ?? null,
    signal:     rateSignal(key, changes[key]?.deltaBps ?? null),
    basis:      changes[key] ? `FRED history ${changes[key].from} → ${changes[key].to}` : "No prior observation available",
  });
  const whatChanged = [
    row("DGS10",  "10Y Treasury",        "dgs10"),
    row("DFII10", "Real Yield (TIPS)",   "dfii10"),
    row("T10YIE", "Breakeven Inflation", "t10yie"),
    row("HY OAS", "HY Credit Spread",    "hy_spread"),
    row("T10Y2Y", "Yield Curve (10-2Y)", "t10y2y"),
  ];

  const store     = loadIdeas();
  const openIdeas = store.ideas.filter(i => i.status === "OPEN").length;

  const cal = getCalendar();
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const upcoming = cal.events.filter(e => e.at >= today).sort((a, b) => a.at - b.at);
  const nextEvent = upcoming[0]
    ? { date: upcoming[0].date, event: upcoming[0].event, ticker: upcoming[0].ticker, importance: upcoming[0].importance,
        kind: upcoming[0].kind, calendarSource: cal.source }
    : null;

  const levels = classifyLevels(Object.fromEntries(Object.entries(r).map(([k, f]) => [k, f?.value ?? null])));
  const observedDates = available.map(f => f.observedAt).filter(Boolean).sort();

  res.json({
    source,
    // Retrieval time of the rates we used — not a claim that they are today's.
    fetchedAt: rawMeta?.fetchedAt ?? null,
    stale:     source !== "cache" || available.some(f => f.freshness && f.freshness !== "current"),
    data: {
      date:            isoDate(),
      ratesAsOf:       observedDates.length ? { oldest: observedDates[0], newest: observedDates[observedDates.length - 1] } : null,
      regime:          levels.regime,
      regimeNote:      levels.note,
      curveMove:       curveMove(null, changes.dgs10?.deltaBps ?? null), // null: no 2Y history, so no direction claim
      regimeDrivers:   regimeDrivers(r),
      whatChanged,
      whyItMatters:    buildWhyItMatters(r, changes, cache.get("portfolio:data")),
      // Removed: "actionable setups" asserted catalysts, betas and instrument
      // characteristics that were never sourced. Level readings are above.
      actionableSetup: [],
      openIdeas,
      nextEvent,
      calendar:        { available: cal.available, source: cal.source, reason: cal.reason },
    },
  });
});

module.exports = router;
module.exports._internals = { deltaFromHistory };
