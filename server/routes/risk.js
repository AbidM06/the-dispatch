/**
 * server/routes/risk.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GET  /api/risk          — return current risk scores (cache → deterministic → seed)
 * POST /api/risk/refresh  — triggers merged AI refresh (events + risks + econ)
 *
 * Hardening pass (Phase 1 — zero-extra-API):
 *   - TTL extended to 24 h (was 12 h). Override: CACHE_TTL_EVENTS (minutes).
 *   - Cooldown raised to 60 min (was 10 min). Override: EVENTS_COOLDOWN_MIN.
 *   - LOW_COST_MODE=true: GET returns deterministic narrative; POST refresh
 *     blocked unless force:true.
 *   - Budget exhaustion: falls back to deterministic narrative.
 *   - analysisMode: "ai" | "deterministic" | "seeded" added to all responses.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { Router } = require("express");
const cache    = require("../cache");
const { fetchAllAnalysis }                        = require("../providers/anthropic");
const { isApiFallback, clearApiFallback,
        setApiFallback, getApiFallbackInfo }      = require("../providers/budget");
const { generateNarrative } = require("../analytics/narrativeEngine");
const { schemas, validate } = require("../schemas");
const seeds = require("../../seeds/fallback");
const requireWriteAuth = require("../middleware/auth");

const router = Router();

const CACHE_KEY      = "risk:scores";
const CACHE_KEY_EVT  = "events:items";
const CACHE_KEY_ECON = "events:econ";

const TTL_AI      = (parseInt(process.env.CACHE_TTL_EVENTS,    10) || 1440) * 60_000; // 24 h
const COOLDOWN_MS = (parseInt(process.env.EVENTS_COOLDOWN_MIN, 10) || 60)   * 60_000; // 60 min

const LOW_COST = () => process.env.LOW_COST_MODE === "true";

let _lastRefreshAt = 0;

function isCoolingDown() {
  return Date.now() - _lastRefreshAt < COOLDOWN_MS;
}

function riskResponse(risks, source, fetchedAt, stale, analysisMode, extra = {}) {
  return { source, fetchedAt, stale, data: { risks }, analysisMode, ...extra };
}

/**
 * Collect rates/fx/portfolio context for the narrative engine.
 */
function getContext() {
  const snapData      = cache.get("snapshot:data");
  const portfolioData = cache.get("portfolio:data");
  return {
    rates:     snapData?.rates     || seeds.RATES_SEED,
    fx:        snapData?.fx        || seeds.FX_SEED,
    portfolio: portfolioData       || null,
  };
}

// ── GET /api/risk ──────────────────────────────────────────────────────────────
router.get("/", (req, res) => {
  // 1. Cache hit
  if (cache.has(CACHE_KEY)) {
    const meta = cache.getWithMeta(CACHE_KEY);
    const response = riskResponse(meta.value, "cache", meta.fetchedAt, meta.stale, "ai");
    const { ok, data } = validate(schemas.RiskResponse, response);
    return res.json(ok ? data : response);
  }

  // 2. LOW_COST_MODE or API credits exhausted — deterministic
  if (LOW_COST() || isApiFallback()) {
    const ctx = getContext();
    const { risks } = generateNarrative(ctx);
    const now = new Date().toISOString();
    const extra = isApiFallback() ? { _apiFallback: getApiFallbackInfo() } : {};
    return res.json({ ...riskResponse(risks, "seeded", now, false, "deterministic"), ...extra });
  }

  // 3. Static seed
  const response = riskResponse(seeds.RISKS_SEED, "seeded", seeds.SEED_DATE, true, "seeded");
  const { ok, data } = validate(schemas.RiskResponse, response);
  res.json(ok ? data : response);
});

