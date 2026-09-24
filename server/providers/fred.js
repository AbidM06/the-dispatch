/**
 * server/providers/fred.js
 * ─────────────────────────────────────────────────────────────────────────────
 * FRED (Federal Reserve Bank of St. Louis) REST API adapter.
 * Docs:  https://fred.stlouisfed.org/docs/api/fred/
 * Key:   Free — register at fred.stlouisfed.org
 *
 * FRED data updates at most daily, so a 1-hour cache TTL is appropriate.
 * Series used by this app:
 *   DGS10          — 10Y Treasury Constant Maturity Rate
 *   DFII10         — 10Y TIPS / Real Yield
 *   T10YIE         — 10Y Breakeven Inflation Rate
 *   BAMLH0A0HYM2   — ICE BofA US HY Option-Adjusted Spread
 *   T10Y2Y         — 10Y minus 2Y yield curve spread
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { fetchWithTimeout, withRetry, isRetryable } = require("../retry");

const BASE_URL = "https://api.stlouisfed.org/fred";

/**
 * Per-series metadata we know from FRED's series pages. `unit` is FRED's own
 * unit, not a display unit: BAMLH0A0HYM2 is PERCENT (3.17 means 317bp), which
 * callers must convert explicitly if they want basis points.
 *
 * `profile` selects the freshness rule in server/provenance.js. Spot oil and
 * H.10 FX publish daily observations in weekly batches, so a week of lag there
 * is normal publication, not a provider failure.
 */
const SERIES_META = {
  DGS10:        { unit: "percent",     profile: "fred-daily" },
  DFII10:       { unit: "percent",     profile: "fred-daily" },
  T10YIE:       { unit: "percent",     profile: "fred-daily" },
  T10Y2Y:       { unit: "percent",     profile: "fred-daily" },
  DGS2:         { unit: "percent",     profile: "fred-daily" },
  DFF:          { unit: "percent",     profile: "fred-daily" },
  BAMLH0A0HYM2: { unit: "percent",     profile: "fred-daily" },
  VIXCLS:       { unit: "index",       profile: "fred-daily" },
  DCOILBRENTEU: { unit: "USD/bbl",     profile: "fred-daily-weekly-release" },
  DCOILWTICO:   { unit: "USD/bbl",     profile: "fred-daily-weekly-release" },
  DEXUSEU:      { unit: "USD per EUR", profile: "fred-daily-weekly-release" },
};

// How many recent rows to request so the newest VALID observation can be
// recovered. FRED marks holidays and not-yet-published days with ".", so
// asking for only the latest row (limit=1) returned "." and threw, and the
// caller lost a series that had a perfectly good observation one row back.
const LATEST_LOOKBACK_ROWS = 10;

function apiKey() {
  const k = process.env.FRED_API_KEY;
  if (!k) {
    throw new Error("FRED_API_KEY not set — add it to .env");
  }
  return k;
}

function seriesMeta(seriesId) {
  return SERIES_META[seriesId] || { unit: null, profile: null };
}

/**
 * getLatestObservation — the most recent VALID value for a FRED series.
 *
 * Returns a Fact-shaped object. `date` is the observation date FRED reports;
 * `retrievedAt` is when we asked. Nothing downstream should treat retrievedAt
 * as evidence that the figure is current.
 *
 * @param {string} seriesId  e.g. "DGS10"
 * @returns {{ seriesId, value, date, observedAt, observedAtPrecision, retrievedAt,
 *             unit, profile, kind, source, skippedMissing }}
 */
