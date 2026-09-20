/**
 * server/jobs/researchBatchJob.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Daily pre-generation of all six research reports via the Message Batches API.
 *
 * WHY BATCH
 * Reports run on a schedule and are cached for 24h, so nobody is waiting on one.
 * The Batch API costs 50% of the synchronous rate for identical output, which
 * makes latency the only thing being traded away — and here it costs nothing.
 *
 * The batch is submitted as a single job containing all six report types. Any
 * report the batch fails to produce is regenerated synchronously, so a batch
 * problem degrades cost, not availability.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const cache        = require("../cache");
const anthropic    = require("../providers/anthropic");
const batchApi     = require("../providers/anthropicBatch");
const macroContext = require("../providers/macroContext");
const { getApiFallbackInfo } = require("../providers/budget");

const REPORT_TYPES = ["macro", "fx", "rates", "thematic", "equity", "commodities"];
const TTL_24H      = 24 * 60 * 60 * 1000;

// Default 06:40 — ahead of the 07:30 AI refresh and the 09:37 price prefetch, so
// a batch that takes 30+ minutes still lands before the morning read.
const RUN_TIME = (process.env.RESEARCH_BATCH_TIME || "06:40").trim();

const status = {
  lastRunAt:     null,
  lastAttemptAt: null,
  lastError:     null,
  lastMode:      null,   // "batch" | "sync" | "mixed"
  generated:     [],
  failed:        [],
};

let timer     = null;
let lastFired = null;
let running   = false;

function cacheKey(type) { return `research:report:${type}`; }
function hhmm(d)        { return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }
function isWeekday(d)   { const g = d.getDay(); return g >= 1 && g <= 5; }

/** Map a spec tier to a concrete model id. */
function modelFor(tier) {
  return tier === "haiku" ? anthropic.MODEL : anthropic.MODEL_SONNET;
}

/**
 * generateSynchronously — the per-report fallback when batching does not deliver.
 * Full price, but a report at full price beats a missing one.
 */
async function generateSynchronously(type, contextStr, failures) {
  try {
    return await anthropic.fetchResearchReport(contextStr, "", type);
  } catch (err) {
    failures.push(`${type}: ${err.message}`);
    return null;
  }
}

/**
 * runBatchRefresh — build every report for the day.
 *
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
    console.log(`[researchBatch] Skipped — API fallback active until ${fb.retryAfter}.`);
    return status;
  }

  running = true;
  status.lastAttemptAt = new Date().toISOString();
  status.generated = [];
  status.failed    = [];

  try {
    // One macro fetch feeds all six reports. Every type sees the same verified
    // levels, so cross-asset claims cannot disagree between reports issued the
    // same morning.
    const macroCtx   = await macroContext.getMacroContext({ force: true }).catch(err => {
      console.warn("[researchBatch] macro context unavailable:", err.message);
      return null;
    });
    const contextStr = macroContext.toPromptBlock(macroCtx);

    const specs = await Promise.all(
      REPORT_TYPES.map(t => anthropic.buildResearchSpec(contextStr, "", t))
    );

    const requests = specs.map(spec => ({
      customId:  spec.reportType,
      system:    spec.system,
      prompt:    spec.prompt,
      maxTokens: spec.maxTokens,
      model:     modelFor(spec.tier),
      tools:     [anthropic.webSearchTool(modelFor(spec.tier))],
    }));

    console.log(`[researchBatch] Submitting ${requests.length} reports as one batch (50% rate)…`);
    const results = await batchApi.runBatch(requests);

    const failures = [];
    let batchCount = 0;
    let syncCount  = 0;

    for (const spec of specs) {
      const type = spec.reportType;
      let report = null;

      const hit = results?.[type];
      if (hit?.text) {
        try {
          // Pass the sources the batch actually returned. This used to hardcode
          // `[], true` — an empty source list with grounded:true — so batched
          // reports claimed to be search-grounded while rendering no footnotes
          // and silently dropping every citation. grounded now reflects whether
          // any source came back, so the client can flag an ungrounded report
          // instead of presenting it as sourced.
          const sources = hit.sources || [];
          report = anthropic.finalizeResearchReport(type, hit.text, sources, sources.length > 0);
          if (!sources.length) {
            console.warn(`[researchBatch] ${type} returned no web_search sources — marked ungrounded.`);
          }
          batchCount++;
        } catch (err) {
          console.warn(`[researchBatch] ${type} batched output unusable (${err.message}) — regenerating synchronously.`);
        }
      } else if (hit?.error) {
        console.warn(`[researchBatch] ${type} failed in batch: ${hit.error}`);
      }

      if (!report) {
        report = await generateSynchronously(type, contextStr, failures);
        if (report) syncCount++;
      }

      if (!report) { status.failed.push(type); continue; }

      // Verified data rides along with every report, exactly as the live route does.
      report.marketData    = macroContext.toMarketDataRows(macroCtx);
      report.policyPath    = macroCtx?.policyPath || null;
      report.dataAsOf      = macroCtx?.fetchedAt || null;
      report.missingSeries = macroCtx?.missing || [];

      cache.set(cacheKey(type), report, TTL_24H);
      status.generated.push(type);
    }

    status.lastMode = batchCount && syncCount ? "mixed" : batchCount ? "batch" : "sync";
    status.lastRunAt = new Date().toISOString();
    status.lastError = failures.length ? failures.join("; ") : null;

    console.log(
      `[researchBatch] Done — ${status.generated.length}/${REPORT_TYPES.length} cached ` +
      `(${batchCount} batched at half rate, ${syncCount} synchronous)` +
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
  return { ...status, runTime: RUN_TIME, running, reportTypes: REPORT_TYPES };
}

module.exports = { start, stop, getStatus, runBatchRefresh, REPORT_TYPES, modelFor };
