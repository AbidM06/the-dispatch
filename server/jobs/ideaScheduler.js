/**
 * server/jobs/ideaScheduler.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Time-based scheduler for the idea engine.
 * No external dependencies — uses setInterval (checks every 60 seconds).
 *
 * Schedule: 08:00 and 15:30 local time, Mon–Fri only.
 * Sunday 18:00: weekly review.
 * Cooldown: skip if last run < ENGINE_COOLDOWN_MIN minutes ago (default 30).
 * Gate: skip if LOW_COST_MODE=true.
 *
 * Usage:
 *   const { start, stop, getStatus } = require("./ideaScheduler");
 *   start();     // call once from server/index.js
 *   stop();      // cleanup in tests
 *   getStatus(); // → { lastRunAt, nextRunAt, totalRuns, lastError }
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const cache     = require("../cache");
const seeds     = require("../../seeds/fallback");
const { generateIdeas, buildCtx } = require("../engine/ideaEngine");
const { appendIdeasLog, appendSignalsLog } = require("../importers/ideaLog");
const { loadIdeas, addIdea, saveIdeas } = require("../importers/ideas");
const { computeMetrics } = require("../analytics/paperTrader");
const { generateWeeklyReport, saveWeeklyReport } = require("./weeklyReview");
const { autoExecuteIdeas } = require("../engine/autoExecute");
const { fireWebhook }      = require("../providers/webhook");

// ── Config ────────────────────────────────────────────────────────────────────

const scheduleStr      = process.env.ENGINE_SCHEDULE || "08:00,15:30";
const RUN_TIMES        = scheduleStr.split(",").map(t => t.trim()).filter(t => /^\d{2}:\d{2}$/.test(t));
const WEEKLY_TIME      = "18:00";                   // Sunday only
const TICK_INTERVAL_MS = 60_000;                    // check every minute

function cooldownMin() {
  return parseInt(process.env.ENGINE_COOLDOWN_MIN ?? "30", 10);
}

function maxOpenIdeas() {
  return parseInt(process.env.MAX_OPEN_IDEAS ?? "60", 10);
}

const PENDING_EXPIRY_DAYS = 14;

/**
 * Idea data hygiene — runs before persisting new tickets each engine cycle:
 *  1. Expire PENDING_APPROVAL ideas older than PENDING_EXPIRY_DAYS (never reviewed).
 *  2. Drop duplicate tickets that match an existing OPEN idea on ticker + playbook
 *     (the universe-scan playbook re-proposes the same setup every run otherwise).
 *  3. If still at/over MAX_OPEN_IDEAS after expiry, drop the lowest-confidence
 *     incoming tickets so the open book never grows unbounded.
 * Returns { tickets: keptTickets, expiredCount, dedupedCount }
 */
function applyIdeaHygiene(store, tickets) {
  const now = Date.now();
  const expiryMs = PENDING_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  let expiredCount = 0;

  for (const idea of store.ideas) {
    if (idea.status === "OPEN" && idea.executionStatus === "PENDING_APPROVAL") {
      const age = now - new Date(idea.openedAt).getTime();
      if (age > expiryMs) {
        idea.status = "CLOSED";
        idea.outcome = "EXPIRED";
        idea.closedAt = new Date().toISOString();
        idea.executionStatus = "SKIPPED";
        expiredCount++;
      }
    }
  }

  const openIdeas = store.ideas.filter(i => i.status === "OPEN");
  const openKeys = new Set(openIdeas.map(i => `${i.ticker}|${i.playbook || "manual"}`));

  let deduped = tickets.filter(t => !openKeys.has(`${t.ticker}|${t.playbook}`));
  const dedupedCount = tickets.length - deduped.length;

  const room = Math.max(0, maxOpenIdeas() - openIdeas.length);
  if (deduped.length > room) {
    deduped = [...deduped].sort((a, b) => (b.confidence || 0) - (a.confidence || 0)).slice(0, room);
  }

  return { tickets: deduped, expiredCount, dedupedCount };
}

// ── State ─────────────────────────────────────────────────────────────────────

