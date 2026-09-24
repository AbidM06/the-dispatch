/**
 * server/routes/macro.js
 * S&T Sales intelligence endpoints.
 *
 * GET /api/macro/view     — global macro view (AI + deterministic fallback)
 * GET /api/macro/clients  — institutional client impact analysis (AI + fallback)
 */
"use strict";

const { Router }      = require("express");
const cache           = require("../cache");
const anthropic       = require("../providers/anthropic");
const fred            = require("../providers/fred");
const { getVolSurface } = require("../providers/polygon");

const router = Router();

const TTL_MACRO_MS   = 4 * 60 * 60 * 1000;  // 4 hours — macro views don't need constant refresh
const TTL_CLIENT_MS  = 4 * 60 * 60 * 1000;

function now() { return new Date().toISOString(); }

/**
 * Extract the numeric value from a FRED Fact.
 *
 * getAllRates() resolves { seriesId, value, date, source } — it has never
 * returned an `observations` array. The old implementation probed for one,
 * missed, and returned its caller-supplied fallback every single time, so the
 * Sales tab ran on the hardcoded constants 4.2 / 1.85 / 2.38 / 3.2 / 0.5 and
 * passed them to the model described as "latest FRED data". That is worse than
 * having no data: it is invented data wearing a source label.
 *
 * There is no fallback parameter any more. Missing means null, and callers must
 * say so rather than substitute a plausible number.
 */
function rateVal(fact) {
  if (typeof fact === "number") return Number.isFinite(fact) ? fact : null;
  if (fact && typeof fact === "object" && Number.isFinite(fact.value)) return fact.value;
  return null;
}

/** Observation date of a Fact — when measured, not when fetched. */
function rateDate(fact) {
  return (fact && typeof fact === "object" && fact.date) ? fact.date : null;
}
function envelope(data, source = "live", stale = false) {
  return { source, fetchedAt: now(), stale, data };
}

/**
 * describeRegime — name the curve SHAPE from a level, never a direction.
 *
 * "Steepener" and "flattener" describe how a curve is MOVING. A single level
 * cannot support either word: 10Y-2Y at +0.5% tells you the curve is positively
 * sloped, not whether it steepened or flattened to get there. The previous
 * logic also derived "Bear Flattener" from the HY spread, which is a credit
 * measure and says nothing about the curve at all.
 *
 * Until a prior observation is available to difference against, this reports
 * shape and credit conditions as separate, separately-sourced facts.
 */
function describeRegime(rates = {}) {
  const parts = [];
  const { t10y2y, hy_spread, dfii10 } = rates;

  if (t10y2y != null) {
    if (t10y2y < 0)        parts.push("Inverted curve");
    else if (t10y2y < 0.3) parts.push("Flat curve");
    else                   parts.push("Positively sloped curve");
  }
  if (hy_spread != null) {
    if (hy_spread > 4.5)      parts.push("credit stress");
    else if (hy_spread > 3.5) parts.push("credit widening");
    else                      parts.push("credit calm");
  }
  if (dfii10 != null && dfii10 > 2.0)      parts.push("high real yields");
  else if (dfii10 != null && dfii10 > 1.5) parts.push("elevated real yields");

  return parts.length ? parts.join(" + ") : "Regime undetermined — inputs unavailable";
}

