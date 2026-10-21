/**
 * server/markets/calendar.js - the economic calendar (D-31). Free FRED data, no AI, no typed-in dates (D-02).
 *
 * What it knows: the dates FRED lists for a few data releases (CPI, the jobs report, PCE, GDP) and for the
 * FOMC press release IF FRED carries one. Each release is found by its NAME in FRED's release list at run
 * time, so nothing here is a remembered id or date; a release FRED does not have is reported as missing,
 * never filled in. For the SOONEST date of each event it adds the previous reading (real FRED figures, with
 * their period). It does not know release times or consensus forecasts - FRED has neither - and says nothing
 * about them.
 *
 * Refreshed with every Markets refresh (jobs/refreshMarkets.js) and stored in data/economic_calendar.json, so
 * a page load never fetches (D-09). A failed refresh keeps the last good copy and getCalendar() flags it stale.
 */
"use strict";

const fs   = require("fs");
const path = require("path");
const { FRED_HELPERS } = require("./sources");
const views = require("./views");

const { fredReleases, fredUpcomingReleaseDates, fredObservations, applyTransform } = FRED_HELPERS;

const DATA_PATH = process.env.CALENDAR_PATH || path.join(__dirname, "../../data/economic_calendar.json");
const PERSIST   = process.env.NODE_ENV !== "test" || Boolean(process.env.CALENDAR_PATH);
const STALE_AFTER_MS = 3 * 24 * 3600 * 1000;      // a copy older than this is shown, flagged stale
const KEEP_DAYS      = 120;                       // how far ahead a refresh stores dates

/**
 * The events. `match` is tested against FRED's own release names; `readings` are ids from views.MACRO whose latest
 * value is shown as the previous reading. FOMC is the one FRED may not carry - it is still listed so its absence is
 * said out loud on screen.
 */
const EVENTS = [
  { key: "cpi",  label: "CPI (consumer prices)",                         match: /^Consumer Price Index$/i,        readings: ["cpi", "corecpi"] },
  { key: "jobs", label: "Jobs report (payrolls, unemployment)",          match: /^Employment Situation$/i,        readings: ["payrolls", "unrate"] },
  { key: "pce",  label: "PCE inflation (Personal Income and Outlays)",   match: /^Personal Income and Outlays$/i, readings: ["pce"] },
  { key: "gdp",  label: "GDP",                                           match: /^Gross Domestic Product$/i,      readings: ["gdp"] },
  { key: "fomc", label: "FOMC decision",                                 match: /^FOMC Press Release$/i,          readings: [] },
];

let current = null;        // { version, generatedAt, source, events, missing }
let lastError = null;      // why the latest refresh did not produce a calendar (memory only)

// ── dates ─────────────────────────────────────────────────────────────────────
const londonDate = (now) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(now);   // YYYY-MM-DD
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── persistence ───────────────────────────────────────────────────────────────
function load() {
  if (current) return current;
  if (!PERSIST) return null;
  try { current = JSON.parse(fs.readFileSync(DATA_PATH, "utf8")); } catch { current = null; }
  return current;
}
function save(cal) {
  current = cal;
  if (!PERSIST) return;
  try {
    fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
    const tmp = DATA_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cal, null, 2));
    fs.renameSync(tmp, DATA_PATH);
  } catch (err) {
    console.warn("[calendar] could not persist:", err.message);
  }
}

// ── previous readings ─────────────────────────────────────────────────────────
function fmtReading(def, v) {
  const n = v.toFixed(def.decimals);
  return def.unit === "%" ? `${n}%` : def.unit === "k" ? `${n}k` : n;
}

