/**
 * server/routes/ideas.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Trade Idea Tickets — full lifecycle CRUD + decision quality stats
 * + idea engine endpoints.
 *
 * GET  /api/ideas                  list all (optional ?status=OPEN|CLOSED|CANCELLED)
 * POST /api/ideas                  create — runs pre-trade risk check, persists
 * POST /api/ideas/generate         idea engine (or AI/deterministic) suggestions
 * GET  /api/ideas/stats            decision quality stats (registered BEFORE /:id)
 * GET  /api/ideas/latest           most recent engine run from ideas_log.jsonl
 * GET  /api/ideas/history          ?days=30 from ideas_log.jsonl
 * GET  /api/ideas/playbooks        all playbook descriptions
 * GET  /api/ideas/performance      paperTrader.computeMetrics(all ideas)
 * POST /api/ideas/weekly-report    trigger weeklyReview + save
 * GET  /api/ideas/alpaca           Alpaca account + positions summary
 * GET  /api/ideas/:id              single idea
 * PATCH /api/ideas/:id             update (close, review, add notes)
 * DELETE /api/ideas/:id            soft-delete (status → CANCELLED)
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const { Router }                         = require("express");
const { loadIdeas, addIdea, updateIdea } = require("../importers/ideas");
const { runPreTradeCheck }               = require("../analytics/riskCheck");
const { generateTradeIdeas }             = require("../providers/anthropic");
const budget  = require("../providers/budget");
const cache   = require("../cache");
const seeds   = require("../../seeds/fallback");

// Engine + new modules
const { generateIdeas, buildCtx } = require("../engine/ideaEngine");
const { PLAYBOOKS }               = require("../engine/playbooks");
const { appendIdeasLog, appendSignalsLog, readIdeasLog, appendExecutionLog, readExecutionLog } = require("../importers/ideaLog");
const { computeMetrics }          = require("../analytics/paperTrader");
const { generateWeeklyReport, saveWeeklyReport } = require("../jobs/weeklyReview");
const alpaca                      = require("../providers/alpaca");
const { getUniverseDetailed, SCREENING_THRESHOLDS, PROHIBITED_TRANSACTIONS } = require("../engine/shariahFilter");
const requireWriteAuth            = require("../middleware/auth");
const { computeSize }             = require("../engine/positionSizing");
const executionPolicy             = require("../analytics/executionPolicy");
const { fireWebhook }            = require("../providers/webhook");
const { autoExecuteIdeas }        = require("../engine/autoExecute");

const router = Router();

// ── Required fields for a new idea ────────────────────────────────────────────
const REQUIRED = [
  "ticker", "direction", "thesis", "catalyst",
  "entry", "stop", "target",
  "invalidation", "horizon", "confidence", "sizePct",
];

function now() { return new Date().toISOString(); }

function envelope(data) {
  return { source: "computed", fetchedAt: now(), stale: false, data };
}

/** Convert engine ticket to idea record for persistence. */
function engineTicketToIdea(ticket) {
  return {
    ticker:          ticket.ticker,
    direction:       ticket.direction,
    thesis:          ticket.rationale || ticket.playbook,
    catalyst:        ticket.expectedDrivers?.[0] || "Engine-generated",
    entry:           ticket.entry  ?? null,
    stop:            ticket.stop   ?? null,
    target:          ticket.target ?? null,
    invalidation:    ticket.invalidation || "",
    horizon:         ticket.horizon || "3 months",
    confidence:      ticket.confidence || 50,
    sizePct:         5,
    notes:           `Engine: ${ticket.playbook} | Regime: ${ticket.regime}`,
    // Engine-specific extras
    playbook:        ticket.playbook,
    regime:          ticket.regime,
    strategyType:    ticket.strategyType,
    riskFlags:       ticket.riskFlags || [],
    engineDecision:  ticket.engineDecision,
    engineReasons:   ticket.engineReasons || [],
    shariahStatus:   ticket.shariahStatus,
    learning:        ticket.learning,
    executionStatus: "PENDING_APPROVAL",
    engineTicketId:  ticket.id,
  };
}

// ── GET /api/ideas ─────────────────────────────────────────────────────────────
router.get("/", (req, res) => {
  const store  = loadIdeas();
  const { status } = req.query;
  const ideas  = status
    ? store.ideas.filter(i => i.status === status.toUpperCase())
    : store.ideas;
  res.json(envelope({ ideas, total: store.ideas.length }));
});

// ── GET /api/ideas/latest  ← MUST be before /:id ──────────────────────────────
router.get("/latest", (_req, res) => {
  const logs = readIdeasLog(90); // look back 90 days
  if (!logs.length) {
    return res.json(envelope({ ideas: [], regime: null, ts: null, message: "No engine runs recorded yet." }));
  }
  const latest = logs[logs.length - 1];
  res.json(envelope(latest));
});

// ── GET /api/ideas/history  ← MUST be before /:id ─────────────────────────────
router.get("/history", (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days || "30", 10), 1), 365);
  const logs = readIdeasLog(days);
  res.json(envelope({ runs: logs, count: logs.length, days }));
});

// ── GET /api/ideas/playbooks  ← MUST be before /:id ───────────────────────────
router.get("/playbooks", (_req, res) => {
  const descriptions = PLAYBOOKS.map(p => ({
    id:           p.id,
    name:         p.name,
    category:     p.category,
    description:  p.description,
    invalidation: p.invalidation,
    riskNotes:    p.riskNotes,
    requiredData: p.requiredData,
  }));
  res.json(envelope({ playbooks: descriptions, count: descriptions.length }));
});

