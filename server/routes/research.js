/**
 * server/routes/research.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GET /api/research/report         — Goldman Sachs-style economics comment
 * POST /api/research/report/refresh — force regenerate with optional topic
 *
 * Cost: ~$0.015 per AI call. Cached 24h — runs once daily unless refreshed.
 * Falls back to deterministic narrative when LOW_COST_MODE=true or AI unavailable.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const { Router }  = require("express");
const cache       = require("../cache");
const anthropic   = require("../providers/anthropic");
const fred        = require("../providers/fred");
const eia         = require("../providers/eia");
const macroContext = require("../providers/macroContext");
const requireWriteAuth = require("../middleware/auth");

const router    = Router();
const TTL_24H   = 24 * 60 * 60 * 1000;
const VALID_TYPES = new Set(["macro", "fx", "rates", "thematic", "equity", "commodities"]);


function cacheKey(type) {
  return `research:report:${VALID_TYPES.has(type) ? type : "macro"}`;
}

function now()     { return new Date().toISOString(); }
function envelope(data, source = "live", stale = false) {
  return { source, fetchedAt: now(), stale, data };
}

// ── Fabricated fallbacks: deliberately absent ────────────────────────────────
//
// This file used to carry six hand-written "deterministic" reports that were
// served whenever AI generation failed. They read exactly like live research —
// same layout, same confident prose, same hard numbers — but every figure was
// hardcoded. The commodities seed asserted a Strait of Hormuz closure with oil
// flows "down ~90%" and a 17mb/d supply shock. None of it was real, and none of
// it was checked against a feed before being shown.
//
// A report that invents a crisis is worse than no report, so there is no seed
// path now. When generation fails the route returns `available: false` with the
// reason and the timestamp of the last good run, and the client renders an
// unavailable state. Silence is honest; fabrication is not.

// ── Build live_market_data from EIA snapshot ──────────────────────────────────
function buildLiveMarketData(prices) {
  const rows = [];
  if (prices.brent) rows.push({ label: "Brent Crude", value: prices.brent.formatted, change: prices.brent.change || "—", direction: prices.brent.direction, source: "EIA", as_of: prices.brent.as_of });
  if (prices.wti)   rows.push({ label: "WTI Crude",   value: prices.wti.formatted,   change: prices.wti.change   || "—", direction: prices.wti.direction,   source: "EIA", as_of: prices.wti.as_of });
  if (prices.ng)    rows.push({ label: "Henry Hub NG", value: prices.ng.formatted,    change: prices.ng.change    || "—", direction: prices.ng.direction,    source: "EIA", as_of: prices.ng.as_of });
  return rows;
}

// ── Merge FRED series history into chart-ready array ─────────────────────────
function mergeRatesHistory(dgs10Res, dfii10Res, hyRes) {
  const byDate = {};
  function merge(res, field) {
    if (res.status === "fulfilled") {
      (res.value.observations || []).forEach(o => {
        byDate[o.date] = { ...byDate[o.date], [field]: o.value };
      });
    }
  }
  merge(dgs10Res,  "dgs10");
  merge(dfii10Res, "dfii10");
  merge(hyRes,     "hy_spread");

  return Object.entries(byDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, vals]) => ({ date, ...vals }));
}

// ── Shared fetch-and-merge helper ─────────────────────────────────────────────
async function fetchChartData(type) {
  let eiaLiveData   = null;
  let priceHistory  = [];
  let ratesHistory  = [];
  let priceContext  = "";

  if (type === "commodities") {
    try {
      const [priceHist, latestPrices] = await Promise.all([
        eia.getPriceHistory(52),
        eia.getLatestPrices(6),
      ]);
      priceHistory = priceHist;
      if (latestPrices) {
        eiaLiveData  = buildLiveMarketData(latestPrices);
        const parts  = [];
        if (latestPrices.brent) parts.push(`Brent: ${latestPrices.brent.formatted} (${latestPrices.brent.change || "flat"}, EIA ${latestPrices.brent.as_of})`);
        if (latestPrices.wti)   parts.push(`WTI: ${latestPrices.wti.formatted} (${latestPrices.wti.change || "flat"}, EIA ${latestPrices.wti.as_of})`);
        if (latestPrices.ng)    parts.push(`NG Henry Hub: ${latestPrices.ng.formatted} (${latestPrices.ng.change || "flat"}, EIA ${latestPrices.ng.as_of})`);
        if (parts.length) priceContext = `EIA official weekly prices (published with ~1 week lag — use web_search for today's spot prices): ${parts.join("; ")}`;
      }
    } catch (err) {
      console.warn("[research] EIA fetch failed:", err.message);
    }
  }

  if (type === "macro") {
    try {
      const [dgs10Res, dfii10Res, hyRes] = await Promise.allSettled([
        fred.getRecentHistory("DGS10",        90),
        fred.getRecentHistory("DFII10",       90),
        fred.getRecentHistory("BAMLH0A0HYM2", 90),
      ]);
      ratesHistory = mergeRatesHistory(dgs10Res, dfii10Res, hyRes);
    } catch (err) {
      console.warn("[research] FRED history fetch failed:", err.message);
    }
  }

  return { eiaLiveData, priceHistory, ratesHistory, priceContext };
}

// ── Merge server-side chart data into report ──────────────────────────────────
function injectChartData(report, type, { eiaLiveData, priceHistory, ratesHistory }) {
  if (type === "commodities") {
    // EIA is for the 52-week historical chart only (structural ~1 week lag)
    // live_market_data is populated by Claude's web_search (real-time); EIA is fallback only
    if (priceHistory && priceHistory.length) report.price_history = priceHistory;
    if (!report.live_market_data || !report.live_market_data.length) {
      if (eiaLiveData && eiaLiveData.length) report.live_market_data = eiaLiveData;
    }
  }
  if (type === "macro") {
    if (ratesHistory && ratesHistory.length) report.rates_history   = ratesHistory;
  }
  return report;
}

// ── Report generation ─────────────────────────────────────────────────────────
/**
 * generateReport — build one report, or explain why it could not be built.
 *
 * Always resolves. A thrown error here would surface to the client as a 500 with
 * no detail, and "the panel is blank" is a worse answer than "generation failed
 * because the budget cap was hit at 14:02".
 *
 * @returns {{ ok: true, report } | { ok: false, reason, detail }}
 */
