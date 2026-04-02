/**
 * server/routes/explain.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GET /api/explain/:ticker
 *
 * Returns an AI-generated explanation of a ticker or macro concept,
 * grounded in the current portfolio context.
 *
 * Cache strategy: each ticker is cached individually for 24 h.
 * Explainer content is stable (what an asset IS doesn't change hourly),
 * so a long TTL dramatically reduces AI spend without hurting UX.
 * If AI call fails and no cache exists, returns a structured error payload
 * rather than a 500 so the UI can show a graceful "unavailable" state.
 *
 * Supported tickers: any string — route is generic.
 * Known tickers for portfolio context: AMD, HIES, HIUS, HIJS, SGLN, HBKS,
 *   and macro labels: DGS10, DFII10, T10YIE, BAMLH0A0HYM2, T10Y2Y, USDGBP.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { Router } = require("express");
const cache   = require("../cache");
const { fetchTickerExplain } = require("../providers/anthropic");
const { schemas, validate }  = require("../schemas");

const router = Router();

// Explainers are stable content — 24 h TTL. Override with CACHE_TTL_EXPLAIN (minutes).
const TTL_AI = (parseInt(process.env.CACHE_TTL_EXPLAIN, 10) || 1440) * 60_000; // default 24 h

// ── GET /api/explain/:ticker ───────────────────────────────────────────────────
router.get("/:ticker", async (req, res, next) => {
  const ticker   = req.params.ticker.toUpperCase().trim();
  const cacheKey = `explain:${ticker}`;

  // Serve from cache if available
  if (cache.has(cacheKey)) {
    const meta = cache.getWithMeta(cacheKey);
    const response = {
      source:    "cache",
      fetchedAt: meta.fetchedAt,
      stale:     meta.stale,
      data:      meta.value,
    };
    const { ok, data } = validate(schemas.ExplainResponse, response);
    return res.json(ok ? data : response);
  }

  // Live AI call
  try {
    const explanation = await fetchTickerExplain(ticker);
    cache.set(cacheKey, explanation, TTL_AI);

    const response = {
      source:    "live",
      fetchedAt: new Date().toISOString(),
      stale:     false,
      data:      explanation,
    };
    const { ok, data, errors } = validate(schemas.ExplainResponse, response);
    if (!ok) console.warn(`[explain/${ticker}] Schema warnings:`, errors);
    res.json(ok ? data : response);
  } catch (err) {
    console.error(`[explain/${ticker}] AI call failed:`, err.message);

    // Structured error payload — UI renders "Analysis unavailable" state
    res.status(200).json({
      source:    "error",
      fetchedAt: new Date().toISOString(),
      stale:     true,
      data: {
        ticker,
        what:       "Explanation unavailable — AI service could not be reached.",
        now:        "Please try again in a moment.",
        portfolio:  "Portfolio impact analysis is temporarily unavailable.",
        confidence: 0,
      },
      _error: err.message,
    });
  }
});

module.exports = router;
