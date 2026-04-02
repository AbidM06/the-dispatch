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
 * Graceful degradation:
 *   If any live fetch fails, the cache (possibly stale) is used.
 *   If no cache exists, seed fallback data is used.
 *   The envelope reports `source` and `stale` so the UI can badge accordingly.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const { Router } = require("express");
const cache      = require("../cache");
const { getAllRates, getRecentHistory } = require("../providers/fred");
const { getQuotes, getFxRate }          = require("../providers/alphaVantage");
const { getSnapshots, POLYGON_PEERS }   = require("../providers/polygon");
const { schemas, validate }             = require("../schemas");
const seeds = require("../../seeds/fallback");
const requireWriteAuth = require("../middleware/auth");

const router = Router();

// ── Cache keys ────────────────────────────────────────────────────────────────
const KEYS = {
  rates:        "snapshot:rates",
  fx:           "snapshot:fx",
  watchlist:    "snapshot:watchlist",
  ratesHistory: "snapshot:ratesHistory",
  hyHistory:    "snapshot:hyHistory",
};

// ── TTLs ─────────────────────────────────────────────────────────────────────
const TTL_FRED   = (parseInt(process.env.CACHE_TTL_FRED,   10) || 60)  * 60_000;
// Default 30 min for market data — daily prefetch keeps it fresh, no need for 5 min
const TTL_MARKET = (parseInt(process.env.CACHE_TTL_MARKET, 10) || 30)  * 60_000;

// ── Watchlist symbol split ────────────────────────────────────────────────────
// AMD — still via Alpha Vantage (direct position, want AV's real-time quote)
const AV_SYMBOLS      = seeds.WATCHLIST_SEED.map(w => w.sym).filter(s => !POLYGON_PEERS.has(s));
// NVDA, MSFT, TSLA, MU, AMAT, LRCX — via Polygon.io (1 call, unlimited free)
const POLYGON_SYMBOLS = seeds.WATCHLIST_SEED.map(w => w.sym).filter(s =>  POLYGON_PEERS.has(s));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * tryFresh — attempt live fetch; return null + warn on any error.
 */
