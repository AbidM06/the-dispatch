/**
 * server/markets/views.js - the yield-curve snapshot and the macro series views (D-28, PR 3 of 4).
 *
 * Free FRED data only; no AI. Nothing is invented: every plotted value is a FRED observation (or an
 * arithmetic transform of two, labelled), each curve states the date it is actually from, and a missing
 * maturity or an unavailable release calendar is named rather than filled.
 *
 *   getYieldCurve()           US Treasury constant-maturity curve: latest date + 1 week / 1 month / 1 year earlier
 *   getMacroSeries(id, range) inflation / labour / growth / policy series, each print paired with the date it was
 *                             published (FRED release calendar)
 */
"use strict";

const { FRED_HELPERS } = require("./sources");
const { fredObservations, fredSeriesInfo, fredReleaseDates, applyTransform } = FRED_HELPERS;

const HOUR = 3_600_000;
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await fn();
  cache.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const r4 = (n) => Math.round(n * 10_000) / 10_000;
const iso = (d) => d.toISOString().slice(0, 10);
const ymd = (s) => new Date(s + "T00:00:00Z");

// ── Yield curve ──────────────────────────────────────────────────────────────
// [label, FRED series, years to maturity]
const CURVE = [
  ["1M", "DGS1MO", 1 / 12], ["3M", "DGS3MO", 0.25], ["6M", "DGS6MO", 0.5], ["1Y", "DGS1", 1], ["2Y", "DGS2", 2], ["3Y", "DGS3", 3],
  ["5Y", "DGS5", 5], ["7Y", "DGS7", 7], ["10Y", "DGS10", 10], ["20Y", "DGS20", 20], ["30Y", "DGS30", 30],
].map(([label, series, years]) => ({ label, series, years }));

function monthsBefore(dateStr, n) { const d = ymd(dateStr); d.setUTCMonth(d.getUTCMonth() - n); return iso(d); }
function daysBefore(dateStr, n) { return iso(new Date(ymd(dateStr).getTime() - n * 86_400_000)); }

/** Latest date on or before `target` on which EVERY maturity has a value (looks back at most 7 days: weekends, holidays). */
function curveDateOnOrBefore(target, byDate, mats) {
  const floor = daysBefore(target, 7);
  const dates = [...byDate.keys()].filter(d => d <= target && d >= floor).sort().reverse();
  return dates.find(d => mats.every(m => byDate.get(d).has(m.series))) || null;
}

