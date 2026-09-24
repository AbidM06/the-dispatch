/**
 * server/provenance.js
 * ─────────────────────────────────────────────────────────────────────────────
 * One vocabulary for "what do we know, when did we know it, and how".
 *
 * Every number the app shows falls into exactly one KIND:
 *
 *   observed     — a value a provider published for a stated observation date
 *   calculated   — arithmetic on observed inputs; carries those inputs' refs
 *   estimate     — a model's forecast or an assumption; never a measurement
 *   unavailable  — we do not have it; `reason` says why
 *   demo         — hand-entered demonstration data, only served in DEMO_MODE
 *
 * Two clocks are kept apart on purpose:
 *
 *   observedAt   — when the MARKET produced the figure (FRED observation date,
 *                  bar date, provider's own timestamp). This decides freshness.
 *   retrievedAt  — when WE fetched it. This decides nothing about freshness.
 *
 * Conflating them is how a Friday close fetched on Monday, or a six-month-old
 * value re-cached a second ago, used to read as current.
 *
 * Precision is never invented: a provider that supplies a date gets
 * `observedAtPrecision: "date"`, not a midnight timestamp that looks exact.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const KIND = Object.freeze({
  OBSERVED:    "observed",
  CALCULATED:  "calculated",
  ESTIMATE:    "estimate",
  UNAVAILABLE: "unavailable",
  DEMO:        "demo",
});

/**
 * Freshness profiles by publication pattern. Lags are in BUSINESS days
 * (weekends skipped; exchange/Fed holidays are NOT modelled, so a holiday can
 * push a series from "current" into "lagging" — never into "stale" on its own,
 * because staleAfter leaves two days of slack).
 *
 *   expectedLagBd — how far behind "today" the newest observation normally is
 *                   when the provider is working as designed
 *   staleAfterBd  — beyond this, something is wrong (provider stall, dropped
 *                   series, stale cache) rather than normal publication lag
 */
const PROFILES = Object.freeze({
  // FRED H.15 rates, ICE BofA OAS, DFF, VIX: next-business-day publication.
  "fred-daily":        { frequency: "daily",  expectedLagBd: 1, staleAfterBd: 3,  executable: false },
  // FRED spot oil (EIA-sourced) and H.10 FX publish in weekly batches of daily
  // observations, so a week of lag is normal, not a failure.
  "fred-daily-weekly-release": { frequency: "daily (weekly release)", expectedLagBd: 6, staleAfterBd: 9, executable: false },
  // End-of-day equity bars (Polygon /v2/aggs free tier, AV GLOBAL_QUOTE).
  // A daily close is a settled historical price, not an executable quote.
  "eod-bar":           { frequency: "daily close", expectedLagBd: 1, staleAfterBd: 3,  executable: false },
  // Keyless ExchangeRate-API: provider publishes roughly once per day.
  "fx-daily-ref":      { frequency: "daily reference rate", expectedLagBd: 1, staleAfterBd: 3, executable: false },
  // EIA weekly petroleum series.
  "eia-weekly":        { frequency: "weekly", expectedLagBd: 8, staleAfterBd: 13, executable: false },
});

const FREQUENCY_NOTE = "Freshness counts business days only; public holidays are not modelled.";

function isoNow(now = new Date()) { return new Date(now).toISOString(); }

