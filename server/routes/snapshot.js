/**
 * server/routes/snapshot.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GET  /api/snapshot         — full market snapshot (cached)
 * POST /api/snapshot/prefetch — bust market cache + re-fetch (for scheduled job)
 *
 * Assembles the full market snapshot:
 *   - FRED rates (DGS10, DFII10, T10YIE, BAMLH0A0HYM2, T10Y2Y)
 *   - Alpha Vantage FX rate (USD/GBP)          ← 1 AV call
 *   - Alpha Vantage quote for AMD              ← 1 AV call  (was 7 calls)
 *   - Polygon.io quotes for NVDA/MSFT/TSLA/MU/AMAT/LRCX ← 1 Polygon call
 *   - International watchlist (seeded)
 *   - Chart history (FRED) for rates, HY spread, RSI
 *
 * Provider split:
 *   AV (Alpha Vantage)  → AMD quote + USD/GBP FX  = 2 calls/refresh  (was 8)
 *   Polygon.io free     → 6 peer quotes in 1 call = 0 AV budget impact
 *
 * Cache strategy (TTLs from env or defaults):
 *   FRED data     — 60 min  (only updates once daily)
 *   Market data   — 30 min  (generous; daily prefetch keeps things fresh)
 *
 * Degradation — and why seeds are no longer part of it:
 *   If a live fetch fails, the last value we actually fetched is served with
 *   its ORIGINAL observation date and retrieval time. If there is none, the
 *   component is explicitly unavailable. Hand-entered fixtures from
 *   seeds/fallback.js are served only when DEMO_MODE=true, tagged kind:"demo".
 *
 * Two clocks, never merged:
 *   observedAt  — when the market produced the figure (decides freshness)
 *   retrievedAt — when we fetched it (decides nothing about freshness)
 * The envelope reports the OLDEST observation and the OLDEST retrieval, so one
 * fresh component can no longer make a page of old components read as current.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const { Router } = require("express");
const cache      = require("../cache");
const { fetchWithTimeout } = require("../retry");
const { getAllRates, getRecentHistory } = require("../providers/fred");
const { getQuotes, getFxRate: getAvFxRate } = require("../providers/alphaVantage");
const { getSnapshots, POLYGON_PEERS } = require("../providers/polygon");
const { schemas, validate }             = require("../schemas");
const seeds = require("../../seeds/fallback");
const requireWriteAuth = require("../middleware/auth");
const { makeFact, unavailable, summariseComponents, KIND } = require("../provenance");
const { isDemoMode, DEMO_BANNER } = require("../demoMode");

const router = Router();

// ── Cache keys ────────────────────────────────────────────────────────────────
// Every value under these keys came from a live provider call. Nothing seeded
// is ever written here, so a cache hit can never launder demo data into "live".
const KEYS = {
  rates:        "snapshot:rates",
  fx:           "snapshot:fx",
  watchlist:    "snapshot:watchlist",
  ratesHistory: "snapshot:ratesHistory",
  hyHistory:    "snapshot:hyHistory",
};

// ── TTLs ─────────────────────────────────────────────────────────────────────
const TTL_FRED   = (parseInt(process.env.CACHE_TTL_FRED,   10) || 60)  * 60_000;
const TTL_MARKET = (parseInt(process.env.CACHE_TTL_MARKET, 10) || 30)  * 60_000;

// ── Watchlist symbol split ────────────────────────────────────────────────────
// The symbol list and its labels are configuration, not market data, so they
// are still read from the seed file. Prices from that file are not.
const WATCHLIST_SYMBOLS = seeds.WATCHLIST_SEED.map(w => ({ sym: w.sym, note: w.note }));
const AV_SYMBOLS        = WATCHLIST_SYMBOLS.map(w => w.sym).filter(s => !POLYGON_PEERS.has(s));
const POLYGON_SYMBOLS   = WATCHLIST_SYMBOLS.map(w => w.sym).filter(s =>  POLYGON_PEERS.has(s));

const RATE_FIELDS = {
  dgs10:     { seriesId: "DGS10",        label: "10Y UST Nominal" },
  dfii10:    { seriesId: "DFII10",       label: "10Y UST Real (TIPS)" },
  t10yie:    { seriesId: "T10YIE",       label: "10Y Breakeven Inflation" },
  hy_spread: { seriesId: "BAMLH0A0HYM2", label: "US HY OAS" },
  t10y2y:    { seriesId: "T10Y2Y",       label: "Curve 10Y-2Y" },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function tryFresh(label, fn) {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[snapshot] ${label} live fetch failed:`, err.message);
    return null;
  }
}

/**
 * resolveWithFallback — warm cache, then live, then last-known, then demo or
 * unavailable. Never a seed outside DEMO_MODE.
 *
 * `retrievedAt` is when the value was actually fetched from the provider — on
 * a cache hit that is the ORIGINAL fetch, not now. `cacheExpired` means the
 * TTL lapsed and a refresh failed; the value is the last one we had.
 *
 * @returns {{ value, source: "live"|"cache"|"demo"|"unavailable",
 *             retrievedAt, fetchedAt, cacheExpired, stale, reason? }}
 */
