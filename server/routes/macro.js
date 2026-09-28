/**
 * server/routes/macro.js
 * S&T Sales intelligence endpoints.
 *
 * GET /api/macro/view     — global macro view (AI)
 * GET /api/macro/clients  — institutional client impact analysis (AI)
 *
 * Both are grounded on the verified FRED block (providers/macroContext.js).
 * There is NO fabricated fallback: when AI is unavailable the route returns
 * 503 `available: false`, the same contract as research. The previous
 * fallbacks invented a Fed level, scenario probabilities, a complete trade idea
 * with entry/stop/target, dated catalysts and client talking points — and the
 * old rateVal() read a shape getAllRates() never returns, so the LIVE model was
 * handed hardcoded rates (10Y 4.2%, HY 3.2%…) labelled as the latest FRED data.
 */
"use strict";

const { Router }      = require("express");
const cache           = require("../cache");
const anthropic       = require("../providers/anthropic");
const macroContext    = require("../providers/macroContext");
const { getVolSurface } = require("../providers/polygon");

const router = Router();

const TTL_MACRO_MS   = 4 * 60 * 60 * 1000;  // 4 hours — macro views don't need constant refresh
const TTL_CLIENT_MS  = 4 * 60 * 60 * 1000;

function now() { return new Date().toISOString(); }

function envelope(data, source = "live", stale = false) {
  return { source, fetchedAt: now(), stale, data };
}

