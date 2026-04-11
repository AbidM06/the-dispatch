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

/**
 * getTnxYield — fetch the CBOE 10-Year Treasury yield (^TNX / I:TNX).
 * Tries Polygon first (15-min delay, free tier may 403 on index data).
 * Falls back to Yahoo Finance (same-day data, no key required).
 * Returns null on all failures so callers degrade silently to FRED.
 */
async function getTnxYield() {
  // ── Tier 1: Polygon I:TNX ──────────────────────────────────────────────────
  const key = apiKey();
  if (key) {
    try {
      const today = new Date();
      const from  = new Date(today);
      from.setDate(from.getDate() - 7);
      const url =
        `${BASE_URL}/v2/aggs/ticker/I:TNX/range/1/day/${toDateStr(from)}/${toDateStr(today)}` +
        `?adjusted=true&sort=desc&limit=1&apiKey=${key}`;
      const res = await fetchWithTimeout(url, {}, 12_000);
      if (res.ok) {
        const json = await res.json();
        const bar  = json.results?.[0];
        if (bar) {
          return {
            value:    +(bar.c / 10).toFixed(3), // TNX price × 10 = yield bp → / 10 = %
            date:     new Date(bar.t).toISOString().slice(0, 10),
            source:   "Polygon (15min delay)",
            seriesId: "I:TNX",
          };
        }
      }
    } catch (_) { /* fall through to Yahoo */ }
  }

  // ── Tier 2: Yahoo Finance ^TNX (no key, same-day data) ────────────────────
  try {
    const url = "https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX?interval=1d&range=2d";
    const res = await fetchWithTimeout(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    }, 10_000);
    if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
    const json  = await res.json();
    const meta  = json.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    const ts    = meta?.regularMarketTime;
    if (!price || !ts) throw new Error("Yahoo TNX: missing price/time");
    return {
      value:    +parseFloat(price).toFixed(3), // Yahoo quotes yield directly in %
      date:     new Date(ts * 1000).toISOString().slice(0, 10),
      source:   "Yahoo Finance (15min delay)",
      seriesId: "^TNX",
    };
  } catch (err) {
    console.warn("[Polygon/Yahoo] TNX fetch failed:", err.message, "— keeping FRED value");
    return null;
  }
}

/**
 * getVolSurface — fetch VIX term structure and skew proxy from Yahoo Finance.
 * Returns:
 *   vix3m  — CBOE 3-Month VIX (^VIX3M): spot VIX vs VIX3M tells you if fear
 *            is a spike (spot > 3m) or a sustained regime (spot ≈ 3m).
 *   skew   — CBOE SKEW Index (^SKEW): measures tail risk / put demand.
 *            100 = normal, 130+ = elevated crash protection buying.
 * Both are free via Yahoo Finance, no key required.
 * Returns { vix3m, skew } — either field is null on failure.
 */
async function getVolSurface() {
  async function yahooIndex(symbol) {
    try {
      const encoded = encodeURIComponent(symbol);
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=2d`;
      const res = await fetchWithTimeout(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
      }, 10_000);
      if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
      const json  = await res.json();
      const meta  = json.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice;
      const ts    = meta?.regularMarketTime;
      if (!price || !ts) throw new Error(`${symbol}: missing price/time`);
      return {
        value:  +parseFloat(price).toFixed(2),
        date:   new Date(ts * 1000).toISOString().slice(0, 10),
        source: "Yahoo Finance (15min delay)",
      };
    } catch (err) {
      console.warn(`[Polygon/Yahoo] ${symbol} fetch failed:`, err.message);
      return null;
    }
  }

  const [vix3m, skew] = await Promise.all([
    yahooIndex("^VIX3M"),
    yahooIndex("^SKEW"),
  ]);

  return { vix3m, skew };
}

/**
 * getHistory — fetch N calendar days of daily bars for a single ticker.
 * Returns array of { date: "YYYY-MM-DD", close: number } ascending.
 * Works for any ticker (not just POLYGON_PEERS) — used for momentum screen.
 *
 * @param {string} sym    Ticker symbol
 * @param {number} days   Lookback in calendar days (default 252 ≈ 1 trading year)
 * @returns {Promise<Array<{date, close}>>}
 */
async function getHistory(sym, days = 252) {
  const key = apiKey();
  if (!key) throw new Error("POLYGON_API_KEY not configured");

  const today = new Date();
  const from  = new Date(today);
  from.setDate(from.getDate() - days);

  const url =
    `${BASE_URL}/v2/aggs/ticker/${sym}/range/1/day/${toDateStr(from)}/${toDateStr(today)}` +
    `?adjusted=true&sort=asc&limit=${days}&apiKey=${key}`;

  const json = await withRetry(
    async () => {
      const res = await fetchWithTimeout(url, {}, 15_000);
      if (!res.ok) {
        const err = new Error(`Polygon HTTP ${res.status} for ${sym} history`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    { attempts: 3, baseMs: 5_000, maxMs: 20_000, shouldRetry: (e) => isRetryable(e) }
  );

  if (json.status === "ERROR") {
    throw new Error(`Polygon error: ${json.error || "unknown error"}`);
  }

  return (json.results || []).map(bar => ({
    date:  new Date(bar.t).toISOString().slice(0, 10),
    close: bar.c,
  }));
}

module.exports = { getSnapshots, getTnxYield, getVolSurface, getHistory, POLYGON_PEERS };
