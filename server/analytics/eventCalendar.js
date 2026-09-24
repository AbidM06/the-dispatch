/**
 * server/analytics/eventCalendar.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Scheduled-event calendar for the risk checks, the brief and the news tab.
 *
 * It used to be two hand-typed lists in seeds/fallback.js with dates like
 * "19 Mar" and NO YEAR. parseEventDate() filled in the current year, so the
 * same March 2026 calendar re-fired every spring forever — which is why a
 * pre-trade event check passed in March and failed the rest of the year. A
 * third list in news.js ("Dates sourced from Fed Reserve, BLS, and BEA") put
 * FOMC meetings on 19 Mar, 7 May, 18 Jun, 30 Jul and 17 Sep 2026 — dates that appear to
 * follow the Fed's 2025 meeting pattern rather than its 2026 one. None of it
 * could be verified from this environment, so none of it is served as current.
 *
 * Now: events come from Finnhub responses the news route has cached, each
 * with a full date. If there are none, the calendar is UNAVAILABLE and callers
 * must say so — "no events found" and "we have no calendar" are different.
 * The hand-typed lists are demo-only.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const cache = require("../cache");
const seeds = require("../../seeds/fallback");
const { isDemoMode } = require("../demoMode");

const HIGH_IMPACT = /fomc|fed |federal funds|interest rate decision|cpi|consumer price|payroll|nfp|pce|gdp/i;

function fullDate(d) {
  if (!d) return null;
  const s = String(d);
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;   // no year → not usable
  const t = new Date(s.length === 10 ? `${s}T00:00:00Z` : s);
  return Number.isNaN(t.getTime()) ? null : t;
}

/** Demo fixtures carry "19 Mar"-style dates; pin them to the seed's year. */
function demoEvents() {
  const year = new Date(seeds.SEED_DATE).getUTCFullYear();
  return [...(seeds.EARNINGS_CAL || []), ...(seeds.MACRO_CAL || [])]
    .map(ev => {
      if (!ev.date || /TBC/.test(ev.date)) return null;
      const d = new Date(`${ev.date} ${year} UTC`);
      if (Number.isNaN(d.getTime())) return null;
      return { date: d.toISOString().slice(0, 10), at: d, event: ev.event, ticker: ev.ticker, importance: ev.importance, kind: "demo" };
    })
    .filter(Boolean);
}

/**
 * getCalendar — { available, events, source, reason }.
 * `events` entries: { date: "YYYY-MM-DD", at: Date, event, ticker, importance, kind }
 */
function getCalendar() {
  const econ     = cache.getWithMeta("news:economic-calendar")?.value || [];
  const earnings = cache.getWithMeta("news:earnings-calendar")?.value || [];
  const events = [];

  for (const e of econ) {
    const at = fullDate(e.date);
    if (!at) continue;
    events.push({ date: at.toISOString().slice(0, 10), at, event: e.event, ticker: e.country || "MACRO",
                  importance: HIGH_IMPACT.test(e.event || "") || /high/i.test(e.impact || "") ? "HIGH" : "MED",
                  kind: "observed", source: "Finnhub" });
  }
  for (const e of earnings) {
    const at = fullDate(e.date);
    if (!at) continue;
    events.push({ date: at.toISOString().slice(0, 10), at, event: "Earnings", ticker: e.ticker,
                  importance: "MED", kind: "observed", source: "Finnhub" });
  }

  if (events.length) {
    return { available: true, events, source: "Finnhub (cached)", reason: null };
  }
  if (isDemoMode()) {
    return { available: true, events: demoEvents(), source: "demo", reason: "DEMO_MODE calendar — hand-entered, March 2026." };
  }
  return {
    available: false,
    events: [],
    source: "unavailable",
    reason: "No event calendar loaded (Finnhub calendar not fetched, or its economic endpoint is premium-only). Scheduled events cannot be ruled out.",
  };
}

module.exports = { getCalendar, fullDate };