/** "2026-09-18" or "2026-09-18T20:00:00Z" → Date at UTC midnight of that day. */
function toUtcDay(d) {
  if (!d) return null;
  const s = String(d);
  const day = /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
  const parsed = day ? new Date(`${day}T00:00:00Z`) : new Date(s);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

/**
 * businessDaysBetween — weekdays strictly after `from` up to and including `to`.
 * Friday → Monday is 1. Same day is 0. Negative if `from` is in the future.
 */
function businessDaysBetween(from, to) {
  const a = toUtcDay(from);
  const b = toUtcDay(to);
  if (!a || !b) return null;
  if (a > b) return -businessDaysBetween(to, from);
  let count = 0;
  const cur = new Date(a);
  while (cur < b) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

/**
 * assessFreshness — classify an observation date against its profile.
 *
 * status:
 *   current      — as recent as this source ever is
 *   lagging      — older than usual but inside normal publication slack
 *                  (e.g. a holiday); shown, not treated as a failure
 *   stale        — older than the source should ever be when working
 *   unknown      — no observation date supplied
 *   demo         — demonstration data; freshness does not apply
 *   unavailable  — no value
 */
function assessFreshness({ observedAt, profile, kind }, now = new Date()) {
  if (kind === KIND.DEMO) {
    return { status: "demo", note: "Demonstration data — not a market observation." };
  }
  if (kind === KIND.UNAVAILABLE) {
    return { status: "unavailable", note: "No value." };
  }
  const p = PROFILES[profile];
  if (!observedAt) {
    return { status: "unknown", note: "Provider supplied no observation date." };
  }
  if (!p) {
    return { status: "unknown", note: `No freshness profile for "${profile}".` };
  }
  const ageBd = businessDaysBetween(observedAt, now);
  if (ageBd == null) return { status: "unknown", note: `Unparseable observation date "${observedAt}".` };

  let status;
  if (ageBd <= p.expectedLagBd)      status = "current";
  else if (ageBd <= p.staleAfterBd)  status = "lagging";
  else                               status = "stale";

  const lagText = p.expectedLagBd === 1 ? "1 business day" : `${p.expectedLagBd} business days`;
  const note =
    status === "current" ? `Within this source's normal ${lagText} publication lag.` :
    status === "lagging" ? `Older than the usual ${lagText} lag but inside normal slack (holiday or late release). ${FREQUENCY_NOTE}` :
                           `Older than this source should be (${ageBd} business days; stale after ${p.staleAfterBd}). Provider or cache problem, not normal lag.`;

  return {
    status,
    ageBusinessDays:         ageBd,
    expectedLagBusinessDays: p.expectedLagBd,
    staleAfterBusinessDays:  p.staleAfterBd,
    note,
  };
}

/**
 * makeFact — the single constructor for an observed or calculated value.
 * `date` is kept as an alias of the observation day for older callers.
 */
function makeFact({
  key, label, value, unit, source, seriesId,
  observedAt, observedAtPrecision, retrievedAt,
  profile, kind = KIND.OBSERVED, inputs, method, note,
}, now = new Date()) {
  const p = PROFILES[profile];
  const fact = {
    key,
    label,
    value,
    unit,
    kind,
    source,
    seriesId,
    observedAt:          observedAt ?? null,
    observedAtPrecision: observedAt ? (observedAtPrecision || (String(observedAt).length <= 10 ? "date" : "timestamp")) : null,
    retrievedAt:         retrievedAt ?? null,
    frequency:           p ? p.frequency : null,
    executable:          p ? p.executable : false,
    profile,
    date:                observedAt ? String(observedAt).slice(0, 10) : null,
  };
  if (inputs)  fact.inputs = inputs;
  if (method)  fact.method = method;
  if (note)    fact.note   = note;
  fact.freshness = assessFreshness({ observedAt, profile, kind }, now);
  return fact;
}

/** An explicit "we do not have this", never a zero or a remembered value. */
function unavailable(key, reason, extra = {}) {
  return {
    key,
    value: null,
    kind: KIND.UNAVAILABLE,
    reason,
    observedAt: null,
    date: null,
    freshness: { status: "unavailable", note: reason },
    ...extra,
  };
}

/** Wrap demonstration data so it can never be mistaken for a measurement. */
function demo(value, { label, reason = "DEMO_MODE fixture" } = {}) {
  return {
    value,
    kind: KIND.DEMO,
    label,
    reason,
    freshness: { status: "demo", note: "Demonstration data — not a market observation." },
  };
}

/** Input reference for calculated facts: which series, which date. */
function inputRef(fact) {
  if (!fact) return null;
  return { seriesId: fact.seriesId ?? fact.key ?? null, observedAt: fact.observedAt ?? fact.date ?? fact.asOf ?? null, source: fact.source ?? null };
}

/**
 * summariseComponents — roll per-component provenance up WITHOUT hiding the
 * weakest link. The overall view reports the OLDEST observation, not the
 * newest: a page whose FX is from today and whose rates are from last week is
 * a last-week page for anything that combines them.
 */
function summariseComponents(components, now = new Date()) {
  const list = Object.entries(components).map(([name, c]) => ({ name, ...c }));
  const observed = list.filter(c => c.observedAt);
  const byObs = [...observed].sort((a, b) => String(a.observedAt).localeCompare(String(b.observedAt)));
  const retrieved = list.filter(c => c.retrievedAt).sort((a, b) => String(a.retrievedAt).localeCompare(String(b.retrievedAt)));
  const obsDays = new Set(observed.map(c => String(c.observedAt).slice(0, 10)));

  const statuses = list.map(c => c.freshness?.status || c.status || "unknown");
  const worst =
    statuses.includes("unavailable") ? "partial" :
    statuses.includes("stale")       ? "stale"   :
    statuses.includes("demo")        ? "demo"    :
    statuses.includes("unknown")     ? "unknown" :
    statuses.includes("lagging")     ? "lagging" : "current";

  return {
    status: worst,
    oldestObservation:  byObs[0]                 ? { component: byObs[0].name, observedAt: byObs[0].observedAt } : null,
    newestObservation:  byObs[byObs.length - 1]  ? { component: byObs[byObs.length - 1].name, observedAt: byObs[byObs.length - 1].observedAt } : null,
    oldestRetrieval:    retrieved[0]             ? { component: retrieved[0].name, retrievedAt: retrieved[0].retrievedAt } : null,
    mixedObservationDates: obsDays.size > 1,
    unavailable: list.filter(c => (c.freshness?.status || c.status) === "unavailable").map(c => c.name),
    stale:       list.filter(c => (c.freshness?.status || c.status) === "stale").map(c => c.name),
    demo:        list.filter(c => (c.freshness?.status || c.status) === "demo").map(c => c.name),
    evaluatedAt: isoNow(now),
    note: FREQUENCY_NOTE,
  };
}

module.exports = {
  KIND,
  PROFILES,
  makeFact,
  unavailable,
  demo,
  inputRef,
  assessFreshness,
  businessDaysBetween,
  summariseComponents,
};
