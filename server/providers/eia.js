"use strict";

/**
 * server/providers/eia.js
 * ─────────────────────────────────────────────────────────────────────────────
 * U.S. Energy Information Administration (EIA) API v2 provider.
 *
 * Fetches weekly energy spot prices for use in commodities research reports.
 *
 * Free tier — no rate limit for reasonable usage.
 * Requires: EIA_API_KEY env var (get from eia.gov/opendata)
 *
 * Series:
 *   petroleum/pri/spt  RWTC   — WTI crude (Cushing, OK) $/bbl weekly
 *   petroleum/pri/spt  RBRTE  — Brent crude (ICE) $/bbl weekly
 *   natural-gas/pri/sum RNGWHHD — Henry Hub NG $/mmbtu weekly
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { withRetry, fetchWithTimeout, isRetryable } = require("../retry");

const BASE = "https://api.eia.gov/v2";
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

let _cache     = null;
let _cacheTs   = 0;

function apiKey() {
  return process.env.EIA_API_KEY || "";
}

/**
 * Build a well-formed EIA v2 URL with array-style query parameters.
 * EIA v2 uses bracket notation: facets[series][]=RWTC
 */
function buildUrl(endpoint, seriesIds, weeks, frequency = "weekly") {
  const key = apiKey();
  // Build query string manually — URLSearchParams percent-encodes brackets
  // which some API implementations reject; we want literal bracket notation.
  const seriesQS = seriesIds.map(s => `facets[series][]=${encodeURIComponent(s)}`).join("&");
  return (
    `${BASE}/${endpoint}?api_key=${encodeURIComponent(key)}` +
    `&frequency=${frequency}` +
    `&data[0]=value` +
    `&${seriesQS}` +
    `&sort[0][column]=period` +
    `&sort[0][direction]=desc` +
    `&length=${weeks}`
  );
}

/**
 * fetchEiaSeries — fetch one or more EIA series from a given endpoint.
 * Returns array of { period, series, value } in ascending date order.
 */
async function fetchEiaSeries(endpoint, seriesIds, weeks = 52, frequency = "weekly") {
  if (!apiKey()) throw new Error("EIA_API_KEY not set");

  const url = buildUrl(endpoint, seriesIds, weeks, frequency);
  const maskedUrl = url.replace(apiKey(), "***");
  console.log(`[EIA] Fetching: ${maskedUrl}`);

  const json = await withRetry(
    async () => {
      const res = await fetchWithTimeout(url, {}, 12_000);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const err  = new Error(`EIA HTTP ${res.status}: ${body.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    { attempts: 3, shouldRetry: (e) => isRetryable(e) }
  );

  const data = (json.response?.data || [])
    .filter(d => d.value !== null && d.value !== undefined && d.value !== "")
    .map(d => ({ period: String(d.period), series: d.series || seriesIds[0], value: Number(d.value) }))
    .reverse(); // ascending order

  console.log(`[EIA] ${endpoint} → ${data.length} obs (series: ${seriesIds.join(",")})`);
  return data;
}

/**
 * fetchSeriesById — uses EIA v2's backward-compatible seriesid route.
 * Accepts a v1-style series ID like "NG.RNGWHHD.W".
 * Returns array of { period, value } in ascending date order.
 */
async function fetchSeriesById(seriesId, length = 52) {
  if (!apiKey()) throw new Error("EIA_API_KEY not set");

  const url = `${BASE}/seriesid/${encodeURIComponent(seriesId)}?api_key=${encodeURIComponent(apiKey())}&length=${length}`;
  console.log(`[EIA] Fetching seriesid: ${seriesId} (${length} obs)`);

  const json = await withRetry(
    async () => {
      const res = await fetchWithTimeout(url, {}, 12_000);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const err  = new Error(`EIA seriesid HTTP ${res.status}: ${body.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    { attempts: 3, shouldRetry: (e) => isRetryable(e) }
  );

  const data = (json.response?.data || [])
    .filter(d => d.value !== null && d.value !== undefined)
    .map(d => ({ period: String(d.period), value: Number(d.value) }))
    .reverse(); // ascending order

  console.log(`[EIA] seriesid ${seriesId} → ${data.length} obs`);
  return data;
}

/**
 * getPriceHistory — fetches weekly WTI, Brent, and Henry Hub NG prices.
 *
 * Returns array of { period (YYYY-MM-DD or YYYY-WXX), wti?, brent?, ng? }
 * sorted ascending. Missing values omitted per week (partial data is fine).
 *
 * Cached 30 min.
 */
async function getPriceHistory(weeks = 52) {
  if (_cache && Date.now() - _cacheTs < CACHE_TTL_MS) return _cache;

  const [wtiRes, brentRes, ngRes] = await Promise.allSettled([
    fetchEiaSeries("petroleum/pri/spt/data", ["RWTC"],  weeks, "weekly"),
    fetchEiaSeries("petroleum/pri/spt/data", ["RBRTE"], weeks, "weekly"),
    fetchSeriesById("NG.RNGWHHD.W", weeks), // Henry Hub weekly — use seriesid compat route
  ]);

  // Merge into a map keyed by period
  const byPeriod = {};

  function merge(res, field) {
    if (res.status === "fulfilled") {
      res.value.forEach(d => {
        byPeriod[d.period] = { ...byPeriod[d.period], [field]: d.value };
      });
    } else {
      console.warn(`[EIA] ${field} fetch failed:`, res.reason?.message);
    }
  }

  merge(wtiRes,   "wti");
  merge(brentRes, "brent");
  merge(ngRes,    "ng");

  const combined = Object.entries(byPeriod)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, vals]) => ({ period, ...vals }));

  _cache   = combined;
  _cacheTs = Date.now();
  return combined;
}

