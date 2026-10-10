/**
 * server/jobs/researchBatchJob.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Daily pre-generation of the research reports through the FULL five-agent
 * pipeline, with every Claude call sent via the Message Batches API.
 *
 * WHY BATCH
 * Reports run on a schedule and are cached for 24h, so nobody is waiting on one.
 * The Batch API costs 50% of the synchronous rate for identical output, which
 * makes latency the only thing traded away — and here it costs nothing.
 *
 * WHY THROUGH THE PIPELINE
 * This job used to batch single-call drafts and cache them directly, so the
 * morning reports skipped the audit, red team, PM and chair entirely and never
 * reached the report store (which the Research idea button reads). Now each
 * report runs the same generateReport() the Research tab uses, inside batch
 * mode: every stage is submitted as a batch, stages run in order, and any call
 * a batch fails to deliver is re-sent synchronously. Batching affects cost
 * only, never availability or QA.
 *
 * RESEARCH_BATCH_TYPES narrows which reports are pre-generated (comma list);
 * default is all seven. Each report's cost receipt shows what was batched.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const cache    = require("../cache");
const research = require("../routes/research");
const { getApiFallbackInfo } = require("../providers/budget");

const ALL_TYPES = ["macro", "fx", "rates", "thematic", "equity", "commodities", "sector"];

function reportTypes() {
  const raw = (process.env.RESEARCH_BATCH_TYPES || "").split(",").map(t => t.trim()).filter(Boolean);
  const chosen = raw.filter(t => ALL_TYPES.includes(t));
  return chosen.length ? chosen : ALL_TYPES;
}

const RUN_TIME = (process.env.RESEARCH_BATCH_TIME || "06:40").trim();

const status = {
  lastRunAt:     null,
  lastAttemptAt: null,
  lastError:     null,
  generated:     [],
  failed:        [],
  costUSD:       null,
};

let timer     = null;
let lastFired = null;
let running   = false;

function hhmm(d)      { return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }
function isWeekday(d) { const g = d.getDay(); return g >= 1 && g <= 5; }

/**
 * runBatchRefresh — build every scheduled report for the day.
 * @param {{ force?: boolean }} opts
 */
async function runBatchRefresh({ force = false } = {}) {
  if (running) {
    console.log("[researchBatch] Already running — skipping this tick.");
    return status;
  }
  if (process.env.LOW_COST_MODE === "true") {
    console.log("[researchBatch] Skipped — LOW_COST_MODE active.");
    return status;
  }
  const fb = getApiFallbackInfo?.();
  if (!force && fb?.active) {
    console.log(`[researchBatch] Skipped — API fallback active until ${fb.expiresAt}.`);
    return status;
  }

  running = true;
  status.lastAttemptAt = new Date().toISOString();
  status.generated = [];
  status.failed    = [];
  const types = reportTypes();

  try {
    console.log(`[researchBatch] Generating ${types.length} report(s) through the five-agent pipeline in batch mode (50% rate)…`);
    const results = await Promise.all(types.map(async type => {
      const r = await research.generateReport(type, "", { batch: true });
      return { type, r };
    }));

    let cost = 0;
    const failures = [];
    for (const { type, r } of results) {
      if (!r.ok) {
        status.failed.push(type);
        failures.push(`${type}: ${r.detail || r.reason}`);
        continue;
      }
      cache.set(research.cacheKey(type), r.report, research.TTL_24H);
      status.generated.push(type);
      cost += r.record?.meta?.cost?.totalUSD || 0;
    }

    status.costUSD   = Math.round(cost * 100) / 100;
    status.lastRunAt = new Date().toISOString();
    status.lastError = failures.length ? failures.join("; ") : null;
    console.log(
      `[researchBatch] Done — ${status.generated.length}/${types.length} cached, $${status.costUSD.toFixed(2)} total` +
      (status.failed.length ? `; failed: ${status.failed.join(", ")}` : "")
    );
  } catch (err) {
    status.lastError = err.message;
    console.error("[researchBatch] Run failed:", err.message);
  } finally {
    running = false;
  }

  return status;
}

function tick() {
  const now = new Date();
  if (!isWeekday(now)) return;
  const stamp = `${now.toDateString()} ${hhmm(now)}`;
  if (hhmm(now) !== RUN_TIME || lastFired === stamp) return;
  lastFired = stamp;
  runBatchRefresh().catch(err => console.error("[researchBatch] tick error:", err.message));
}

function start() {
  if (timer) return;
  timer = setInterval(tick, 60_000);
  if (timer.unref) timer.unref();
  console.log(`[researchBatch] Daily research batch scheduled at ${RUN_TIME} Mon–Fri (override: RESEARCH_BATCH_TIME).`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function getStatus() {
  return { ...status, runTime: RUN_TIME, running, reportTypes: reportTypes() };
}

module.exports = { start, stop, getStatus, runBatchRefresh, reportTypes, ALL_TYPES };