// ── Rules-based cross-asset matrix from verified FRED rates ───────────────────
// Fills the matrix when the model returns none. Scores -2 (very bearish) to +2
// (very bullish). Every input must be a fetched value: with any missing the
// matrix is omitted rather than computed from invented defaults.
function buildCrossAssetMatrix(rates = {}) {
  const { dgs10, dfii10, t10y2y, hy_spread, t10y_ie } = rates;
  if ([dgs10, dfii10, t10y2y, hy_spread, t10y_ie].some(v => !Number.isFinite(v))) return [];

  function score(val, [ vbear, bear, neutral, bull, vbull ]) {
    if (val <= vbear)  return -2;
    if (val <= bear)   return -1;
    if (val <= neutral) return 0;
    if (val <= bull)   return 1;
    return 2;
  }

  // Real yield thresholds: very high real yields = duration pain
  const realYieldScore = -score(dfii10, [0.5, 1.0, 1.5, 2.0, 2.5]);

  // HY spread: wider = risk-off. Invert so higher spread = lower score
  const creditScore = -score(hy_spread, [2.0, 2.5, 3.0, 4.0, 5.0]);

  // Curve: steeper = better for growth outlook. Flat/inverted = bad
  const curveScore = score(t10y2y, [-0.5, 0, 0.3, 0.7, 1.2]);

  // Breakeven inflation: higher = good for TIPS, bad for nominal long
  const beiScore = score(t10y_ie, [1.5, 2.0, 2.3, 2.6, 3.0]);

  function label(s) {
    return s >= 1 ? "BULLISH" : s <= -1 ? "BEARISH" : "NEUTRAL";
  }
  function rationale(s, asset, context) {
    return context;
  }

  return [
    {
      asset: "US Treasuries (Long Duration)",
      signal: label(realYieldScore),
      score: realYieldScore,
      rationale: `Real yield at ${dfii10}% — ${dfii10 > 1.8 ? "high real rates compress duration; long bonds face headwinds" : dfii10 > 1.2 ? "real rates normalising but still manageable for duration" : "low real yields supportive of duration and long bonds"}.`,
    },
    {
      asset: "TIPS / Inflation-Linked",
      signal: label(beiScore),
      score: beiScore,
      rationale: `10Y breakeven at ${t10y_ie}% — ${t10y_ie > 2.4 ? "elevated inflation expectations support TIPS over nominals" : t10y_ie > 2.0 ? "breakevens near target; TIPS fairly valued vs nominals" : "low inflation expectations reduce TIPS premium"}.`,
    },
    {
      asset: "IG Credit",
      signal: label(Math.round((creditScore + curveScore) / 2)),
      score: Math.round((creditScore + curveScore) / 2),
      rationale: `HY OAS at ${hy_spread}% — ${hy_spread > 4.0 ? "spreads wide, IG credit under stress; prefer shorter duration" : hy_spread > 3.0 ? "spreads slightly elevated; selective IG still offers carry vs Treasuries" : "tight spreads reduce risk premium; limited upside in IG"}.`,
    },
    {
      asset: "HY Credit",
      signal: label(creditScore),
      score: creditScore,
      rationale: `HY OAS ${hy_spread}% — ${hy_spread > 4.5 ? "distressed territory; default risk rising" : hy_spread > 3.5 ? "spreads widening; risk/reward deteriorating for HY" : hy_spread > 3.0 ? "spreads ticking up — watch for momentum; defensive credit sectors preferred" : "benign credit environment; carry trade intact"}.`,
    },
    {
      asset: "US Equities — Growth / Tech",
      signal: label(realYieldScore + (creditScore > 0 ? 1 : 0) - 1),
      score: Math.max(-2, Math.min(2, realYieldScore + (creditScore > 0 ? 1 : 0) - 1)),
      rationale: `Real yield at ${dfii10}% pressures long-duration equities (growth/tech). ${dfii10 > 1.8 ? "Expensive multiples hard to sustain; earnings quality paramount." : "Supportive for growth but watch rate sensitivity."}.`,
    },
    {
      asset: "US Equities — Value / Cyclical",
      signal: label(curveScore + 1),
      score: Math.max(-2, Math.min(2, curveScore + 1)),
      rationale: `Yield curve at +${t10y2y}% — ${t10y2y > 0.5 ? "mild steepener supports banks and cyclicals; financials, energy, industrials in focus" : t10y2y > 0 ? "flat curve limits bank margin expansion; value vs growth rotation cautious" : "inverted curve pressures cyclicals and raises recession risk"}.`,
    },
    {
      asset: "EM Equities",
      signal: label(creditScore - 1),
      score: Math.max(-2, Math.min(2, creditScore - 1)),
      rationale: `USD rates at ${dgs10}% — ${dgs10 > 4.5 ? "high US rates drive EM capital outflows; EM FX under pressure" : dgs10 > 4.0 ? "elevated US yields keep EM under moderate pressure; selective opportunity in carry" : "declining US yields support EM; local currency bonds attractive"}.`,
    },
    {
      asset: "USD (DXY)",
      signal: label(-realYieldScore),
      score: Math.max(-2, Math.min(2, -realYieldScore)),
      rationale: `Real yield differential at ${dfii10}% — ${dfii10 > 1.8 ? "high US real rates vs peers support USD strength; watch positioning" : dfii10 > 1.0 ? "moderate real yield advantage; USD supported but not stretched" : "low real yields reduce USD carry advantage"}.`,
    },
    {
      asset: "Gold",
      signal: label(Math.round((beiScore - realYieldScore) / 2) + (creditScore < 0 ? 1 : 0)),
      score: Math.max(-2, Math.min(2, Math.round((beiScore - realYieldScore) / 2) + (creditScore < 0 ? 1 : 0))),
      rationale: `Real yield ${dfii10}% vs breakeven ${t10y_ie}% — ${dfii10 > 2.0 ? "high real yields a headwind for gold; needs geopolitical bid to outperform" : "moderate real yield + elevated breakevens support gold as inflation hedge; risk-off adds safe-haven bid"}.`,
    },
    {
      asset: "Commodities",
      signal: label(Math.round((beiScore + curveScore) / 2)),
      score: Math.max(-2, Math.min(2, Math.round((beiScore + curveScore) / 2))),
      rationale: `Inflation breakeven ${t10y_ie}%, curve +${t10y2y}% — ${t10y_ie > 2.4 ? "elevated inflation expectations support commodity complex; energy and metals sensitive to demand outlook" : "neutral commodity backdrop; geopolitical supply risk key swing factor"}.`,
    },
  ];
}

