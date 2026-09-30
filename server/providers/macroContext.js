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

const CACHE_KEY = "macro:context";
const TTL_60M   = 60 * 60 * 1000;

/**
 * Series catalogue. `group` drives prompt ordering; `fmt` renders the display
 * string. Everything is a daily FRED series with a 1–2 business day lag.
 */
const SERIES = [
  // Rates & credit
  { key: "dgs10",   id: "DGS10",        label: "10Y UST Nominal",     group: "rates",     unit: "%",     fmt: v => `${v.toFixed(2)}%` },
  { key: "dfii10",  id: "DFII10",       label: "10Y UST Real (TIPS)", group: "rates",     unit: "%",     fmt: v => `${v.toFixed(2)}%` },
  { key: "t10yie",  id: "T10YIE",       label: "10Y Breakeven Infl.", group: "rates",     unit: "%",     fmt: v => `${v.toFixed(2)}%` },
  { key: "t10y2y",  id: "T10Y2Y",       label: "Curve 10Y-2Y",        group: "rates",     unit: "%",     fmt: v => `${v.toFixed(2)}%` },
  { key: "dgs2",    id: "DGS2",         label: "2Y UST",              group: "rates",     unit: "%",     fmt: v => `${v.toFixed(2)}%` },
  { key: "dff",     id: "DFF",          label: "Effective Fed Funds", group: "rates",     unit: "%",     fmt: v => `${v.toFixed(2)}%` },
  { key: "hySpread",id: "BAMLH0A0HYM2", label: "US HY OAS",           group: "credit",    unit: "%",     fmt: v => `${v.toFixed(2)}%` },
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
 */
function buildFact(spec, obs) {
  return {
    key:       spec.key,
    label:     spec.label,
    group:     spec.group,
    value:     obs.value,
    unit:      spec.unit,
    formatted: spec.fmt(obs.value),
    source:    "FRED",
    seriesId:  spec.id,
    url:       `https://fred.stlouisfed.org/series/${spec.id}`,
    asOf:      obs.date,
  };
}

// ── Freshness (D-20) ─────────────────────────────────────────────────────────
// FRED's daily oil series is published weekly, so its latest value can be a
// week old — a report once anchored on $114.89 Brent while the market traded
// ~$99. Two fixes: (1) where the Markets tab holds a NEWER live price for the
// same thing, use it (labelled with its own source and time); (2) any figure
// still more than STALE_AFTER_TRADING_DAYS old is flagged stale, and the model
// is told it is the last known value, not today's.
const STALE_AFTER_TRADING_DAYS = 2;
const MARKETS_EQUIVALENT = {          // fact key → Markets instrument id
  brent:  "BRENT",
  wti:    "WTI",
  dgs10:  "US10Y",
  eurusd: "EURUSD",
};
// Sanity bound per key: a Markets value further than this from FRED is a unit
// or symbol mismatch, not news — keep FRED rather than trust it.
const MAX_JUMP = { brent: 0.35, wti: 0.35, eurusd: 0.10 };   // relative
const MAX_JUMP_ABS = { dgs10: 1.5 };                         // percentage points

/** Weekdays strictly after `asOf` up to and including `now` (UTC). */
function tradingDaysSince(asOf, now = Date.now()) {
  const start = Date.parse(String(asOf).length === 10 ? asOf + "T00:00:00Z" : asOf);
  if (!Number.isFinite(start)) return null;
  let n = 0;
  const d = new Date(start); d.setUTCHours(0, 0, 0, 0);
  const end = new Date(now); end.setUTCHours(0, 0, 0, 0);
  while (d < end) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}

/**
 * withMarkets — overlay newer Markets prices and mark stale facts.
 * Pure: returns a new ctx; the cached FRED ctx is never mutated.
 */
function withMarkets(ctx, snapshot, now = Date.now()) {
  if (!ctx || !ctx.facts) return ctx;
  const items = new Map((snapshot?.items || []).filter(i => i.ok && !i.stale && i.quote).map(i => [i.id, i]));
  const facts = {};
  const overlaid = [];
  let missing = [...(ctx.missing || [])];
  // Markets-only facts too: a FRED series that failed this run can still be
  // supplied by a fresh Markets quote (and leaves the UNAVAILABLE list).
  const keys = [...new Set([...Object.keys(ctx.facts), ...Object.keys(MARKETS_EQUIVALENT)])];
  for (const key of keys) {
    const f = ctx.facts[key];
    const spec = SERIES.find(x => x.key === key);
    const it = items.get(MARKETS_EQUIVALENT[key]);
    const q = it?.quote;
    const usable = q && Number.isFinite(q.value) && Number.isFinite(Date.parse(q.asOf));
    let fact = f ? { ...f } : null;
    // With a FRED value: overlay only when newer and within the sanity bound.
    // Without one (FRED failed): nothing to compare against, so the fresh quote
    // is used as is — it is the same figure the Markets tab shows.
    const newer = usable && (!f || Date.parse(q.asOf) > Date.parse(f.asOf + (String(f.asOf).length === 10 ? "T23:59:59Z" : "")));
    const jump = newer && f && (MAX_JUMP_ABS[key] != null ? Math.abs(q.value - f.value) > MAX_JUMP_ABS[key]
                                                          : Math.abs(q.value - f.value) / Math.abs(f.value) > (MAX_JUMP[key] ?? 0.35));
    if (newer && !jump) {
      fact = { ...(f || { key, label: spec.label, group: spec.group, unit: spec.unit }),
               value: q.value, formatted: spec.fmt(q.value), source: q.source || "Markets",
               // seriesId stays unique per instrument (Brent and WTI can share a
               // venue label); the venue detail is kept separately for display.
               seriesId: it.id, sourceDetail: q.sourceDetail || it.label || null,
               url: q.sourceUrl || null, asOf: q.asOf,
               replaced: f ? { source: f.source, seriesId: f.seriesId, value: f.value, asOf: f.asOf } : null };
      if (!f) missing = missing.filter(id => id !== spec.id);
      overlaid.push(key);
    }
    if (!fact) continue;
    const age = tradingDaysSince(fact.asOf, now);
    fact.stale = age != null && age > STALE_AFTER_TRADING_DAYS;
    if (fact.stale) fact.ageTradingDays = age;
    facts[key] = fact;
  }
  // The policy proxy is derived from DGS2 and DFF. If either is stale, the
  // derived direction is as old as its inputs — say so, never present it as today's.
  let policyPath = ctx.policyPath || derivePolicyPath(facts);
  const ppStale = ["dgs2", "dff"].filter(k => facts[k]?.stale);
  if (policyPath && ppStale.length) {
    policyPath = { ...policyPath, stale: true,
      staleNote: `STALE: built from ${ppStale.map(k => facts[k].seriesId).join(" and ")}, more than ${STALE_AFTER_TRADING_DAYS} trading days old — this is the last known reading, not today's.` };
  }
  return { ...ctx, facts, missing, policyPath, overlaid, stale: Object.values(facts).filter(f => f.stale).map(f => f.key),
           marketsSnapshotAt: snapshot?.generatedAt || null,
           sources: overlaid.length ? [...new Set([...(ctx.sources || ["FRED"]), ...overlaid.map(k => facts[k].source)])] : ctx.sources };
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

  return {
    direction,
    reading,
    gapBp,
    method:      "2Y UST minus effective fed funds rate (DGS2 − DFF)",
    source:      "DERIVED",
    basis:       "FRED DGS2, DFF",
    asOf:        dgs2.asOf,
    isProxy:     true,
    caveat:      "Derived proxy for policy DIRECTION only. This is not a market-implied probability and is not CME FedWatch data. It cannot price the odds of a specific move at a specific meeting.",
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
  const fred = await getFredContext({ force });
  let snapshot = null;
  try { snapshot = require("../markets/service").getSnapshot(); } catch { /* no Markets snapshot */ }
  return withMarkets(fred, snapshot);
}

async function getFredContext({ force = false } = {}) {
  if (!force) {
    const hit = cache.getWithMeta(CACHE_KEY);
    if (hit && !hit.stale) return hit.value;
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
    fetchedAt:  new Date().toISOString(),
    sources:    ["FRED"],
  };

  // Cache even a partial result — a report with 9 of 11 facts beats no report,
  // and `missing` keeps the gap visible rather than silent.
  if (Object.keys(facts).length > 0) cache.set(CACHE_KEY, ctx, TTL_60M);
  return ctx;
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
    lines.push(inGroup.map(f => `  ${f.label}: ${f.formatted} [${f.source} ${f.seriesId}, as of ${f.asOf}]` +
      (f.stale ? ` — STALE (${f.ageTradingDays} trading days old): this is the last KNOWN value, not today's. web_search for the current level and state both, with dates.` : "")).join("\n"));
  }

  let block =
    `VERIFIED MARKET DATA — fetched server-side (FRED, plus live Markets prices where newer), today is ${new Date().toISOString().slice(0, 10)}.\n` +
    "Each figure carries its own source and as-of time. Use these exact figures for anything not marked STALE; do NOT web_search for those and do NOT substitute values you remember.\n" +
    "A figure marked STALE is old: never present it as the current level.\n\n" +
    lines.join("\n");

  if (ctx.policyPath) {
    block +=
      `\n\nPOLICY PATH (DERIVED PROXY — NOT market-implied probability):\n` +
      `  Direction: ${ctx.policyPath.direction} (${ctx.policyPath.gapBp >= 0 ? "+" : ""}${ctx.policyPath.gapBp}bp)\n` +
      (ctx.policyPath.stale ? `  ${ctx.policyPath.staleNote} Do not present this direction as current.\n` : "") +
      `  Method: ${ctx.policyPath.method}\n` +
      `  ${ctx.policyPath.reading}\n` +
      `  CAVEAT: ${ctx.policyPath.caveat}\n` +
      `  If you cite this, call it a derived proxy. Never present it as FedWatch or as a probability.`;
  }

  if (ctx.missing.length) {
    block += `\n\nUNAVAILABLE THIS RUN: ${ctx.missing.join(", ")}. Do not invent these — say they could not be verified.`;
  }

  return block;
}

/**
 * toMarketDataRows — the provenance table the client renders above every report.
 * Server-fetched only, so each row is a figure the reader can trust absolutely.
 */
function toMarketDataRows(ctx) {
  if (!ctx || !ctx.facts) return [];
  const order = ["commodity", "rates", "credit", "risk", "fx"];
  return Object.values(ctx.facts)
    .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group))
    .map(f => ({
      label:  f.label,
      value:  f.formatted,
      source: f.source,
      detail: f.sourceDetail || f.seriesId,
      asOf:   f.asOf,
      url:    f.url || null,
      stale:  Boolean(f.stale),
      replaced: f.replaced || null,
    }));
}

module.exports = { getMacroContext, toPromptBlock, toMarketDataRows, derivePolicyPath, SERIES,
  withMarkets, tradingDaysSince, STALE_AFTER_TRADING_DAYS, MARKETS_EQUIVALENT };
