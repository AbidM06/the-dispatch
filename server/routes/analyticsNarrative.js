/**
 * server/routes/analyticsNarrative.js
 * ─────────────────────────────────────────────────────────────────────────────
 * POST /api/correlations/narrative
 *   Takes the current correlation engine output and asks Claude to interpret
 *   it in S&T language — regime, live signal analysis, what to watch, and
 *   2-3 talking points for a sales call.
 *
 * Accepts the full correlation result in the request body (already computed
 * by the frontend via /api/correlations/full) so we don't re-fetch FRED data.
 *
 * Uses Haiku (cheap) — this is a structured summary task, not a research report.
 * TTL: 4 hours — re-runs when the user explicitly requests it.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const { Router } = require("express");
const cache      = require("../cache");
const { callClaude } = require("../providers/anthropic");
const budget     = require("../providers/budget");

const router    = Router();
const TTL_4H    = 4 * 60 * 60 * 1000;

function now() { return new Date().toISOString(); }

function stripCiteTags(str) {
  if (typeof str !== "string") return str;
  return str.replace(/<cite[^>]*>(.*?)<\/cite>/gs, "$1").replace(/<\/?cite[^>]*>/g, "");
}

/**
 * Summarise pair results for the prompt — keep it token-efficient.
 */
function summarisePairs(pairs = []) {
  return pairs
    .filter(p => !p.error)
    .map(p => {
      const sig  = p.currentSignal === 1 ? "LONG" : p.currentSignal === -1 ? "SHORT" : "FLAT";
      const IS   = p.backtest?.inSample;
      const OOS  = p.backtest?.outSample;
      const corr = p.fullCorrelation != null ? p.fullCorrelation.toFixed(2) : "n/a";
      const isS  = IS?.sharpe  != null ? IS.sharpe  + "x"  : "n/a";
      const oosS = OOS?.sharpe != null ? OOS.sharpe + "x"  : "n/a";
      const isR  = IS?.totalReturn  != null ? IS.totalReturn  + "%" : "n/a";
      const oosR = OOS?.totalReturn != null ? OOS.totalReturn + "%" : "n/a";
      const degraded = IS?.sharpe != null && OOS?.sharpe != null && OOS.sharpe < IS.sharpe * 0.5;
      return `${p.name}: signal=${sig}, r=${corr}, IS Sharpe=${isS} (ret=${isR}), OOS Sharpe=${oosS} (ret=${oosR})${degraded ? " [DEGRADED OUT-OF-SAMPLE]" : ""}`;
    })
    .join("\n");
}

/**
 * Summarise the top correlation matrix cells for the prompt.
 */
function summariseMatrix(matrix) {
  if (!matrix?.series || !matrix?.values) return "";
  const { series, values } = matrix;
  const pairs = [];
  for (let i = 0; i < series.length; i++) {
    for (let j = i + 1; j < series.length; j++) {
      const r = values[i]?.[j];
      if (r != null) {
        pairs.push({ a: series[i].id, b: series[j].id, r });
      }
    }
  }
  // Top 5 strongest correlations (abs value)
  pairs.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
  return pairs.slice(0, 6).map(p => `${p.a} vs ${p.b}: r=${p.r.toFixed(3)}`).join("\n");
}

// Derive a stable cache key from the live signal fingerprint.
// Rotates monthly so the narrative refreshes even without an explicit ?refresh=true.
function narrativeCacheKey(pairs, regime) {
  const month   = new Date().toISOString().slice(0, 7); // "2026-04"
  const sigFP   = (pairs || []).map(p => `${p.id || "?"}:${p.currentSignal ?? 0}`).join("|");
  const regLbl  = (regime?.label || "?").replace(/\s+/g, "_");
  return `correlations:narrative:${month}:${regLbl}:${sigFP}`;
}

