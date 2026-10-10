/**
 * server/routes/research.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GET  /api/research/report?type=            — cached report (24h), generated on first load
 * POST /api/research/report/refresh           — regenerate (optional topic); requires confirm
 *                                               when the estimate exceeds RESEARCH_CONFIRM_ABOVE_USD
 * GET  /api/research/report/estimate?type=    — projected USD cost of a refresh, before running it
 * GET  /api/research/report/progress?type=    — live pipeline stage
 * GET  /api/research/report/versions?type=
 * GET  /api/research/report/:reportId/qa      — five-agent QA record + cost receipt
 * GET  /api/research/report/:reportId/sources
 * POST /api/research/interrogate
 *
 * Every report goes through the five-agent pipeline (server/research/) — or one
 * draft call when RESEARCH_MULTI_AGENT=false — with the
 * cross-asset fact layer (providers/macroContext.js) supplied to every agent.
 * There is no fabricated fallback: when generation fails the route returns 503
 * with `available: false` and the reason.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const { Router }  = require("express");
const { z }       = require("zod");
const cache       = require("../cache");
const anthropic   = require("../providers/anthropic");
const fred        = require("../providers/fred");
const eia         = require("../providers/eia");
const macroContext = require("../providers/macroContext");
const requireWriteAuth = require("../middleware/auth");
const orchestrator = require("../research/orchestrator");
const reportStore  = require("../research/reportStore");
const interrogator = require("../research/interrogator");
const cost         = require("../providers/aiCost");
const redTeamLog   = require("../research/redTeamLog");
const transport    = require("../providers/claudeTransport");

const router    = Router();
const TTL_24H   = 24 * 60 * 60 * 1000;
const VALID_TYPES = new Set(["macro", "fx", "rates", "thematic", "equity", "commodities", "sector"]);


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
 * attachQA — keep the existing frontend contract (`data` = research object)
 * while exposing the pipeline's QA record, version and cost receipt.
 */
function attachQA(research, record) {
  return {
    ...research,
    reportId:        record ? record.reportId : null,
    reportVersion:   record ? record.version : null,
    institutionalQA: record ? record.institutionalQA : orchestrator.notRunQA("Report predates institutional QA"),
    claimsCount:     record ? (record.claims || []).length : 0,
    sourcesCount:    record ? (record.sources || []).length : 0,
    costReceipt:     record?.meta?.cost || null,
  };
}

/**
 * buildContext — the verified cross-asset block plus any type-specific chart
 * data. Fetched for EVERY type: an equity report that cannot see crude or the
 * policy path cannot reason about margins or multiples.
 */
async function buildContext(type) {
  const [macroCtx, chartData] = await Promise.all([
    macroContext.getMacroContext().catch(err => {
      console.warn("[research] macro context unavailable:", err.message);
      return null;
    }),
    fetchChartData(type).catch(() => ({})),
  ]);
  const contextStr = [macroContext.toPromptBlock(macroCtx), chartData.priceContext].filter(Boolean).join("\n\n");
  return { macroCtx, chartData, contextStr };
}

/** decorate — server-fetched rows ride along with every report, tagged as verified. */
function decorate(research, type, { macroCtx, chartData }) {
  injectChartData(research, type, chartData || {});
  research.marketData    = macroContext.toMarketDataRows(macroCtx);
  research.policyPath    = macroCtx?.policyPath || null;
  research.dataAsOf      = macroCtx?.fetchedAt || null;
  research.missingSeries = macroCtx?.missing || [];
  return research;
}

/**
 * singleCallReport — RESEARCH_MULTI_AGENT=false: one draft call, no reviewers.
 * Cheaper (~1 call instead of 6-8); QA is honestly labelled NOT_RUN. Still
 * priced, versioned and stored so interrogation and idea cards work.
 */
async function singleCallReport(type, topic, contextStr, batch) {
  const receipt  = cost.newReceipt();
  const research = await transport.runWithContext({ receipt, batch, role: "draft" },
    () => anthropic.fetchResearchReport(contextStr, topic, type));
  const version  = reportStore.nextVersion(type);
  return reportStore.save({
    reportId: reportStore.makeReportId(type, version),
    version, reportType: type,
    generatedAt: research.generatedAt || new Date().toISOString(),
    dataAsOf: new Date().toISOString().slice(0, 10),
    topic: topic || null, research, thesisFrame: null,
    institutionalQA: orchestrator.notRunQA("Multi-agent QA disabled via RESEARCH_MULTI_AGENT=false"),
    claims: [], sources: [], corrections: [],
    meta: { pipeline: "single-agent", batch, cost: cost.finalizeReceipt(receipt) },
  });
}