/** The latest published reading for each id, as { label, value, text, period, sourceUrl }. A reading that cannot be fetched is left out. */
async function previousReadings(ids) {
  const out = [];
  for (const id of ids) {
    const def = views.MACRO.find(m => m.id === id);
    if (!def) continue;
    try {
      const raw = await fredObservations(def.series, { sort: "desc", limit: def.transform === "yoy" ? 26 : def.transform === "diff" ? 3 : 5 });
      const last = applyTransform(raw, def).slice(-1)[0];
      if (!last) continue;
      const period = views.periodLabel(last.date, def.freq);
      out.push({
        label: def.label, value: Number(last.v.toFixed(def.decimals + 2)), period,
        text: `${def.label} ${fmtReading(def, last.v)} (${period})`,
        sourceUrl: `https://fred.stlouisfed.org/series/${def.series}`,
      });
    } catch { /* this reading is omitted; the event stays */ }
  }
  return out;
}

// ── refresh ───────────────────────────────────────────────────────────────────
/**
 * Fetch the calendar from FRED and store it. Never throws: on failure it returns { ok: false, reason } and keeps
 * the previous copy. Needs FRED_API_KEY (already required by Markets).
 */
async function refresh({ now = new Date() } = {}) {
  if (!process.env.FRED_API_KEY) { lastError = "FRED_API_KEY is not set"; return { ok: false, reason: lastError }; }

  let releases;
  try { releases = await fredReleases(); }
  catch (err) { lastError = `could not read FRED's release list (${err.message})`; return { ok: false, reason: lastError }; }

  const from = londonDate(now), until = addDays(from, KEEP_DAYS);
  const events = [], missing = [];

  for (const def of EVENTS) {
    const rel = releases.find(r => def.match.test(String(r.name).trim()));
    if (!rel) { missing.push({ key: def.key, label: def.label, reason: "FRED has no release with this name" }); continue; }
    let dates;
    try { dates = (await fredUpcomingReleaseDates(rel.id, from)).filter(d => d <= until); }
    catch (err) { missing.push({ key: def.key, label: def.label, reason: `FRED date lookup failed (${err.message})` }); continue; }
    if (!dates.length) { missing.push({ key: def.key, label: def.label, reason: "FRED lists no upcoming date for it yet" }); continue; }

    // The previous reading is only true of the NEXT release; later dates will follow newer data, so they carry none.
    const previous = def.readings.length ? await previousReadings(def.readings) : [];
    dates.forEach((date, i) => events.push({
      key: def.key, date, event: def.label, release: rel.name,
      previous: i === 0 ? previous : [],
      source: "FRED", sourceUrl: rel.link || `https://fred.stlouisfed.org/release?rid=${rel.id}`,
    }));
  }

  if (!events.length) {
    lastError = "FRED returned no upcoming dates for any event";
    return { ok: false, reason: lastError };
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
  lastError = null;
  save({ version: 1, generatedAt: now.toISOString(), source: "FRED", events, missing });
  return { ok: true, events: events.length, missing: missing.map(m => m.key) };
}

// ── read ──────────────────────────────────────────────────────────────────────
/**
 * The stored calendar, trimmed to today (London) onward and `daysAhead` days. Never fetches.
 * -> { available:false, reason } | { available:true, source, generatedAt, stale, events[], missing[] }
 */
function getCalendar({ daysAhead = 45, now = new Date() } = {}) {
  const cal = load();
  if (!cal || !Array.isArray(cal.events)) {
    return { available: false, reason: lastError
      ? `Economic calendar unavailable - ${lastError}.`
      : "Economic calendar unavailable - not fetched yet; it loads with the next Markets refresh (07:45 / 14:45 London, or the Refresh button)." };
  }
  const today = londonDate(now), last = addDays(today, daysAhead);
  return {
    available: true, source: cal.source, generatedAt: cal.generatedAt,
    stale: now.getTime() - Date.parse(cal.generatedAt) > STALE_AFTER_MS,
    events: cal.events.filter(e => e.date >= today && e.date <= last),
    missing: cal.missing || [],
  };
}

function _reset() { current = null; lastError = null; }

module.exports = { refresh, getCalendar, EVENTS, londonDate, _reset, DATA_PATH };
