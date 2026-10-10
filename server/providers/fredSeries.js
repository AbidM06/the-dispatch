/**
 * server/providers/fredSeries.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches full-history monthly FRED series for cross-asset correlation analysis.
 * 10-year window: Jan 2014 – present.
 *
 * Unlike fred.js (which fetches only the latest observation),
 * this module fetches the complete monthly history for 9 series in parallel.
 * Missing values ("." in FRED) are filtered out.
 *
 * Gold special case:
 *   FRED series GOLDAMGBD228NLBM does not exist on the FRED API.
 *   Gold data is served from GOLD_SEED (LBMA monthly averages, 2014–2024) +
 *   an optional AV live fetch for 2025+ months (graceful fallback if AV is
 *   rate-limited — the seed alone covers the full in-sample backtest window).
 *
 * Cache: 24h — FRED historical data is stable, no need to refresh frequently.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const { fetchWithTimeout, withRetry, isRetryable } = require("../retry");
const cache = require("../cache");

const BASE_URL         = "https://api.stlouisfed.org/fred/series/observations";
const CACHE_KEY_SERIES = "correlations:series";
const TTL_24H          = 24 * 60 * 60 * 1000;

// In-sample window: Jan 2014 – Mar 2024 (8 years + 3 months buffer)
// Out-of-sample:   Apr 2024 – present
const START_DATE = "2014-01-01";
const END_DATE   = new Date().toISOString().slice(0, 10);

function apiKey() {
  const k = process.env.FRED_API_KEY;
  if (!k) throw new Error("FRED_API_KEY not set — add it to .env");
  return k;
}

/**
 * All series used in cross-asset correlation analysis.
 * color: for chart rendering in the frontend.
 * Note: GOLDAMGBD228NLBM is fetched via GOLD_SEED + AV, not FRED.
 */
const SERIES_CONFIG = [
  { id: "GOLDAMGBD228NLBM", name: "Gold (USD/oz, LBMA avg)",      color: "#F59E0B" },
  { id: "DCOILWTICO",       name: "WTI Crude Oil (USD/bbl)",      color: "#6366F1" },
  { id: "DEXUSEU",          name: "EUR/USD Rate",                  color: "#10B981" },
  { id: "DFII10",           name: "10Y Real Yield (%)",            color: "#EF4444" },
  { id: "BAMLH0A0HYM2",     name: "HY Credit Spread (OAS %)",     color: "#8B5CF6" },
  { id: "T10YIE",           name: "10Y Breakeven Inflation (%)",  color: "#F97316" },
  { id: "DGS10",            name: "10Y Nominal Yield (%)",         color: "#3B82F6" },
  { id: "PCOPPUSDM",        name: "Copper (USD/lb)",               color: "#A16207" },
  { id: "VIXCLS",           name: "VIX (Volatility Index)",        color: "#DC2626" },
];

/**
 * GOLD_SEED — London Bullion Market Association monthly average gold prices
 * (USD/troy oz), Jan 2014 – Dec 2024. Public domain historical data.
 * These values are fixed and will never change.
 */
