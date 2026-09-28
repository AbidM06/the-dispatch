/**
 * server/routes/pitch.js
 * ─────────────────────────────────────────────────────────────────────────────
 * POST /api/pitch/:ticker
 *
 * Manual, on-demand single-stock equity pitch generator (conclusion-first
 * analyst format). NEVER called by schedulers/cron — strictly user-triggered
 * to control Anthropic spend.
 *
 * One Sonnet call with web_search per pitch. Cached 24h per ticker (no-context
 * requests). Requests with a `context` body field always go live (the framing
 * changes the output, so caching by ticker alone would be misleading) and
 * `?force=true` bypasses the cache for an explicit regenerate.
 *
 * Degrades gracefully: if LOW_COST_MODE=true or the API-credit fallback window
 * is active, returns HTTP 200 with `source: "error"` and no AI call.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { Router } = require("express");
const cache   = require("../cache");
const { generatePitch } = require("../providers/anthropic");
const { getApiFallbackInfo } = require("../providers/budget");
const { schemas, validate }  = require("../schemas");

const router = Router();

// Pitches are research narratives, not live prices — 24h TTL like /explain.
// Override with CACHE_TTL_PITCH (minutes).
const TTL_PITCH = (parseInt(process.env.CACHE_TTL_PITCH, 10) || 1440) * 60_000; // default 24h

const LOW_COST = () => process.env.LOW_COST_MODE === "true";

function unavailablePayload(ticker) {
  return {
    ticker,
    companyName:  "",
    direction:    "OVERWEIGHT",
    priceTarget:  null,
    currentPrice: null,
    timeframe:    "",
    upsidePct:    null,
    conclusion:   "Pitch unavailable — AI service is in budget/fallback mode.",
    scene:        "",
    thesis:       "",
    catalyst:     "",
    risks:        [],
    hedge:        "",
    confidence:   0,
  };
}

// ── POST /api/pitch/:ticker ─────────────────────────────────────────────────────
router.post("/:ticker", async (req, res) => {
  const ticker   = req.params.ticker.toUpperCase().trim();
  const context  = (req.body && typeof req.body.context === "string") ? req.body.context.trim() : "";
  const force    = req.query.force === "true";
  const cacheKey = `pitch:${ticker}`;

  // Cache hit — only for context-free, non-forced requests
  if (!context && !force && cache.has(cacheKey)) {
    const meta = cache.getWithMeta(cacheKey);
    const response = {
      source:    "cache",
      fetchedAt: meta.fetchedAt,
      stale:     meta.stale,
      data:      meta.value,
    };
    const { ok, data } = validate(schemas.PitchResponse, response);
    return res.json(ok ? data : response);
  }

  // Budget/fallback gate — no AI call in low-cost or fallback mode
  const fallback = getApiFallbackInfo();
  if (LOW_COST() || fallback.active) {
    return res.status(200).json({
      source:    "error",
      fetchedAt: new Date().toISOString(),
      stale:     true,
      data:      unavailablePayload(ticker),
      _note: LOW_COST()
        ? "LOW_COST_MODE=true — AI pitch generation disabled."
        : `API credits exhausted — deterministic fallback active. Retrying in ${fallback.retryInMins} min.`,
    });
  }

  // Live AI call
  try {
    const pitch = await generatePitch(ticker, context);
    if (!context) cache.set(cacheKey, pitch, TTL_PITCH);

    const response = {
      source:    "live",
      fetchedAt: new Date().toISOString(),
      stale:     false,
      data:      pitch,
    };
    const { ok, data, errors } = validate(schemas.PitchResponse, response);
    if (!ok) console.warn(`[pitch/${ticker}] Schema warnings:`, errors);
    res.json(ok ? data : response);
  } catch (err) {
    console.error(`[pitch/${ticker}] AI call failed:`, err.message);
    res.status(200).json({
      source:    "error",
      fetchedAt: new Date().toISOString(),
      stale:     true,
      data:      unavailablePayload(ticker),
      _error: err.message,
    });
  }
});

module.exports = router;