/**
 * getLatestPrices — returns the most recent price snapshot for each commodity.
 * Used to populate live_market_data in research reports with real EIA values.
 *
 * Returns:
 *   { wti, brent, ng } each with { value, formatted, change, direction, source, as_of }
 */
async function getLatestPrices(weeks = 6) {
  const history = await getPriceHistory(6);
  if (!history.length) return null;

  // Find the most recent entry with each field
  function latest(field) {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i][field] !== undefined) return { idx: i, value: history[i][field], period: history[i].period };
    }
    return null;
  }

  function prevOf(field, idx) {
    for (let i = idx - 1; i >= 0; i--) {
      if (history[i][field] !== undefined) return history[i][field];
    }
    return null;
  }

  function pctChange(curr, prev) {
    if (prev === null || prev === undefined || curr === null || curr === undefined) return null;
    const pct = ((curr - prev) / Math.abs(prev)) * 100;
    return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% 1W`;
  }

  function direction(curr, prev) {
    if (prev === null) return "flat";
    return curr > prev ? "up" : curr < prev ? "down" : "flat";
  }

  const wtiL   = latest("wti");
  const brentL = latest("brent");
  const ngL    = latest("ng");

  const wtiPrev   = wtiL   ? prevOf("wti",   wtiL.idx)   : null;
  const brentPrev = brentL ? prevOf("brent", brentL.idx) : null;
  const ngPrev    = ngL    ? prevOf("ng",    ngL.idx)    : null;

  // Format period (YYYY-MM-DD or YYYY-WXX → readable)
  function fmtPeriod(p) {
    if (!p) return "";
    if (p.includes("-W")) return p; // ISO week — return as-is
    return new Date(p + "T00:00:00Z").toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric" });
  }

  return {
    wti:   wtiL   ? { value: wtiL.value,   formatted: `$${wtiL.value.toFixed(2)}/bbl`,     change: pctChange(wtiL.value, wtiPrev),     direction: direction(wtiL.value, wtiPrev),     source: "EIA", as_of: fmtPeriod(wtiL.period)   } : null,
    brent: brentL ? { value: brentL.value, formatted: `$${brentL.value.toFixed(2)}/bbl`,   change: pctChange(brentL.value, brentPrev), direction: direction(brentL.value, brentPrev), source: "EIA", as_of: fmtPeriod(brentL.period) } : null,
    ng:    ngL    ? { value: ngL.value,    formatted: `$${ngL.value.toFixed(2)}/mmbtu`,    change: pctChange(ngL.value, ngPrev),       direction: direction(ngL.value, ngPrev),       source: "EIA", as_of: fmtPeriod(ngL.period)   } : null,
  };
}

module.exports = { getPriceHistory, getLatestPrices };
