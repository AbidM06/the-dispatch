/**
 * server/providers/finnhub.js
 * Free tier: 60 req/min, no daily cap.
 * Env: FINNHUB_API_KEY
 */
"use strict";

const { fetchWithTimeout, withRetry, isRetryable } = require("../retry");

const BASE_URL = "https://finnhub.io/api/v1";
const TTL_NEWS_MS = 30 * 60 * 1000;        // 30 min
const TTL_CALENDAR_MS = 60 * 60 * 1000;    // 60 min

function apiKey() {
  const k = process.env.FINNHUB_API_KEY;
  if (!k) console.warn("[Finnhub] FINNHUB_API_KEY not set — news/calendar unavailable");
  return k || null;
}

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

async function finnhubGet(path) {
  const key = apiKey();
  if (!key) throw new Error("FINNHUB_API_KEY not configured");

  const url = `${BASE_URL}${path}${path.includes("?") ? "&" : "?"}token=${key}`;
  return withRetry(async () => {
    const res = await fetchWithTimeout(url, {}, 12_000);
    if (!res.ok) {
      const err = new Error(`Finnhub HTTP ${res.status} for ${path}`);
      err.status = res.status;
      // 403 = premium endpoint, 401 = bad key — never retry these
      if (res.status === 403 || res.status === 401) err.permanent = true;
      throw err;
    }
    return res.json();
  }, {
    attempts: 3,
    baseMs: 2_000,
    maxMs: 10_000,
    shouldRetry: (err) => !err.permanent && isRetryable(err),
  });
}

/**
 * General market news headlines (last N articles).
 * category: "general" | "forex" | "crypto" | "merger"
 */
async function getMarketNews(category = "general", limit = 10) {
  const data = await finnhubGet(`/news?category=${category}`);
  return (Array.isArray(data) ? data : [])
    .slice(0, limit)
    .map(a => ({
      id:        a.id,
      headline:  a.headline,
      summary:   a.summary?.slice(0, 300) ?? "",
      source:    a.source,
      url:       a.url,
      datetime:  new Date(a.datetime * 1000).toISOString(),
      related:   a.related ?? "",
    }));
}

/**
 * Company-specific news for a ticker.
 * daysBack: how many days of history to fetch (max 30 for free tier)
 */
async function getCompanyNews(ticker, daysBack = 7, limit = 5) {
  const to   = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - daysBack);

  const data = await finnhubGet(
    `/company-news?symbol=${ticker}&from=${toDateStr(from)}&to=${toDateStr(to)}`
  );
  return (Array.isArray(data) ? data : [])
    .slice(0, limit)
    .map(a => ({
      headline:  a.headline,
      summary:   a.summary?.slice(0, 200) ?? "",
      source:    a.source,
      datetime:  new Date(a.datetime * 1000).toISOString(),
    }));
}

/**
 * Earnings calendar for next N days.
 */
async function getEarningsCalendar(daysAhead = 45) {
  const from = new Date();
  const to   = new Date();
  to.setDate(to.getDate() + daysAhead);

  const data = await finnhubGet(
    `/calendar/earnings?from=${toDateStr(from)}&to=${toDateStr(to)}`
  );
  const items = data?.earningsCalendar ?? [];
  return items.map(e => ({
    ticker:      e.symbol,
    date:        e.date,
    epsEstimate: e.epsEstimate,
    revenueEst:  e.revenueEstimate,
    hour:        e.hour, // "bmo" | "amc" | ""
  }));
}

/**
 * Economic calendar (FOMC, CPI, NFP, etc.) for next N days.
 * NOTE: /calendar/economic is a Finnhub premium endpoint — free tier returns 403.
 * On 403 this returns [] so the caller can fall back to seeded dates.
 */
async function getEconomicCalendar(daysAhead = 30) {
  let data;
  try {
    data = await finnhubGet(`/calendar/economic`);
  } catch (err) {
    if (err.status === 403) return []; // premium gate — degrade silently
    throw err;
  }
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + daysAhead);
  const items = data?.economicCalendar ?? [];
  return items
    .filter(e => {
      const d = new Date(e.time ?? e.date ?? "");
      return !isNaN(d) && d >= new Date() && d <= cutoff;
    })
    .slice(0, 20)
    .map(e => ({
      event:    e.event,
      country:  e.country,
      date:     e.time ?? e.date,
      impact:   e.impact ?? "",
      actual:   e.actual,
      estimate: e.estimate,
      previous: e.previous,
    }));
}

/**
 * Sentiment for a ticker from news articles (Finnhub sentiment endpoint).
 * Returns { bullishPct, bearishPct, score, articlesScanned }
 */
async function getNewsSentiment(ticker) {
  try {
    const data = await finnhubGet(`/news-sentiment?symbol=${ticker}`);
    return {
      bullishPct:    data.sentiment?.bullishPercent ?? null,
      bearishPct:    data.sentiment?.bearishPercent ?? null,
      score:         data.companyNewsScore ?? null,
      articlesScanned: data.buzz?.articlesInLastWeek ?? null,
    };
  } catch (err) {
    console.warn(`[Finnhub] Sentiment failed for ${ticker}:`, err.message);
    return null;
  }
}

/**
 * isConfigured — returns true if API key is set.
 */
function isConfigured() {
  return !!process.env.FINNHUB_API_KEY;
}

module.exports = {
  getMarketNews,
  getCompanyNews,
  getEarningsCalendar,
  getEconomicCalendar,
  getNewsSentiment,
  isConfigured,
  TTL_NEWS_MS,
  TTL_CALENDAR_MS,
};
