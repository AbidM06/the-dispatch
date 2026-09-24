/**
 * server/analytics/regime.js
 * ─────────────────────────────────────────────────────────────────────────────
 * One place that turns rate LEVELS (and, when available, CHANGES) into labels.
 *
 * Three routes used to each carry their own copy, and two of them named a
 * curve DIRECTION from a LEVEL: a positive 10Y–2Y printed "Bear steepener",
 * and HY + real yields printed "Bear flattener" — two mutually exclusive
 * movements, neither measured, both able to appear in one label.
 *
 * Steepener/flattener describe how the curve MOVED and which leg drove it:
 *   bear steepener — long end rising faster than the short end
 *   bull steepener — short end falling faster than the long end
 *   bear flattener — short end rising faster than the long end
 *   bull flattener — long end falling faster than the short end
 * That needs the change in BOTH the 2Y and the 10Y over a stated window.
 * `curveMove()` returns null unless it is given both.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const LEVEL_NOTE = "Shape and level labels only; thresholds are this app's heuristics.";

function num(v) {
  if (v && typeof v === "object") v = v.value;
  return Number.isFinite(v) ? v : null;
}

/**
 * classifyLevels — labels from levels. Missing inputs are named, never assumed.
 * @param {{dgs10,dfii10,t10yie,hy_spread,t10y2y}} rates  numbers or Facts
 */
function classifyLevels(rates = {}) {
  const r = {
    dgs10: num(rates.dgs10), dfii10: num(rates.dfii10), t10yie: num(rates.t10yie),
    hy_spread: num(rates.hy_spread), t10y2y: num(rates.t10y2y),
  };
  const missing = Object.entries(r).filter(([, v]) => v == null).map(([k]) => k);
  const labels = [];

  if (r.t10y2y != null) {
    labels.push(r.t10y2y < 0 ? "Inverted curve" : r.t10y2y < 0.3 ? "Flat curve" : "Positively sloped curve");
  }
  if (r.dfii10 != null) {
    if (r.dfii10 > 2.0)      labels.push("High real yields");
    else if (r.dfii10 > 1.5) labels.push("Elevated real yields");
  }
  if (r.hy_spread != null) {
    if (r.hy_spread > 4.5)      labels.push("Credit stress");
    else if (r.hy_spread > 3.5) labels.push("Wide credit spreads");
  }
  if (r.dgs10 != null && r.dgs10 > 4.5) labels.push("High nominal yields");

  let regime;
  if (missing.length === 5)   regime = "Unavailable — no rate data";
  else if (labels.length)     regime = labels.join(" + ");
  else                        regime = "No threshold breached";
  if (missing.length && missing.length < 5) regime += ` (missing: ${missing.join(", ")})`;

  return { regime, labels, missing, basis: "levels", note: LEVEL_NOTE };
}

/**
 * curveMove — steepener/flattener from CHANGES in both legs.
 * @param {number|null} d2yBp   change in the 2Y yield over the window, bp
 * @param {number|null} d10yBp  change in the 10Y yield over the same window, bp
 * @param {number} [thresholdBp] smaller slope changes are reported as "unchanged"
 * @returns {string|null} null when either change is missing
 */
function curveMove(d2yBp, d10yBp, thresholdBp = 5) {
  if (!Number.isFinite(d2yBp) || !Number.isFinite(d10yBp)) return null;
  const slopeChange = d10yBp - d2yBp;
  if (Math.abs(slopeChange) < thresholdBp) return "Curve slope little changed";
  const steepening = slopeChange > 0;
  // Which leg dominates the move decides bull (yields falling) vs bear (rising).
  const driver = Math.abs(d10yBp) >= Math.abs(d2yBp) ? d10yBp : d2yBp;
  const bear = driver > 0;
  return `${bear ? "Bear" : "Bull"} ${steepening ? "steepener" : "flattener"}`;
}

module.exports = { classifyLevels, curveMove, LEVEL_NOTE };