/**
 * generateReport — build one report through the five-agent pipeline, or
 * explain why it could not be built. Always resolves.
 *
 * @param {string} type
 * @param {string} topic
 * @param {{ batch?: boolean }} opts  batch: run every agent call through the
 *        Message Batches API at 50% (used by the daily job; minutes of latency)
 * @returns {{ ok: true, report, record } | { ok: false, reason, detail }}
 */
async function generateReport(type, topic = "", { batch = false } = {}) {
  if (process.env.LOW_COST_MODE === "true") {
    return { ok: false, reason: "LOW_COST_MODE", detail: "AI generation is disabled by LOW_COST_MODE=true. Unset it to generate reports." };
  }

  // D-20: start every report from prices fetched seconds ago (free data). A
  // failed refresh is not fatal — the report uses the last snapshot, and every
  // figure still carries its own as-of time and STALE flag.
  if (process.env.NODE_ENV !== "test" || process.env.RESEARCH_REFRESH_MARKETS === "on") {
    orchestrator.setStage(type, "refreshing market data", "Fetching current prices before writing");
    await require("../jobs/refreshMarkets").refreshMarkets("research")
      .catch(err => console.warn(`[research:${type}] markets refresh failed — using last snapshot:`, err.message));
  }
  const ctx = await buildContext(type);

  let record;
  try {
    record = orchestrator.multiAgentEnabled()
      ? await orchestrator.runPipeline({ type, topic, ratesContext: ctx.contextStr, macroCtx: ctx.macroCtx, batch })
      : await singleCallReport(type, topic, ctx.contextStr, batch);
  } catch (err) {
    console.warn(`[research:${type}] generation failed:`, err.message);
    orchestrator.setStage(type, "failed", err.message);
    return { ok: false, reason: err.code || "AI_UNAVAILABLE", detail: err.message };
  }

  decorate(record.research, type, ctx);
  reportStore.save(record);   // re-persist with the decorated research
  return { ok: true, report: attachQA(record.research, record), record };
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

function sendResult(res, type, result) {
  if (!result.ok) {
    return res.status(503).json(envelope(unavailablePayload(type, result.reason, result.detail), "unavailable", false));
  }
  cache.set(cacheKey(type), result.report, TTL_24H);
  res.json(envelope(result.report, "live", false));
}

// ── GET /api/research/report ──────────────────────────────────────────────────
// Read-only: never spends money. Serves today's cached report, else the latest
// stored one (e.g. from the 06:40 batch, which survives a restart on disk).
// Generating is POST /report/refresh only, behind the cost estimate + confirm —
// a GET that silently ran a ~$0.70 pipeline on a cache miss would defeat that.
router.get("/report", (req, res) => {
  const type   = VALID_TYPES.has(req.query.type) ? req.query.type : "macro";
  const cached = cache.getWithMeta(cacheKey(type));
  if (cached && !cached.stale) {
    return res.json(envelope(cached.value, "cache", false));
  }

  const stored = reportStore.latestForType(type);
  if (stored && stored.research) {
    const payload = attachQA(stored.research, stored);
    const age = Date.now() - Date.parse(stored.generatedAt || 0);
    return res.json(envelope(payload, "stored", !(age < TTL_24H)));
  }

  res.status(404).json(envelope({
    ...unavailablePayload(type, "NOT_GENERATED",
      "No report of this type has been generated yet. Use GENERATE REPORT — you will see the estimated cost and confirm before it runs."),
  }, "unavailable", false));
});

// ── GET /api/research/report/estimate?type= ──────────────────────────────────
// What a refresh is projected to cost, from this type's recent real receipts
// (or a stated default when none exist yet). Nothing is called.
router.get("/report/estimate", (req, res) => {
  const type = VALID_TYPES.has(req.query.type) ? req.query.type : "macro";
  res.json({ type, ...cost.estimateReport(type, reportStore.recentForType(type)), spend: cost.spendSummary() });
});

// ── POST /api/research/report/refresh ────────────────────────────────────────
router.post("/report/refresh", requireWriteAuth, async (req, res) => {
  const { topic, type: bodyType, confirm } = req.body || {};
  const type = VALID_TYPES.has(bodyType || req.query.type) ? (bodyType || req.query.type) : "macro";

  // A manual refresh spends real money. Above the threshold, the caller must
  // have seen the estimate and confirmed it.
  const estimate = cost.estimateReport(type, reportStore.recentForType(type));
  if (!confirm && estimate.estimateUSD > cost.confirmThresholdUSD()) {
    return res.status(409).json({
      error: "confirmation_required",
      message: `This refresh is estimated at ~$${estimate.estimateUSD.toFixed(2)}. Resend with confirm: true to proceed.`,
      type, ...estimate,
    });
  }

  sendResult(res, type, await generateReport(type, topic || ""));
});

// ── GET /api/research/report/progress?type= ──────────────────────────────────
// Stage labels only — no fictional percentages (§35).
router.get("/report/progress", (req, res) => {
  const type = VALID_TYPES.has(req.query.type) ? req.query.type : "macro";
  res.json({ type, progress: orchestrator.getProgress(type) });
});

// ── GET /api/research/report/versions?type= ──────────────────────────────────
router.get("/report/versions", (req, res) => {
  const type = VALID_TYPES.has(req.query.type) ? req.query.type : "macro";
  const latest = reportStore.latestForType(type);
  res.json({
    type,
    latest: latest ? { reportId: latest.reportId, version: latest.version, generatedAt: latest.generatedAt, qaStatus: latest.institutionalQA?.status } : null,
  });
});

// ── GET /api/research/report/:reportId/qa ────────────────────────────────────
router.get("/report/:reportId/qa", (req, res) => {
  const report = reportStore.get(req.params.reportId);
  if (!report) return res.status(404).json({ error: "Report not found" });
  res.json({
    reportId:        report.reportId,
    version:         report.version,
    reportType:      report.reportType,
    generatedAt:     report.generatedAt,
    dataAsOf:        report.dataAsOf,
    institutionalQA: report.institutionalQA,
    thesisFrame:     report.thesisFrame,
    claims:          report.claims,
    corrections:     report.corrections,
    meta:            { pipeline: report.meta?.pipeline, usage: report.meta?.usage, models: report.meta?.models, cost: report.meta?.cost || null },
  });
});

// ── GET /api/research/report/:reportId/sources ───────────────────────────────
router.get("/report/:reportId/sources", (req, res) => {
  const report = reportStore.get(req.params.reportId);
  if (!report) return res.status(404).json({ error: "Report not found" });
  res.json({
    reportId: report.reportId,
    sources:  report.sources || [],
    claims:   (report.claims || []).map(c => ({ claimId: c.claimId, statement: c.statement, classification: c.classification, materiality: c.materiality, verificationStatus: c.verificationStatus, confidence: c.confidence, sourceIds: c.sourceIds })),
  });
});

// ── GET /api/research/redteam-log ────────────────────────────────────────────
// What the red team warned about, per report — scored later in the Journal.
router.get("/redteam-log", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  res.json({ entries: redTeamLog.list({ limit }) });
});

