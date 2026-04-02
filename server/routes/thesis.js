/**
 * server/routes/thesis.js
 * ─────────────────────────────────────────────────────────────────────────────
 * POST /api/thesis
 *
 * Evaluates a user-written investment thesis using Claude with web_search.
 * Returns a structured bull / bear / base scoring with specific catalysts,
 * risks, and current key metrics pulled live from the web.
 *
 * Request body: { ticker: string, thesis: string, horizon?: string }
 * Response:     { source, ticker, thesis, horizon, bull, bear, base,
 *                 confidence, risks, keyMetrics, fetchedAt }
 *
 * Caching: theses are cached 30 min keyed by ticker + first 100 chars of
 * thesis text. A changed thesis (even slightly) gets fresh scoring.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const { Router } = require("express");
const cache      = require("../cache");
const { evaluateThesis } = require("../providers/anthropic");

const router = Router();
const TTL    = 30 * 60_000; // 30 minutes

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Lightweight cache key: ticker + digest of thesis text */
function cacheKey(ticker, thesis) {
  // Use first 80 chars of thesis as discriminator (good enough for 30-min cache)
  const slug = thesis.trim().slice(0, 80).replace(/\s+/g, "_").replace(/[^\w_]/g, "");
  return `thesis:${ticker}:${slug}`;
}

// ── Route handler ─────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  const { ticker, thesis, horizon = "12 months" } = req.body || {};

  // ── Validate ────────────────────────────────────────────────────────────────
  if (!ticker || typeof ticker !== "string") {
    return res.status(400).json({ error: "ticker is required" });
  }
  if (!thesis || typeof thesis !== "string") {
    return res.status(400).json({ error: "thesis is required" });
  }
  if (thesis.trim().length < 20) {
    return res.status(400).json({ error: "thesis must be at least 20 characters" });
  }

  const sym = ticker.toUpperCase().trim();
  const key = cacheKey(sym, thesis);

  // ── Cache hit ───────────────────────────────────────────────────────────────
  if (cache.has(key)) {
    const meta = cache.getWithMeta(key);
    return res.json({ source: "cache", fetchedAt: meta.fetchedAt, stale: meta.stale, ...meta.value });
  }

  // ── Live AI evaluation ──────────────────────────────────────────────────────
  try {
    const result = await evaluateThesis(sym, thesis, horizon);

    const payload = {
      ticker:    sym,
      thesis:    thesis.trim(),
      horizon,
      bull:      result.bull,
      bear:      result.bear,
      base:      result.base,
      confidence: result.confidence ?? 70,
      risks:     result.risks      ?? [],
      keyMetrics: result.keyMetrics ?? {},
      fetchedAt: new Date().toISOString(),
    };

    cache.set(key, payload, TTL);
    return res.json({ source: "live", ...payload });

  } catch (err) {
    console.error("[thesis] AI evaluation failed:", err.message);

    // Return a structured degraded response — never 500
    return res.status(200).json({
      source:    "error",
      ticker:    sym,
      thesis:    thesis.trim(),
      horizon,
      error:     true,
      message:   "Thesis evaluation temporarily unavailable. The AI service returned an error — please try again in a moment.",
      fetchedAt: new Date().toISOString(),
    });
  }
});

module.exports = router;