async function getLatestObservation(seriesId) {
  const url = new URL(`${BASE_URL}/series/observations`);
  url.searchParams.set("series_id",   seriesId);
  url.searchParams.set("api_key",     apiKey());
  url.searchParams.set("file_type",   "json");
  url.searchParams.set("sort_order",  "desc");
  url.searchParams.set("limit",       String(LATEST_LOOKBACK_ROWS));

  const json = await withRetry(
    async () => {
      const res = await fetchWithTimeout(url.toString(), {}, 12_000);
      if (!res.ok) {
        const err = new Error(`FRED HTTP ${res.status} for ${seriesId}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    { attempts: 3, shouldRetry: (e) => isRetryable(e) }
  );
  const retrievedAt = new Date().toISOString();

  const obs = json.observations;
  if (!obs || obs.length === 0) throw new Error(`No observations for ${seriesId}`);

  // Rows arrive newest-first. "." is FRED's missing-value marker.
  const idx = obs.findIndex(o => o.value !== "." && Number.isFinite(parseFloat(o.value)));
  if (idx === -1) {
    throw new Error(`No valid value in the latest ${obs.length} ${seriesId} rows (all ".")`);
  }
  const latest = obs[idx];
  const meta   = seriesMeta(seriesId);

  return {
    seriesId,
    value:               parseFloat(latest.value),
    date:                latest.date,
    observedAt:          latest.date,
    observedAtPrecision: "date",
    retrievedAt,
    unit:                meta.unit,
    profile:             meta.profile,
    kind:                "observed",
    source:              "FRED",
    // How many newer rows were "." — non-zero means the newest calendar day
    // had no value (holiday or not yet published), which is visible, not hidden.
    skippedMissing:      idx,
  };
}

/**
 * getRecentHistory — fetch the last N observations for a FRED series.
 * Returns observations in ascending date order.
 *
 * @param {string} seriesId
 * @param {number} limit     Number of obs (default 7)
 * @returns {{ seriesId, observations: {date, value}[] }}
 */
async function getRecentHistory(seriesId, limit = 7) {
  const url = new URL(`${BASE_URL}/series/observations`);
  url.searchParams.set("series_id",  seriesId);
  url.searchParams.set("api_key",    apiKey());
  url.searchParams.set("file_type",  "json");
  url.searchParams.set("sort_order", "desc");
  url.searchParams.set("limit",      String(limit));

  const json = await withRetry(
    async () => {
      const res = await fetchWithTimeout(url.toString(), {}, 12_000);
      if (!res.ok) {
        const err = new Error(`FRED HTTP ${res.status} for ${seriesId}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    { attempts: 3, shouldRetry: (e) => isRetryable(e) }
  );

  const obs = (json.observations || [])
    .filter(o => o.value !== "." && Number.isFinite(parseFloat(o.value)))
    .map(o => ({ date: o.date, value: parseFloat(o.value) }))
    .reverse(); // ascending order

  return {
    seriesId,
    observations: obs,
    source:       "FRED",
    unit:         seriesMeta(seriesId).unit,
    retrievedAt:  new Date().toISOString(),
  };
}

/**
 * getAllRates — fetch all rate series in parallel.
 * Returns the full rates object needed by /api/snapshot.
 */
async function getAllRates() {
  const SERIES = ["DGS10", "DFII10", "T10YIE", "BAMLH0A0HYM2", "T10Y2Y"];
  const results = await Promise.allSettled(SERIES.map(id => getLatestObservation(id)));

  const rates = {};
  const fieldMap = {
    DGS10:         "dgs10",
    DFII10:        "dfii10",
    T10YIE:        "t10yie",
    BAMLH0A0HYM2:  "hy_spread",
    T10Y2Y:        "t10y2y",
  };

  for (let i = 0; i < SERIES.length; i++) {
    const id    = SERIES[i];
    const field = fieldMap[id];
    const res   = results[i];
    if (res.status === "fulfilled") {
      rates[field] = res.value;
    } else {
      // Missing stays missing. The caller renders it as unavailable; it must
      // not be back-filled with a seed or a remembered level.
      console.error(`[FRED] ${id} failed:`, res.reason?.message);
      rates[field] = null;
    }
  }
  return rates;
}

module.exports = { getLatestObservation, getRecentHistory, getAllRates, SERIES_META, LATEST_LOOKBACK_ROWS };