async function generateReport(type, topic = "") {
  // Cross-asset context is fetched for EVERY type, not just the one that "owns"
  // the data. An equity report that cannot see crude or the policy path cannot
  // reason about margins or multiples — which is exactly how it used to fail.
  const [macroCtx, chartData] = await Promise.all([
    macroContext.getMacroContext().catch(err => {
      console.warn("[research] macro context unavailable:", err.message);
      return null;
    }),
    fetchChartData(type).catch(() => ({})),
  ]);

  const contextStr = [
    macroContext.toPromptBlock(macroCtx),
    chartData.priceContext,
  ].filter(Boolean).join("\n\n");

  if (process.env.LOW_COST_MODE === "true") {
    return { ok: false, reason: "LOW_COST_MODE", detail: "AI generation is disabled by LOW_COST_MODE=true. Unset it to generate reports." };
  }

  let report;
  try {
    report = await anthropic.fetchResearchReport(contextStr, topic, type);
  } catch (err) {
    console.warn(`[research:${type}] generation failed:`, err.message);
    return { ok: false, reason: err.code || "AI_UNAVAILABLE", detail: err.message };
  }

  injectChartData(report, type, chartData);

  // The verified market data rides along with every report. These rows are
  // server-fetched, so each one is a figure the reader can trust outright —
  // unlike anything the model wrote, which is tagged separately.
  report.marketData     = macroContext.toMarketDataRows(macroCtx);
  report.policyPath     = macroCtx?.policyPath || null;
  // Observation dates, not fetch time. `dataAsOf` used to be the moment the
  // context was assembled, so regenerating a report made week-old FRED data
  // read as fresh. Retrieval is reported separately and labelled as such.
  report.dataAsOf       = macroContext.observationSpan(macroCtx);
  report.missingSeries  = macroCtx?.missing || [];

  return { ok: true, report };
}

/**
 * unavailablePayload — what the client renders instead of a fabricated report.
 * Names the last successful run without serving its (now stale) content.
 */
function unavailablePayload(type, reason, detail) {
  const stale = cache.getWithMeta(cacheKey(type));
  return {
    available:   false,
    reportType:  type,
    reason,
    detail,
    lastSuccessAt: stale?.value?.generatedAt || null,
    checkedAt:   now(),
  };
}

// ── GET /api/research/report ──────────────────────────────────────────────────
router.get("/report", async (req, res) => {
  const type   = VALID_TYPES.has(req.query.type) ? req.query.type : "macro";
  const key    = cacheKey(type);

  const cached = cache.getWithMeta(key);
  if (cached && !cached.stale) {
    return res.json(envelope(cached.value, "cache", false));
  }

  const result = await generateReport(type, "");
  if (!result.ok) {
    return res.status(503).json(envelope(unavailablePayload(type, result.reason, result.detail), "unavailable", false));
  }

  cache.set(key, result.report, TTL_24H);
  res.json(envelope(result.report, "live", false));
});

// ── POST /api/research/report/refresh ────────────────────────────────────────
// Regenerating a report costs a Sonnet call with unbounded web_search, so this
// is a spend endpoint, not a read. Every sibling refresh route (bulletin,
// events, correlations) was already guarded; this one was not, which left
// anyone who could reach the port able to run up the API bill at will.
router.post("/report/refresh", requireWriteAuth, async (req, res) => {
  const { topic, type: bodyType } = req.body || {};
  const type = VALID_TYPES.has(bodyType || req.query.type) ? (bodyType || req.query.type) : "macro";

  const result = await generateReport(type, topic || "");
  if (!result.ok) {
    return res.status(503).json(envelope(unavailablePayload(type, result.reason, result.detail), "unavailable", false));
  }

  cache.set(cacheKey(type), result.report, TTL_24H);
  res.json(envelope(result.report, "live", false));
});

module.exports = router;
module.exports.generateReport = generateReport;
module.exports.VALID_TYPES    = VALID_TYPES;
module.exports.cacheKey       = cacheKey;
module.exports.TTL_24H        = TTL_24H;
