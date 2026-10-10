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

function apiKey() {
  const k = process.env.FRED_API_KEY;
  if (!k) {
    throw new Error("FRED_API_KEY not set — add it to .env");
  }
  return k;
}

/**
 * getLatestObservation — fetch the most recent value for a FRED series.
 *
 * @param {string} seriesId  e.g. "DGS10"
 * @returns {{ seriesId, value, date, source }}
 */
async function getLatestObservation(seriesId) {
  const url = new URL(`${BASE_URL}/series/observations`);
  url.searchParams.set("series_id",   seriesId);
  url.searchParams.set("api_key",     apiKey());
  url.searchParams.set("file_type",   "json");
  url.searchParams.set("sort_order",  "desc");
  url.searchParams.set("limit",       "1");
  // Exclude observations with missing values (period before series starts, etc.)
  url.searchParams.set("observation_start", "2020-01-01");

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

  const obs = json.observations;
  if (!obs || obs.length === 0) throw new Error(`No observations for ${seriesId}`);

  // FRED uses "." for missing values
  const latest = obs.find(o => o.value !== ".");
  if (!latest) throw new Error(`Only missing values for ${seriesId}`);

  return {
    seriesId,
    value:  parseFloat(latest.value),
    date:   latest.date,
    source: "FRED",
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
    .filter(o => o.value !== ".")
    .map(o => ({ date: o.date, value: parseFloat(o.value) }))
    .reverse(); // ascending order

  return { seriesId, observations: obs, source: "FRED" };
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
      // Log and mark as missing — caller uses seed fallback for missing fields
      console.error(`[FRED] ${id} failed:`, res.reason?.message);
      rates[field] = null;
    }
  }
  return rates;
}

module.exports = { getLatestObservation, getRecentHistory, getAllRates };