async function resolveWithFallback(key, fetchFn, ttl, demoValue) {
  if (cache.has(key)) {
    const meta = cache.getWithMeta(key);
    return { value: meta.value, source: "cache", retrievedAt: meta.fetchedAt, fetchedAt: meta.fetchedAt, cacheExpired: false, stale: false };
  }

  const fresh = await tryFresh(key, fetchFn);
  if (fresh !== null) {
    cache.set(key, fresh, ttl);
    const retrievedAt = cache.getWithMeta(key).fetchedAt;
    return { value: fresh, source: "live", retrievedAt, fetchedAt: retrievedAt, cacheExpired: false, stale: false };
  }

  const last = cache.getWithMeta(key);
  if (last) {
    return { value: last.value, source: "cache", retrievedAt: last.fetchedAt, fetchedAt: last.fetchedAt, cacheExpired: true, stale: true,
             reason: "Live refresh failed; serving the last value actually fetched." };
  }

  if (isDemoMode() && demoValue !== undefined) {
    return { value: demoValue, source: "demo", retrievedAt: null, fetchedAt: null, cacheExpired: false, stale: true,
             reason: DEMO_BANNER };
  }

  return { value: null, source: "unavailable", retrievedAt: null, fetchedAt: null, cacheExpired: false, stale: true,
           reason: "Live fetch failed and no previously fetched value exists." };
}

/**
 * parseAvTimestamp — AV returns "2026-09-23 14:05:01" plus a separate zone.
 * Only a UTC zone is converted; anything else is kept verbatim rather than
 * guessed at.
 */
