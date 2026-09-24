/**
 * server/providers/macroContext.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Cross-asset macro context — the single fact source every research report reads.
 *
 * WHY THIS EXISTS
 * Report types used to fetch their own context: commodities got oil, macro got a
 * rates history, and equity got five spot rates and nothing else. That silo meant
 * an equity report could not see an oil shock or a change in the policy path, so
 * it could not reason about the two channels that matter most to equities:
 *   energy costs → input costs → margins
 *   real yields / policy path → discount rate → multiples
 *
 * Every series here is free (FRED). Fetching them costs no API budget and removes
 * the need for the model to web_search for numbers we can source deterministically.
 *
 * PROVENANCE
 * Every value is returned as a Fact carrying its own `source` and `asOf`. Callers
 * render those verbatim. A number without a Fact wrapper did not come from here.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const fred  = require("./fred");
const cache = require("../cache");
const { makeFact, inputRef, summariseComponents, assessFreshness, KIND } = require("../provenance");

const CACHE_KEY = "macro:context";
const TTL_60M   = 60 * 60 * 1000;

/**
 * Series catalogue. `group` drives prompt ordering; `fmt` renders the display
 * string. All are daily FRED series, but they do not publish on one schedule:
 * rates, OAS, DFF and VIX arrive next business day; spot oil and EUR/USD (H.10)
 * arrive in weekly batches. The freshness profile comes from fred.SERIES_META.
 *
 * HY OAS is stored in FRED's unit (percent). `fmt` shows both percent and bp so
 * no reader has to guess which one a bare "3.17" is.
 */
const SERIES = [
  // Rates & credit
  { key: "dgs10",   id: "DGS10",        label: "10Y UST Nominal",     group: "rates",     unit: "%",     fmt: v => `${v.toFixed(2)}%` },
  { key: "dfii10",  id: "DFII10",       label: "10Y UST Real (TIPS)", group: "rates",     unit: "%",     fmt: v => `${v.toFixed(2)}%` },
  { key: "t10yie",  id: "T10YIE",       label: "10Y Breakeven Infl.", group: "rates",     unit: "%",     fmt: v => `${v.toFixed(2)}%` },
  { key: "t10y2y",  id: "T10Y2Y",       label: "Curve 10Y-2Y",        group: "rates",     unit: "%",     fmt: v => `${v.toFixed(2)}%` },
  { key: "dgs2",    id: "DGS2",         label: "2Y UST",              group: "rates",     unit: "%",     fmt: v => `${v.toFixed(2)}%` },
  { key: "dff",     id: "DFF",          label: "Effective Fed Funds", group: "rates",     unit: "%",     fmt: v => `${v.toFixed(2)}%` },
  { key: "hySpread",id: "BAMLH0A0HYM2", label: "US HY OAS",           group: "credit",    unit: "%",     fmt: v => `${v.toFixed(2)}% (${Math.round(v * 100)}bp)` },
  // Energy — the channel the equity report was blind to
  { key: "brent",   id: "DCOILBRENTEU", label: "Brent Crude",         group: "commodity", unit: "$/bbl", fmt: v => `$${v.toFixed(2)}/bbl` },
  { key: "wti",     id: "DCOILWTICO",   label: "WTI Crude",           group: "commodity", unit: "$/bbl", fmt: v => `$${v.toFixed(2)}/bbl` },
  // Risk & FX
  { key: "vix",     id: "VIXCLS",       label: "VIX",                 group: "risk",      unit: "idx",   fmt: v => v.toFixed(2) },
  { key: "eurusd",  id: "DEXUSEU",      label: "EUR/USD",             group: "fx",        unit: "",      fmt: v => v.toFixed(4) },
];

/**
 * buildFact — wrap a FRED observation with its provenance.
 * `asOf` is the observation date, NOT the fetch time: a Friday close served on
 * Monday must read Friday, or the report will overstate how current it is.
 * `retrievedAt` is kept separately and never used to judge freshness.
 */
function buildFact(spec, obs, now = new Date()) {
  const base = makeFact({
    key:         spec.key,
    label:       spec.label,
    value:       obs.value,
    unit:        obs.unit || spec.unit,
    source:      "FRED",
    seriesId:    spec.id,
    observedAt:  obs.observedAt || obs.date,
    observedAtPrecision: "date",
    retrievedAt: obs.retrievedAt || null,
    profile:     obs.profile || (fred.SERIES_META[spec.id] || {}).profile,
    kind:        KIND.OBSERVED,
  }, now);
  return {
    ...base,
    group:     spec.group,
    formatted: spec.fmt(obs.value),
    asOf:      base.observedAt,
  };
}

