/**
 * server/providers/alphaVantage.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Alpha Vantage REST API adapter.
 * Free tier: 25 requests/day, 5/min.
 *
 * Hardening (Phase 2a):
 *   - Global 1.1 s throttle: no two AV HTTP calls less than 1.1 s apart.
 *   - Daily call budget: max 20 calls/day (leaves 5 buffer). Resets at midnight.
 *     Once exhausted, every call throws a 429-like error so callers fall back
 *     to cache/seed instead of wasting quota.
 *   - Per-symbol 5-min in-process quote cache: prevents duplicate AV calls when
 *     snapshot and portfolio both need AMD within the same cache window.
 *   - AV_SUPPORTED whitelist: AMD only. Peers (NVDA/MSFT/TSLA/MU/AMAT/LRCX)
 *     moved to Polygon.io to cut AV usage from 8 → 2 calls per snapshot refresh.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { fetchWithTimeout, withRetry, isRetryable } = require("../retry");

const BASE_URL = "https://www.alphavantage.co/query";

// ── US-listed symbols served by Alpha Vantage ─────────────────────────────────
// Restricted to AMD only — watchlist peers (NVDA/MSFT/TSLA/MU/AMAT/LRCX) now
// fetched via Polygon.io (unlimited free tier) to conserve AV's 25-call/day cap.
// FX (USD/GBP) continues to use AV via getFxRate — 1 call per refresh.
// Net AV calls per snapshot refresh: 1 (AMD quote) + 1 (FX) = 2  (was 8).
const AV_SUPPORTED = new Set(["AMD"]);

function apiKey() {
  const k = process.env.ALPHA_VANTAGE_API_KEY;
  if (!k || k === "demo") {
    console.warn("[AV] ALPHA_VANTAGE_API_KEY not set — using demo key (limited symbols)");
  }
  return k || "demo";
}

function buildUrl(params) {
  const p = new URLSearchParams({ ...params, apikey: apiKey() });
  return `${BASE_URL}?${p}`;
}

// ── Global 1.1 s throttle ─────────────────────────────────────────────────────
let _lastCallMs = 0;
const MIN_INTERVAL_MS = 1100;

async function _throttle() {
  const wait = MIN_INTERVAL_MS - (Date.now() - _lastCallMs);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastCallMs = Date.now();
}

// ── Daily budget guard (20 calls / day) ───────────────────────────────────────
const DAILY_BUDGET = 20;
let _budgetDate  = null;
let _budgetCount = 0;

function _checkBudget() {
  const today = new Date().toISOString().slice(0, 10);
  if (_budgetDate !== today) { _budgetDate = today; _budgetCount = 0; }
  if (_budgetCount >= DAILY_BUDGET) {
    const err = new Error(`AV daily budget exhausted (${DAILY_BUDGET} calls/day). Using cached/seed data.`);
    err.status = 429;
    throw err;
  }
  _budgetCount++;
}

// Exposed for tests
function _getBudget()   { return { date: _budgetDate, count: _budgetCount, limit: DAILY_BUDGET }; }
function _resetBudget() { _budgetDate = null; _budgetCount = 0; }

// ── Per-symbol 5-min quote cache (deduplicates snapshot ↔ portfolio calls) ────
const QUOTE_TTL_MS = 5 * 60_000;
const _quoteCache  = new Map(); // sym → { data, expiresAt }

function _getCachedQuote(sym) {
  const entry = _quoteCache.get(sym);
  if (entry && Date.now() < entry.expiresAt) return entry.data;
  return null;
}
function _setCachedQuote(sym, data) {
  _quoteCache.set(sym, { data, expiresAt: Date.now() + QUOTE_TTL_MS });
}

// ── Core fetch ────────────────────────────────────────────────────────────────
async function avFetch(params) {
  _checkBudget();
  await _throttle();

  const url  = buildUrl(params);
  const json = await withRetry(
    async () => {
      const res = await fetchWithTimeout(url, {}, 12_000);
      if (!res.ok) {
        const err = new Error(`AV HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    { attempts: 3, shouldRetry: (e) => isRetryable(e) }
  );

  if (json["Note"] || json["Information"]) {
    const msg = json["Note"] || json["Information"];
    const err = new Error(`Alpha Vantage rate limit: ${msg}`);
    err.status = 429;
    throw err;
  }
  if (json["Error Message"]) {
    throw new Error(`Alpha Vantage error: ${json["Error Message"]}`);
  }
  return json;
}

// ── getQuote ──────────────────────────────────────────────────────────────────
async function getQuote(sym) {
  if (!AV_SUPPORTED.has(sym)) {
    throw new Error(`${sym} not in AV_SUPPORTED whitelist — skip AV call`);
  }

  const cached = _getCachedQuote(sym);
  if (cached) return cached;

  const json = await avFetch({ function: "GLOBAL_QUOTE", symbol: sym });
  const q = json["Global Quote"];
  if (!q || !q["05. price"]) throw new Error(`No quote data for ${sym}`);

  const result = {
    sym,
    price:            parseFloat(q["05. price"]),
    chg:              parseFloat(q["09. change"]),
    chgPct:           parseFloat(q["10. change percent"].replace("%", "")),
    volume:           parseInt(q["06. volume"], 10),
    latestTradingDay: q["07. latest trading day"],
    source:           "Alpha Vantage",
  };
  _setCachedQuote(sym, result);
  return result;
}

// ── getQuotes ─────────────────────────────────────────────────────────────────
// Sequential with 1.2 s spacing; per-symbol cache avoids re-fetching within 5 min.
async function getQuotes(symbols) {
  const filtered = symbols.filter(s => AV_SUPPORTED.has(s));
  const results  = [];
  for (let i = 0; i < filtered.length; i++) {
    const q = await getQuote(filtered[i]);
    results.push(q);
    if (i < filtered.length - 1) await new Promise(r => setTimeout(r, 1200));
  }
  return results;
}

// ── getFxRate ─────────────────────────────────────────────────────────────────
async function getFxRate(from, to) {
  const json = await avFetch({
    function:      "CURRENCY_EXCHANGE_RATE",
    from_currency: from,
    to_currency:   to,
  });
  const r = json["Realtime Currency Exchange Rate"];
  if (!r) throw new Error(`No FX data for ${from}/${to}`);
  return {
    fromCurrency:  r["1. From_Currency Code"],
    toCurrency:    r["3. To_Currency Code"],
    rate:          parseFloat(r["5. Exchange Rate"]),
    lastRefreshed: r["6. Last Refreshed"],
    source:        "Alpha Vantage",
  };
}

module.exports = {
  getQuote,
  getQuotes,
  getFxRate,
  AV_SUPPORTED,
  _getBudget,
  _resetBudget,
};
