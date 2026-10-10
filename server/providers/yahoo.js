/**
 * server/providers/yahoo.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Yahoo Finance chart API adapter — historical daily closes for tickers not
 * covered by Polygon's free tier (e.g. native Asian listings: 005930.KS,
 * 000660.KS, 2330.TW, 6758.T). No API key required.
 *
 * Used as a fallback source for the strategy backtester — Polygon remains the
 * primary source for US-listed tickers/ADRs/ETFs.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const { fetchWithTimeout, withRetry, isRetryable } = require("../retry");

/**
 * getHistory — fetch up to `days` calendar days of daily closes for a ticker.
 * Returns array of { date: "YYYY-MM-DD", close: number } ascending.
 *
 * @param {string} sym   Ticker symbol (e.g. "005930.KS", "2330.TW")
 * @param {number} days  Lookback in calendar days (default 252 ≈ 1 trading year)
 * @returns {Promise<Array<{date, close}>>}
 */
async function getHistory(sym, days = 252) {
  // Yahoo's "range" param accepts coarse buckets — pick the smallest that covers `days`.
  let range = "1y";
  if (days <= 31) range = "1mo";
  else if (days <= 95) range = "3mo";
  else if (days <= 186) range = "6mo";
  else if (days <= 370) range = "1y";
  else if (days <= 740) range = "2y";
  else range = "5y";

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=${range}`;

  const json = await withRetry(
    async () => {
      const res = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0" } }, 12_000);
      if (!res.ok) {
        const err = new Error(`Yahoo HTTP ${res.status} for ${sym}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    { attempts: 3, baseMs: 2_000, maxMs: 10_000, shouldRetry: (e) => isRetryable(e) }
  );

  const result = json.chart?.result?.[0];
  if (!result) {
    const reason = json.chart?.error?.description || "no data";
    throw new Error(`Yahoo: ${reason} for ${sym}`);
  }

  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];

  const bars = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] == null) continue;
    bars.push({
      date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
      close: closes[i],
    });
  }

  if (!bars.length) throw new Error(`Yahoo: no usable bars for ${sym}`);

  return bars;
}

/**
 * getQuote — current price + change vs prior close for a single symbol.
 * Used for live cross-asset "what's actually moving today" context
 * (bulletin generation). No API key required.
 *
 * @param {string} sym  Yahoo symbol (e.g. "^GSPC", "^VIX", "CL=F", "GC=F")
 * @returns {Promise<{symbol: string, price: number, prevClose: number, changePct: number}>}
 */
async function getQuote(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=1d`;

  const json = await withRetry(
    async () => {
      const res = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0" } }, 8_000);
      if (!res.ok) {
        const err = new Error(`Yahoo HTTP ${res.status} for ${sym}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    { attempts: 2, baseMs: 1_000, maxMs: 4_000, shouldRetry: (e) => isRetryable(e) }
  );

  const result = json.chart?.result?.[0];
  if (!result) {
    const reason = json.chart?.error?.description || "no data";
    throw new Error(`Yahoo: ${reason} for ${sym}`);
  }

  const meta      = result.meta || {};
  const price     = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose ?? meta.previousClose;
  if (price == null || prevClose == null) throw new Error(`Yahoo: incomplete quote for ${sym}`);

  return { symbol: sym, price, prevClose, changePct: ((price - prevClose) / prevClose) * 100 };
}

module.exports = { getHistory, getQuote };
