/**
 * server/routes/correlations.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GET /api/correlations/full
 *   Runs the full cross-asset correlation + MA-crossover backtest engine.
 *   Data: FRED monthly series (9 series, 10-year history).
 *   Computation: entirely deterministic — no AI cost.
 *   Cache: 24 hours (FRED historical data is stable).
 *   ?refresh=true  — bust cache and re-fetch all series.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const { Router }      = require("express");
const cache           = require("../cache");
const fredSeries      = require("../providers/fredSeries");
const correlationEngine = require("../engine/correlationEngine");

const router      = Router();
const CACHE_KEY   = "correlations:full";
const TTL_24H     = 24 * 60 * 60 * 1000;

function now()     { return new Date().toISOString(); }
function envelope(data, source = "live", stale = false, warnings = []) {
  return { source, fetchedAt: now(), stale, warnings, data };
}

// GET /api/correlations/full
router.get("/full", async (req, res) => {
  const force = req.query.refresh === "true";

  if (!force) {
    const cached = cache.getWithMeta(CACHE_KEY);
    if (cached && !cached.stale) {
      return res.json(envelope(cached.value, "cache", false));
    }
  }

  if (!process.env.FRED_API_KEY) {
    return res.status(503).json({
      error:  "FRED_API_KEY not configured",
      code:   "NO_FRED_KEY",
      source: "error",
    });
  }

  const warnings = [];

  // Fetch all series (cached 24h internally in fredSeries provider)
  let allSeries;
  try {
    allSeries = await fredSeries.fetchAllSeries(force);
  } catch (err) {
    console.error("[correlations] Fatal error fetching FRED series:", err.message);
    return res.status(503).json({
      error:  "Failed to fetch FRED series: " + err.message,
      source: "error",
    });
  }

  // Collect warnings for series that failed
  for (const s of allSeries) {
    if (s.error) {
      warnings.push(`${s.id} (${s.name}) fetch failed — dependent pairs will be skipped.`);
    }
  }

  // Run correlation + backtest engine (pure computation, no API calls)
  let result;
  try {
    result = correlationEngine.runFullAnalysis(allSeries);
  } catch (err) {
    console.error("[correlations] Engine error:", err.message);
    return res.status(500).json({
      error:  "Correlation engine error: " + err.message,
      source: "error",
    });
  }

  cache.set(CACHE_KEY, result, TTL_24H);
  res.json(envelope(result, "live", false, warnings));
});

module.exports = router;
