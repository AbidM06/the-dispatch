/**
 * server/routes/events.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GET  /api/events         — return market events + econ analysis (cache → deterministic → seed)
 * POST /api/events/refresh — trigger AI refresh or return deterministic fallback
 *
 * Hardening pass (Phase 1 — zero-extra-API):
 *   - TTL extended to 24 h (was 12 h). Override: CACHE_TTL_EVENTS (minutes).
 *   - Cooldown raised to 60 min (was 10 min). Override: EVENTS_COOLDOWN_MIN.
 *   - LOW_COST_MODE=true: GET returns deterministic narrative; POST refresh
 *     blocked unless force:true (returns deterministic without calling AI).
 *   - Budget exhaustion (BUDGET_DAILY / BUDGET_MONTHLY): falls back to
 *     deterministic narrative instead of seeded static data.
 *   - analysisMode: "ai" | "deterministic" | "seeded" added to every response.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { Router } = require("express");
const cache    = require("../cache");
const { fetchAllAnalysis }                        = require("../providers/anthropic");
const { isApiFallback, clearApiFallback,
        setApiFallback, getApiFallbackInfo }      = require("../providers/budget");
const { generateNarrative } = require("../analytics/narrativeEngine");
const { schemas, validate } = require("../schemas");
const requireWriteAuth = require("../middleware/auth");
const store = require("../analytics/analysisStore");

const router = Router();

/**
 * Build a short news context string from Finnhub headlines to feed into the AI prompt.
 * Returns empty string if Finnhub is not configured or fetch fails.
 */
async function buildNewsContext() {
  const finnhub = require("../providers/finnhub");
  if (!finnhub.isConfigured()) return "";
  try {
    const headlines = await finnhub.getMarketNews("general", 6);
    if (!headlines.length) return "";
    const lines = headlines.map(h => `- ${h.headline} (${h.source}, ${h.datetime.slice(0, 10)})`);
    return `\nLATEST MARKET NEWS:\n${lines.join("\n")}`;
  } catch (_) { return ""; }
}

const CACHE_KEY_EVENTS = "events:items";
const CACHE_KEY_ECON   = "events:econ";
const CACHE_KEY_RISK   = "risk:scores";  // shared with risk route

const TTL_AI      = (parseInt(process.env.CACHE_TTL_EVENTS,  10) || 1440) * 60_000; // 24 h default
const COOLDOWN_MS = (parseInt(process.env.EVENTS_COOLDOWN_MIN, 10) || 60) * 60_000; // 60 min default

const LOW_COST = () => process.env.LOW_COST_MODE === "true";

let _lastRefreshAt = 0;

function isCoolingDown() {
  return Date.now() - _lastRefreshAt < COOLDOWN_MS;
}

function buildResponse(events, econ, source, fetchedAt, stale, analysisMode, extra = {}) {
  return { source, fetchedAt, stale, data: { events, econ }, analysisMode, ...extra };
}

// Rates/FX facts from the snapshot — never seed levels. See analysisStore.
const getContext = store.narrativeContext;

/** Deterministic narrative, stored WITH its mode so a later read keeps it. */
function computeAndStore() {
  const n = generateNarrative(getContext());
  store.storeAnalysis(CACHE_KEY_EVENTS, n.events, "deterministic", TTL_AI, { inputs: n.inputs });
  store.storeAnalysis(CACHE_KEY_ECON,   n.econ,   "deterministic", TTL_AI, { inputs: n.inputs });
  store.storeAnalysis(CACHE_KEY_RISK,   n.risks,  "deterministic", TTL_AI, { inputs: n.inputs });
  return n;
}

function fallbackResponse(extra = {}) {
  const ev = store.fallback("events");
  const ec = store.fallback("econ");
  return buildResponse(ev.items, ec.items, ev.source, ev.fetchedAt, true, ev.analysisMode,
                       { reason: ev.reason, ...extra });
}

// ── GET /api/events ────────────────────────────────────────────────────────────
router.get("/", (req, res) => {
  // 1. Cache hit — served with the mode that PRODUCED it, not assumed "ai".
  const em = store.readAnalysis(CACHE_KEY_EVENTS);
  const ec = store.readAnalysis(CACHE_KEY_ECON);
  if (em && ec) {
    const response = buildResponse(em.items, ec.items, store.sourceFor(em.analysisMode), em.fetchedAt,
                                   em.stale || ec.stale, em.analysisMode, em.inputs ? { inputs: em.inputs } : {});
    const { ok, data } = validate(schemas.EventsResponse, response);
    return res.json(ok ? data : response);
  }

  // 2. LOW_COST_MODE or API credits exhausted — deterministic narrative
  if (LOW_COST() || isApiFallback()) {
    const n = generateNarrative(getContext());
    const now = new Date().toISOString();
    const extra = isApiFallback() ? { _apiFallback: getApiFallbackInfo() } : {};
    return res.json({ ...buildResponse(n.events, n.econ, "computed", now, false, "deterministic", { inputs: n.inputs }), ...extra });
  }

  // 3. Nothing generated yet: demo fixtures in DEMO_MODE, else explicit empty.
  const response = fallbackResponse();
  const { ok, data } = validate(schemas.EventsResponse, response);
  res.json(ok ? data : response);
});