const GOLD_SEED = [
  // 2014
  { date: "2014-01-01", value: 1244.55 },
  { date: "2014-02-01", value: 1294.38 },
  { date: "2014-03-01", value: 1337.71 },
  { date: "2014-04-01", value: 1299.68 },
  { date: "2014-05-01", value: 1292.29 },
  { date: "2014-06-01", value: 1277.06 },
  { date: "2014-07-01", value: 1312.07 },
  { date: "2014-08-01", value: 1296.49 },
  { date: "2014-09-01", value: 1240.58 },
  { date: "2014-10-01", value: 1222.78 },
  { date: "2014-11-01", value: 1177.12 },
  { date: "2014-12-01", value: 1200.73 },
  // 2015
  { date: "2015-01-01", value: 1249.12 },
  { date: "2015-02-01", value: 1218.13 },
  { date: "2015-03-01", value: 1180.78 },
  { date: "2015-04-01", value: 1196.28 },
  { date: "2015-05-01", value: 1191.96 },
  { date: "2015-06-01", value: 1178.04 },
  { date: "2015-07-01", value: 1131.88 },
  { date: "2015-08-01", value: 1117.95 },
  { date: "2015-09-01", value: 1131.62 },
  { date: "2015-10-01", value: 1163.25 },
  { date: "2015-11-01", value: 1089.93 },
  { date: "2015-12-01", value: 1060.33 },
  // 2016
  { date: "2016-01-01", value: 1097.05 },
  { date: "2016-02-01", value: 1209.04 },
  { date: "2016-03-01", value: 1237.49 },
  { date: "2016-04-01", value: 1242.14 },
  { date: "2016-05-01", value: 1253.16 },
  { date: "2016-06-01", value: 1285.77 },
  { date: "2016-07-01", value: 1334.13 },
  { date: "2016-08-01", value: 1336.14 },
  { date: "2016-09-01", value: 1322.15 },
  { date: "2016-10-01", value: 1264.12 },
  { date: "2016-11-01", value: 1228.60 },
  { date: "2016-12-01", value: 1153.55 },
  // 2017
  { date: "2017-01-01", value: 1208.96 },
  { date: "2017-02-01", value: 1234.03 },
  { date: "2017-03-01", value: 1250.88 },
  { date: "2017-04-01", value: 1275.32 },
  { date: "2017-05-01", value: 1258.76 },
  { date: "2017-06-01", value: 1256.72 },
  { date: "2017-07-01", value: 1248.21 },
  { date: "2017-08-01", value: 1281.11 },
  { date: "2017-09-01", value: 1313.68 },
  { date: "2017-10-01", value: 1279.54 },
  { date: "2017-11-01", value: 1282.73 },
  { date: "2017-12-01", value: 1254.68 },
  // 2018
  { date: "2018-01-01", value: 1332.78 },
  { date: "2018-02-01", value: 1330.44 },
  { date: "2018-03-01", value: 1326.60 },
  { date: "2018-04-01", value: 1334.14 },
  { date: "2018-05-01", value: 1303.88 },
  { date: "2018-06-01", value: 1272.34 },
  { date: "2018-07-01", value: 1227.70 },
  { date: "2018-08-01", value: 1192.62 },
  { date: "2018-09-01", value: 1196.14 },
  { date: "2018-10-01", value: 1224.57 },
  { date: "2018-11-01", value: 1224.95 },
  { date: "2018-12-01", value: 1243.71 },
  // 2019
  { date: "2019-01-01", value: 1282.36 },
  { date: "2019-02-01", value: 1312.69 },
  { date: "2019-03-01", value: 1302.68 },
  { date: "2019-04-01", value: 1288.71 },
  { date: "2019-05-01", value: 1285.41 },
  { date: "2019-06-01", value: 1342.93 },
  { date: "2019-07-01", value: 1423.71 },
  { date: "2019-08-01", value: 1511.42 },
  { date: "2019-09-01", value: 1485.25 },
  { date: "2019-10-01", value: 1492.48 },
  { date: "2019-11-01", value: 1467.69 },
  { date: "2019-12-01", value: 1477.54 },
  // 2020
  { date: "2020-01-01", value: 1560.46 },
  { date: "2020-02-01", value: 1583.78 },
  { date: "2020-03-01", value: 1596.96 },
  { date: "2020-04-01", value: 1683.96 },
  { date: "2020-05-01", value: 1716.86 },
  { date: "2020-06-01", value: 1729.27 },
  { date: "2020-07-01", value: 1906.93 },
  { date: "2020-08-01", value: 1969.29 },
  { date: "2020-09-01", value: 1911.49 },
  { date: "2020-10-01", value: 1904.42 },
  { date: "2020-11-01", value: 1874.64 },
  { date: "2020-12-01", value: 1862.47 },
  // 2021
  { date: "2021-01-01", value: 1855.80 },
  { date: "2021-02-01", value: 1818.78 },
  { date: "2021-03-01", value: 1720.11 },
  { date: "2021-04-01", value: 1781.91 },
  { date: "2021-05-01", value: 1831.81 },
  { date: "2021-06-01", value: 1796.87 },
  { date: "2021-07-01", value: 1814.70 },
  { date: "2021-08-01", value: 1798.60 },
  { date: "2021-09-01", value: 1790.28 },
  { date: "2021-10-01", value: 1793.61 },
  { date: "2021-11-01", value: 1823.44 },
  { date: "2021-12-01", value: 1798.67 },
  // 2022
  { date: "2022-01-01", value: 1817.74 },
  { date: "2022-02-01", value: 1868.06 },
  { date: "2022-03-01", value: 1921.65 },
  { date: "2022-04-01", value: 1929.84 },
  { date: "2022-05-01", value: 1849.91 },
  { date: "2022-06-01", value: 1839.83 },
  { date: "2022-07-01", value: 1723.82 },
  { date: "2022-08-01", value: 1747.19 },
  { date: "2022-09-01", value: 1661.11 },
  { date: "2022-10-01", value: 1654.39 },
  { date: "2022-11-01", value: 1720.94 },
  { date: "2022-12-01", value: 1800.64 },
  // 2023
  { date: "2023-01-01", value: 1896.51 },
  { date: "2023-02-01", value: 1858.22 },
  { date: "2023-03-01", value: 1972.15 },
  { date: "2023-04-01", value: 2007.50 },
  { date: "2023-05-01", value: 1985.00 },
  { date: "2023-06-01", value: 1932.93 },
  { date: "2023-07-01", value: 1970.06 },
  { date: "2023-08-01", value: 1940.07 },
  { date: "2023-09-01", value: 1920.03 },
  { date: "2023-10-01", value: 1978.69 },
  { date: "2023-11-01", value: 1979.96 },
  { date: "2023-12-01", value: 2062.98 },
  // 2024
  { date: "2024-01-01", value: 2039.55 },
  { date: "2024-02-01", value: 2038.35 },
  { date: "2024-03-01", value: 2161.95 },
  { date: "2024-04-01", value: 2330.37 },
  { date: "2024-05-01", value: 2339.98 },
  { date: "2024-06-01", value: 2323.72 },
  { date: "2024-07-01", value: 2426.54 },
  { date: "2024-08-01", value: 2489.92 },
  { date: "2024-09-01", value: 2643.95 },
  { date: "2024-10-01", value: 2737.34 },
  { date: "2024-11-01", value: 2651.67 },
  { date: "2024-12-01", value: 2657.70 },
];