/** Plain numeric rates from the verified facts — null when a series was not fetched. */
function ratesFromContext(ctx) {
  const f = ctx?.facts || {};
  const v = (k) => (Number.isFinite(f[k]?.value) ? f[k].value : null);
  return { dgs10: v("dgs10"), dfii10: v("dfii10"), t10y_ie: v("t10yie"), hy_spread: v("hySpread"), t10y2y: v("t10y2y") };
}

/** Regime label only from real values; unknown when inputs are missing. */
function regimeFrom(r) {
  if (!Number.isFinite(r.hy_spread) || !Number.isFinite(r.t10y2y)) return "";
  return r.hy_spread > 3.5 ? "Bear Flattener / Risk-Off" : r.t10y2y > 0.5 ? "Bear Steepener" : "Uncertain";
}

function unavailable(res, cacheKey, err) {
  const reason = err.code || (err.message === "LOW_COST_MODE" ? "LOW_COST_MODE" : "AI_UNAVAILABLE");
  const last = cache.getWithMeta(cacheKey);
  return res.status(503).json(envelope({
    available: false,
    reason,
    detail: err.message,
    lastSuccessAt: last?.value?.fetchedAt || null,
    checkedAt: now(),
  }, "unavailable", false));
}

// ── GET /api/macro/view ───────────────────────────────────────────────────────
router.get("/view", async (req, res) => {
  const force = req.query.refresh === "true";
  const cacheKey = "macro:view";

  if (!force) {
    const cached = cache.getWithMeta(cacheKey);
    if (cached && !cached.stale) {
      return res.json(envelope(cached.value, "cache", false));
    }
  }

  const [ctx, volSurface] = await Promise.all([
    macroContext.getMacroContext().catch(() => null),
    getVolSurface().catch(() => ({ vix3m: null, skew: null })),
  ]);
  const rates  = ratesFromContext(ctx);
  const volStr = [
    volSurface.vix3m ? `VIX3M: ${volSurface.vix3m.value}` : null,
    volSurface.skew  ? `CBOE SKEW: ${volSurface.skew.value}` : null,
  ].filter(Boolean).join(", ");
  const ratesStr = macroContext.toPromptBlock(ctx) + (volStr ? `\n\nVol surface: ${volStr}` : "");

  try {
    if (process.env.LOW_COST_MODE === "true") throw new Error("LOW_COST_MODE");
    const viewData = await anthropic.fetchMacroView(ratesStr, volSurface);
    if (!viewData.crossAsset || viewData.crossAsset.length === 0) {
      viewData.crossAsset = buildCrossAssetMatrix(rates);
      viewData.crossAssetBasis = viewData.crossAsset.length ? "rules-based from FRED (computed in code)" : "unavailable — FRED inputs missing";
    }
    viewData.marketData = macroContext.toMarketDataRows(ctx);
    viewData.fetchedAt  = now();
    cache.set(cacheKey, viewData, TTL_MACRO_MS);
    res.json(envelope(viewData, "live", false));
  } catch (err) {
    console.warn("[macro/view] unavailable:", err.message);
    unavailable(res, cacheKey, err);
  }
});

// ── GET /api/macro/clients ────────────────────────────────────────────────────
router.get("/clients", async (req, res) => {
  const force = req.query.refresh === "true";
  const cacheKey = "macro:clients";

  if (!force) {
    const cached = cache.getWithMeta(cacheKey);
    if (cached && !cached.stale) {
      return res.json(envelope(cached.value, "cache", false));
    }
  }

  const ctx = await macroContext.getMacroContext().catch(() => null);

  try {
    if (process.env.LOW_COST_MODE === "true") throw new Error("LOW_COST_MODE");
    const clients = await anthropic.fetchClientImpact(macroContext.toPromptBlock(ctx), regimeFrom(ratesFromContext(ctx)));
    cache.set(cacheKey, clients, TTL_CLIENT_MS);
    res.json(envelope(clients, "live", false));
  } catch (err) {
    console.warn("[macro/clients] unavailable:", err.message);
    unavailable(res, cacheKey, err);
  }
});

module.exports = router;
module.exports._internal = { buildCrossAssetMatrix, ratesFromContext, regimeFrom };