async function tryFresh(label, fn) {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[snapshot] ${label} live fetch failed:`, err.message);
    return null;
  }
}

/**
 * resolveWithFallback — cache-first, then live, then stale cache, then seed.
 * @param {string}   key      Cache key
 * @param {Function} fetchFn  Async function returning fresh data
 * @param {number}   ttl      Cache TTL in ms
 * @param {*}        seedData Fallback seed value
 * @returns {{ value, source, fetchedAt, stale }}
 */
async function resolveWithFallback(key, fetchFn, ttl, seedData) {
  // 1. Warm cache — serve immediately
  if (cache.has(key)) {
    const meta = cache.getWithMeta(key);
    return { value: meta.value, source: "cache", fetchedAt: meta.fetchedAt, stale: meta.stale };
  }

  // 2. Try live
  const fresh = await tryFresh(key, fetchFn);
  if (fresh !== null) {
    cache.set(key, fresh, ttl);
    return { value: fresh, source: "live", fetchedAt: new Date().toISOString(), stale: false };
  }

  // 3. Stale cache (expired but exists)
  const stale = cache.getWithMeta(key);
  if (stale) {
    return { value: stale.value, source: "cache", fetchedAt: stale.fetchedAt, stale: true };
  }

  // 4. Seed fallback
  return { value: seedData, source: "seeded", fetchedAt: seeds.SEED_DATE, stale: true };
}

/**
 * fetchWatchlist — merge AV (AMD) + Polygon (peers) into unified watchlist format.
 * AV symbols fetched sequentially (throttled by alphaVantage.js).
 * Polygon symbols fetched in one batched API call.
 * Any provider failure falls through to resolveWithFallback's stale/seed layers.
 */
async function fetchWatchlist() {
  const [avQuotes, polyQuotes] = await Promise.all([
    getQuotes(AV_SYMBOLS).catch(() => []),
    getSnapshots(POLYGON_SYMBOLS).catch(() => []),
  ]);

  const unified = [];

  // AV results (AMD) — format: { sym, price, chgPct, volume, latestTradingDay, source }
  for (const q of avQuotes) {
    unified.push({
      sym:    q.sym,
      price:  q.price,
      chg:    q.chgPct,
      note:   `Vol: ${(q.volume / 1_000_000).toFixed(1)}M`,
      source: q.source,
      date:   q.latestTradingDay,
    });
  }

  // Polygon results (peers) — format: { sym, price, chgPct, volume, source, date }
  for (const q of polyQuotes) {
    unified.push({
      sym:    q.sym,
      price:  q.price,
      chg:    q.chgPct,
      note:   `Vol: ${(q.volume / 1_000_000).toFixed(1)}M`,
      source: q.source,
      date:   q.date,
    });
  }

  // Guard: if both providers failed completely, throw so resolveWithFallback
  // drops to stale cache / seed instead of caching an empty array.
  if (!unified.length) {
    throw new Error("All watchlist providers returned empty results");
  }

  return unified;
}

// ── GET /api/snapshot ─────────────────────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const [
      ratesResult,
      fxResult,
      watchlistResult,
      ratesHistResult,
      hyHistResult,
    ] = await Promise.all([
      resolveWithFallback(
        KEYS.rates,
        () => getAllRates(),
        TTL_FRED,
        {
          dgs10:     seeds.RATES_SEED.dgs10,
          dfii10:    seeds.RATES_SEED.dfii10,
          t10yie:    seeds.RATES_SEED.t10yie,
          hy_spread: seeds.RATES_SEED.hy_spread,
          t10y2y:    seeds.RATES_SEED.t10y2y,
        }
      ),
      resolveWithFallback(
        KEYS.fx,
        async () => {
          const r = await getFxRate("USD", "GBP");
          return {
            value:  r.rate,
            pair:   "USDGBP",
            date:   r.lastRefreshed,
            source: r.source,
          };
        },
        TTL_MARKET,
        seeds.FX_SEED.usdgbp
      ),
      resolveWithFallback(
        KEYS.watchlist,
        fetchWatchlist,
        TTL_MARKET,
        seeds.WATCHLIST_SEED
      ),
      resolveWithFallback(
        KEYS.ratesHistory,
        async () => {
          const [dgs10H, dfii10H, t10yieH] = await Promise.all([
            getRecentHistory("DGS10",  13),
            getRecentHistory("DFII10", 13),
            getRecentHistory("T10YIE", 13),
          ]);
          const dMap = Object.fromEntries(dgs10H.observations.map(o  => [o.date, o.value]));
          const rMap = Object.fromEntries(dfii10H.observations.map(o => [o.date, o.value]));
          const bMap = Object.fromEntries(t10yieH.observations.map(o => [o.date, o.value]));
          const dates = dgs10H.observations.map(o => o.date);
          return dates.map(d => ({
            m:    d,
            y10:  dMap[d] ?? null,
            real: rMap[d] ?? null,
            bei:  bMap[d] ?? null,
          })).filter(p => p.y10 !== null && p.real !== null && p.bei !== null);
        },
        TTL_FRED,
        seeds.RATES_HISTORY_SEED
      ),
      resolveWithFallback(
        KEYS.hyHistory,
        async () => {
          const h = await getRecentHistory("BAMLH0A0HYM2", 13);
          return h.observations.map(o => ({ m: o.date, oas: o.value }));
        },
        TTL_FRED,
        seeds.HY_HISTORY_SEED
      ),
    ]);

    // ── Envelope ──────────────────────────────────────────────────────────────
    const sources = [ratesResult, fxResult, watchlistResult, ratesHistResult, hyHistResult];
    const anyStale   = sources.some(s => s.stale);
    const anySeeded  = sources.some(s => s.source === "seeded");
    const overallSource = anySeeded ? "seeded" : (anyStale ? "cache" : "live");
    const fetchedAts = sources.map(s => s.fetchedAt).filter(Boolean).sort();
    const fetchedAt  = fetchedAts[fetchedAts.length - 1] || new Date().toISOString();

    const payload = {
      source:    overallSource,
      fetchedAt,
      stale:     anyStale,
      data: {
        rates:        ratesResult.value,
        fx:           { usdgbp: fxResult.value },
        watchlist:    watchlistResult.value,
        intl:         seeds.INTL_SEED,
        ratesHistory: ratesHistResult.value,
        hyHistory:    hyHistResult.value,
        rsiHistory:   seeds.RSI_HISTORY_SEED,
      },
    };

    // Write combined snapshot:data for events/risk context lookups
    const combinedTtl = Math.max(TTL_FRED, TTL_MARKET);
    cache.set("snapshot:data", {
      rates:     ratesResult.value,
      fx:        fxResult.value,
      watchlist: watchlistResult.value,
    }, combinedTtl);

    const { ok, data, errors } = validate(schemas.SnapshotResponse, payload);
    if (!ok) console.warn("[snapshot] Schema validation warnings:", errors);
    res.json(ok ? data : payload);

  } catch (err) {
    next(err);
  }
});

// ── POST /api/snapshot/prefetch ───────────────────────────────────────────────
// Clears market-data cache entries and immediately re-fetches fresh prices.
// Called by the daily scheduled task (e.g. at 09:35 AM London time).
// Using this endpoint uses exactly 2 AV calls (AMD + FX) + 1 Polygon call.
router.post("/prefetch", requireWriteAuth, async (req, res, next) => {
  try {
    const before = new Date().toISOString();
    console.log(`[snapshot/prefetch] Starting daily cache refresh at ${before}`);

    // Bust the short-TTL market cache so resolveWithFallback goes live
    cache.delete(KEYS.fx);
    cache.delete(KEYS.watchlist);

    // Re-fetch FX and watchlist in parallel
    const [fxResult, watchlistResult] = await Promise.all([
      resolveWithFallback(
        KEYS.fx,
        async () => {
          const r = await getFxRate("USD", "GBP");
          return { value: r.rate, pair: "USDGBP", date: r.lastRefreshed, source: r.source };
        },
        TTL_MARKET,
        seeds.FX_SEED.usdgbp
      ),
      resolveWithFallback(
        KEYS.watchlist,
        fetchWatchlist,
        TTL_MARKET,
        seeds.WATCHLIST_SEED
      ),
    ]);

    const symbols = (watchlistResult.value || []).map(w => w.sym);
    console.log(`[snapshot/prefetch] Done — FX: ${fxResult.source}, watchlist: ${watchlistResult.source} (${symbols.join(",")})`);

    res.json({
      prefetched:   true,
      fetchedAt:    new Date().toISOString(),
      fx:           { source: fxResult.source,       value: fxResult.value?.value },
      watchlist:    { source: watchlistResult.source, symbols },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