async function buildYieldCurve(now = new Date()) {
  const start = new Date(now); start.setUTCMonth(start.getUTCMonth() - 13);
  const settled = await Promise.allSettled(CURVE.map(m => fredObservations(m.series, { start: iso(start) })));
  const mats = [], missing = [];
  const byDate = new Map();                                   // date -> Map(series -> value)
  settled.forEach((r, i) => {
    const m = CURVE[i];
    if (r.status !== "fulfilled" || !r.value.length) {
      missing.push({ label: m.label, series: m.series, reason: r.status === "rejected" ? r.reason.message : "no observations" });
      return;
    }
    mats.push(m);
    for (const o of r.value) { if (!byDate.has(o.date)) byDate.set(o.date, new Map()); byDate.get(o.date).set(m.series, o.v); }
  });
  if (mats.length < 4) {
    throw httpError(502, `Yield curve unavailable - FRED returned too few maturities (${missing.map(x => x.label).join(", ") || "none"} failed).`);
  }

  const latest = curveDateOnOrBefore(iso(now), new Map([...byDate].filter(([d]) => d >= daysBefore(iso(now), 40))), mats);
  if (!latest) throw httpError(502, "Yield curve unavailable - no recent date has a value for every maturity.");

  const targets = [["today", "Latest", latest], ["1w", "1 week earlier", daysBefore(latest, 7)],
                   ["1m", "1 month earlier", monthsBefore(latest, 1)], ["1y", "1 year earlier", monthsBefore(latest, 12)]];
  const curves = [], notes = [];
  for (const [key, label, target] of targets) {
    const date = key === "today" ? latest : curveDateOnOrBefore(target, byDate, mats);
    if (!date) { notes.push(`No complete curve found for ${label.toLowerCase()} (around ${target}), so that line is left out.`); continue; }
    curves.push({ key, label, date, points: mats.map(m => ({ maturity: m.label, years: r4(m.years), v: byDate.get(date).get(m.series) })) });
  }

  // Standard spreads, computed from the same observations (and labelled as computed).
  const val = (c, label) => { const p = c.points.find(x => x.maturity === label); return p ? p.v : null; };
  const spreadDefs = [["2s10s", "10Y - 2Y", "10Y", "2Y"], ["3m10y", "10Y - 3M", "10Y", "3M"], ["5s30s", "30Y - 5Y", "30Y", "5Y"]];
  const spreads = spreadDefs.map(([key, label, hi, lo]) => ({
    key, label,
    computed: `${hi} - ${lo}, computed from FRED ${CURVE.find(m => m.label === hi).series} and ${CURVE.find(m => m.label === lo).series}`,
    values: Object.fromEntries(curves.map(c => [c.key, val(c, hi) != null && val(c, lo) != null ? Math.round((val(c, hi) - val(c, lo)) * 100) : null])),   // basis points
  })).filter(s => Object.values(s.values).some(v => v != null));

  const ageDays = Math.floor((now - ymd(latest)) / 86_400_000);
  return {
    generatedAt: now.toISOString(), source: "FRED", latestDate: latest, unit: "%",
    maturities: mats.map(m => ({ label: m.label, years: r4(m.years), series: m.series, sourceUrl: `https://fred.stlouisfed.org/series/${m.series}` })),
    missing, curves, spreads, notes,
    stale: ageDays > 5,
    note: "US Treasury constant-maturity yields (FRED, from the Federal Reserve H.15). Each line is the curve on the date shown; spreads are computed from the same observations, in basis points.",
  };
}
function getYieldCurve() { return cached("curve", HOUR, () => buildYieldCurve()); }

// ── Macro series ─────────────────────────────────────────────────────────────
// freq: M monthly, Q quarterly, D daily. transform: yoy / diff (see sources.applyTransform).
const MACRO = [
  { id: "cpi",      group: "inflation", label: "CPI inflation (YoY)",                    series: "CPIAUCSL",        transform: "yoy",  unit: "%", decimals: 1, freq: "M", style: "line" },
  { id: "corecpi",  group: "inflation", label: "Core CPI inflation (YoY)",               series: "CPILFESL",        transform: "yoy",  unit: "%", decimals: 1, freq: "M", style: "line" },
  { id: "pce",      group: "inflation", label: "PCE inflation (YoY)",                    series: "PCEPI",           transform: "yoy",  unit: "%", decimals: 1, freq: "M", style: "line" },
  { id: "unrate",   group: "labour",    label: "Unemployment rate",                      series: "UNRATE",                           unit: "%", decimals: 1, freq: "M", style: "line" },
  { id: "payrolls", group: "labour",    label: "Non-farm payrolls (monthly change, thousands)", series: "PAYEMS",   transform: "diff", unit: "k", decimals: 0, freq: "M", style: "bars" },
  { id: "gdp",      group: "growth",    label: "Real GDP growth (annualised, quarter on quarter)", series: "A191RL1Q225SBEA",       unit: "%", decimals: 1, freq: "Q", style: "bars" },
  { id: "fedfunds", group: "policy",    label: "Effective fed funds rate",               series: "DFF",                              unit: "%", decimals: 2, freq: "D", style: "line" },
];
const MACRO_GROUPS = [{ id: "inflation", label: "Inflation" }, { id: "labour", label: "Labour" }, { id: "growth", label: "Growth" }, { id: "policy", label: "Policy rate" }];
const RANGES = { "1y": 1, "5y": 5, "10y": 10 };

/** Last calendar day of the period an observation refers to (FRED dates monthly/quarterly data at the period START). */
function periodEnd(dateStr, freq) {
  const d = ymd(dateStr);
  const months = freq === "Q" ? 3 : 1;
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 0)));
}
function periodLabel(dateStr, freq) {
  const d = ymd(dateStr);
  return freq === "Q" ? `${d.getUTCFullYear()} Q${Math.floor(d.getUTCMonth() / 3) + 1}` : dateStr.slice(0, 7);
}
/**
 * The date each observation was published, taken as the first FRED release date AFTER its period ended.
 * This is an inference from the release calendar (FRED does not attach a publication date to each point here),
 * and the response says so. `null` when no later release date is known.
 */