/**
 * derivePolicyPath — a labelled PROXY for the market-implied policy direction.
 *
 * There is no free, documented API for CME FedWatch probabilities, so we do not
 * claim one. The 2Y UST embeds the market's average expected policy rate over the
 * next two years; the spread of that over the current effective funds rate is the
 * standard crude read on direction. It is a direction and a magnitude, not a
 * probability, and every field here says so.
 *
 * Thresholds are in percentage points. ±25bp is roughly one hike/cut priced
 * across the horizon — inside that band the signal is noise.
 */
function derivePolicyPath(facts) {
  const dgs2 = facts.dgs2;
  const dff  = facts.dff;
  if (!dgs2 || !dff) return null;

  const gapPp = dgs2.value - dff.value;
  const gapBp = Math.round(gapPp * 100);

  let direction, reading;
  if (gapPp > 0.25) {
    direction = "TIGHTENING BIAS";
    reading   = `The 2Y UST sits ${gapBp}bp above the effective funds rate, so the curve embeds a higher average policy rate ahead than today's setting. That is consistent with the market leaning toward tightening, or toward a longer hold at an elevated rate.`;
  } else if (gapPp < -0.25) {
    direction = "EASING BIAS";
    reading   = `The 2Y UST sits ${Math.abs(gapBp)}bp below the effective funds rate, so the curve embeds a lower average policy rate ahead than today's setting. That is consistent with the market pricing cuts over the next two years.`;
  } else {
    direction = "NEUTRAL / HOLD";
    reading   = `The 2Y UST is within ${Math.abs(gapBp)}bp of the effective funds rate. The curve embeds roughly the current policy setting over the next two years — no material directional bias.`;
  }

  // Both inputs keep their own dates. DFF and DGS2 usually share a date, but
  // when they do not the gap mixes two days' data and the reader must see that.
  const inputs = [inputRef(dgs2), inputRef(dff)];
  const mixedDates = dgs2.asOf !== dff.asOf;

  return {
    direction,
    reading,
    gapBp,
    kind:        KIND.CALCULATED,
    method:      "2Y UST minus effective fed funds rate (DGS2 − DFF)",
    neutralBandBp: 25,
    source:      "DERIVED",
    basis:       "FRED DGS2, DFF",
    inputs,
    mixedDates,
    // The older of the two dates: a calculation is only as current as its
    // oldest input.
    asOf:        [dgs2.asOf, dff.asOf].sort()[0],
    isProxy:     true,
    caveat:      "Derived proxy for policy DIRECTION only. This is not a market-implied probability and is not CME FedWatch data. It cannot price the odds of a specific move at a specific meeting.",
    limitations: [
      "Horizon mismatch: the 2Y yield averages expected policy over roughly two years; DFF is today's overnight rate. The gap says nothing about the next meeting.",
      "Not OIS pricing: the 2Y Treasury yield also carries a term premium and Treasury supply/demand effects, so a gap can move with no change in policy expectations.",
      "Direction only: the ±25bp neutral band is a heuristic, not a statistical threshold.",
    ],
  };
}

/**
 * getMacroContext — fetch every cross-asset fact in parallel.
 *
 * Per-series failures are tolerated: a missing VIX should not cost you the oil
 * price. Missing keys are simply absent from `facts`, and `missing` names them so
 * a caller can tell "not fetched" apart from "fetched as zero".
 *
 * @returns {{ facts, policyPath, missing, fetchedAt, sources }}
 */
async function getMacroContext({ force = false } = {}) {
  if (!force) {
    const hit = cache.getWithMeta(CACHE_KEY);
    if (hit && !hit.stale) return reassess(hit.value);
  }

  const settled = await Promise.allSettled(
    SERIES.map(s => fred.getLatestObservation(s.id))
  );

  const facts   = {};
  const missing = [];

  settled.forEach((res, i) => {
    const spec = SERIES[i];
    if (res.status === "fulfilled" && Number.isFinite(res.value?.value)) {
      facts[spec.key] = buildFact(spec, res.value);
    } else {
      missing.push(spec.id);
      console.warn(`[macroContext] ${spec.id} unavailable:`, res.reason?.message || "no value");
    }
  });

  const ctx = {
    facts,
    policyPath: derivePolicyPath(facts),
    missing,
    // When this context was assembled. It says nothing about how current the
    // figures are — each fact's own observedAt and freshness do that.
    fetchedAt:  new Date().toISOString(),
    freshness:  summariseComponents(facts),
    sources:    ["FRED"],
  };

  // Cache even a partial result — a report with 9 of 11 facts beats no report,
  // and `missing` keeps the gap visible rather than silent.
  if (Object.keys(facts).length > 0) cache.set(CACHE_KEY, ctx, TTL_60M);
  return ctx;
}

/**
 * reassess — recompute freshness at READ time. A context cached on Friday and
 * served on Tuesday must not carry Friday's "current" verdict; the observation
 * dates are unchanged, so only the verdict moves.
 */
