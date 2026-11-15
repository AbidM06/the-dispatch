/**
 * server/routes/news.js
 * GET /api/news              — live market headlines + macro calendar
 * GET /api/news/:ticker      — company-specific news + sentiment
 * GET /api/news/calendar     — earnings + economic events calendar
 * POST /api/news/card        — { headlineId } | { top: true } → a news card (2 AI calls, button-driven; WO-03)
 * GET  /api/news/cards       — stored news cards, newest first (no AI)
 * GET  /api/news/cards/:id   — one stored card (no AI)
 * No route edits or deletes a card: the store is append-only.
 */
"use strict";

const { Router } = require("express");
const cache      = require("../cache");
const finnhub    = require("../providers/finnhub");
const requireWriteAuth = require("../middleware/auth");
const newsCard   = require("../news/card");
const cardStore  = require("../news/store");

const router = Router();

/**
 * No hand-typed calendar. The old seed listed FOMC/CPI/NFP/PCE dates and "previous" prints typed in once (the
 * FOMC dates followed the 2025 pattern) and served them as the live calendar — unverifiable dates presented as
 * fact. The economic calendar is now FRED's own release dates (markets/calendar.js, D-31, stored at each Markets
 * refresh; Finnhub's economic calendar is a paid endpoint and always came back empty). When it is unavailable the
 * response says so (`economicSource`).
 */
const econCalendar = require("../markets/calendar");

/** The economic part of a calendar response: events, where they came from, and what is missing — never invented. */
function economicPart(daysAhead) {
  const cal = econCalendar.getCalendar({ daysAhead });
  return {
    events:  cal.available ? cal.events : [],
    source:  cal.available ? (cal.stale ? "stale" : "live") : "unavailable",
    missing: cal.available ? (cal.missing || []).map(m => m.label) : [],
    note:    cal.available ? (cal.stale ? "This calendar was last refreshed more than 3 days ago." : undefined) : cal.reason,
  };
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

  const econ = economicPart(30);

  res.json(envelope({
    headlines,
    economicCalendar: econ.events,
    econCalendarSource: econ.source,
    ...(econ.note ? { econCalendarNote: econ.note } : {}),
    configured: finnhub.isConfigured(),
  }, source, stale));
});

// GET /api/news/calendar  — must be BEFORE /:ticker
router.get("/calendar", async (req, res) => {
  const daysAhead = Math.min(parseInt(req.query.days || "45", 10), 90);

  const [earningsResult] = await Promise.allSettled([
    resolveWithFallback(
      "news:earnings-calendar",
      () => finnhub.getEarningsCalendar(daysAhead),
      finnhub.TTL_CALENDAR_MS,
      []
    ),
  ]);

  const earnings = earningsResult.status === "fulfilled" ? earningsResult.value.data : [];
  const econ     = economicPart(daysAhead);

  res.json(envelope({
    earnings,
    economic: econ.events,
    economicSource: econ.source,
    economicMissing: econ.missing,
    ...(econ.note ? { economicNote: econ.note } : {}),
    daysAhead,
  }));
});

// ── News cards (WO-03) — all before /:ticker, which would otherwise swallow "cards" ──
async function currentHeadlines() {
  const cached = cache.get("news:market");
  if (cached && cached.length) return cached;
  const fresh = await finnhub.getMarketNews("general", 12);
  cache.set("news:market", fresh, finnhub.TTL_NEWS_MS);
  return fresh;
}

/** The stored FRED calendar (never fetches); a copy older than 3 days is tagged, as for idea cards. */
function currentCalendar() {
  const cal = econCalendar.getCalendar({ daysAhead: 45 });
  if (!cal.available) return [];
  return cal.stale ? cal.events.map(e => ({ ...e, calendarStale: true })) : cal.events;
}

router.post("/card", requireWriteAuth, async (req, res) => {
  const top = req.body?.top === true;
  const headlineId = req.body?.headlineId ?? null;
  if (!top && headlineId == null) return res.status(400).json({ error: "Send { headlineId } or { top: true }." });
  let headlines;
  try { headlines = await currentHeadlines(); }
  catch (err) { return res.status(503).json({ available: false, reason: `Headlines could not be loaded (${err.message}). Nothing was stored.` }); }
  if (!top && !headlines.some(h => String(h.id) === String(headlineId))) {
    return res.status(404).json({ error: "That headline is no longer in the current news feed — reload News and try again." });
  }
  try {
    const card = await newsCard.buildCard({ headlines, calendar: currentCalendar(), focusId: headlineId, top });
    res.json({ card });
  } catch (err) {
    if (err.unavailable) {
      return err.status === 404 ? res.status(404).json({ error: err.message })
        : res.status(err.status || 503).json({ available: false, reason: err.message, at: new Date().toISOString() });
    }
    console.error("[news-card]", err);
    res.status(503).json({ available: false, reason: "The news card could not be built: " + err.message, at: new Date().toISOString() });
  }
});

router.get("/cards", (req, res) => {
  res.json({ cards: cardStore.list({ limit: Math.min(parseInt(req.query.limit, 10) || 50, 200) }) });
});

router.get("/cards/:id", (req, res) => {
  const card = cardStore.get(req.params.id);
  if (!card) return res.status(404).json({ error: "News card not found" });
  res.json({ card });
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