function pairReleaseDates(obs, releaseDates, freq) {
  return obs.map(o => {
    const end = periodEnd(o.date, freq);
    return { ...o, published: releaseDates.find(d => d > end) || null };
  });
}

async function buildMacro(def, range, now = new Date()) {
  const years = RANGES[range];
  const start = new Date(now);
  start.setUTCFullYear(start.getUTCFullYear() - years - (def.transform === "yoy" ? 1 : 0));
  start.setUTCMonth(start.getUTCMonth() - (def.transform === "diff" ? 1 : 0));
  const [raw, info, rel] = await Promise.all([
    fredObservations(def.series, { start: iso(start) }),
    fredSeriesInfo(def.series).catch(() => ({})),
    def.freq === "D" ? Promise.resolve(null) : fredReleaseDates(def.series).catch(e => ({ error: e.message })),
  ]);
  const cutoff = new Date(now); cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
  const obs = applyTransform(raw, def).filter(o => o.date >= iso(cutoff));
  if (!obs.length) throw httpError(404, `No ${def.label} observations in the last ${years === 1 ? "year" : years + " years"}.`);

  const hasDates = rel && !rel.error;
  const paired = hasDates ? pairReleaseDates(obs, rel.dates, def.freq) : obs.map(o => ({ ...o, published: null }));
  const dec = def.decimals;
  const prints = paired.slice(-12).reverse().map(o => ({
    period: periodLabel(o.date, def.freq), date: o.date, value: Number(o.v.toFixed(dec + 2)), published: o.published,
  }));
  const last = paired[paired.length - 1], prev = paired.length > 1 ? paired[paired.length - 2] : null;
  return {
    id: def.id, group: def.group, label: def.label, unit: def.unit, decimals: dec, freq: def.freq, style: def.style, range,
    source: "FRED", sourceUrl: `https://fred.stlouisfed.org/series/${def.series}`, series: def.series, seriesTitle: info.title || null,
    points: paired.map(o => (o.published ? { t: Math.floor(ymd(o.date).getTime() / 1000), v: r4(o.v), published: o.published } : { t: Math.floor(ymd(o.date).getTime() / 1000), v: r4(o.v) })),
    latest: { date: last.date, period: periodLabel(last.date, def.freq), value: r4(last.v), published: last.published },
    previous: prev ? { date: prev.date, period: periodLabel(prev.date, def.freq), value: r4(prev.v) } : null,
    release: def.freq === "D" ? null : hasDates
      ? { name: rel.name, link: rel.link, available: true }
      : { available: false, reason: rel ? rel.error : "not requested" },
    prints,
    note: def.freq === "D"
      ? "Daily series: there are no discrete release dates, each point is that day's value."
      : hasDates
        ? `"Published" is the first FRED release date after the period ended (release: ${rel.name}). It is inferred from the release calendar, and later revisions to a figure are not tracked here.`
        : `Release dates are unavailable right now (${rel ? rel.error : "n/a"}); the series is shown without them.`,
    generatedAt: now.toISOString(),
  };
}
function listMacro() {
  return {
    groups: MACRO_GROUPS,
    series: MACRO.map(({ id, group, label, unit, decimals, freq, style }) => ({ id, group, label, unit, decimals, freq, style })),
    ranges: Object.keys(RANGES),
  };
}
function getMacroSeries(id, range = "5y") {
  const def = MACRO.find(m => m.id === id);
  if (!def) throw httpError(404, `Unknown macro series: ${id}`);
  if (!RANGES[range]) throw httpError(400, `Range must be one of ${Object.keys(RANGES).join(", ")}`);
  return cached(`macro:${id}:${range}`, HOUR, () => buildMacro(def, range));
}
function _reset() { cache.clear(); }

module.exports = {
  getYieldCurve, buildYieldCurve, getMacroSeries, buildMacro, listMacro, pairReleaseDates, periodEnd, periodLabel, CURVE, MACRO, _reset,
};