const status = {
  lastRunAt:   null,
  nextRunAt:   null,
  totalRuns:   0,
  lastError:   null,
  skipped:     null,
  intervalId:  null,
  running:     false,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeStr(date) {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function isWeekday(date) {
  const d = date.getDay(); // 0=Sun, 6=Sat
  return d >= 1 && d <= 5;
}

function isSunday(date) {
  return date.getDay() === 0;
}

function withinCooldown() {
  if (!status.lastRunAt) return false;
  const elapsedMin = (Date.now() - new Date(status.lastRunAt).getTime()) / 60_000;
  return elapsedMin < cooldownMin();
}

/**
 * Compute the next scheduled run time string (informational only).
 */
function computeNextRunAt() {
  const now  = new Date();
  const hm   = timeStr(now);
  const all  = [...RUN_TIMES, WEEKLY_TIME].sort();
  // Find the next time today or tomorrow
  const next = all.find(t => t > hm);
  if (next) {
    const d = new Date(now);
    const [h, m] = next.split(":").map(Number);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  }
  // Past all times today — next is first time tomorrow
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  const [h, m] = all[0].split(":").map(Number);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

// ── Engine ticket → persisted idea ───────────────────────────────────────────

function ticketToIdea(ticket) {
  return {
    ticker:         ticket.ticker,
    direction:      ticket.direction,
    thesis:         ticket.rationale || ticket.playbook,
    catalyst:       ticket.expectedDrivers?.[0] || "Scheduler-generated",
    entry:          ticket.entry  ?? null,
    stop:           ticket.stop   ?? null,
    target:         ticket.target ?? null,
    invalidation:   ticket.invalidation || "",
    horizon:        ticket.horizon || "3 months",
    confidence:     ticket.confidence || 50,
    sizePct:        5,
    notes:          `Engine: ${ticket.playbook} | Regime: ${ticket.regime}`,
    playbook:       ticket.playbook,
    regime:         ticket.regime,
    strategyType:   ticket.strategyType,
    riskFlags:      ticket.riskFlags || [],
    engineDecision: ticket.engineDecision,
    engineReasons:  ticket.engineReasons || [],
    shariahStatus:  ticket.shariahStatus,
    learning:       ticket.learning,
    executionStatus: "PENDING_APPROVAL",
    engineTicketId:  ticket.id,
  };
}

// ── Engine run ────────────────────────────────────────────────────────────────

/**
 * Execute one engine run: build ctx, generate ideas, persist, auto-execute.
 */
async function runEngine() {
  if (status.running) {
    console.log("[scheduler] Engine already running — skipping.");
    return;
  }
  status.running   = true;
  status.lastRunAt = new Date().toISOString();
  status.totalRuns++;
  status.lastError = null;

  try {
    const rawRates      = cache.get("snapshot:rates");
    const portfolioData = cache.get("portfolio:data");
    const watchlistRaw  = cache.get("snapshot:watchlist");

    const ctx     = buildCtx(rawRates, portfolioData, watchlistRaw);
    const tickets = generateIdeas(ctx, { maxIdeas: 5 });

    // ── Log signals + ideas ──
    appendIdeasLog({ ideas: tickets, regime: ctx.regime, totalIdeas: tickets.length });
    appendSignalsLog({ signals: ctx.signals, rates: ctx.rates, regime: ctx.regime });

    // ── Idea hygiene: expire stale pending ideas, dedupe vs. existing open book, cap size ──
    const store = loadIdeas();
    const { tickets: keptTickets, expiredCount, dedupedCount } = applyIdeaHygiene(store, tickets);
    if (expiredCount > 0 || dedupedCount > 0) {
      saveIdeas(store.ideas);
      console.log(`[scheduler] Idea hygiene — expired ${expiredCount} stale pending idea(s), deduped ${dedupedCount} repeat ticket(s).`);
    }

    // ── Persist as PENDING_APPROVAL + fire webhook ──
    const persisted = [];
    for (const ticket of keptTickets) {
      try {
        const idea = addIdea(ticketToIdea(ticket));
        persisted.push(idea);
      } catch (err) {
        console.warn("[scheduler] Could not persist ticket:", err.message);
      }
    }
    if (persisted.length > 0) {
      fireWebhook("idea.pending", {
        count:   persisted.length,
        tickers: persisted.map(i => i.ticker),
        regime:  ctx.regime,
        source:  "scheduler",
      }).catch(() => {});
    }

    console.log(`[scheduler] Engine run — ${tickets.length} ideas generated (regime: ${ctx.regime}).`);

    // ── Auto-execution (if TRADING_ENABLED + AUTO_APPROVE_PAPER + ALPACA_AUTO_EXECUTE) ──
    let playbookPerf = {};
    try {
      const { runBacktest } = require("../engine/backtester");
      const bt = runBacktest();
      playbookPerf = Object.fromEntries(bt.byPlaybook.map(p => [p.playbookId, p]));
    } catch (_) {}

    const execResult = await autoExecuteIdeas(keptTickets, ctx, playbookPerf);

    if (execResult.enabled) {
      console.log(`[scheduler] Auto-execution: ${execResult.orders.length} executed, ${execResult.skipped.length} skipped.`);
      if (execResult.freshness.warning) {
        console.warn(`[scheduler] Freshness warning: ${execResult.freshness.warning}`);
      }
    } else {
      const reason = execResult.freshness.warning || "Auto-execute not enabled";
      console.log(`[scheduler] Auto-execution skipped — ${reason}`);
    }

  } catch (err) {
    status.lastError = err.message;
    console.error("[scheduler] Engine run error:", err.message);
  } finally {
    status.running   = false;
    status.nextRunAt = computeNextRunAt();
  }
}

/**
 * Execute weekly review: read closed ideas, generate + save report.
 */
async function runWeeklyReview() {
  try {
    const store   = loadIdeas();
    const ideas   = store.ideas ?? [];
    const metrics = computeMetrics(ideas);
    const rawRates = cache.get("snapshot:rates");
    // Build regime from cached rates
    const ctx     = buildCtx(rawRates, null, null);
    const md      = generateWeeklyReport(ideas, metrics, ctx.regime);
    saveWeeklyReport(md);
    console.log("[scheduler] Weekly review report generated.");
  } catch (err) {
    console.error("[scheduler] Weekly review error:", err.message);
  }
}

// ── Tick ──────────────────────────────────────────────────────────────────────

async function tick() {
  const now = new Date();
  const hm  = timeStr(now);

  // LOW_COST_MODE gate
  if (process.env.LOW_COST_MODE === "true") {
    status.skipped = "LOW_COST_MODE";
    return;
  }

  // Weekly review: Sunday at 18:00
  if (isSunday(now) && hm === WEEKLY_TIME) {
    await runWeeklyReview();
    return;
  }

  // Regular engine runs: weekdays at 08:00 and 15:30
  if (!isWeekday(now)) return;
  if (!RUN_TIMES.includes(hm)) return;

  // Cooldown guard
  if (withinCooldown()) {
    const elapsed = Math.round((Date.now() - new Date(status.lastRunAt).getTime()) / 60_000);
    console.log(`[scheduler] Cooldown active — last run ${elapsed}m ago (cooldown ${cooldownMin()}m). Skipping.`);
    return;
  }

  await runEngine();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start the scheduler. Safe to call multiple times (no-op if already running).
 */
function start() {
  if (status.intervalId) return; // already started
  status.nextRunAt  = computeNextRunAt();
  status.intervalId = setInterval(tick, TICK_INTERVAL_MS);
  console.log(`[scheduler] Idea engine scheduler started. Next run: ${status.nextRunAt}`);
}

/**
 * Stop the scheduler. Used in test cleanup.
 */
function stop() {
  if (status.intervalId) {
    clearInterval(status.intervalId);
    status.intervalId = null;
  }
}

/**
 * Return current scheduler status (for /api/health or debug endpoints).
 */
function getStatus() {
  return {
    lastRunAt:  status.lastRunAt,
    nextRunAt:  status.nextRunAt,
    totalRuns:  status.totalRuns,
    lastError:  status.lastError,
    skipped:    status.skipped,
    running:    status.running,
  };
}

// Export runEngine for direct testing
module.exports = { start, stop, getStatus, runEngine, tick };