// ── POST /api/risk/refresh ─────────────────────────────────────────────────────
router.post("/refresh", requireWriteAuth, async (req, res) => {
  const { force } = req.body || {};

  // LOW_COST_MODE or API credits exhausted — no AI calls unless force
  if ((LOW_COST() || isApiFallback()) && !force) {
    const ctx = getContext();
    const { events, risks, econ } = generateNarrative(ctx);
    const now = new Date().toISOString();
    cache.set(CACHE_KEY,      risks,  TTL_AI);
    cache.set(CACHE_KEY_EVT,  events, TTL_AI);
    cache.set(CACHE_KEY_ECON, econ,   TTL_AI);
    const note = isApiFallback()
      ? `API credits exhausted — deterministic fallback active. Retrying AI in ${getApiFallbackInfo().retryInMins} min, or pass force:true to retry now.`
      : "LOW_COST_MODE=true — deterministic narrative returned. Pass force:true to call AI.";
    return res.json({
      ...riskResponse(risks, "seeded", now, false, "deterministic"),
      _lowCostMode: note,
      ...(isApiFallback() ? { _apiFallback: getApiFallbackInfo() } : {}),
    });
  }

  // Cooldown guard
  if (!force && isCoolingDown()) {
    const remaining = Math.ceil((COOLDOWN_MS - (Date.now() - _lastRefreshAt)) / 60_000);
    if (cache.has(CACHE_KEY)) {
      const meta = cache.getWithMeta(CACHE_KEY);
      return res.json({
        ...riskResponse(meta.value, "cache", meta.fetchedAt, true, "ai"),
        _cooldown: `Cooldown active — ${remaining} min remaining. Pass force:true to override.`,
      });
    }
    return res.json({
      ...riskResponse(seeds.RISKS_SEED, "seeded", seeds.SEED_DATE, true, "seeded"),
      _cooldown: `Cooldown active — ${remaining} min remaining.`,
    });
  }

  try {
    // Merged AI call — also populates events and econ as side-effect
    const { events, risks, econ } = await fetchAllAnalysis();

    // AI succeeded — credits available; exit fallback mode if active
    clearApiFallback();
    const fetchedAt = new Date().toISOString();
    _lastRefreshAt  = Date.now();

    cache.set(CACHE_KEY,      risks,  TTL_AI);
    cache.set(CACHE_KEY_EVT,  events, TTL_AI);
    cache.set(CACHE_KEY_ECON, econ,   TTL_AI);

    const response = riskResponse(risks, "live", fetchedAt, false, "ai");
    const { ok, data, errors } = validate(schemas.RiskResponse, response);
    if (!ok) console.warn("[risk/refresh] Schema warnings:", errors);
    res.json(ok ? data : response);

  } catch (err) {
    console.error("[risk/refresh] AI call failed:", err.message);

    // Budget exhausted or API credits exhausted → deterministic fallback
    const isBudgetErr = err.code === "BUDGET_DAILY" || err.code === "BUDGET_MONTHLY"
                     || err.code === "API_CREDITS_EXHAUSTED";
    // Ensure fallback state is active for billing errors (safety net for mocked tests).
    if (err.code === "API_CREDITS_EXHAUSTED") setApiFallback();
    if (isBudgetErr || LOW_COST() || isApiFallback()) {
      const ctx = getContext();
      const { events, risks, econ } = generateNarrative(ctx);
      const now = new Date().toISOString();
      cache.set(CACHE_KEY,      risks,  TTL_AI);
      cache.set(CACHE_KEY_EVT,  events, TTL_AI);
      cache.set(CACHE_KEY_ECON, econ,   TTL_AI);
      return res.json({
        ...riskResponse(risks, "seeded", now, false, "deterministic"),
        _refreshError: err.message,
      });
    }

    // Generic AI failure — reset cooldown
    _lastRefreshAt = 0;

    const meta = cache.getWithMeta(CACHE_KEY);
    if (meta) {
      return res.status(200).json({
        ...riskResponse(meta.value, "cache", meta.fetchedAt, true, "ai"),
        _refreshError: err.message,
      });
    }
    res.status(200).json({
      ...riskResponse(seeds.RISKS_SEED, "seeded", seeds.SEED_DATE, true, "seeded"),
      _refreshError: err.message,
    });
  }
});

module.exports = router;