// ── GET /api/ideas/universe  — Shariah-compliant universe ────────────────────
router.get("/universe", (_req, res) => {
  res.json(envelope({
    universe:    getUniverseDetailed(),
    count:       getUniverseDetailed().length,
    thresholds:  SCREENING_THRESHOLDS,
    prohibitedTransactions: Object.fromEntries(
      Object.entries(PROHIBITED_TRANSACTIONS).map(([k, v]) => [k, v.reason])
    ),
    note: "Pre-screened against DJIM, FTSE Shariah, and S&P 500 Shariah indices. " +
          "Financial ratios (debt/assets, interest income) verified at screening date. " +
          "Re-screen annually as company financials change.",
  }));
});

// ── GET /api/ideas/performance  ← MUST be before /:id ─────────────────────────
router.get("/performance", (_req, res) => {
  const store   = loadIdeas();
  const metrics = computeMetrics(store.ideas ?? []);
  res.json(envelope(metrics));
});

// ── POST /api/ideas/weekly-report  ← MUST be before /:id ──────────────────────
router.post("/weekly-report", requireWriteAuth, async (_req, res) => {
  try {
    const store       = loadIdeas();
    const ideas       = store.ideas ?? [];
    const metrics     = computeMetrics(ideas);
    const rawRates    = cache.get("snapshot:rates");
    const ctx         = buildCtx(rawRates, null, null);
    const markdown    = generateWeeklyReport(ideas, metrics, ctx.regime);
    const filePath    = saveWeeklyReport(markdown);
    res.json(envelope({ filePath, lines: markdown.split("\n").length, regime: ctx.regime }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/ideas/alpaca  ← MUST be before /:id ──────────────────────────────
router.get("/alpaca", async (_req, res) => {
  try {
    const summary = await alpaca.getSummary();
    res.json(envelope({
      configured: alpaca.isConfigured(),
      autoExecute: alpaca.isAutoExecuteEnabled(),
      summary,
    }));
  } catch (err) {
    res.json(envelope({
      configured:  alpaca.isConfigured(),
      autoExecute: alpaca.isAutoExecuteEnabled(),
      summary:     null,
      error:       err.message,
    }));
  }
});

// ── GET /api/ideas/stats  ← MUST be before /:id ───────────────────────────────
router.get("/stats", (req, res) => {
  const store     = loadIdeas();
  const all       = store.ideas;
  const open      = all.filter(i => i.status === "OPEN");
  const closed    = all.filter(i => i.status === "CLOSED");
  const cancelled = all.filter(i => i.status === "CANCELLED");
  const hits      = closed.filter(i => i.outcome === "HIT");
  const stopped   = closed.filter(i => i.outcome === "STOPPED");

  const hitRate  = closed.length > 0 ? +(hits.length   / closed.length * 100).toFixed(1) : null;
  const stopRate = closed.length > 0 ? +(stopped.length / closed.length * 100).toFixed(1) : null;

  const avgConf = arr =>
    arr.length > 0
      ? +(arr.reduce((s, i) => s + (i.confidence ?? 0), 0) / arr.length).toFixed(1)
      : null;

  // R-multiple = actualPnLPct / riskPct  (riskPct = |entry-stop|/entry × 100)
  const rMultiples = closed
    .filter(i => i.actualPnLPct !== null && i.entry && i.stop)
    .map(i => {
      const riskPct = Math.abs(i.entry - i.stop) / i.entry * 100;
      return riskPct > 0 ? i.actualPnLPct / riskPct : null;
    })
    .filter(r => r !== null);

  const avgRMultiple = rMultiples.length > 0
    ? +(rMultiples.reduce((s, r) => s + r, 0) / rMultiples.length).toFixed(2)
    : null;

  // Average hold time in days
  const holdTimes = closed
    .filter(i => i.openedAt && i.closedAt)
    .map(i => (new Date(i.closedAt) - new Date(i.openedAt)) / 86_400_000);

  const avgHoldDays = holdTimes.length > 0
    ? +(holdTimes.reduce((s, d) => s + d, 0) / holdTimes.length).toFixed(1)
    : null;

  res.json(envelope({
    total:             all.length,
    open:              open.length,
    closed:            closed.length,
    cancelled:         cancelled.length,
    hitRate,
    stopRate,
    avgConfidenceWin:  avgConf(hits),
    avgConfidenceLoss: avgConf(stopped),
    avgRMultiple,
    avgHoldDays,
  }));
});

// ── GET /api/ideas/pending  ← MUST be before /:id ───────────────────────────
router.get("/pending", requireWriteAuth, (req, res) => {
  const store   = loadIdeas();
  const pending = (store.ideas || []).filter(i => i.executionStatus === "PENDING_APPROVAL");
  res.json(envelope({ ideas: pending, count: pending.length }));
});

// ── GET /api/ideas/journal  ← MUST be before /:id ──────────────────────────
router.get("/journal", (_req, res) => {
  const store  = loadIdeas();
  const ideas  = store.ideas ?? [];
  const closed = ideas.filter(i => i.status === "CLOSED");

  // By playbook
  const pbMap = {};
  for (const idea of closed) {
    const pb = idea.playbook || "manual";
    if (!pbMap[pb]) pbMap[pb] = { count: 0, hits: 0, rMultiples: [], pnls: [] };
    pbMap[pb].count++;
    if (idea.outcome === "HIT") pbMap[pb].hits++;
    if (idea.actualPnLPct != null) pbMap[pb].pnls.push(idea.actualPnLPct);
    if (idea.actualPnLPct != null && idea.entry && idea.stop) {
      const rPct = Math.abs(idea.entry - idea.stop) / idea.entry * 100;
      if (rPct > 0) pbMap[pb].rMultiples.push(idea.actualPnLPct / rPct);
    }
  }
  const playbookStats = Object.entries(pbMap).map(([pb, d]) => ({
    playbook: pb, count: d.count,
    hitRate: d.count > 0 ? +(d.hits / d.count * 100).toFixed(1) : null,
    avgPnLPct: d.pnls.length ? +(d.pnls.reduce((s, v) => s + v, 0) / d.pnls.length).toFixed(2) : null,
    avgRMultiple: d.rMultiples.length ? +(d.rMultiples.reduce((s, v) => s + v, 0) / d.rMultiples.length).toFixed(2) : null,
  }));

  // By regime
  const regMap = {};
  for (const idea of closed) {
    const reg = idea.regime || "unknown";
    if (!regMap[reg]) regMap[reg] = { count: 0, hits: 0, pnls: [] };
    regMap[reg].count++;
    if (idea.outcome === "HIT") regMap[reg].hits++;
    if (idea.actualPnLPct != null) regMap[reg].pnls.push(idea.actualPnLPct);
  }
  const regimeStats = Object.entries(regMap).map(([regime, d]) => ({
    regime, count: d.count,
    hitRate: d.count > 0 ? +(d.hits / d.count * 100).toFixed(1) : null,
    avgPnLPct: d.pnls.length ? +(d.pnls.reduce((s, v) => s + v, 0) / d.pnls.length).toFixed(2) : null,
  }));

  const sorted = [...closed].filter(i => i.actualPnLPct != null).sort((a, b) => b.actualPnLPct - a.actualPnLPct);
  const best3  = sorted.slice(0, 3).map(i => ({ id: i.id, ticker: i.ticker, playbook: i.playbook, pnl: i.actualPnLPct }));
  const worst3 = sorted.slice(-3).map(i => ({ id: i.id, ticker: i.ticker, playbook: i.playbook, pnl: i.actualPnLPct }));

  res.json(envelope({ playbookStats, regimeStats, best3, worst3, totalClosed: closed.length }));
});

// ── GET /api/ideas/execution-log  ← MUST be before /:id ──────────────────────
router.get("/execution-log", (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days || "7", 10), 1), 90);
  const logs = readExecutionLog(days);
  const summary = {};
  for (const log of logs) {
    const d = log.decision || "UNKNOWN";
    summary[d] = (summary[d] || 0) + 1;
  }
  res.json(envelope({ logs, summary, count: logs.length, days }));
});

// ── GET /api/ideas/exits  ← MUST be before /:id ─────────────────────────────
router.get("/exits", async (_req, res) => {
  const { checkExits } = require("../engine/exitEngine");
  const store = loadIdeas();
  const open  = (store.ideas || []).filter(i => i.status === "OPEN");

  const rawRates      = cache.get("snapshot:rates");
  const portfolioData = cache.get("portfolio:data");
  const watchlistRaw  = cache.get("snapshot:watchlist");
  const ctx = buildCtx(rawRates, portfolioData, watchlistRaw);

  const signals = checkExits(open, ctx);

  // Fire webhook for HIGH priority exit signals (fire-and-forget)
  const highSignals = signals.filter(s => s.priority === "HIGH");
  if (highSignals.length > 0) {
    fireWebhook("exit.signal", { signals: highSignals, count: highSignals.length }).catch(() => {});
  }

  res.json(envelope({ signals, count: signals.length, openIdeas: open.length, regime: ctx.regime }));
});

// ── GET /api/ideas/backtest  ← MUST be before /:id ──────────────────────────
router.get("/backtest", (req, res) => {
  const { runBacktest } = require("../engine/backtester");
  const cats = req.query.categories
    ? req.query.categories.split(",").map(c => c.trim())
    : ["macro", "structure", "portfolio"];
  const result = runBacktest({ categories: cats });
  res.json(envelope(result));
});

// ── GET /api/ideas/universe-scan — scan all 33 Shariah tickers against macro regime
router.get("/universe-scan", (req, res) => {
  const { scanUniverse, markPortfolioOverlap, getActiveConditions } = require("../engine/universeScanner");
  const minScore   = parseInt(req.query.minScore || "0", 10);
  const maxResults = Math.min(parseInt(req.query.limit || "10", 10), 33);

  const rawRates      = cache.get("snapshot:rates");
  const portfolioData = cache.get("portfolio:data");
  const watchlistRaw  = cache.get("snapshot:watchlist");

  const ctx = buildCtx(rawRates, portfolioData, watchlistRaw);

  const portfolioTickers = (portfolioData?.rows ?? seeds.POSITIONS_SEED).map(r => r.ticker);

  let candidates = scanUniverse(ctx, { minScore, maxResults });
  candidates = markPortfolioOverlap(candidates, portfolioTickers);

  res.json(envelope({
    candidates,
    count:            candidates.length,
    regime:           ctx.regime,
    activeConditions: ctx.rates ? getActiveConditions(ctx.rates) : [],
    scannedTotal:     33,
  }));
});

// ── Live price helper ────────────────────────────────────────────────────────
async function fetchLivePrice(ticker) {
  // Returns { price, source } or null on failure
  try {
    const { AV_SUPPORTED, getQuote } = require("../providers/alphaVantage");
    const { POLYGON_PEERS, getSnapshots } = require("../providers/polygon");
    if (AV_SUPPORTED.has(ticker)) {
      const q = await getQuote(ticker);
      return q ? { price: q.price, source: "AlphaVantage" } : null;
    }
    if (POLYGON_PEERS.has(ticker)) {
      const results = await getSnapshots([ticker]);
      if (results.length > 0) return { price: results[0].price, source: "Polygon" };
    }
    // LSE ETFs — no live price available
    return null;
  } catch (err) {
    console.warn(`[approve] Live price fetch failed for ${ticker}:`, err.message);
    return null;
  }
}

// ── POST /api/ideas/:id/approve  ← MUST be before GET /:id ─────────────────
router.post("/:id/approve", requireWriteAuth, async (req, res) => {
  const store = loadIdeas();
  const idea  = (store.ideas || []).find(i => i.id === req.params.id);
  if (!idea) return res.status(404).json({ error: `Idea not found: ${req.params.id}` });

  // Idempotent — already executed
  if (idea.executionStatus === "EXECUTED") {
    return res.json(envelope({ ...idea, message: "Already executed — idempotent." }));
  }
  if (idea.executionStatus === "REJECTED") {
    return res.status(400).json({ error: "Idea has been rejected and cannot be approved." });
  }

  // Freshness gate
  const MAX_AGE_MIN   = parseInt(process.env.TRADING_DATA_MAX_AGE_MIN || "20", 10);
  const snapshotMeta  = cache.getWithMeta("snapshot:rates");
  let dataFresh = true;
  let freshnessWarning = null;
  if (!snapshotMeta || snapshotMeta.stale) {
    dataFresh = false;
    freshnessWarning = "Snapshot data stale or missing.";
  } else {
    const ageMin = (Date.now() - new Date(snapshotMeta.fetchedAt).getTime()) / 60_000;
    if (ageMin > MAX_AGE_MIN) {
      dataFresh = false;
      freshnessWarning = `Snapshot ${ageMin.toFixed(0)} min old (max ${MAX_AGE_MIN} min).`;
    }
  }

  // Execution policy
  const policyCheck = executionPolicy.checkPolicy({ ticker: idea.ticker, notionalGBP: idea.sizePct ? idea.sizePct * 10 : 100 });

  const logBase = { ideaId: idea.id, ticker: idea.ticker, direction: idea.direction,
    freshnessSnapshot: { dataFresh, freshnessWarning } };

  if (!dataFresh) {
    const updated = updateIdea(idea.id, { executionStatus: "SKIPPED", executionNote: freshnessWarning });
    appendExecutionLog({ ...logBase, decision: "SKIPPED", reasons: [freshnessWarning], orderPayload: null, result: null, error: null });
    return res.json(envelope({ ...updated, freshnessWarning }));
  }

  if (!policyCheck.allowed) {
    const updated = updateIdea(idea.id, { executionStatus: "SKIPPED", executionNote: policyCheck.reasons.join("; ") });
    appendExecutionLog({ ...logBase, decision: "SKIPPED", reasons: policyCheck.reasons, orderPayload: null, result: null, error: null });
    return res.json(envelope({ ...updated, policyReasons: policyCheck.reasons }));
  }

  // ── Live price fetch at approval time ──
  let currentPrice = idea.entry;
  let priceSource  = "cached";
  let livePrice    = null;
  try {
    const livePriceResult = await fetchLivePrice(idea.ticker);
    if (livePriceResult) {
      currentPrice = livePriceResult.price;
      priceSource  = livePriceResult.source;
      livePrice    = livePriceResult.price;
    }
  } catch (_) {}

  // Position sizing
  const portfolioData = cache.get("portfolio:data");
  const accountEquityGBP = portfolioData?.totalGBP ?? 1110;
  const usdgbp = portfolioData?.usdgbp ?? 0.7558;
  const priceInGBP = currentPrice ? (alpaca.isSupported(idea.ticker) ? currentPrice * usdgbp : currentPrice) : null;
  const sizing = (currentPrice && idea.stop && priceInGBP)
    ? computeSize(currentPrice, idea.stop, accountEquityGBP, priceInGBP)
    : { qty: 1, blocked: false };

  if (sizing.blocked) {
    const updated = updateIdea(idea.id, { executionStatus: "SKIPPED", executionNote: sizing.blockReason });
    appendExecutionLog({ ...logBase, decision: "SKIPPED", reasons: [sizing.blockReason], orderPayload: null, result: null, error: null });
    return res.json(envelope({ ...updated, sizingBlocked: sizing.blockReason }));
  }

  // Attempt paper order
  let order = null;
  let execError = null;
  if (alpaca.isAutoExecuteEnabled() && executionPolicy.getConfig().tradingEnabled) {
    try {
      const dateStr = new Date().toISOString().slice(0, 10);
      const clientOrderId = `dispatch-${idea.ticker.toLowerCase()}-${idea.id.slice(0, 8)}-${dateStr}`;
      const side  = idea.direction === "LONG" ? "buy" : "sell";

      // Prefer bracket order when we have full numeric entry/stop/target
      const useBracket = idea.entry && idea.stop && idea.target &&
                         alpaca.isSupported(idea.ticker) &&
                         process.env.USE_BRACKET_ORDERS === "true";
      if (useBracket) {
        order = await alpaca.placeBracketOrder(
          idea.ticker, side, sizing.qty || 1,
          idea.entry, idea.target, idea.stop, clientOrderId
        );
      } else {
        order = await alpaca.placeOrder(idea.ticker, side, sizing.qty || 1, "market", clientOrderId);
      }
      executionPolicy.recordTrade(idea.ticker, sizing.notionalGBP || 100);
    } catch (err) {
      execError = err.message;
    }
  }

  const newStatus = order ? "EXECUTED" : (execError ? "FAILED" : "APPROVED");
  const updated = updateIdea(idea.id, { executionStatus: newStatus, executionNote: execError || null, alpacaOrderId: order?.id });
  appendExecutionLog({
    ...logBase, decision: newStatus, reasons: execError ? [execError] : [],
    orderPayload: order ? { ticker: idea.ticker, side: idea.direction === "LONG" ? "buy" : "sell", qty: sizing.qty || 1 } : null,
    result: order ? { orderId: order.id } : null, error: execError
  });

  // Fire webhook for executed orders (fire-and-forget)
  if (order) {
    fireWebhook("idea.executed", { ideaId: idea.id, ticker: idea.ticker, orderId: order?.id }).catch(() => {});
  }

  res.json(envelope({ ...updated, sizing, order, priceSource, livePrice }));
});

// ── POST /api/ideas/:id/reject  ← MUST be before GET /:id ──────────────────
router.post("/:id/reject", requireWriteAuth, (req, res) => {
  const store = loadIdeas();
  const idea  = (store.ideas || []).find(i => i.id === req.params.id);
  if (!idea) return res.status(404).json({ error: `Idea not found: ${req.params.id}` });

  const note = req.body?.reason || "Manually rejected.";
  const updated = updateIdea(idea.id, { executionStatus: "REJECTED", executionNote: note });
  appendExecutionLog({ ideaId: idea.id, ticker: idea.ticker, direction: idea.direction,
    decision: "REJECTED", reasons: [note], freshnessSnapshot: {}, orderPayload: null, result: null, error: null });

  // Fire webhook (fire-and-forget)
  fireWebhook("idea.rejected", { ideaId: idea.id, ticker: idea.ticker, reason: note }).catch(() => {});

  res.json(envelope(updated));
});

// ── GET /api/ideas/:id ─────────────────────────────────────────────────────────
router.get("/:id", (req, res) => {
  const store = loadIdeas();
  const idea  = store.ideas.find(i => i.id === req.params.id);
  if (!idea) return res.status(404).json({ error: `Idea not found: ${req.params.id}` });
  res.json(envelope(idea));
});

// ── POST /api/ideas ────────────────────────────────────────────────────────────
router.post("/", requireWriteAuth, (req, res) => {
  const body = req.body || {};

  // Shariah: reject SHORT ideas
  if (body.direction === "SHORT") {
    return res.status(400).json({
      error: "SHORT ideas are not permitted. Shariah principles prohibit short-selling (gharar — selling what you do not own). Only LONG positions are allowed.",
      shariahRule: "gharar"
    });
  }

  // Validate required fields
  const missing = REQUIRED.filter(f => body[f] === undefined || body[f] === "");
  if (missing.length) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(", ")}` });
  }

  // Validate enums + types
  if (!["LONG", "SHORT"].includes(body.direction)) {
    return res.status(400).json({ error: "direction must be LONG or SHORT" });
  }
  if (typeof body.confidence !== "number" || body.confidence < 0 || body.confidence > 100) {
    return res.status(400).json({ error: "confidence must be a number 0–100" });
  }
  if (typeof body.sizePct !== "number" || body.sizePct <= 0) {
    return res.status(400).json({ error: "sizePct must be a positive number" });
  }
  if (typeof body.entry !== "number" || typeof body.stop !== "number" || typeof body.target !== "number") {
    return res.status(400).json({ error: "entry, stop, and target must be numbers" });
  }

  // Run pre-trade risk check using cached portfolio data (or seeds as fallback)
  const portfolioData = cache.get("portfolio:data");
  const portfolioRows = portfolioData?.rows ?? [];
  const totalGBP      = portfolioData?.totalGBP ?? seeds.POSITIONS_SEED.reduce((s, _p) => s, 1110);
  const usdgbp        = portfolioData?.usdgbp   ?? seeds.FX_SEED.usdgbp.value;

  const riskCheck = runPreTradeCheck(body, portfolioRows, totalGBP, usdgbp);

  const idea = addIdea({ ...body, riskCheck });
  res.status(201).json(envelope(idea));
});

// ── PATCH /api/ideas/:id ───────────────────────────────────────────────────────
router.patch("/:id", requireWriteAuth, (req, res) => {
  const patch = req.body || {};

  // Validate status / outcome if provided
  if (patch.status && !["OPEN", "CLOSED", "CANCELLED"].includes(patch.status)) {
    return res.status(400).json({ error: "status must be OPEN, CLOSED, or CANCELLED" });
  }
  if (patch.outcome && !["HIT", "STOPPED", "CANCELLED"].includes(patch.outcome)) {
    return res.status(400).json({ error: "outcome must be HIT, STOPPED, or CANCELLED" });
  }

  // Auto-set closedAt when closing or cancelling
  if ((patch.status === "CLOSED" || patch.status === "CANCELLED") && !patch.closedAt) {
    patch.closedAt = now();
  }

  try {
    const updated = updateIdea(req.params.id, patch);
    res.json(envelope(updated));
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    throw err;
  }
});

// ── DELETE /api/ideas/:id ──────────────────────────────────────────────────────
router.delete("/:id", requireWriteAuth, (req, res) => {
  try {
    const updated = updateIdea(req.params.id, {
      status:   "CANCELLED",
      closedAt: now(),
      outcome:  "CANCELLED",
    });
    res.json(envelope(updated));
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    throw err;
  }
});

// ── POST /api/ideas/generate ──────────────────────────────────────────────────
// Returns draft trade idea suggestions (not persisted) based on current
// portfolio + macro context. Uses Claude AI or falls back to deterministic.
// ─────────────────────────────────────────────────────────────────────────────

/** Extract numeric value from a seed rate object or plain number. */
function extractRateVal(obs, fallback) {
  if (obs && typeof obs.value === "number") return obs.value;
  if (typeof obs === "number") return obs;
  return fallback;
}

/** Classify current macro regime from rates (mirrors brief.js). */
function classifyRegime(r) {
  const labels = [];
  if      (r.t10y2y < 0)   labels.push("Inverted curve");
  else if (r.t10y2y < 0.3) labels.push("Flat curve");
  else                      labels.push("Bear steepener");
  if      (r.dfii10 > 2.0) labels.push("High real yields");
  else if (r.dfii10 > 1.5) labels.push("Elevated real yields");
  if      (r.hy_spread > 4.5)                         labels.push("Credit stress");
  else if (r.hy_spread > 3.5)                         labels.push("Risk-off");
  else if (r.hy_spread > 3.0 && r.dfii10 > 1.5)      labels.push("Bear flattener");
  if (r.dgs10 > 4.5) labels.push("Rates restrictive");
  return labels.length ? labels.join(" + ") : "Broadly neutral";
}

/** Build portfolio context string for the AI prompt. */
function buildPortfolioContext(rates, portfolioRows, totalGBP) {
  const regime = classifyRegime(rates);
  const rowLines = portfolioRows
    .map(r => {
      const pct = totalGBP > 0 && r.valGBP != null ? (r.valGBP / totalGBP * 100).toFixed(1) : "—";
      return `  ${r.ticker}: ${pct}% portfolio weight${r.chg != null ? `, today ${r.chg >= 0 ? "+" : ""}${r.chg.toFixed(1)}%` : ""}`;
    })
    .join("\n");

  return [
    `MACRO REGIME: ${regime}`,
    `FRED RATES:  10Y ${rates.dgs10.toFixed(2)}%  Real ${rates.dfii10.toFixed(2)}%  Breakeven ${rates.t10yie.toFixed(2)}%  HY OAS ${rates.hy_spread.toFixed(2)}%  Curve ${rates.t10y2y.toFixed(2)}%`,
    `PORTFOLIO (total ~£${totalGBP.toFixed(0)}):`,
    rowLines,
    `KEY EVENTS:  FOMC 19 Mar (hold expected, dot plot critical)  |  AMD Q1 Earnings 22 Apr (guide $9.8B)`,
  ].join("\n");
}

/** Deterministic ideas based on current regime — used when AI is unavailable. */
function deterministicIdeas(rates, portfolioRows, totalGBP) {
  function weight(ticker) {
    const row = portfolioRows.find(r => r.ticker === ticker);
    return (row?.valGBP != null && totalGBP > 0) ? row.valGBP / totalGBP * 100 : 0;
  }

  const ideas = [];
  const amdPct  = weight("AMD");
  const sglnPct = weight("SGLN");

  // 1. AMD long — rate-sensitive growth / FOMC catalyst
  if (amdPct < 20) {
    ideas.push({
      ticker:       "AMD",
      direction:    "LONG",
      thesis:       `Earnings momentum + macro catalyst play. AMD trades at a discount (real yields ${rates.dfii10.toFixed(2)}% compress growth P/E). MI450 GPU ramp on track for Q1 $9.8B guide. A dovish FOMC dot plot shift on 19 Mar mechanically re-rates growth multiples, delivering double benefit: lower discount rate + improved AI capex sentiment.`,
      catalyst:     "FOMC dot plot shifts dovish on 19 Mar; real yield compression below 1.6%.",
      entry:        192,
      stop:         175,
      target:       230,
      invalidation: "MI450 hyperscaler order cancellations; Q1 miss >10% vs $9.8B guide; FOMC unexpectedly hawkish.",
      horizon:      "3 months",
      confidence:   62,
      sizePct:      4,
      notes:        `Strategy: earnings momentum + rate catalyst. Current weight ${amdPct.toFixed(1)}%. High beta (1.82) — size conservatively while real yields >1.5%.`,
    });
  }

  // 2. SGLN long — macro hedge / risk-off
  if (sglnPct < 25 && (rates.hy_spread > 3.0 || rates.dfii10 > 1.5)) {
    ideas.push({
      ticker:       "SGLN",
      direction:    "LONG",
      thesis:       `Macro hedge strategy. HY OAS at ${rates.hy_spread.toFixed(2)}% signals credit stress building; real yields at ${rates.dfii10.toFixed(2)}% support gold's store-of-value bid. SGLN's negative beta (−0.08) earns its keep passively without active management. Risk-off / high-real-yield regime typically favours gold over equities.`,
      catalyst:     "HY spread widening above 3.5% or equity drawdown >5%.",
      entry:        74.00,
      stop:         70.50,
      target:       82.00,
      invalidation: "HY spread compression below 2.5% or real yield decline below 1.0% on confirmed Fed pivot.",
      horizon:      "3 months",
      confidence:   70,
      sizePct:      3,
      notes:        `Strategy: macro hedge / risk-off. Current weight ${sglnPct.toFixed(1)}%. Keep total SGLN below 25%.`,
    });
  }

  // 3. HBKS long — duration play / flat curve
  if (rates.t10y2y < 0.5) {
    ideas.push({
      ticker:       "HBKS",
      direction:    "LONG",
      thesis:       `Late-cycle duration long strategy. Yield curve at ${rates.t10y2y.toFixed(2)}% points to late-cycle dynamics where the front end reprices lower first on any growth scare. Halal sukuk provides compliant duration + income. Negative equity correlation provides ballast against AMD drawdown risk in the portfolio.`,
      catalyst:     "Fed signals June 2026 rate cuts in dot plot; US ISM Manufacturing <48 for two consecutive months.",
      entry:        8.65,
      stop:         8.25,
      target:       9.50,
      invalidation: "Bear steepener — long-end yield sell-off above 4.75% on inflationary re-acceleration.",
      horizon:      "6 months",
      confidence:   65,
      sizePct:      3,
      notes:        "Strategy: late-cycle duration long. Halal-compliant. Diversifies AMD equity concentration risk.",
    });
  }

  return ideas.slice(0, 3);
}

router.post("/generate", requireWriteAuth, async (req, res) => {
  const count   = Math.min(Math.max(parseInt(req.body?.count || 5, 10), 1), 10);
  const lowCost = process.env.LOW_COST_MODE === "true";
  const apiFallback = budget.getApiFallbackInfo().active;

  // ── Build context ──
  const rawRates      = cache.get("snapshot:rates");
  const portfolioData = cache.get("portfolio:data");
  const watchlistRaw  = cache.get("snapshot:watchlist");

  let ctx;
  try {
    ctx = buildCtx(rawRates, portfolioData, watchlistRaw);
  } catch (err) {
    console.warn("[ideas/generate] buildCtx failed, using legacy path:", err.message);
    // Legacy fallback: use old deterministic path
    const rates = {
      dgs10:     extractRateVal(rawRates?.dgs10,     seeds.RATES_SEED.dgs10.value),
      dfii10:    extractRateVal(rawRates?.dfii10,    seeds.RATES_SEED.dfii10.value),
      t10yie:    extractRateVal(rawRates?.t10yie,    seeds.RATES_SEED.t10yie.value),
      hy_spread: extractRateVal(rawRates?.hy_spread, seeds.RATES_SEED.hy_spread.value),
      t10y2y:    extractRateVal(rawRates?.t10y2y,    seeds.RATES_SEED.t10y2y.value),
    };
    const portfolioRows = portfolioData?.rows ?? seeds.POSITIONS_SEED.map(p => ({ ticker: p.ticker, valGBP: null, chg: null }));
    const totalGBP      = portfolioData?.totalGBP ?? 1110;
    const ideas = deterministicIdeas(rates, portfolioRows, totalGBP);
    return res.json({ source: "deterministic", fetchedAt: now(), stale: false, data: { ideas, regime: classifyRegime(rates) } });
  }

  // ── Try idea engine (deterministic playbooks) ──
  let engineIdeas = [];
  let engineError = null;
  try {
    engineIdeas = generateIdeas(ctx, { maxIdeas: count });
  } catch (err) {
    engineError = err.message;
    console.warn("[ideas/generate] Idea engine failed:", err.message);
  }

  // ── Append to logs ──
  try {
    if (engineIdeas.length > 0) {
      appendIdeasLog({ ideas: engineIdeas, regime: ctx.regime, totalIdeas: engineIdeas.length });
      appendSignalsLog({ signals: ctx.signals, rates: ctx.rates, regime: ctx.regime });
    }
  } catch (err) {
    console.warn("[ideas/generate] Log append failed:", err.message);
  }

  // ── Persist engine ideas as PENDING_APPROVAL ──
  const persistedIdeas = [];
  for (const ticket of engineIdeas) {
    try {
      const idea = addIdea(engineTicketToIdea(ticket));
      persistedIdeas.push(idea);
    } catch (err) {
      console.warn("[ideas/generate] Could not persist ticket:", err.message);
    }
  }

  // Fire webhook for new pending ideas (fire-and-forget)
  if (persistedIdeas.length > 0) {
    fireWebhook("idea.pending", { count: persistedIdeas.length, tickers: persistedIdeas.map(i => i.ticker), regime: ctx.regime }).catch(() => {});
  }

  // ── Alpaca auto-execution — shared module (also used by ideaScheduler) ──
  let playbookPerf = {};
  try {
    const { runBacktest } = require("../engine/backtester");
    const bt = runBacktest();
    playbookPerf = Object.fromEntries(bt.byPlaybook.map(p => [p.playbookId, p]));
  } catch (_) {}

  const execResult = await autoExecuteIdeas(engineIdeas, ctx, playbookPerf);
  const alpacaOrders = execResult.orders;
  const freshnessWarning = execResult.freshness.warning;

  if (execResult.enabled) {
    console.log(`[ideas/generate] Auto-execution: ${execResult.orders.length} executed, ${execResult.skipped.length} skipped.`);
  } else if (freshnessWarning) {
    console.log(`[ideas/generate] Auto-execution skipped — ${freshnessWarning}`);
  }

  // ── Optional AI enrichment of learning layer ──
  let source = engineIdeas.length > 0 ? "engine" : "deterministic";
  if (!lowCost && !apiFallback && engineIdeas.length > 0) {
    try {
      budget.checkAndIncrement(); // throws BudgetError if over daily/monthly cap
      const rates = ctx.rates;
      const portfolioRows = portfolioData?.rows ?? [];
      const totalGBP = portfolioData?.totalGBP ?? 1110;
      const aiContext = buildPortfolioContext(rates, portfolioRows, totalGBP);
      // Enrich top 2 ideas — merge AI narrative into rationale, preserve engine structure
      const aiIdeas = await generateTradeIdeas(aiContext, Math.min(engineIdeas.length, 2));
      for (let i = 0; i < Math.min(aiIdeas.length, engineIdeas.length); i++) {
        if (aiIdeas[i]?.thesis) {
          engineIdeas[i].rationale  = aiIdeas[i].thesis;
          engineIdeas[i].sourceMode = "ai-enriched";
        }
      }
      source = "ai-enriched";
    } catch (err) {
      console.warn("[ideas/generate] AI enrichment skipped:", err.message);
    }
  }

  // ── Universe scan: additional candidates from Shariah universe ──
  let universeCandidates = [];
  try {
    const { scanUniverse, markPortfolioOverlap } = require("../engine/universeScanner");
    const portfolioTickers = (portfolioData?.rows ?? seeds.POSITIONS_SEED).map(r => r.ticker);
    // Exclude tickers already covered by engine ideas
    const engineTickers = new Set(engineIdeas.map(i => i.ticker));
    let rawCandidates = scanUniverse(ctx, { minScore: 1, maxResults: 3 });
    rawCandidates = markPortfolioOverlap(rawCandidates, portfolioTickers);
    // Only include tickers NOT already in engine ideas, to avoid duplication
    universeCandidates = rawCandidates.filter(c => !engineTickers.has(c.ticker));
  } catch (err) {
    console.warn("[ideas/generate] Universe scan failed:", err.message);
  }

  // ── Fallback: if engine produced nothing, use legacy deterministic ideas ──
  const finalIdeas = engineIdeas.length > 0 ? engineIdeas : (() => {
    const rates = ctx.rates;
    const portfolioRows = portfolioData?.rows ?? seeds.POSITIONS_SEED.map(p => ({ ticker: p.ticker, valGBP: null, chg: null }));
    const totalGBP = portfolioData?.totalGBP ?? 1110;
    return deterministicIdeas(rates, portfolioRows, totalGBP);
  })();

  res.json({
    source:    source,
    fetchedAt: now(),
    stale:     false,
    data: {
      ideas:        finalIdeas,
      universeScan: universeCandidates,
      regime:       ctx.regime,
      engineVersion: "1.0",
      alpacaOrders,
      persistedCount: persistedIdeas.length,
      ...(freshnessWarning ? { freshnessWarning } : {}),
      ...(engineError ? { engineError } : {}),
    },
  });
});

// ── POST /api/ideas/sync  ← Alpaca ↔ local ideas sync ──────────────────────
router.post("/sync", requireWriteAuth, async (req, res) => {
  if (!alpaca.isConfigured()) {
    return res.json(envelope({ synced: 0, message: "Alpaca not configured." }));
  }

  let positions = [];
  let orders = [];
  try {
    [positions, orders] = await Promise.all([alpaca.getPositions(), alpaca.getOpenOrders()]);
  } catch (err) {
    return res.status(502).json({ error: `Alpaca sync failed: ${err.message}` });
  }

  const positionTickers = new Set(positions.map(p => p.symbol.toUpperCase()));
  const store  = loadIdeas();
  const synced = [];

  for (const idea of store.ideas) {
    if (idea.status !== "OPEN" || idea.executionStatus !== "EXECUTED") continue;
    if (!alpaca.isSupported(idea.ticker)) continue;

    // If position no longer held — it was closed
    if (!positionTickers.has(idea.ticker.toUpperCase())) {
      const wl = cache.getWithMeta("snapshot:watchlist");
      const watchlistItems = wl?.value ?? [];
      const priceItem = Array.isArray(watchlistItems) && watchlistItems.find(w => (w.sym || w.ticker) === idea.ticker);
      const currentPrice = priceItem?.price ?? null;

      let actualPnLPct = null;
      let outcome = "STOPPED"; // default
      if (currentPrice != null && idea.entry != null && idea.entry > 0) {
        actualPnLPct = +((currentPrice - idea.entry) / idea.entry * 100).toFixed(2);
        outcome = actualPnLPct >= 0 ? "HIT" : "STOPPED";
      }

      try {
        updateIdea(idea.id, {
          status:          "CLOSED",
          closedAt:        new Date().toISOString(),
          outcome,
          actualPnLPct,
          executionStatus: "EXECUTED",
          notes:           (idea.notes || "") + " [Auto-closed via Alpaca sync]",
        });
        synced.push({ ideaId: idea.id, ticker: idea.ticker, outcome, actualPnLPct });
        appendExecutionLog({
          ideaId: idea.id, ticker: idea.ticker, direction: idea.direction,
          decision: "SYNCED_CLOSED", reasons: [`Position no longer held - ${outcome}`],
          freshnessSnapshot: {}, orderPayload: null,
          result: { outcome, actualPnLPct }, error: null,
        });
      } catch (err) {
        console.warn(`[sync] Failed to update idea ${idea.id}:`, err.message);
      }
    }
  }

  res.json(envelope({
    synced:    synced.length,
    positions: positions.length,
    orders:    orders.length,
    updates:   synced,
  }));
});

module.exports = router;