// ── POST /api/events/refresh ───────────────────────────────────────────────────
router.post("/refresh", requireWriteAuth, async (req, res) => {
  const { force } = req.body || {};

  // LOW_COST_MODE or API credits exhausted — no AI calls unless force overrides
  if ((LOW_COST() || isApiFallback()) && !force) {
    const { events, econ, inputs } = computeAndStore();
    const now = new Date().toISOString();
    const note = isApiFallback()
      ? `API credits exhausted — deterministic fallback active. Retrying AI in ${getApiFallbackInfo().retryInMins} min, or pass force:true to retry now.`
      : "LOW_COST_MODE=true — deterministic narrative returned. Pass force:true to call AI.";
    return res.json({
      ...buildResponse(events, econ, "computed", now, false, "deterministic", { inputs }),
      _lowCostMode: note,
      ...(isApiFallback() ? { _apiFallback: getApiFallbackInfo() } : {}),
    });
  }

  // Cooldown guard
  if (!force && isCoolingDown()) {
    const remaining = Math.ceil((COOLDOWN_MS - (Date.now() - _lastRefreshAt)) / 60_000);
    const em = store.readAnalysis(CACHE_KEY_EVENTS);
    const ec = store.readAnalysis(CACHE_KEY_ECON);
    if (em && ec) {
      return res.json({
        ...buildResponse(em.items, ec.items, store.sourceFor(em.analysisMode), em.fetchedAt, true, em.analysisMode),
        _cooldown: `Refresh cooldown active — ${remaining} min remaining. Pass force:true to override.`,
      });
    }
    return res.json(fallbackResponse({ _cooldown: `Refresh cooldown active — ${remaining} min remaining.` }));
  }

  try {
    // Build news context from Finnhub (best-effort, non-blocking on failure)
    const newsCtx = await buildNewsContext();

    // Single merged AI call — returns events + risks + econ
    const { events, risks, econ } = await fetchAllAnalysis(newsCtx);

    // AI succeeded — credits are available; exit fallback mode if active
    clearApiFallback();
    const fetchedAt    = new Date().toISOString();
    _lastRefreshAt     = Date.now();

    store.storeAnalysis(CACHE_KEY_EVENTS, events, "ai", TTL_AI);
    store.storeAnalysis(CACHE_KEY_ECON,   econ,   "ai", TTL_AI);
    store.storeAnalysis(CACHE_KEY_RISK,   risks,  "ai", TTL_AI);

    const response = buildResponse(events, econ, "live", fetchedAt, false, "ai");
    const { ok, data, errors } = validate(schemas.EventsResponse, response);
    if (!ok) console.warn("[events/refresh] Schema warnings:", errors);
    res.json({ ...(ok ? data : response), analysisMode: "ai" });

  } catch (err) {
    console.error("[events/refresh] AI call failed:", err.message);

    // Budget exhausted or API credits exhausted → deterministic fallback
    const isBudgetErr = err.code === "BUDGET_DAILY" || err.code === "BUDGET_MONTHLY"
                     || err.code === "API_CREDITS_EXHAUSTED";
    // Ensure fallback state is active for billing errors (anthropic.js also sets it,
    // but mocked tests bypass callClaude so we set it here too as a safety net).
    if (err.code === "API_CREDITS_EXHAUSTED") setApiFallback();
    if (isBudgetErr || LOW_COST() || isApiFallback()) {
      const { events, econ, inputs } = computeAndStore();
      const now = new Date().toISOString();
      return res.json({
        ...buildResponse(events, econ, "computed", now, false, "deterministic", { inputs }),
        _refreshError: err.message,
      });
    }

    // Generic AI failure — reset cooldown so user can retry immediately
    _lastRefreshAt = 0;

    const em = store.readAnalysis(CACHE_KEY_EVENTS, { allowExpired: true });
    const ec = store.readAnalysis(CACHE_KEY_ECON,   { allowExpired: true });
    if (em && ec) {
      return res.status(200).json({
        ...buildResponse(em.items, ec.items, store.sourceFor(em.analysisMode), em.fetchedAt, true, em.analysisMode),
        _refreshError: err.message,
      });
    }
    res.status(200).json(fallbackResponse({ _refreshError: err.message }));
  }
});

module.exports = router;
