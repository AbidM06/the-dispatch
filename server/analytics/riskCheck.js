/**
 * server/analytics/riskCheck.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pre-trade risk checks — pure functions, no I/O.
 * Currency look-through weights come from seeds.CCY_EXP — hand-entered
 * ASSUMPTIONS about fund holdings, not sourced data; checks that use them say so.
 * The event calendar is passed in (see analytics/eventCalendar.js); the old
 * year-less seed calendar is no longer read here.
 *
 * Usage:
 *   const { runPreTradeCheck } = require("../analytics/riskCheck");
 *   const result = runPreTradeCheck(idea, portfolioRows, totalGBP, usdgbp);
 *
 * Returns:
 *   { pass: bool, level: "OK"|"WARN"|"BLOCK", checks: [{ name, status, detail }] }
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const seeds = require("../../seeds/fallback");

// ── Thresholds ────────────────────────────────────────────────────────────────
const SIZE_WARN   = 15;    // % of portfolio — warn
const SIZE_BLOCK  = 25;    // % of portfolio — block
const HHI_WARN    = 2000;  // HHI points — warn
const HHI_BLOCK   = 2800;  // HHI points — block
const USD_WARN    = 55;    // % total USD exposure — warn
const USD_BLOCK   = 70;    // % total USD exposure — block
const R_WARN      = 1.5;   // R-ratio — warn if below
const R_BLOCK     = 1.0;   // R-ratio — block if below

// ── Helpers ───────────────────────────────────────────────────────────────────

function pctOf(part, total) {
  return total > 0 ? (part / total) * 100 : 0;
}

/**
 * Classify status based on a threshold pair.
 * higherIsBad=true: BLOCK if value >= blockThresh, WARN if >= warnThresh.
 * higherIsBad=false: BLOCK if value < blockThresh, WARN if < warnThresh.
 */
function threshold(value, warnThresh, blockThresh, higherIsBad = true) {
  if (higherIsBad) {
    if (value >= blockThresh) return "BLOCK";
    if (value >= warnThresh)  return "WARN";
    return "OK";
  }
  // Lower is bad
  if (value < blockThresh) return "BLOCK";
  if (value < warnThresh)  return "WARN";
  return "OK";
}

/**
 * Parse a horizon string ("3 months", "6 weeks", "1 year") into calendar days.
 * Defaults to 90 days if unparseable.
 */
function horizonToDays(horizon) {
  if (!horizon) return 90;
  const s = String(horizon).toLowerCase().trim();
  const n = parseFloat(s);
  if (isNaN(n)) return 90;
  if (s.includes("year"))  return Math.round(n * 365);
  if (s.includes("month")) return Math.round(n * 30);
  if (s.includes("week"))  return Math.round(n * 7);
  if (s.includes("day"))   return Math.round(n);
  return 90;
}

/**
 * Parse an event date string like "19 Mar" or "22 Apr" into a Date object.
 * Assumes current year; shifts to next year if the date is >30 days in the past.
 * Returns null for "TBC" or unparseable strings.
 */
function parseEventDate(dateStr) {
  if (!dateStr || String(dateStr).includes("TBC")) return null;
  const now  = new Date();
  const year = now.getFullYear();
  try {
    const d = new Date(`${dateStr} ${year}`);
    if (isNaN(d.getTime())) return null;
    if ((now - d) > 30 * 86_400_000) return new Date(`${dateStr} ${year + 1}`);
    return d;
  } catch (_) {
    return null;
  }
}

// ── Individual checks ─────────────────────────────────────────────────────────

/** Check 1: Position size concentration */
function checkPositionSize(idea, portfolioRows, totalGBP) {
  const existing    = portfolioRows.find(r => r.ticker === idea.ticker);
  const existingPct = existing && totalGBP > 0 ? pctOf(existing.valGBP ?? 0, totalGBP) : 0;
  // LONG: adds on top of existing weight. SHORT: sizePct is standalone allocation.
  const proposedPct = idea.direction === "LONG"
    ? existingPct + (idea.sizePct ?? 0)
    : (idea.sizePct ?? 0);

  const status = threshold(proposedPct, SIZE_WARN, SIZE_BLOCK);
  return {
    name:   "Position Size",
    status,
    detail: `Proposed weight: ${proposedPct.toFixed(1)}% (existing ${existingPct.toFixed(1)}% + new ${idea.sizePct ?? 0}%). Warn ≥${SIZE_WARN}%, Block ≥${SIZE_BLOCK}%.`,
  };
}

/** Check 2: HHI concentration post-trade */
function checkHHI(idea, portfolioRows, totalGBP) {
  const addedGBP = totalGBP > 0 ? totalGBP * ((idea.sizePct ?? 0) / 100) : 0;
  const newTotal = totalGBP + addedGBP;

  // Map current GBP values and bump the target ticker
  const vals = {};
  for (const r of portfolioRows) vals[r.ticker] = (r.valGBP ?? 0);
  vals[idea.ticker] = (vals[idea.ticker] ?? 0) + addedGBP;

  const newHHI = Math.round(
    Object.values(vals).reduce((sum, v) => {
      const w = newTotal > 0 ? v / newTotal : 0;
      return sum + w * w;
    }, 0) * 10_000
  );

  const status = threshold(newHHI, HHI_WARN, HHI_BLOCK);
  return {
    name:   "Concentration (HHI)",
    status,
    detail: `Post-trade HHI: ${newHHI.toLocaleString()}. Warn >2,000; Block >2,800. Lower = more diversified.`,
  };
}

