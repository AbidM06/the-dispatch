/**
 * server/jobs/aiRefreshJob.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Daily AI refresh scheduler — keeps events, econ, and risk caches current
 * without requiring manual endpoint calls.
 *
 * Runs once per day at AI_REFRESH_TIME (default "07:30"), Mon–Fri.
 * Skipped when LOW_COST_MODE=true or API credits are exhausted.
 *
 * This mirrors what POST /api/events/refresh does internally:
 *   1. Fetch latest news context from Finnhub (best-effort)
 *   2. Call fetchAllAnalysis() → events + risks + econ
 *   3. Populate cache keys events:items, events:econ, risk:scores (24h TTL)
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const cache              = require("../cache");
const seeds              = require("../../seeds/fallback");
const { fetchAllAnalysis } = require("../providers/anthropic");
const { isApiFallback }  = require("../providers/budget");
const { generateNarrative } = require("../analytics/narrativeEngine");

const CACHE_KEY_EVENTS = "events:items";
const CACHE_KEY_ECON   = "events:econ";
const CACHE_KEY_RISK   = "risk:scores";
const TTL_AI           = (parseInt(process.env.CACHE_TTL_EVENTS, 10) || 1440) * 60_000; // 24h
const TICK_INTERVAL_MS = 60_000; // check every minute

const RUN_TIME = (process.env.AI_REFRESH_TIME || "07:30").trim();

const status = {
  lastRunAt:       null,   // set only after successful cache write
  lastAttemptAt:   null,   // set at start of every attempt
  dailyRetryCount: 0,      // resets at midnight
  lastRetryDay:    null,   // YYYY-MM-DD of last retry day
  nextRunAt:       null,
  intervalId:      null,
  lastError:       null,
};

function hhmm(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function isWeekday(date) {
  const d = date.getDay();
  return d >= 1 && d <= 5;
}

const MAX_DAILY_RETRIES = 5;
const RETRY_INTERVAL_MS = 15 * 60_000; // 15 minutes between retries

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function resetDailyRetryCountIfNeeded() {
  const today = todayDate();
  if (status.lastRetryDay !== today) {
    status.dailyRetryCount = 0;
    status.lastRetryDay = today;
  }
}

function shouldRun() {
  const now = new Date();
  if (!isWeekday(now)) return false;

  resetDailyRetryCountIfNeeded();

  // Already succeeded today — skip
  if (status.lastRunAt) {
    const elapsed = Date.now() - new Date(status.lastRunAt).getTime();
    if (elapsed < 23 * 60 * 60_000) return false;
  }

  // Scheduled run time
  if (hhmm(now) === RUN_TIME) return true;

  // Same-day retry: run if last attempt failed, enough time has passed, and retries remain
  if (
    status.lastAttemptAt &&
    !status.lastRunAt &&
    status.dailyRetryCount < MAX_DAILY_RETRIES &&
    Date.now() - new Date(status.lastAttemptAt).getTime() >= RETRY_INTERVAL_MS
  ) {
    return true;
  }

  return false;
}

async function runRefresh() {
  const LOW_COST = process.env.LOW_COST_MODE === "true";
  if (LOW_COST || isApiFallback()) {
    console.log("[aiRefresh] Skipped — LOW_COST_MODE or API fallback active.");
    return;
  }

  console.log("[aiRefresh] Starting daily AI refresh…");
  status.lastAttemptAt = new Date().toISOString();
  status.dailyRetryCount += 1;

  try {
    // Best-effort news context (same approach as events/refresh route)
    let newsCtx = "";
    try {
      const finnhub = require("../providers/finnhub");
      const headlines = await finnhub.getMarketNews();
      if (Array.isArray(headlines) && headlines.length > 0) {
        const lines = headlines.slice(0, 5).map(h => `- ${h.headline}`);
        newsCtx = `\nLATEST MARKET NEWS:\n${lines.join("\n")}`;
      }
    } catch (_) { /* non-blocking */ }

    const { events, risks, econ } = await fetchAllAnalysis(newsCtx);

    cache.set(CACHE_KEY_EVENTS, events, TTL_AI);
    cache.set(CACHE_KEY_ECON,   econ,   TTL_AI);
    cache.set(CACHE_KEY_RISK,   risks,  TTL_AI);

    // Only record success after cache is written
    status.lastRunAt  = new Date().toISOString();
    status.lastError  = null;
    console.log(`[aiRefresh] Done — events: ${events.length}, risks: ${risks.length}, econ: ${econ.length}`);
  } catch (err) {
    status.lastError = err.message;
    console.error(`[aiRefresh] AI call failed (attempt ${status.dailyRetryCount}/${MAX_DAILY_RETRIES}):`, err.message);

    // Only write deterministic fallback if there is no existing live cached data.
    // Do NOT overwrite a good cache with synthetic content.
    const hasLiveEvents = cache.has(CACHE_KEY_EVENTS);
    const hasLiveEcon   = cache.has(CACHE_KEY_ECON);
    const hasLiveRisk   = cache.has(CACHE_KEY_RISK);

    if (!hasLiveEvents || !hasLiveEcon || !hasLiveRisk) {
      try {
        const snapData      = cache.get("snapshot:data");
        const portfolioData = cache.get("portfolio:data");
        const ctx = {
          rates:     snapData?.rates     ?? seeds.RATES_SEED,
          watchlist: snapData?.watchlist ?? seeds.WATCHLIST_SEED,
          portfolio: portfolioData       ?? [],
        };
        const { events, econ, risks } = generateNarrative(ctx);
        if (!hasLiveEvents) cache.set(CACHE_KEY_EVENTS, events, TTL_AI);
        if (!hasLiveEcon)   cache.set(CACHE_KEY_ECON,   econ,   TTL_AI);
        if (!hasLiveRisk)   cache.set(CACHE_KEY_RISK,   risks,  TTL_AI);
        console.log("[aiRefresh] Deterministic fallback written for missing cache keys.");
      } catch (fallbackErr) {
        console.error("[aiRefresh] Fallback also failed:", fallbackErr.message);
      }
    } else {
      console.log("[aiRefresh] Live cache still valid — skipping deterministic overwrite.");
    }
  }
}

function tick() {
  if (shouldRun()) runRefresh();
}

function start() {
  if (status.intervalId) return;
  status.intervalId = setInterval(tick, TICK_INTERVAL_MS);
  console.log(`[aiRefresh] Daily AI refresh scheduled at ${RUN_TIME} Mon–Fri (override: AI_REFRESH_TIME env var).`);
}

function stop() {
  if (status.intervalId) {
    clearInterval(status.intervalId);
    status.intervalId = null;
  }
}

function getStatus() {
  const { intervalId, ...rest } = status;
  return rest;
}

module.exports = { start, stop, getStatus };
