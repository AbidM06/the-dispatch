/**
 * server/providers/polygon.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Polygon.io REST API adapter — watchlist peer quotes.
 * Free tier: unlimited calls/day, 5/min, ~15-min delayed data.
 *
 * Strategy:
 *   GET /v2/aggs/ticker/{sym}/range/1/day/{from}/{to}
 *         ?adjusted=true&sort=desc&limit=2&apiKey={key}
 *
 *   One call per symbol, run in parallel via Promise.allSettled.
 *   Returns the two most recent trading days so we can compute chgPct.
 *   - results[0] = latest trading day  → price
 *   - results[1] = previous trading day → base for chgPct
 *
 *   The snapshot endpoint (/v2/snapshot/…) requires a paid plan (HTTP 403
 *   on the free tier).  This daily-aggregates endpoint is free.
 *
 * Symbols served:  NVDA, MSFT, TSLA, MU, AMAT, LRCX  (watchlist peers)
 * AMD and FX remain on Alpha Vantage (alphaVantage.js).
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const { fetchWithTimeout, withRetry, isRetryable } = require("../retry");

const BASE_URL = "https://api.polygon.io";

// Symbols this provider handles (watchlist peers only — AMD stays on AV)
const POLYGON_PEERS = new Set(["NVDA", "MSFT", "TSLA", "MU", "AMAT", "LRCX"]);

function apiKey() {
  const k = process.env.POLYGON_API_KEY;
  if (!k) console.warn("[Polygon] POLYGON_API_KEY not set — peer prices unavailable");
  return k || null;
}

/** Format a Date as YYYY-MM-DD */
function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * fetchOneTicker — fetch the two most recent daily bars for a single ticker.
 * Uses /v2/aggs/ticker/{sym}/range/1/day/{from}/{to} (free-tier endpoint).
 *
 * @param {string} sym   Ticker symbol
 * @param {string} key   API key
 * @param {string} from  ISO date string (window start)
 * @param {string} to    ISO date string (today)
 * @returns {Promise<{sym, price, chg, chgPct, volume, source, date}>}
 */
async function fetchOneTicker(sym, key, from, to) {
  const url =
    `${BASE_URL}/v2/aggs/ticker/${sym}/range/1/day/${from}/${to}` +
    `?adjusted=true&sort=desc&limit=2&apiKey=${key}`;

  const json = await withRetry(
    async () => {
      const res = await fetchWithTimeout(url, {}, 12_000);
      if (!res.ok) {
        const err = new Error(`Polygon HTTP ${res.status} for ${sym}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    // 429 rate-limit: base 13s backoff so retry falls outside the 1-min window
    { attempts: 4, baseMs: 13_000, maxMs: 30_000, shouldRetry: (e) => isRetryable(e) }
  );

  if (json.status === "ERROR") {
    throw new Error(`Polygon error: ${json.error || "unknown error"}`);
  }

  const results = json.results || [];
  if (!results.length) {
    throw new Error(`Polygon: no data returned for ${sym}`);
  }

  const latest = results[0];  // most recent trading day (sort=desc → index 0)
  const prev   = results[1];  // previous trading day (may be absent)

  const price  = latest.c || 0;
  const volume = latest.v || 0;

  // chgPct as a percentage value, e.g. -2.31 (not 0.0231)
  const chgPct = prev && prev.c
    ? +((price - prev.c) / prev.c * 100).toFixed(4)
    : 0;
  const chg = prev && prev.c
    ? +(price - prev.c).toFixed(4)
    : 0;

  // t is epoch ms; convert to ISO date string
  const date = new Date(latest.t).toISOString().slice(0, 10);

  return {
    sym,
    price:  +price.toFixed(4),
    chg,
    chgPct,
    volume,
    source: "Polygon.io",
    date,
  };
}

/**
 * getSnapshots — fetch latest quotes for multiple tickers in parallel.
 * Runs one API call per ticker via Promise.allSettled so a single ticker
 * failure never kills the whole batch.
 *
 * @param {string[]} symbols  Subset of POLYGON_PEERS to fetch
 * @returns {Promise<Array<{sym, price, chg, chgPct, volume, source, date}>>}
 */
async function getSnapshots(symbols) {
  const key = apiKey();
  if (!key) throw new Error("POLYGON_API_KEY not configured");

  const filtered = symbols.filter(s => POLYGON_PEERS.has(s));
  if (!filtered.length) return [];

  // Use a 14-day lookback window — wide enough to cover weekends + holidays
  const today = new Date();
  const from  = new Date(today);
  from.setDate(from.getDate() - 14);

  const fromStr = toDateStr(from);
  const toStr   = toDateStr(today);

  // Stagger calls by 200ms each to avoid hitting the 5/min burst limit
  const settled = await Promise.allSettled(
    filtered.map((sym, i) =>
      new Promise(r => setTimeout(r, i * 200)).then(() => fetchOneTicker(sym, key, fromStr, toStr))
    )
  );

  const quotes = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === "fulfilled") {
      quotes.push(r.value);
    } else {
      console.warn(`[Polygon] ${filtered[i]} fetch failed:`, r.reason?.message);
    }
  }
  return quotes;
}

module.exports = { getSnapshots, POLYGON_PEERS };