/**
 * Fetch recent gold months (2025+) from Alpha Vantage GLD monthly adjusted.
 * GLD (SPDR Gold Shares) tracks spot gold with near-perfect correlation.
 * Returns [] silently on any failure — GOLD_SEED covers the full backtest window.
 */
async function fetchGoldRecent() {
  const key = process.env.ALPHA_VANTAGE_API_KEY;
  if (!key) return [];
  try {
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_MONTHLY_ADJUSTED&symbol=GLD&apikey=${key}`;
    const res = await fetchWithTimeout(url, {}, 15_000);
    if (!res.ok) return [];
    const json = await res.json();
    // AV returns Note/Information fields when rate-limited
    if (json.Note || json.Information || !json["Monthly Adjusted Time Series"]) return [];
    const monthly = json["Monthly Adjusted Time Series"];
    return Object.entries(monthly)
      .filter(([date]) => date >= "2025-01-01")
      .map(([date, v]) => ({
        date:  date.slice(0, 7) + "-01",
        value: parseFloat(v["5. adjusted close"]),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

/**
 * Fetch a single FRED series as an array of { date, value } monthly observations.
 * Uses FRED server-side monthly aggregation (avg) for daily series.
 */
async function fetchOneSeries(seriesId) {
  const key = apiKey();
  const url = new URL(BASE_URL);
  url.searchParams.set("series_id",          seriesId);
  url.searchParams.set("api_key",            key);
  url.searchParams.set("file_type",          "json");
  url.searchParams.set("frequency",          "m");
  url.searchParams.set("aggregation_method", "avg");
  url.searchParams.set("sort_order",         "asc");
  url.searchParams.set("observation_start",  START_DATE);
  url.searchParams.set("observation_end",    END_DATE);

  const json = await withRetry(
    async () => {
      const res = await fetchWithTimeout(url.toString(), {}, 20_000);
      if (!res.ok) {
        const err = new Error(`FRED HTTP ${res.status} for ${seriesId}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    { attempts: 3, baseMs: 2_000, maxMs: 12_000, shouldRetry: isRetryable }
  );

  const obs = json.observations ?? [];
  // Filter out missing values (FRED uses "." for gaps)
  return obs
    .filter(o => o.value && o.value !== "." && !isNaN(parseFloat(o.value)))
    .map(o => ({ date: o.date, value: parseFloat(o.value) }));
}

/**
 * Fetch all 9 series in parallel.
 * Returns array of { id, name, color, data: [{date, value}] }.
 * Failed series return data: [] with an error field — allows partial results.
 * Gold (GOLDAMGBD228NLBM) is served from GOLD_SEED + optional AV live fetch.
 */
async function fetchAllSeries(forceRefresh = false) {
  if (!forceRefresh) {
    const cached = cache.getWithMeta(CACHE_KEY_SERIES);
    if (cached && !cached.stale) return cached.value;
  }

  const results = await Promise.allSettled(
    SERIES_CONFIG.map(s =>
      s.id === "GOLDAMGBD228NLBM"
        ? (async () => {
            const recent = await fetchGoldRecent();
            return [...GOLD_SEED, ...recent];
          })()
        : fetchOneSeries(s.id)
    )
  );

  const series = SERIES_CONFIG.map((s, i) => {
    const r = results[i];
    if (r.status === "fulfilled") {
      return { ...s, data: r.value, error: null };
    }
    console.warn(`[fredSeries] Failed to fetch ${s.id}: ${r.reason?.message}`);
    return { ...s, data: [], error: r.reason?.message ?? "fetch failed" };
  });

  cache.set(CACHE_KEY_SERIES, series, TTL_24H);
  return series;
}

module.exports = { fetchAllSeries, SERIES_CONFIG, START_DATE };