function parseAvTimestamp(raw, tz) {
  if (!raw) return { observedAt: null, precision: null };
  if (!tz || /^UTC$/i.test(tz)) {
    const iso = String(raw).trim().replace(" ", "T");
    const d = new Date(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
    if (!Number.isNaN(d.getTime())) {
      return { observedAt: d.toISOString(), precision: iso.length > 10 ? "timestamp" : "date" };
    }
  }
  return { observedAt: String(raw), precision: `provider-local (${tz})` };
}

/**
 * getLiveFxRate — keyless ExchangeRate-API first, AV fallback.
 *
 * The old version stamped `new Date()` into the observation field, so a rate
 * the provider last updated yesterday read as "now". The observation time is
 * the PROVIDER's `time_last_update_unix`; if it is absent we say so rather than
 * substitute our clock.
 */
async function getLiveFxRate(from, to) {
  try {
    const res = await fetchWithTimeout(`https://open.er-api.com/v6/latest/${from}`, {}, 8_000);
    if (res.ok) {
      const json = await res.json();
      const rate = json?.rates?.[to];
      if (rate) {
        const unix = Number(json.time_last_update_unix);
        return {
          fromCurrency:        from,
          toCurrency:          to,
          rate:                parseFloat(rate),
          observedAt:          Number.isFinite(unix) && unix > 0 ? new Date(unix * 1000).toISOString() : null,
          observedAtPrecision: Number.isFinite(unix) && unix > 0 ? "timestamp" : null,
          retrievedAt:         new Date().toISOString(),
          source:              "ExchangeRate-API",
        };
      }
    }
  } catch (err) {
    console.warn(`[snapshot] ExchangeRate-API FX failed (${err.message}) — falling back to AV`);
  }
  const av = await getAvFxRate(from, to);
  const ts = parseAvTimestamp(av.lastRefreshed, av.timeZone);
  return {
    fromCurrency:        av.fromCurrency,
    toCurrency:          av.toCurrency,
    rate:                av.rate,
    observedAt:          ts.observedAt,
    observedAtPrecision: ts.precision,
    retrievedAt:         new Date().toISOString(),
    source:              "Alpha Vantage",
  };
}

/**
 * fetchWatchlist — AV (AMD) + Polygon (peers). Each row is an END-OF-DAY bar
 * or daily quote: `date` is the trading day, and none of them is an
 * executable price.
 */
async function fetchWatchlist() {
  const [avQuotes, polyQuotes] = await Promise.all([
    getQuotes(AV_SYMBOLS).catch(() => []),
    getSnapshots(POLYGON_SYMBOLS).catch(() => []),
  ]);
  const retrievedAt = new Date().toISOString();
  const noteFor = sym => WATCHLIST_SYMBOLS.find(w => w.sym === sym)?.note || "";

  const unified = [];
  for (const q of avQuotes) {
    unified.push({ sym: q.sym, price: q.price, chg: q.chgPct, volume: q.volume, note: noteFor(q.sym),
                   source: q.source, date: q.latestTradingDay, retrievedAt });
  }
  for (const q of polyQuotes) {
    unified.push({ sym: q.sym, price: q.price, chg: q.chgPct, volume: q.volume, note: noteFor(q.sym),
                   source: q.source, date: q.date, retrievedAt });
  }

  if (!unified.length) throw new Error("All watchlist providers returned empty results");
  return unified;
}

// ── Fact builders (run on every READ, so freshness is judged now) ─────────────

function ratesToFacts(raw, resolved, now) {
  const out = {};
  for (const [field, spec] of Object.entries(RATE_FIELDS)) {
    const obs = raw?.[field];
    if (resolved.source === "demo" && obs) {
      out[field] = { ...obs, seriesId: spec.seriesId, label: spec.label, kind: KIND.DEMO,
                     freshness: { status: "demo", note: DEMO_BANNER } };
      continue;
    }
    if (!obs || !Number.isFinite(obs.value)) {
      out[field] = unavailable(field, resolved.reason || `${spec.seriesId} was not returned by FRED.`,
                               { seriesId: spec.seriesId, label: spec.label, source: "FRED" });
      continue;
    }
    out[field] = makeFact({
      key: field, label: spec.label, value: obs.value, unit: obs.unit || "percent",
      source: obs.source || "FRED", seriesId: obs.seriesId || spec.seriesId,
      observedAt: obs.observedAt || obs.date, observedAtPrecision: "date",
      retrievedAt: obs.retrievedAt || resolved.retrievedAt,
      profile: obs.profile || "fred-daily",
    }, now);
  }
  return out;
}

function fxToFact(raw, resolved, now) {
  if (resolved.source === "demo" && raw) {
    return { ...raw, kind: KIND.DEMO, freshness: { status: "demo", note: DEMO_BANNER } };
  }
  if (!raw || !Number.isFinite(raw.value)) {
    return unavailable("usdgbp", resolved.reason || "No USD/GBP rate.", { pair: "USDGBP", label: "USD/GBP" });
  }
  const fact = makeFact({
    key: "usdgbp", label: "USD/GBP", value: raw.value, unit: "GBP per USD",
    source: raw.source, seriesId: "USDGBP",
    observedAt: raw.observedAt, observedAtPrecision: raw.observedAtPrecision,
    retrievedAt: raw.retrievedAt || resolved.retrievedAt,
    profile: "fx-daily-ref",
  }, now);
  return { ...fact, pair: "USDGBP" };
}

function watchlistToFacts(raw, resolved, now) {
  if (resolved.source === "demo" && Array.isArray(raw)) {
    return raw.map(w => ({ ...w, kind: KIND.DEMO, executable: false, freshness: { status: "demo", note: DEMO_BANNER } }));
  }
  const bySym = new Map((raw || []).map(q => [q.sym, q]));
  return WATCHLIST_SYMBOLS.map(({ sym, note }) => {
    const q = bySym.get(sym);
    if (!q || !Number.isFinite(q.price)) {
      return { sym, note, price: null, chg: null, source: null, date: null, ...unavailable(sym, resolved.reason || `No quote returned for ${sym}.`), sym };
    }
    const f = makeFact({
      key: sym, label: sym, value: q.price, unit: "USD", source: q.source, seriesId: sym,
      observedAt: q.date, observedAtPrecision: "date",
      retrievedAt: q.retrievedAt || resolved.retrievedAt, profile: "eod-bar",
    }, now);
    return { ...f, sym, price: q.price, chg: Number.isFinite(q.chg) ? q.chg : null, volume: q.volume ?? null,
             note: q.note || note, priceType: "daily close / daily quote — not executable" };
  });
}

function historyComponent(points, resolved, now, profile, dateKey = "m") {
  if (resolved.source === "demo") return { kind: KIND.DEMO, freshness: { status: "demo", note: DEMO_BANNER }, retrievedAt: null };
  if (!Array.isArray(points) || !points.length) {
    return { kind: KIND.UNAVAILABLE, freshness: { status: "unavailable", note: resolved.reason || "No history." }, retrievedAt: null };
  }
  const last = points[points.length - 1][dateKey];
  return makeFact({ key: "history", value: points.length, unit: "observations", source: "FRED",
                    observedAt: last, retrievedAt: resolved.retrievedAt, profile }, now);
}

/** Components with no free feed at all: intl prices and AMD RSI history. */
function noFeedComponent(demoValue, what) {
  if (isDemoMode()) {
    return { value: demoValue, meta: { kind: KIND.DEMO, freshness: { status: "demo", note: DEMO_BANNER }, source: "demo" } };
  }
  return { value: [], meta: { kind: KIND.UNAVAILABLE, source: "unavailable",
    freshness: { status: "unavailable", note: `${what} — no free data feed is configured; the hand-entered values are demo-only.` } } };
}

function componentMeta(resolved, fact) {
  return {
    source:       resolved.source,
    kind:         fact?.kind ?? null,
    observedAt:   fact?.observedAt ?? null,
    retrievedAt:  resolved.retrievedAt ?? null,
    cacheExpired: resolved.cacheExpired,
    freshness:    fact?.freshness ?? { status: resolved.source === "unavailable" ? "unavailable" : "unknown" },
    reason:       resolved.reason,
  };
}

/** Sources for the whole snapshot, used by both GET and the combined cache. */
async function resolveAll() {
  return Promise.all([
    resolveWithFallback(KEYS.rates, async () => {
      // getAllRates tolerates per-series failures, so a total outage resolves
      // to an object of nulls. That is a failure, not a live fetch: caching it
      // would label nothing as "live" and block a retry for the full TTL.
      const r = await getAllRates();
      if (!r || !Object.values(r).some(o => Number.isFinite(o?.value))) throw new Error("FRED returned no values");
      return r;
    }, TTL_FRED, {
      dgs10: seeds.RATES_SEED.dgs10, dfii10: seeds.RATES_SEED.dfii10, t10yie: seeds.RATES_SEED.t10yie,
      hy_spread: seeds.RATES_SEED.hy_spread, t10y2y: seeds.RATES_SEED.t10y2y,
    }),
    resolveWithFallback(KEYS.fx, async () => {
      const r = await getLiveFxRate("USD", "GBP");
      return { value: r.rate, pair: "USDGBP", observedAt: r.observedAt, observedAtPrecision: r.observedAtPrecision,
               date: r.observedAt ? String(r.observedAt).slice(0, 10) : null, retrievedAt: r.retrievedAt, source: r.source };
    }, TTL_MARKET, seeds.FX_SEED.usdgbp),
    resolveWithFallback(KEYS.watchlist, fetchWatchlist, TTL_MARKET, seeds.WATCHLIST_SEED),
    resolveWithFallback(KEYS.ratesHistory, async () => {
      const [dgs10H, dfii10H, t10yieH] = await Promise.all([
        getRecentHistory("DGS10", 13), getRecentHistory("DFII10", 13), getRecentHistory("T10YIE", 13),
      ]);
      const rMap = Object.fromEntries(dfii10H.observations.map(o => [o.date, o.value]));
      const bMap = Object.fromEntries(t10yieH.observations.map(o => [o.date, o.value]));
      return dgs10H.observations.map(o => ({ m: o.date, y10: o.value, real: rMap[o.date] ?? null, bei: bMap[o.date] ?? null }))
        .filter(p => p.real !== null && p.bei !== null);
    }, TTL_FRED, seeds.RATES_HISTORY_SEED),
    resolveWithFallback(KEYS.hyHistory, async () => {
      const h = await getRecentHistory("BAMLH0A0HYM2", 13);
      return h.observations.map(o => ({ m: o.date, oas: o.value }));
    }, TTL_FRED, seeds.HY_HISTORY_SEED),
  ]);
}

/**
 * buildSnapshot — assemble facts and the provenance summary from resolved
 * components. Exported for tests.
 */
function buildSnapshot([ratesR, fxR, wlR, rhR, hyR], now = new Date()) {
  const rates     = ratesToFacts(ratesR.value, ratesR, now);
  const fx        = fxToFact(fxR.value, fxR, now);
  const watchlist = watchlistToFacts(wlR.value, wlR, now);
  const intl      = noFeedComponent(seeds.INTL_SEED, "International prices (KRX/TSE)");
  const rsi       = noFeedComponent(seeds.RSI_HISTORY_SEED, "AMD RSI(14) history");

  const components = {};
  for (const [field, fact] of Object.entries(rates)) components[`rates.${field}`] = componentMeta(ratesR, fact);
  components["fx.usdgbp"] = componentMeta(fxR, fx);
  for (const w of watchlist) components[`watchlist.${w.sym}`] = componentMeta(wlR, w);
  components.ratesHistory = componentMeta(rhR, historyComponent(rhR.value, rhR, now, "fred-daily"));
  components.hyHistory    = componentMeta(hyR, historyComponent(hyR.value, hyR, now, "fred-daily"));
  // Previously omitted from the summary entirely, so the envelope could say
  // "live" while two panels on the page were hand-typed.
  components.intl         = { ...intl.meta, retrievedAt: null, observedAt: null };
  components.rsiHistory   = { ...rsi.meta,  retrievedAt: null, observedAt: null };

  const freshness = summariseComponents(components, now);
  const sources   = Object.values(components).map(c => c.source);
  const overallSource =
    sources.includes("unavailable") ? (sources.every(s => s === "unavailable") ? "unavailable" : "partial") :
    sources.includes("demo")        ? "demo" :
    sources.includes("cache")       ? "cache" : "live";

  return {
    source:    overallSource,
    // The OLDEST retrieval, not the newest: the page is no fresher than its
    // least recently fetched component.
    fetchedAt: freshness.oldestRetrieval?.retrievedAt ?? null,
    stale:     !["current"].includes(freshness.status) || Object.values(components).some(c => c.cacheExpired),
    demoMode:  isDemoMode(),
    ...(isDemoMode() ? { demoBanner: DEMO_BANNER } : {}),
    freshness,
    components,
    data: {
      rates,
      fx:           { usdgbp: fx },
      watchlist,
      intl:         intl.value,
      ratesHistory: Array.isArray(rhR.value) ? rhR.value : [],
      hyHistory:    Array.isArray(hyR.value) ? hyR.value : [],
      rsiHistory:   rsi.value,
    },
  };
}

// ── GET /api/snapshot ─────────────────────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const resolved = await resolveAll();
    const payload  = buildSnapshot(resolved);

    // Combined snapshot for events/risk/narrative consumers. It carries the
    // facts WITH their provenance and the component summary — the old version
    // stored bare values, so a consumer could not tell live from last-known.
    // Demo data is never written here.
    if (!payload.demoMode) {
      cache.set("snapshot:data", {
        rates:     payload.data.rates,
        fx:        payload.data.fx.usdgbp,
        watchlist: payload.data.watchlist,
        meta:      { source: payload.source, freshness: payload.freshness, components: payload.components },
      }, Math.max(TTL_FRED, TTL_MARKET));
    }

    const { ok, data, errors } = validate(schemas.SnapshotResponse, payload);
    if (!ok) console.warn("[snapshot] Schema validation warnings:", errors);
    res.json(ok ? data : payload);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/snapshot/prefetch ───────────────────────────────────────────────
// Busts the market-data cache and re-fetches. Reports what was actually
// refreshed: a successful prefetch means we asked again, not that the
// underlying observations moved — FRED and daily bars may return the same
// dates they returned yesterday.
router.post("/prefetch", requireWriteAuth, async (req, res, next) => {
  try {
    const before = new Date().toISOString();
    console.log(`[snapshot/prefetch] Starting daily cache refresh at ${before}`);
    cache.delete(KEYS.fx);
    cache.delete(KEYS.watchlist);

    const [fxResult, watchlistResult] = await Promise.all([
      resolveWithFallback(KEYS.fx, async () => {
        const r = await getLiveFxRate("USD", "GBP");
        return { value: r.rate, pair: "USDGBP", observedAt: r.observedAt, observedAtPrecision: r.observedAtPrecision,
                 date: r.observedAt ? String(r.observedAt).slice(0, 10) : null, retrievedAt: r.retrievedAt, source: r.source };
      }, TTL_MARKET, undefined),
      resolveWithFallback(KEYS.watchlist, fetchWatchlist, TTL_MARKET, undefined),
    ]);

    const symbols = (watchlistResult.value || []).map(w => w.sym);
    console.log(`[snapshot/prefetch] Done — FX: ${fxResult.source}, watchlist: ${watchlistResult.source} (${symbols.join(",")})`);

    res.json({
      prefetched:  true,
      retrievedAt: new Date().toISOString(),
      fetchedAt:   new Date().toISOString(),
      note:        "Retrieval time only. Check each component's observedAt to see whether the market data itself changed.",
      fx:          { source: fxResult.source, value: fxResult.value?.value ?? null, observedAt: fxResult.value?.observedAt ?? null },
      watchlist:   { source: watchlistResult.source, symbols,
                     observedDates: (watchlistResult.value || []).map(w => ({ sym: w.sym, date: w.date })) },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports._internals = { resolveWithFallback, buildSnapshot, getLiveFxRate, parseAvTimestamp, KEYS };