// ── GET /api/research/spend ──────────────────────────────────────────────────
// Today's and this month's Claude spend in USD, from the persistent ledger.
router.get("/spend", (req, res) => {
  const budget = require("../providers/budget");
  res.json({ ...cost.spendSummary(), budget: budget.getStatus() });
});

// ── POST /api/research/interrogate ───────────────────────────────────────────
const InterrogateRequest = z.object({
  reportId:       z.string().min(1).max(120),
  question:       z.string().min(1).max(2000),
  conversationId: z.string().max(60).optional(),
});

router.post("/interrogate", requireWriteAuth, async (req, res) => {
  const parsed = InterrogateRequest.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({
      error:   "Invalid interrogation request",
      details: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`),
    });
  }

  if (process.env.LOW_COST_MODE === "true" || process.env.DISABLE_AI === "true") {
    return res.status(503).json({
      error:      "Research interrogation requires AI, which is currently disabled.",
      aiStatus:   "UNAVAILABLE",
      reason:     process.env.LOW_COST_MODE === "true" ? "LOW_COST_MODE=true" : "DISABLE_AI=true",
    });
  }

  try {
    const result = await interrogator.interrogate(parsed.data);
    res.json(result);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    const budgetErr = err.code === "BUDGET_DAILY" || err.code === "BUDGET_MONTHLY" || err.code === "API_CREDITS_EXHAUSTED";
    if (budgetErr) {
      return res.status(503).json({ error: "AI budget exhausted — interrogation unavailable until it resets.", aiStatus: "UNAVAILABLE", reason: err.code });
    }
    console.error("[research:interrogate]", err.message);
    res.status(500).json({ error: "Interrogation failed: " + err.message });
  }
});

module.exports = router;
module.exports.generateReport = generateReport;
module.exports.VALID_TYPES    = VALID_TYPES;
module.exports.cacheKey       = cacheKey;
module.exports.TTL_24H        = TTL_24H;