// POST /api/correlations/narrative
router.post("/narrative", async (req, res) => {
  const force = req.query.refresh === "true";

  const { pairs, matrix, regime, methodology } = req.body || {};
  if (!pairs || !regime) {
    return res.status(400).json({
      error: "Request body must include pairs and regime from /api/correlations/full",
    });
  }

  const cacheKey = narrativeCacheKey(pairs, regime);
  if (!force) {
    const cached = cache.getWithMeta(cacheKey);
    if (cached && !cached.stale) {
      return res.json({ source: "cache", fetchedAt: now(), data: cached.value });
    }
  }

  if (budget.getApiFallbackInfo().active || process.env.LOW_COST_MODE === "true") {
    const fallback = buildFallbackNarrative(pairs, regime);
    return res.json({ source: "deterministic", fetchedAt: now(), data: fallback });
  }

  const pairSummary   = summarisePairs(pairs);
  const matrixSummary = summariseMatrix(matrix);

  const systemPrompt = `You are a senior cross-asset strategist at a major investment bank, writing for an S&T sales desk briefing. Your output is read by salespeople who relay it to hedge fund, asset manager, and pension fund clients. Be precise, markets-literate, and direct. Never hedge with vague disclaimers — state positions clearly with supporting logic.`;

  const userPrompt = `Analyse the current cross-asset model output and produce a structured interpretation.

CURRENT MACRO REGIME: ${regime?.label || "Unknown"}
Regime metrics: ${JSON.stringify(regime?.metrics || {})}

CROSS-ASSET PAIR SIGNALS (MA-crossover backtest, in-sample / out-of-sample walk-forward):
${pairSummary}

TOP PAIRWISE CORRELATIONS (10-year Pearson):
${matrixSummary}

Backtest methodology: ${methodology?.signalMethod || "MA crossover on driver → position in correlated asset"}, IS 2014–Mar 2024, OOS Apr 2024–present, no re-optimisation in OOS.

Return a JSON object with exactly this structure:
{
  "regime_interpretation": "2-3 sentences: what this macro regime means for cross-asset positioning right now. Be specific about rates, credit, and equity implications.",
  "live_signals": [
    { "pair": "pair name", "signal": "LONG/SHORT/FLAT", "thesis": "1-2 sentences: why this signal makes sense in the current regime", "confidence": "HIGH/MEDIUM/LOW based on IS vs OOS Sharpe comparison" }
  ],
  "regime_risks": "2-3 sentences: what would break the current model signals. What is NOT being captured by rates-based signals.",
  "model_health": "1-2 sentences: honest assessment of IS vs OOS performance degradation across pairs. Flag any pairs where OOS Sharpe is less than half of IS Sharpe.",
  "sales_talking_points": [
    "Talking point 1 for a client call (specific, actionable, references data)",
    "Talking point 2",
    "Talking point 3"
  ],
  "watch_list": ["event or data point 1 that could flip signals", "event or data point 2", "event or data point 3"]
}

Only return valid JSON. Do not include markdown fences or commentary outside the JSON.`;

  try {
    const raw = await callClaude(systemPrompt, userPrompt, 1200);

    // Extract JSON — Claude may emit surrounding whitespace
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON object in Claude response");

    const parsed = JSON.parse(jsonMatch[0]);

    // Strip cite tags from all string fields
    function deepStrip(obj) {
      if (typeof obj === "string") return stripCiteTags(obj);
      if (Array.isArray(obj))     return obj.map(deepStrip);
      if (obj && typeof obj === "object") {
        return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, deepStrip(v)]));
      }
      return obj;
    }

    const clean = deepStrip(parsed);
    cache.set(cacheKey, clean, TTL_4H);
    return res.json({ source: "live", fetchedAt: now(), data: clean });

  } catch (err) {
    console.error("[analyticsNarrative] Claude error:", err.message);
    const fallback = buildFallbackNarrative(pairs, regime);
    return res.json({ source: "deterministic", fetchedAt: now(), data: fallback, warning: err.message });
  }
});

/**
 * Deterministic fallback — no AI cost. Derives simple observations from the data.
 */
function buildFallbackNarrative(pairs, regime) {
  const activeSigs = (pairs || [])
    .filter(p => !p.error && p.currentSignal !== 0)
    .map(p => ({
      pair:       p.name,
      signal:     p.currentSignal === 1 ? "LONG" : "SHORT",
      thesis:     p.salesPoint || p.mechanism || "",
      confidence: "MEDIUM",
    }));

  return {
    regime_interpretation: `Current regime: ${regime?.label || "Uncertain"}. Rates and credit data suggest ${
      (regime?.metrics?.hy_spread || 0) > 3.5 ? "risk-off conditions with elevated credit spreads" :
      (regime?.metrics?.dfii10   || 0) > 1.8 ? "restrictive real yields constraining equity multiples" :
      "broadly neutral cross-asset conditions"
    }. Monitor high-yield spreads and real yields for regime confirmation.`,
    live_signals:      activeSigs.length ? activeSigs : [{ pair: "No active signals", signal: "FLAT", thesis: "All MA crossover signals are flat in the current regime.", confidence: "LOW" }],
    regime_risks:      "Rates-based signals do not capture geopolitical shocks, earnings surprises, or central bank communication deviations. Correlations measured over 10 years include structural breaks (COVID, 2022 rate shock) that may not repeat.",
    model_health:      "Deterministic mode — AI narrative unavailable. Enable ANTHROPIC_API_KEY and set LOW_COST_MODE=false to generate live model health assessment.",
    sales_talking_points: [
      `HY OAS at ${regime?.metrics?.hy_spread ?? "?"}% — ${(regime?.metrics?.hy_spread || 0) > 3.5 ? "elevated relative to post-2023 tights, suggesting credit is pricing in more risk than equities" : "tight conditions with limited spread cushion against a growth shock"}`,
      `10Y real yield at ${regime?.metrics?.dfii10 ?? "?"}% — ${(regime?.metrics?.dfii10 || 0) > 1.5 ? "high real rates continue to apply discount-rate pressure on growth equity and gold" : "supportive for risk assets if growth holds"}`,
      `Regime: ${regime?.label || "Uncertain"} — position accordingly across rates, credit, and commodity exposure`,
    ],
    watch_list: ["Next FOMC meeting — dot plot revision", "CPI print — breakeven inflation confirmation", "HY spread direction (lead/lag vs equity vol is a hypothesis to test, not assumed)"],
  };
}

module.exports = router;