/** Check 3: USD FX exposure post-trade */
function checkFxExposure(idea, portfolioRows, totalGBP) {
  const addedGBP    = totalGBP > 0 ? totalGBP * ((idea.sizePct ?? 0) / 100) : 0;
  const newTotal    = totalGBP + addedGBP;
  const ideaUsdFrac = (seeds.CCY_EXP[idea.ticker]?.USD ?? 0) / 100;

  let currentUsdGBP = 0;
  for (const r of portfolioRows) {
    const usdFrac = (seeds.CCY_EXP[r.ticker]?.USD ?? 0) / 100;
    currentUsdGBP += (r.valGBP ?? 0) * usdFrac;
  }

  const newUsdGBP = currentUsdGBP + addedGBP * ideaUsdFrac;
  const newUsdPct = newTotal > 0 ? pctOf(newUsdGBP, newTotal) : 0;
  const status    = threshold(newUsdPct, USD_WARN, USD_BLOCK);

  return {
    name:   "USD FX Exposure",
    status,
    detail: `Post-trade USD exposure: ${newUsdPct.toFixed(1)}% of portfolio. ${idea.ticker} is ${(ideaUsdFrac * 100).toFixed(0)}% USD-denominated. Warn >${USD_WARN}%; Block >${USD_BLOCK}%.`,
  };
}

/** Check 4: R-ratio (reward-to-risk) */
function checkRRatio(idea) {
  const { entry, stop, target } = idea;
  if (!entry || !stop || !target) {
    return {
      name:   "R-Ratio",
      status: "WARN",
      detail: "Entry, stop, or target missing — cannot compute reward-to-risk ratio.",
    };
  }
  const risk = Math.abs(entry - stop);
  if (risk === 0) {
    return {
      name:   "R-Ratio",
      status: "BLOCK",
      detail: "Stop equals entry — zero risk defined; trade is invalid.",
    };
  }
  const reward = Math.abs(target - entry);
  const r      = reward / risk;
  const status = threshold(r, R_WARN, R_BLOCK, false); // lower is bad

  return {
    name:   "R-Ratio",
    status,
    detail: `R = ${r.toFixed(2)}× (reward ${reward.toFixed(2)} / risk ${risk.toFixed(2)}). Warn <${R_WARN}×; Block <${R_BLOCK}×.`,
  };
}

/** Check 5: Material events within the idea horizon */
function checkEventRisk(idea, calendar) {
  // No calendar is not the same as no events. It used to read a year-less seed
  // list that recurred every spring; now an absent calendar is a WARN that says
  // exactly that, so the check cannot silently pass on missing data.
  if (!calendar || !calendar.available) {
    return {
      name:   "Event Risk",
      status: "WARN",
      detail: `Event calendar unavailable — cannot rule out scheduled events within ${idea.horizon}. ${calendar?.reason || ""}`.trim(),
    };
  }
  const horizonDays = horizonToDays(idea.horizon);
  const now         = Date.now();
  const cutoff      = new Date(now + horizonDays * 86_400_000);
  const hits        = [];

  for (const ev of calendar.events) {
    const d = ev.at instanceof Date ? ev.at : new Date(ev.date);
    if (Number.isNaN(d.getTime()) || d < new Date(now - 86_400_000) || d > cutoff) continue;
    if (ev.ticker === idea.ticker || ev.importance === "HIGH") {
      hits.push(`${ev.date}: ${ev.event} (${ev.ticker}, ${ev.importance}${ev.kind === "demo" ? ", DEMO" : ""})`);
    }
  }

  const status = hits.length > 0 ? "WARN" : "OK";
  return {
    name:   "Event Risk",
    status,
    detail: hits.length > 0
      ? `${hits.length} event(s) within ${idea.horizon}: ${hits.slice(0, 3).join(" | ")} [calendar: ${calendar.source}]`
      : `No material events within ${idea.horizon} horizon [calendar: ${calendar.source}].`,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Run all pre-trade risk checks for a given idea.
 *
 * @param {object}   idea           Trade idea (ticker, direction, sizePct, entry, stop, target, horizon)
 * @param {object[]} portfolioRows  Current portfolio rows — each needs { ticker, valGBP }
 * @param {number}   totalGBP       Current portfolio total GBP value
 * @param {number}   usdgbp         Current USD/GBP rate
 * @returns {{ pass: boolean, level: "OK"|"WARN"|"BLOCK", checks: Array }}
 */
/**
 * @param {object} [opts.calendar]  from analytics/eventCalendar.getCalendar();
 *   defaults to the live cached calendar.
 */
function runPreTradeCheck(idea, portfolioRows = [], totalGBP = 0, usdgbp = null, opts = {}) {
  const calendar = opts.calendar !== undefined ? opts.calendar : require("./eventCalendar").getCalendar();
  const checks = [
    checkPositionSize(idea, portfolioRows, totalGBP),
    checkHHI(idea, portfolioRows, totalGBP),
    checkFxExposure(idea, portfolioRows, totalGBP),
    checkRRatio(idea),
    checkEventRisk(idea, calendar),
  ];

  const hasBlock = checks.some(c => c.status === "BLOCK");
  const hasWarn  = checks.some(c => c.status === "WARN");
  const level    = hasBlock ? "BLOCK" : hasWarn ? "WARN" : "OK";

  return { pass: !hasBlock, level, checks };
}

module.exports = { runPreTradeCheck, horizonToDays, parseEventDate };
