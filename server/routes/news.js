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
const { isDemoMode } = require("../demoMode");

const router = Router();

/**
 * DEMO-ONLY macro calendar. Served only when DEMO_MODE=true.
 *
 * It claimed to be "sourced from Fed Reserve, BLS, and BEA release schedules",
 * but its FOMC dates (19 Mar, 7 May, 18 Jun, 30 Jul, 17 Sep 2026) appear to
 * follow the Fed's 2025 meeting pattern, and nothing here could be checked
 * against the published schedules from this environment. A calendar that may
 * be a year out is worse than an empty one labelled unavailable.
 */
const MACRO_CALENDAR_SEED = [
  // ── FOMC meetings (Fed decision days) ──────────────────────────────────────
  { event: "FOMC Rate Decision",    country: "US", date: "2026-03-19", impact: "high",   estimate: "4.25–4.50%", previous: "4.25–4.50%" },
  { event: "FOMC Rate Decision",    country: "US", date: "2026-05-07", impact: "high",   estimate: null,         previous: "4.25–4.50%" },
  { event: "FOMC Rate Decision",    country: "US", date: "2026-06-18", impact: "high",   estimate: null,         previous: null },
  { event: "FOMC Rate Decision",    country: "US", date: "2026-07-30", impact: "high",   estimate: null,         previous: null },
  { event: "FOMC Rate Decision",    country: "US", date: "2026-09-17", impact: "high",   estimate: null,         previous: null },
  // ── CPI (BLS, 8:30 ET) ─────────────────────────────────────────────────────
  { event: "US CPI (YoY)",          country: "US", date: "2026-04-10", impact: "high",   estimate: null,         previous: "2.8%" },
  { event: "US CPI (YoY)",          country: "US", date: "2026-05-13", impact: "high",   estimate: null,         previous: null },
  { event: "US CPI (YoY)",          country: "US", date: "2026-06-11", impact: "high",   estimate: null,         previous: null },
  { event: "US CPI (YoY)",          country: "US", date: "2026-07-10", impact: "high",   estimate: null,         previous: null },
  // ── NFP / Non-Farm Payrolls (BLS, 8:30 ET, first Fri of month) ────────────
  { event: "Non-Farm Payrolls",     country: "US", date: "2026-04-04", impact: "high",   estimate: null,         previous: "151k" },
  { event: "Non-Farm Payrolls",     country: "US", date: "2026-05-02", impact: "high",   estimate: null,         previous: null },
  { event: "Non-Farm Payrolls",     country: "US", date: "2026-06-05", impact: "high",   estimate: null,         previous: null },
  { event: "Non-Farm Payrolls",     country: "US", date: "2026-07-03", impact: "high",   estimate: null,         previous: null },
  // ── PCE Price Index (BEA, 8:30 ET) ────────────────────────────────────────
  { event: "PCE Price Index (YoY)", country: "US", date: "2026-03-28", impact: "high",   estimate: null,         previous: "2.5%" },
  { event: "PCE Price Index (YoY)", country: "US", date: "2026-04-30", impact: "high",   estimate: null,         previous: null },
  { event: "PCE Price Index (YoY)", country: "US", date: "2026-05-29", impact: "high",   estimate: null,         previous: null },
  { event: "PCE Price Index (YoY)", country: "US", date: "2026-06-26", impact: "high",   estimate: null,         previous: null },
  // ── GDP (BEA, advance estimate) ────────────────────────────────────────────
  { event: "US GDP (QoQ, adv.)",    country: "US", date: "2026-04-29", impact: "medium", estimate: null,         previous: "2.3%" },
  { event: "US GDP (QoQ, adv.)",    country: "US", date: "2026-07-29", impact: "medium", estimate: null,         previous: null },
  // ── UK events ──────────────────────────────────────────────────────────────
  { event: "BoE Rate Decision",     country: "GB", date: "2026-05-08", impact: "high",   estimate: null,         previous: "4.50%" },
  { event: "UK CPI (YoY)",          country: "GB", date: "2026-04-16", impact: "medium", estimate: null,         previous: "2.8%" },
].map(e => ({ ...e, seeded: true, kind: "demo" }));

/**
 * Filter seeded calendar to upcoming events within daysAhead window.
 */
function upcomingSeededEvents(daysAhead = 30) {
  if (!isDemoMode()) return [];
  const now    = new Date();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + daysAhead);
  return MACRO_CALENDAR_SEED.filter(e => {
    const d = new Date(e.date);
    return !isNaN(d) && d >= now && d <= cutoff;
  });
}

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
    return { data: fallback, source: "unavailable", stale: true };
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

  // Finnhub economic calendar is a premium feature — fall back to seeded dates
  const economic = (economicRaw && economicRaw.length > 0)
    ? economicRaw
    : upcomingSeededEvents(30);
  const econSourceLabel =
    economic[0]?.seeded ? "demo" :
    economic.length     ? (econSource === "unavailable" ? "unavailable" : "live") :
                          "unavailable";

  res.json(envelope({
    headlines,
    economicCalendar: economic,
    econCalendarSource: econSourceLabel,
    ...(econSourceLabel === "unavailable" ? {
      econCalendarNote: "Economic calendar unavailable: Finnhub's economic calendar is a premium endpoint on the free tier, and no hand-entered calendar is shown outside DEMO_MODE.",
    } : {}),
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
  // Fall back to seeded calendar when Finnhub premium endpoint unavailable
  const economic  = (econRaw && econRaw.length > 0) ? econRaw : upcomingSeededEvents(daysAhead);

  res.json(envelope({
    earnings, economic, daysAhead,
    economicSource: economic[0]?.seeded ? "demo" : economic.length ? "live" : "unavailable",
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
