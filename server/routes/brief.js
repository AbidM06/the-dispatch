/**
 * server/routes/brief.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GET /api/brief
 *
 * Deterministic Daily Brief — zero AI calls, read-only (never fetches).
 * Every figure comes from the Markets snapshot with its own source, print time
 * and previous value. There are no seeds, no hardcoded baselines and no
 * hand-typed calendar (D-02): a figure Markets does not have is reported as
 * unavailable, and with no snapshot at all the route returns 503
 * `available: false` + the reason. The next event is the soonest entry in the
 * stored FRED economic calendar (markets/calendar.js, D-31) — read, never fetched.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const { Router } = require("express");
const markets    = require("../markets/service");
const calendar   = require("../markets/calendar");

const router = Router();

// The five rate series the Brief reads, by Markets instrument id.
const SERIES = [
  { key: "dgs10",     id: "US10Y",  series: "DGS10",  label: "10Y Treasury" },
  { key: "dfii10",    id: "REAL10", series: "DFII10", label: "Real Yield (TIPS)" },
  { key: "t10yie",    id: "BEI10",  series: "T10YIE", label: "Breakeven Inflation" },
  { key: "hy_spread", id: "HYOAS",  series: "HY OAS", label: "HY Credit Spread" },
  { key: "t10y2y",    id: "T10Y2Y", series: "T10Y2Y", label: "Yield Curve (10-2Y)" },
];

/** The soonest event in the stored FRED calendar (D-31), or an explicit "unavailable" with the reason. Never fetches. */
function nextEvent() {
  const cal = calendar.getCalendar({ daysAhead: 90 });
  if (!cal.available) return { available: false, reason: cal.reason };
  const ev = cal.events[0];
  if (!ev) return { available: false, reason: "The stored calendar lists no release in the next 90 days." };
  return {
    available: true, date: ev.date, name: ev.event, release: ev.release, previous: ev.previous || [],
    source: ev.source, sourceUrl: ev.sourceUrl, stale: cal.stale,
    missing: (cal.missing || []).map(m => m.label),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rateSignal(key, delta) {
  if (key === "t10y2y") return "NEUTRAL";
  // Rising rates / wider spreads = bearish for risk assets
  return delta > 5 ? "BEARISH" : delta < -5 ? "BULLISH" : "NEUTRAL";
}

// One "what changed" row from a Markets item. Delta is against the quote's own
// previous value (previous close / previous observation), never a stored baseline.
function buildRow(def, item) {
  const q = item && item.ok ? item.quote : null;
  if (!q || typeof q.value !== "number") {
    return { series: def.series, label: def.label, available: false,
             current: null, prev: null, deltaBps: null, signal: null };
  }
  const prev     = typeof q.prevValue === "number" ? q.prevValue : null;
  const deltaBps = prev != null ? Math.round((q.value - prev) * 100) : null;
  return {
    series: def.series, label: def.label, available: true,
    current: q.value, prev, deltaBps,
    signal: deltaBps != null ? rateSignal(def.key, deltaBps) : null,
    asOf: q.asOf || null, source: q.source || null, sourceUrl: q.sourceUrl || null,
    stale: !!item.stale, staleSince: item.staleSince || null,
    freshness: item.freshness?.label || null,
  };
}

// ── Regime classification ─────────────────────────────────────────────────────
// r holds only the series that are available; each rule runs only if its
// inputs exist, so a missing series can never be filled in or read as "neutral".

const has = (r, k) => typeof r[k] === "number";

function classifyRegime(r) {
  const labels = [];

  if (has(r, "t10y2y")) {
    if      (r.t10y2y < 0)    labels.push("Inverted curve");
    else if (r.t10y2y < 0.3)  labels.push("Flat curve");
    else                       labels.push("Bear steepener");
  }

  if (has(r, "dfii10")) {
    if      (r.dfii10 > 2.0)  labels.push("High real yields");
    else if (r.dfii10 > 1.5)  labels.push("Elevated real yields");
  }

  if (has(r, "hy_spread")) {
    if      (r.hy_spread > 4.5) labels.push("Credit stress");
    else if (r.hy_spread > 3.5) labels.push("Risk-off");
    else if (r.hy_spread > 3.0 && has(r, "dfii10") && r.dfii10 > 1.5) labels.push("Bear flattener");
  }

  if (has(r, "dgs10") && r.dgs10 > 4.5) labels.push("Rates restrictive");

  return labels.length ? labels.join(" + ") : null;
}

function regimeDrivers(r) {
  const d = [];
  if (has(r, "dfii10")    && r.dfii10 > 1.5)    d.push(`Real yields ${r.dfii10.toFixed(2)}% (TIPS 10Y)`);
  if (has(r, "hy_spread") && r.hy_spread > 3.0) d.push(`HY OAS ${r.hy_spread.toFixed(2)}%`);
  if (has(r, "t10y2y")    && r.t10y2y < 0.3)    d.push(`10Y-2Y spread ${r.t10y2y >= 0 ? "+" : ""}${r.t10y2y.toFixed(2)}%`);
  if (has(r, "t10yie")    && r.t10yie > 2.3)    d.push(`Breakeven inflation ${r.t10yie.toFixed(2)}%`);
  return d;
}

// ── Why it matters — built only from the fetched figures ─────────────────────

function buildWhyItMatters(r, hyDeltaBps) {
  const parts = [];

  if (has(r, "dfii10") && r.dfii10 > 1.5) {
    parts.push(`Real yields at ${r.dfii10.toFixed(2)}% mechanically compress growth equity multiples.`);
  }

  if (has(r, "hy_spread") && r.hy_spread > 3.0) {
    const move = hyDeltaBps == null ? ""
      : ` (${hyDeltaBps >= 0 ? "+" : ""}${hyDeltaBps}bps vs previous close)`;
    const read = hyDeltaBps != null && hyDeltaBps > 5 ? " Widening spreads signal rising risk-off pressure."
               : hyDeltaBps != null && hyDeltaBps < -5 ? " Tightening spreads signal easing credit stress." : "";
    parts.push(`HY OAS at ${r.hy_spread.toFixed(2)}%${move}.${read}`);
  }

  if (has(r, "t10y2y") && r.t10y2y < 0) {
    parts.push("An inverted yield curve is a historically reliable 12–18 month leading recession indicator.");
  }

  if (parts.length) return parts.join(" ");
  return SERIES.every(s => has(r, s.key)) ? "No regime-level stress signals in the latest figures." : null;
}

// ── GET /api/brief ─────────────────────────────────────────────────────────────
router.get("/", (req, res) => {
  const snap = markets.getSnapshot();
  if (!snap || !Array.isArray(snap.items)) {
    return res.status(503).json({
      available: false,
      reason: "No Markets snapshot yet. Press Refresh on the Markets tab, then reload this page.",
    });
  }

  const byId = Object.fromEntries(snap.items.map(i => [i.id, i]));
  const rows = SERIES.map(def => buildRow(def, byId[def.id]));
  const live = rows.filter(r => r.available);

  if (!live.length) {
    return res.status(503).json({
      available: false,
      reason: "The Markets snapshot has none of the rate series the Brief needs (US 10Y, real yield, breakeven, HY OAS, 2s10s).",
    });
  }

  // Only the figures we actually have feed the regime and the prose.
  const rates = {};
  SERIES.forEach((def, i) => { if (rows[i].available) rates[def.key] = rows[i].current; });
  const hyRow = rows[SERIES.findIndex(s => s.key === "hy_spread")];

  const oldest = live.map(r => r.asOf).filter(Boolean).sort()[0] || null;

  res.json({
    available: true,
    source:    "computed",   // derived from the Markets snapshot
    fetchedAt: snap.generatedAt,
    stale:     live.some(r => r.stale),
    data: {
      date:            (snap.generatedAt || "").slice(0, 10),
      oldestAsOf:      oldest,
      regime:          classifyRegime(rates),
      regimeDrivers:   regimeDrivers(rates),
      whatChanged:     rows,
      missing:         rows.filter(r => !r.available).map(r => r.series),
      whyItMatters:    buildWhyItMatters(rates, hyRow.available ? hyRow.deltaBps : null),
      nextEvent:       nextEvent(),
    },
  });
});

module.exports = router;
