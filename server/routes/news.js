/**
 * server/routes/news.js
 * GET /api/news              — live market headlines + macro calendar
 * GET /api/news/:ticker      — company-specific news + sentiment
 * GET /api/news/calendar     — earnings + economic events calendar
 */
"use strict";

const { Router } = require("express");
const cache      = require("../cache");
const finnhub    = require("../providers/finnhub");

const router = Router();

/**
 * No hand-typed calendar. The old seed listed FOMC/CPI/NFP/PCE dates and
 * "previous" prints typed in once (the FOMC dates followed the 2025 pattern)
 * and served them as the live calendar whenever Finnhub's premium economic
 * endpoint refused — unverifiable dates presented as fact. When the live
 * calendar is unavailable the response says so (`economicSource`).
 */
const CALENDAR_UNAVAILABLE_NOTE =
  "Economic calendar unavailable — Finnhub's economic calendar requires a paid plan and returned no data.";

function now() { return new Date().toISOString(); }

function envelope(data, source = "live", stale = false) {
  return { source, fetchedAt: now(), stale, data };
}

async function resolveWithFallback(cacheKey, fetchFn, ttlMs, fallback) {
  const cached = cache.getWithMeta(cacheKey);
  if (cached && !cached.stale) return { data: cached.value, source: "cache", stale: false };
  try {
    const fresh = await fetchFn();
    cache.set(cacheKey, fresh, ttlMs);
    return { data: fresh, source: "live", stale: false };
  } catch (err) {
    console.warn(`[news] fetch failed (${cacheKey}):`, err.message);
    if (cached) return { data: cached.value, source: "cache", stale: true };
    return { data: fallback, source: "seeded", stale: true };
  }
}

// GET /api/news
router.get("/", async (req, res) => {
  const { data: headlines, source, stale } = await resolveWithFallback(
    "news:market",
    () => finnhub.getMarketNews("general", 12),
    finnhub.TTL_NEWS_MS,
    []
  );

  const { data: economicRaw, source: econSource } = await resolveWithFallback(
    "news:economic-calendar",
    () => finnhub.getEconomicCalendar(30),
    finnhub.TTL_CALENDAR_MS,
    []
  );

  // Finnhub economic calendar is a premium feature — no hand-typed substitute
  const haveEcon = Array.isArray(economicRaw) && economicRaw.length > 0;

  res.json(envelope({
    headlines,
    economicCalendar: haveEcon ? economicRaw : [],
    econCalendarSource: haveEcon ? (econSource === "seeded" ? "stale" : "live") : "unavailable",
    ...(haveEcon ? {} : { econCalendarNote: CALENDAR_UNAVAILABLE_NOTE }),
    configured: finnhub.isConfigured(),
  }, source, stale));
});

// GET /api/news/calendar  — must be BEFORE /:ticker
router.get("/calendar", async (req, res) => {
  const daysAhead = Math.min(parseInt(req.query.days || "45", 10), 90);

  const [earningsResult, economicResult] = await Promise.allSettled([
    resolveWithFallback(
      "news:earnings-calendar",
      () => finnhub.getEarningsCalendar(daysAhead),
      finnhub.TTL_CALENDAR_MS,
      []
    ),
    resolveWithFallback(
      "news:economic-calendar",
      () => finnhub.getEconomicCalendar(daysAhead),
      finnhub.TTL_CALENDAR_MS,
      []
    ),
  ]);

  const earnings  = earningsResult.status === "fulfilled" ? earningsResult.value.data : [];
  const econRaw   = economicResult.status === "fulfilled" ? economicResult.value.data : [];
  const haveEcon  = Array.isArray(econRaw) && econRaw.length > 0;

  res.json(envelope({
    earnings,
    economic: haveEcon ? econRaw : [],
    economicSource: haveEcon ? "live" : "unavailable",
    ...(haveEcon ? {} : { economicNote: CALENDAR_UNAVAILABLE_NOTE }),
    daysAhead,
  }));
});

// GET /api/news/:ticker
router.get("/:ticker", async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();

  const [newsResult, sentimentResult] = await Promise.allSettled([
    resolveWithFallback(
      `news:company:${ticker}`,
      () => finnhub.getCompanyNews(ticker, 7, 8),
      finnhub.TTL_NEWS_MS,
      []
    ),
    finnhub.getNewsSentiment(ticker).catch(() => null),
  ]);

  const articles  = newsResult.status === "fulfilled" ? newsResult.value.data : [];
  const sentiment = sentimentResult.status === "fulfilled" ? sentimentResult.value : null;

  res.json(envelope({ ticker, articles, sentiment, configured: finnhub.isConfigured() }));
});

module.exports = router;
