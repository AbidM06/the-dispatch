/**
 * server/routes/correlationsCustom.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Custom backtest builder + saved models CRUD.
 *
 *   POST   /api/correlations/custom              — run a one-off backtest (no save)
 *   GET    /api/correlations/saved               — list all saved models
 *   POST   /api/correlations/saved               — run + save a named model
 *   DELETE /api/correlations/saved/:id           — delete a saved model
 *   POST   /api/correlations/saved/:id/narrate   — generate AI talking points
 *
 * The custom endpoint re-uses the cached FRED series (fetchAllSeries, 24h TTL)
 * so no extra FRED quota is consumed after the first /api/correlations/full load.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const { Router }        = require("express");
const fredSeries        = require("../providers/fredSeries");
const { runCustomBacktest, getCurrentRegime } = require("../engine/correlationEngine");
const { listModels, saveModel, getModel, deleteModel, updateModel } = require("../importers/savedModels");
const { callClaude }    = require("../providers/anthropic");
const budget            = require("../providers/budget");
const requireWriteAuth  = require("../middleware/auth");

const router = Router();

function now() { return new Date().toISOString(); }

function stripCiteTags(str) {
  if (typeof str !== "string") return str;
  return str.replace(/<cite[^>]*>(.*?)<\/cite>/gs, "$1").replace(/<\/?cite[^>]*>/g, "");
}
function deepStrip(obj) {
  if (typeof obj === "string") return stripCiteTags(obj);
  if (Array.isArray(obj))     return obj.map(deepStrip);
  if (obj && typeof obj === "object")
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, deepStrip(v)]));
  return obj;
}

// ── Input validation ───────────────────────────────────────────────────────
const VALID_SERIES = new Set([
  "DFII10","GOLDAMGBD228NLBM","DEXUSEU","DCOILWTICO",
  "BAMLH0A0HYM2","T10YIE","DGS10","PCOPPUSDM","VIXCLS",
]);
const VALID_STRATEGIES = new Set(["ma-crossover", "zscore-reversion"]);

function validateConfig(body) {
  const { driverSeriesId, targetSeriesId, direction, strategy } = body;
  if (!driverSeriesId || !targetSeriesId)
    return "driverSeriesId and targetSeriesId are required";
  if (!VALID_SERIES.has(driverSeriesId))
    return `Unknown driverSeriesId: ${driverSeriesId}`;
  if (!VALID_SERIES.has(targetSeriesId))
    return `Unknown targetSeriesId: ${targetSeriesId}`;
  if (driverSeriesId === targetSeriesId)
    return "Driver and target must be different series";
  if (![1, -1, "1", "-1"].includes(direction))
    return "direction must be 1 or -1";
  if (strategy && !VALID_STRATEGIES.has(strategy))
    return `strategy must be one of: ${[...VALID_STRATEGIES].join(", ")}`;
  return null;
}

function buildConfig(body) {
  return {
    driverSeriesId:  body.driverSeriesId,
    targetSeriesId:  body.targetSeriesId,
    direction:       Number(body.direction),
    strategy:        body.strategy        || "ma-crossover",
    isSampleStart:   body.isSampleStart   || "2014-01-01",
    isSampleEnd:     body.isSampleEnd     || null,
    oosSampleStart:  body.oosSampleStart  || null,
    oosSampleEnd:    body.oosSampleEnd    || null,
    maFast:          body.maFast  ? Number(body.maFast)  : null,
    maSlow:          body.maSlow  ? Number(body.maSlow)  : null,
    zscoreWindow:    body.zscoreWindow    ? Number(body.zscoreWindow)    : 12,
    zscoreThreshold: body.zscoreThreshold ? Number(body.zscoreThreshold) : 1.5,
    name:            body.name?.trim() || `${body.driverSeriesId} → ${body.targetSeriesId}`,
  };
}

async function fetchSeriesAndRegime() {
  const allSeries = await fredSeries.fetchAllSeries(false);
  const seriesMap = new Map(allSeries.map(s => [s.id, s.data]));
  const regime    = getCurrentRegime(allSeries);
  return { seriesMap, regime };
}

// ── POST /api/correlations/custom ─────────────────────────────────────────
router.post("/custom", async (req, res) => {
  const err = validateConfig(req.body);
  if (err) return res.status(400).json({ error: err });
  if (!process.env.FRED_API_KEY)
    return res.status(503).json({ error: "FRED_API_KEY not configured" });

  try {
    const { seriesMap, regime } = await fetchSeriesAndRegime();
    const config = buildConfig(req.body);
    const result = runCustomBacktest(config, seriesMap);

    return res.json({
      source: "live", fetchedAt: now(),
      data: { result, regime, config },
    });
  } catch (err) {
    console.error("[correlationsCustom] custom error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/correlations/saved ────────────────────────────────────────────
router.get("/saved", (req, res) => {
  const models = listModels();
  // Strip heavy equityCurve data from list view — only sent on full load
  const slim = models.map(m => ({
    id:           m.id,
    name:         m.name,
    savedAt:      m.savedAt,
    narrativeAt:  m.narrativeAt,
    config:       m.config,
    regime:       m.regime,
    summary: m.result ? {
      currentSignal:        m.result.currentSignal,
      fullCorrelation:      m.result.fullCorrelation,
      inSampleSharpe:       m.result.backtest?.inSample?.sharpe,
      outSampleSharpe:      m.result.backtest?.outSample?.sharpe,
      outSampleReturn:      m.result.backtest?.outSample?.totalReturn,
      outSampleMaxDD:       m.result.backtest?.outSample?.maxDD,
      strategy:             m.result.strategy,
    } : null,
    narrativeData: m.narrativeData,
  }));

  res.json({ source: "file", fetchedAt: now(), data: { models: slim, count: slim.length } });
});

// ── GET /api/correlations/saved/:id ───────────────────────────────────────
router.get("/saved/:id", (req, res) => {
  const model = getModel(req.params.id);
  if (!model) return res.status(404).json({ error: "Model not found" });
  res.json({ source: "file", fetchedAt: now(), data: { model } });
});

// ── POST /api/correlations/saved ──────────────────────────────────────────
router.post("/saved", requireWriteAuth, async (req, res) => {
  const err = validateConfig(req.body);
  if (err) return res.status(400).json({ error: err });
  if (!req.body.name?.trim())
    return res.status(400).json({ error: "name is required when saving a model" });
  if (!process.env.FRED_API_KEY)
    return res.status(503).json({ error: "FRED_API_KEY not configured" });

  try {
    const { seriesMap, regime } = await fetchSeriesAndRegime();
    const config = buildConfig(req.body);
    const result = runCustomBacktest(config, seriesMap);

    if (result.error)
      return res.status(422).json({ error: result.error });

    const model = saveModel({ name: config.name, config, result, regime });
    return res.status(201).json({ source: "saved", fetchedAt: now(), data: { model } });
  } catch (err) {
    console.error("[correlationsCustom] save error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/correlations/saved/:id ────────────────────────────────────
router.delete("/saved/:id", requireWriteAuth, (req, res) => {
  deleteModel(req.params.id);
  res.status(204).end();
});

// ── POST /api/correlations/saved/:id/narrate ──────────────────────────────
router.post("/saved/:id/narrate", async (req, res) => {
  const model = getModel(req.params.id);
  if (!model) return res.status(404).json({ error: "Model not found" });

  const r      = model.result;
  const regime = model.regime ?? {};

  if (!r) return res.status(422).json({ error: "Model has no result — re-save to generate backtest first" });

  if (budget.getApiFallbackInfo().active || process.env.LOW_COST_MODE === "true") {
    const fallback = buildFallbackNarrative(r, regime, model.config);
    return res.json({ source: "deterministic", fetchedAt: now(), data: fallback });
  }

  const sig    = r.currentSignal === 1 ? "LONG" : r.currentSignal === -1 ? "SHORT" : "FLAT";
  const IS     = r.backtest?.inSample;
  const OOS    = r.backtest?.outSample;
  const corr   = r.fullCorrelation?.toFixed(3) ?? "n/a";
  const oosDeg = IS?.sharpe != null && OOS?.sharpe != null && OOS.sharpe < IS.sharpe * 0.5;

  const system = `You are a senior cross-asset strategist on a Sales & Trading desk at a top-tier investment bank. You write client-facing talking points for sales calls with hedge funds, asset managers, and pension funds. Be specific, quantify everything, and frame every observation around what it means for the client's portfolio.`;

  const user = `Analyse this custom cross-asset model and produce structured sales-desk talking points.

MODEL: ${model.name}
Driver: ${r.driverSeriesId}  →  Target: ${r.targetSeriesId}
Correlation type: ${r.direction > 0 ? "Positive (+1)" : "Negative (−1)"}
Strategy: ${r.strategy === "zscore-reversion" ? "Z-Score Mean Reversion" : "MA Crossover — Trend Following"}
In-sample: ${model.config?.isSampleStart || "2014-01-01"} → ${model.config?.isSampleEnd || "2024-03-31"}
Out-of-sample: ${model.config?.oosSampleStart || "2024-04-01"} → ${model.config?.oosSampleEnd || "present"}

BACKTEST RESULTS:
  Current signal:  ${sig}
  Pearson r:       ${corr}
  IS  — Sharpe ${IS?.sharpe ?? "n/a"}×, return ${IS?.totalReturn ?? "n/a"}%, max DD ${IS?.maxDD ?? "n/a"}%, hit rate ${IS?.hitRate ?? "n/a"}%, n=${IS?.n ?? "?"}mo
  OOS — Sharpe ${OOS?.sharpe ?? "n/a"}×, return ${OOS?.totalReturn ?? "n/a"}%, max DD ${OOS?.maxDD ?? "n/a"}%, hit rate ${OOS?.hitRate ?? "n/a"}%, n=${OOS?.n ?? "?"}mo
  ${oosDeg ? "⚠ OOS Sharpe < 50% of IS Sharpe — significant out-of-sample degradation." : ""}

MACRO REGIME: ${regime.label || "Unknown"}
${regime.metrics ? "Regime metrics: " + JSON.stringify(regime.metrics) : ""}

Return a JSON object with EXACTLY this structure:
{
  "signal_thesis": "2-3 sentences: why does the model show ${sig} right now, given current regime conditions? Be specific about the driver-target mechanism.",
  "mechanism": "1-2 sentences: the fundamental economic reason ${r.driverSeriesId} and ${r.targetSeriesId} are correlated. Use market terminology.",
  "model_quality": "1-2 sentences: honest IS vs OOS assessment. ${oosDeg ? "Flag the degradation clearly." : ""}",
  "sales_talking_points": [
    "Data-referenced point 1 — specific and actionable for a client call",
    "Point 2",
    "Point 3"
  ],
  "risks": "1-2 sentences: what would break or invert this signal.",
  "watch_list": ["specific data release or event 1", "event 2", "event 3"]
}

Return only valid JSON. No markdown fences, no text outside the JSON.`;

  try {
    const raw        = await callClaude(system, user, 900);
    const jsonMatch  = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in Claude response");
    const narrativeData = deepStrip(JSON.parse(jsonMatch[0]));

    updateModel(req.params.id, { narrativeData, narrativeAt: now() });
    return res.json({ source: "live", fetchedAt: now(), data: narrativeData });
  } catch (err) {
    console.error("[correlationsCustom] narrate error:", err.message);
    const fallback = buildFallbackNarrative(r, regime, model.config);
    return res.json({ source: "deterministic", fetchedAt: now(), data: fallback, warning: err.message });
  }
});

// ── Deterministic fallback narrative ─────────────────────────────────────
function buildFallbackNarrative(result, regime, config) {
  const sig = result?.currentSignal === 1 ? "LONG" : result?.currentSignal === -1 ? "SHORT" : "FLAT";
  const IS  = result?.backtest?.inSample;
  const OOS = result?.backtest?.outSample;
  const degraded = IS?.sharpe != null && OOS?.sharpe != null && OOS.sharpe < IS.sharpe * 0.5;
  return {
    signal_thesis: `Current signal is ${sig} on ${result?.targetSeriesId} based on ${result?.driverSeriesId} dynamics. Regime: ${regime?.label || "Unknown"}.`,
    mechanism:     `${result?.driverSeriesId} and ${result?.targetSeriesId} show a ${result?.direction > 0 ? "positive" : "negative"} historical relationship (r = ${result?.fullCorrelation?.toFixed(3) ?? "n/a"}).`,
    model_quality: IS?.sharpe != null && OOS?.sharpe != null
      ? `IS Sharpe ${IS.sharpe}× vs OOS Sharpe ${OOS.sharpe}×. ${degraded ? "Significant OOS degradation — treat signal with caution." : "Reasonable OOS stability."}`
      : "Insufficient out-of-sample data to assess model quality.",
    sales_talking_points: [
      `${result?.driverSeriesId} → ${result?.targetSeriesId}: current signal ${sig}. Pearson r = ${result?.fullCorrelation?.toFixed(3) ?? "n/a"} over selected sample.`,
      `In-sample Sharpe: ${IS?.sharpe ?? "n/a"}× (${IS?.n ?? "?"}mo). Out-of-sample: ${OOS?.sharpe ?? "n/a"}× (${OOS?.n ?? "?"}mo).`,
      `Regime context: ${regime?.label || "Uncertain"} — real yield ${regime?.metrics?.dfii10 ?? "?"}%, HY OAS ${regime?.metrics?.hy_spread ?? "?"}%.`,
    ],
    risks: "Rates-based signals do not capture earnings surprises, geopolitical shocks, or central bank communication deviations. Structural breaks (COVID, GFC) can invalidate historical correlations.",
    watch_list: ["FOMC dot plot revision", "CPI print vs breakeven inflation", "HY spread direction"],
  };
}

module.exports = router;