// ── Deterministic cross-asset matrix from FRED rates ──────────────────────────
// Used as fallback when AI unavailable. Scores -2 (very bearish) to +2 (very bullish).
function buildCrossAssetMatrix(rates = {}) {
  // No invented inputs. These defaults used to be 4.2 / 1.85 / 0.5 / 3.2 / 2.38,
  // so a FRED outage produced a fully-scored BULLISH/BEARISH matrix built out of
  // constants — signals with no measurement behind them. If the inputs the
  // matrix depends on are missing, it returns nothing and the caller says so.
  const { dgs10 = null, dfii10 = null, t10y2y = null, hy_spread = null, t10y_ie = null } = rates;
  if ([dfii10, t10y2y, hy_spread, t10y_ie].some(v => v == null)) return [];

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
      rationale: `Yield curve at +${t10y2y}% — ${t10y2y > 0.5 ? "positively sloped (a level, not a steepening) — conventionally read as supportive of bank net interest margins" : t10y2y > 0 ? "flat — conventionally read as a constraint on bank margins" : "inverted — historically associated with later recessions, with long and variable lags"}.`,
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

// ── Deterministic client impact fallback ──────────────────────────────────────
/*
 * buildClientFallback() and buildMacroViewFallback() used to live here.
 *
 * They were the same failure class as the six fabricated research reports that
 * were deleted in the cross-asset rewrite — and were missed at the time, while
 * CLAUDE.md claimed the class was gone. Between them they asserted a Fed level
 * of "4.25-4.50%", scenario probabilities of 60/20/20, a complete trade idea
 * with entry, stop and target, CPI/FOMC/NFP catalysts dated April and May 2026,
 * and client talking points claiming real yields were "the highest since
 * 2007-era". None of it was measured; all of it rendered exactly like live
 * desk output.
 *
 * On AI failure these routes now return HTTP 503 with available:false, the same
 * contract /api/research uses. A Sales tab that says nothing is worth more than
 * one that invents a catalyst calendar.
 */

/**
 * unavailablePayload — what the client renders instead of an invented view.
 * Names the last successful run without serving its (now stale) content.
 */
function unavailablePayload(surface, cacheKey, reason, detail) {
  const stale = cache.getWithMeta(cacheKey);
  return {
    available:     false,
    surface,
    reason,
    detail,
    lastSuccessAt: stale?.value?.fetchedAt || null,
    checkedAt:     now(),
  };
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

  // Build rates context from FRED + vol surface (parallel, best-effort).
  // Only figures actually returned are described; nothing is substituted.
  let rates = {};
  let ratesStr = "";
  let volSurface = { vix3m: null, skew: null };
  try {
    const [r, vol] = await Promise.all([
      fred.getAllRates(),
      getVolSurface().catch(() => ({ vix3m: null, skew: null })),
    ]);
    rates = {
      dgs10:     rateVal(r.dgs10),
      dfii10:    rateVal(r.dfii10),
      t10y_ie:   rateVal(r.t10yie),
      hy_spread: rateVal(r.hy_spread),
      t10y2y:    rateVal(r.t10y2y),
    };
    volSurface = vol;
    // Each figure carries its own observation date. The old string appended
    // only the NEWEST date, so an older series read as current.
    const d = f => rateDate(f) ? ` (${rateDate(f)})` : " (date n/a)";
    const parts = [
      rates.dgs10     != null ? `10Y nominal: ${rates.dgs10}%${d(r.dgs10)}`                     : null,
      rates.dfii10    != null ? `real yield: ${rates.dfii10}%${d(r.dfii10)}`                    : null,
      rates.t10y_ie   != null ? `breakeven inflation: ${rates.t10y_ie}%${d(r.t10yie)}`          : null,
      rates.hy_spread != null ? `HY OAS: ${Math.round(rates.hy_spread * 100)}bp${d(r.hy_spread)}` : null,
      rates.t10y2y    != null ? `yield curve (10Y-2Y): ${rates.t10y2y}pp${d(r.t10y2y)}`         : null,
    ].filter(Boolean);
    const volStr = [
      vol.vix3m ? `VIX3M: ${vol.vix3m.value} (${vol.vix3m.source}, ${vol.vix3m.date})` : null,
      vol.skew  ? `CBOE SKEW: ${vol.skew.value} (${vol.skew.source}, ${vol.skew.date})` : null,
    ].filter(Boolean).join(", ");
    ratesStr = parts.length
      ? `FRED end-of-day observations — ${parts.join(", ")}`
        + (volStr ? `. Vol surface: ${volStr}` : "")
      : "";
  } catch (err) {
    console.warn("[macro/view] FRED unavailable:", err.message);
  }
  if (!ratesStr) ratesStr = "No verified rate data available this run — do not assert levels you cannot source.";

  let viewData;
  try {
    if (process.env.LOW_COST_MODE === "true") throw new Error("LOW_COST_MODE");
    viewData = await anthropic.fetchMacroView(ratesStr, volSurface);
    viewData.crossAsset = viewData.crossAsset && viewData.crossAsset.length > 0
      ? viewData.crossAsset
      : buildCrossAssetMatrix(rates);
  } catch (err) {
    // No fabricated substitute. See the note above unavailablePayload().
    console.warn("[macro/view] unavailable:", err.message);
    return res.status(503).json(envelope(
      unavailablePayload("macro-view", cacheKey, err.code || "AI_UNAVAILABLE", err.message),
      "unavailable", false,
    ));
  }

  cache.set(cacheKey, viewData, TTL_MACRO_MS);
  res.json(envelope(viewData, "live", false));
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

  let rates = {};
  let ratesStr = "";
  let regime = "";
  try {
    const r = await fred.getAllRates();
    rates = {
      dgs10:     rateVal(r.dgs10),
      dfii10:    rateVal(r.dfii10),
      t10y_ie:   rateVal(r.t10yie),
      hy_spread: rateVal(r.hy_spread),
      t10y2y:    rateVal(r.t10y2y),
    };
    const d = f => rateDate(f) ? ` (${rateDate(f)})` : " (date n/a)";
    const parts = [
      rates.dgs10     != null ? `10Y nominal: ${rates.dgs10}%${d(r.dgs10)}`                     : null,
      rates.dfii10    != null ? `real yield: ${rates.dfii10}%${d(r.dfii10)}`                    : null,
      rates.t10y_ie   != null ? `breakeven inflation: ${rates.t10y_ie}%${d(r.t10yie)}`          : null,
      rates.hy_spread != null ? `HY OAS: ${Math.round(rates.hy_spread * 100)}bp${d(r.hy_spread)}` : null,
      rates.t10y2y    != null ? `yield curve (10Y-2Y): ${rates.t10y2y}pp${d(r.t10y2y)}`         : null,
    ].filter(Boolean);
    ratesStr = parts.length ? `FRED end-of-day observations — ${parts.join(", ")}` : "";
    // Only label a regime when the inputs it depends on were actually measured.
    regime = describeRegime(rates);
  } catch (err) {
    console.warn("[macro/clients] FRED unavailable:", err.message);
  }
  if (!ratesStr) ratesStr = "No verified rate data available this run — do not assert levels you cannot source.";

  let clients;
  try {
    if (process.env.LOW_COST_MODE === "true") throw new Error("LOW_COST_MODE");
    clients = await anthropic.fetchClientImpact(ratesStr, regime);
  } catch (err) {
    console.warn("[macro/clients] unavailable:", err.message);
    return res.status(503).json(envelope(
      unavailablePayload("macro-clients", cacheKey, err.code || "AI_UNAVAILABLE", err.message),
      "unavailable", false,
    ));
  }

  cache.set(cacheKey, clients, TTL_CLIENT_MS);
  res.json(envelope(clients, "live", false));
});

module.exports = router;