function reassess(ctx, now = new Date()) {
  if (!ctx || !ctx.facts) return ctx;
  const facts = {};
  for (const [k, f] of Object.entries(ctx.facts)) {
    facts[k] = { ...f, freshness: assessFreshness({ observedAt: f.observedAt || f.asOf, profile: f.profile, kind: f.kind }, now) };
  }
  return { ...ctx, facts, freshness: summariseComponents(facts, now) };
}

/**
 * toPromptBlock — render the context as the fact table the model must anchor to.
 *
 * The framing is deliberate. Numbers arrive pre-sourced and the model is told not
 * to search for them, which does two things at once: it removes the chance of a
 * fabricated spot price, and it cuts web_search calls (and therefore cost).
 */
function toPromptBlock(ctx) {
  if (!ctx || !ctx.facts || Object.keys(ctx.facts).length === 0) {
    return "VERIFIED MARKET DATA: unavailable this run — no live figures were fetched. Do not substitute remembered values. State that current levels could not be verified.";
  }

  const order = ["rates", "credit", "commodity", "risk", "fx"];
  const lines = [];

  for (const group of order) {
    const inGroup = Object.values(ctx.facts).filter(f => f.group === group);
    if (!inGroup.length) continue;
    lines.push(inGroup.map(f => {
      const fresh = f.freshness?.status && f.freshness.status !== "current" ? `, ${f.freshness.status.toUpperCase()}` : "";
      return `  ${f.label}: ${f.formatted} [${f.source} ${f.seriesId}, observation date ${f.asOf}${fresh}]`;
    }).join("\n"));
  }

  const oldest = ctx.freshness?.oldestObservation?.observedAt;
  const newest = ctx.freshness?.newestObservation?.observedAt;
  const dateSpan = oldest && newest && oldest !== newest
    ? `Observation dates range from ${oldest} to ${newest}; do not describe these as a single same-day snapshot.\n`
    : "";

  let block =
    "VERIFIED MARKET DATA — fetched server-side from FRED. These are the latest AVAILABLE observations, each with its own observation date. They are end-of-day figures, not intraday prices.\n" +
    "Use these exact figures and quote their dates when you cite them. Do NOT web_search for them and do NOT substitute values you remember.\n" +
    dateSpan + "\n" +
    lines.join("\n");

  if (ctx.policyPath) {
    block +=
      `\n\nPOLICY PATH (DERIVED PROXY — NOT market-implied probability):\n` +
      `  Direction: ${ctx.policyPath.direction} (${ctx.policyPath.gapBp >= 0 ? "+" : ""}${ctx.policyPath.gapBp}bp)\n` +
      `  Method: ${ctx.policyPath.method}\n` +
      `  ${ctx.policyPath.reading}\n` +
      `  CAVEAT: ${ctx.policyPath.caveat}\n` +
      (ctx.policyPath.limitations || []).map(l => `  LIMITATION: ${l}\n`).join("") +
      `  If you cite this, call it a derived proxy. Never present it as FedWatch or as a probability.`;
  }

  if (ctx.missing.length) {
    block += `\n\nUNAVAILABLE THIS RUN: ${ctx.missing.join(", ")}. Do not invent these — say they could not be verified.`;
  }

  return block;
}

/**
 * toMarketDataRows — the provenance table the client renders above every report.
 * Server-fetched only: each row is a provider observation with its own date and
 * freshness status. "Fetched from FRED" establishes the source, not that the
 * value is today's.
 */
function toMarketDataRows(ctx) {
  if (!ctx || !ctx.facts) return [];
  const order = ["commodity", "rates", "credit", "risk", "fx"];
  return Object.values(ctx.facts)
    .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group))
    .map(f => ({
      label:       f.label,
      value:       f.formatted,
      source:      f.source,
      detail:      f.seriesId,
      asOf:        f.asOf,
      kind:        f.kind,
      freshness:   f.freshness?.status || "unknown",
      retrievedAt: f.retrievedAt || null,
    }));
}

/**
 * observationSpan — how current the report's inputs are, as data:
 * the oldest and newest observation dates, the retrieval time, and the
 * overall freshness status. Regenerating a report changes retrievedAt only.
 */
function observationSpan(ctx) {
  if (!ctx) return null;
  const fr = ctx.freshness || summariseComponents(ctx.facts || {});
  return {
    oldestObservation: fr.oldestObservation?.observedAt ?? null,
    newestObservation: fr.newestObservation?.observedAt ?? null,
    mixedDates:        Boolean(fr.mixedObservationDates),
    status:            fr.status,
    retrievedAt:       ctx.fetchedAt ?? null,
    note:              "Observation dates are when FRED measured the figures. Retrieval time is when this app fetched them; regenerating a report does not make the observations newer.",
  };
}

module.exports = { observationSpan, getMacroContext, toPromptBlock, toMarketDataRows, derivePolicyPath, reassess, buildFact, SERIES };
