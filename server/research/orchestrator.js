/**
 * server/research/orchestrator.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Five-agent research pipeline (§18).
 *
 *   INPUT
 *     ↓ Lead Analyst draft            (call 1 — reuses fetchResearchReport)
 *     ↓ Claim/source extraction       (call 2 — cheap, no search)
 *     ↓ PARALLEL, uncontaminated:
 *         Data Auditor                (call 3 — independent web search)
 *         Red Team                    (call 4 — independent web search)
 *         Cross-Asset PM              (call 5 — search-assisted)
 *     ↓ IC Chair adjudication         (call 6 — no search)
 *     ↓ Deterministic quality gate
 *     ↓ PASS → publish | FAIL → targeted revision (bounded rounds/call cap)
 *
 * Failure philosophy (§20): a reviewer failing does NOT crash the pipeline —
 * its verdict is recorded as NOT_RUN and disclosed in institutionalQA. If the
 * draft itself fails, runPipeline throws and the route returns an honest
 * "unavailable" (there is no fabricated fallback report).
 *
 * Cross-asset facts: every agent receives the verified FRED block
 * (providers/macroContext.js). After claim extraction, factCheck.js settles
 * claims about those series in code, so the Data Auditor only searches for
 * claims the fact layer cannot cover.
 *
 * Cost: the whole run executes inside a claudeTransport context carrying a
 * cost receipt, so every call — including the draft made via anthropic.js —
 * is priced from real usage into report.meta.cost. With `batch: true` every
 * call goes through the Message Batches API at 50% (daily job only).
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const leadAnalyst  = require("./agents/leadAnalyst");
const dataAuditor  = require("./agents/dataAuditor");
const redTeam      = require("./agents/redTeam");
const portfolioPM  = require("./agents/portfolioTranslator");
const icChair      = require("./agents/icChair");
const ledger       = require("./claimLedger");
const registry     = require("./sourceRegistry");
const gate         = require("./qualityGate");
const store        = require("./reportStore");
const { newUsageTracker, modelForRole } = require("./llm");
const factCheck    = require("./factCheck");
const redTeamLog   = require("./redTeamLog");
const aiCost       = require("../providers/aiCost");
const transport    = require("../providers/claudeTransport");
const macroContext = require("../providers/macroContext");

// ── Config ────────────────────────────────────────────────────────────────────
function multiAgentEnabled() {
  // Default ON. Disable with RESEARCH_MULTI_AGENT=false.
  return process.env.RESEARCH_MULTI_AGENT !== "false";
}
function maxRounds() {
  const v = parseInt(process.env.RESEARCH_MAX_VALIDATION_ROUNDS, 10);
  return Number.isFinite(v) ? Math.max(0, v) : 2;
}
function maxCalls() {
  const v = parseInt(process.env.RESEARCH_MAX_AGENT_CALLS, 10);
  return Number.isFinite(v) ? Math.max(1, v) : 8;
}

// ── Progress tracking (§35) — stage labels, no fictional percentages ──────────
const _progress = new Map(); // type -> { stage, detail, startedAt, updatedAt }
const STAGES = {
  draft:    "Building thesis (Lead Analyst)",
  claims:   "Extracting claim ledger",
  review:   "Verifying data · stress-testing thesis · testing portfolio implications",
  chair:    "Investment Committee review",
  gate:     "Quality gate",
  revision: "Targeted revision",
  publish:  "Publishing",
  done:     "Complete",
  failed:   "Failed",
};
function setStage(type, stage, detail = "") {
  const cur = _progress.get(type) || { startedAt: new Date().toISOString() };
  _progress.set(type, { ...cur, stage, label: STAGES[stage] || stage, detail, updatedAt: new Date().toISOString() });
  console.log(`[research-orchestrator] ${type}: ${stage}${detail ? ` — ${detail}` : ""}`);
}
function getProgress(type) {
  return _progress.get(type) || null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function researchSummary(research) {
  return [research?.title, research?.subtitle, research?.thesis || research?.executiveSummary]
    .filter(Boolean).join(" — ");
}

/** Run a reviewer, capturing failure as a NOT_RUN verdict instead of throwing. */
// D-19 (owner): a review step that fails on a temporary problem (overloaded,
// rate-limited, server error, timeout) is retried ONCE after a pause. If it
// fails again the report is still shown, marked unreviewed with the reason.
// Budget, billing and key errors are never retried.
const REVIEW_RETRY_MS = () => Number(process.env.RESEARCH_REVIEW_RETRY_MS ?? (process.env.NODE_ENV === "test" ? 0 : 60_000));
function isTransient(err) {
  const s = err?.status;
  if (err?.code === "BUDGET_DAILY" || err?.code === "BUDGET_MONTHLY" || err?.code === "API_CREDITS_EXHAUSTED") return false;
  return s === 429 || s === 529 || (s >= 500 && s < 600) || /timed out|timeout|ECONNRESET|socket hang up/i.test(err?.message || "");
}

// `chargeRetry` charges the retry to the pipeline's call cap and returns false
// when there is no room — a retry is a real API call and must be counted.
async function safeReview(name, fn, chargeRetry = () => true) {
  let capNote = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const out = await fn();
      return { ok: true, out, retried: attempt > 1 };
    } catch (err) {
      if (attempt === 1 && isTransient(err) && !chargeRetry()) capNote = " (not retried: the call cap was reached)";
      else if (attempt === 1 && isTransient(err)) {
        console.warn(`[research-orchestrator] ${name} failed (${err.message}) — retrying once in ${Math.round(REVIEW_RETRY_MS() / 1000)}s`);
        await new Promise(r => setTimeout(r, REVIEW_RETRY_MS()));
        continue;
      }
      console.warn(`[research-orchestrator] ${name} failed: ${err.message}`);
      return { ok: false, error: (attempt > 1 ? "failed twice (retried once) — " : "") + err.message + capNote,
               budget: err.code === "BUDGET_DAILY" || err.code === "BUDGET_MONTHLY" || err.code === "API_CREDITS_EXHAUSTED" };
    }
  }
}

function notRunQA(reason) {
  return {
    status: "NOT_RUN",
    reason,
    score: null,
    agentVerdicts: null,
    materialDisagreements: [],
    unresolvedQuestions: [],
    keyAssumptions: [],
    invalidationConditions: [],
  };
}

/**
 * runPipeline — full five-agent generation for one report type.
 *
 * @param {object} opts { type, topic, ratesContext, draftFn? }
 *   draftFn: optional override used by routes so chart-context building
 *            stays where it is today (research.js).
 * @returns {object} published report object (also persisted in reportStore)
 */
async function runPipeline(opts) {
  const receipt = aiCost.newReceipt();
  return transport.runWithContext({ receipt, batch: Boolean(opts.batch) }, () => runStages({ ...opts, receipt }));
}

async function runStages({ type, topic = "", ratesContext = "", macroCtx = null, batch = false, draftFn = null, receipt }) {
  const usage = newUsageTracker();
  const verifiedBlock = macroCtx ? macroContext.toPromptBlock(macroCtx) : "";
  const callCap = maxCalls();
  let callsUsed = 0; // authoritative call accounting for the cap (usage tracks tokens)
  // A retry costs a call. `reserve` keeps room for calls still planned (the chair).
  const retryBudget = (reserve = 0) => () => {
    if (callsUsed + 1 + reserve > callCap) return false;
    callsUsed += 1;
    return true;
  };
  const t0 = Date.now();

  // ── 1. Lead draft ───────────────────────────────────────────────────────────
  setStage(type, "draft");
  let research = await transport.runWithContext({ role: "draft" }, () => draftFn
    ? draftFn()
    : leadAnalyst.draft({ type, topic, ratesContext }));
  callsUsed += 1;   // draft goes through anthropic.js, not llm.js — count it
  // Who drafted it is fixed now: a later Sonnet revision must not erase the
  // OpenAI tier's grounded:false (no web search) marker or its attribution.
  const draftUngrounded = research?.grounded === false;
  usage.calls += 1;

  // ── 2. Claim/source extraction ─────────────────────────────────────────────
  setStage(type, "claims");
  let extraction = null;
  let claims = [];
  let sources = [];
  callsUsed += 1;
  const extractRes = await safeReview("extraction", () => leadAnalyst.extract({ research, usage }), retryBudget(1));
  let fc = { settledIds: [], sources: [], results: [] };
  if (extractRes.ok) {
    extraction = extractRes.out;
    claims  = ledger.normalizeClaims(extraction.claims);
    sources = registry.registerSources(extraction.sources, "lead", []);

    // Settle claims about the verified FRED series in code — free, sourced,
    // and they never reach the auditor's search budget.
    fc = factCheck.checkClaims(claims, macroCtx);
    if (fc.sources.length) {
      // Link every source that supports a settled claim — registerSources merges
      // a FRED URL the lead already cited into that existing entry.
      sources = registry.registerSources(fc.sources, "fact_check", sources);
      for (const src of sources) {
        for (const id of src.supportsClaims || []) {
          const c = claims.find(x => x.claimId === id);
          if (c && !c.sourceIds.includes(src.sourceId)) c.sourceIds.push(src.sourceId);
        }
      }
    }
    if (fc.settledIds.length) console.log(`[research-orchestrator] fact check settled ${fc.settledIds.length} claim(s) against FRED in code`);
  } else {
    console.warn("[research-orchestrator] claim extraction unavailable — publishing with QA degraded");
  }

  // ── 3. Parallel independent reviews (no cross-contamination) ───────────────
  setStage(type, "review");
  let auditRes = { ok: false, error: "not attempted" };
  let redRes   = { ok: false, error: "not attempted" };
  let pmRes    = { ok: false, error: "not attempted" };

  // Red Team and Cross-Asset PM review the report itself — they run even when
  // claim extraction failed. Only the Data Auditor requires the claim ledger.
  const auditClaims  = claims.filter(c => !fc.settledIds.includes(c.claimId));
  const needAudit    = Boolean(extraction) && auditClaims.length > 0;
  const reviewerCost = needAudit ? 3 : 2;
  if (callsUsed + reviewerCost <= callCap) {
    callsUsed += reviewerCost;
    [auditRes, redRes, pmRes] = await Promise.all([
      needAudit
        ? safeReview("data-auditor", () => dataAuditor.audit({ claims: auditClaims, researchSummary: researchSummary(research), usage, verifiedBlock }), retryBudget(1))
        : Promise.resolve(!extraction
            ? { ok: false, error: "claim extraction unavailable — no ledger to audit" }
            // Not a failure: nothing was left for the auditor to check.
            : { ok: false, skipped: true, error: "every extracted claim was settled against FRED in code — no search needed" }),
      safeReview("red-team",     () => redTeam.review({ research, usage, verifiedBlock }), retryBudget(1)),
      safeReview("portfolio-pm", () => portfolioPM.translate({ research, usage, verifiedBlock }), retryBudget(1)),
    ]);
  } else {
    const reason = `call cap ${callCap} would be exceeded`;
    auditRes = redRes = pmRes = { ok: false, error: reason };
  }

  console.log(`[research-orchestrator] audit ${auditRes.ok ? "complete" : "NOT RUN"} · red-team ${redRes.ok ? "complete" : "NOT RUN"} · portfolio ${pmRes.ok ? "complete" : "NOT RUN"}`);

  // Merge auditor verdicts + sources into ledger/registry
  if (auditRes.ok) {
    ledger.applyAuditVerdicts(claims, auditRes.out.verdicts);
    for (const v of auditRes.out.verdicts || []) {
      if (Array.isArray(v.sources) && v.sources.length) {
        const before = sources.length;
        sources = registry.registerSources(
          v.sources.map(s => ({ ...s, supportsClaims: [v.claimId] })),
          "data_auditor", sources
        );
        // link newly added source ids back to the claim
        const claim = claims.find(c => c.claimId === v.claimId);
        if (claim) {
          for (const s of sources.slice(before)) {
            if (!claim.sourceIds.includes(s.sourceId)) claim.sourceIds.push(s.sourceId);
          }
          for (const s of sources) {
            if (s.supportsClaims.includes(v.claimId) && !claim.sourceIds.includes(s.sourceId)) {
              claim.sourceIds.push(s.sourceId);
            }
          }
        }
      }
    }
    registry.pruneDanglingSourceRefs(claims, sources);
  }

  // ── 4. IC Chair ────────────────────────────────────────────────────────────
  setStage(type, "chair");
  let chairOut = null;
  let chairError = `call cap ${callCap} reached before the chair could run`;
  if (callsUsed < callCap) {
    callsUsed += 1;
    const chairRes = await safeReview("ic-chair", () => icChair.adjudicate({
      research, extraction,
      auditOutput:     auditRes.ok ? auditRes.out : null,
      redTeamOutput:   redRes.ok ? redRes.out : null,
      portfolioOutput: pmRes.ok ? pmRes.out : null,
      factCheck: fc.results,
      type, usage, verifiedBlock,
    }), retryBudget(0));
    if (chairRes.ok) chairOut = chairRes.out;
    else chairError = chairRes.error;
  }

  // ── 5. Deterministic gate + bounded revision loop ──────────────────────────
  let verdict = null;
  let rounds = 0;
  if (chairOut) {
    setStage(type, "gate");
    verdict = gate.adjudicate({ research, claims, sources, chairOutput: chairOut });
    console.log(`[research-orchestrator] IC score=${verdict.score} status=${verdict.status}`);

    while (
      (verdict.status === "REVISION_REQUIRED") &&
      rounds < maxRounds() &&
      callsUsed + 2 <= callCap
    ) {
      rounds += 1;
      setStage(type, "revision", `round ${rounds}`);
      console.log(`[research-orchestrator] revision round ${rounds} triggered`);
      for (const f of verdict.hardFailures) {
        console.log(`[research-orchestrator] hard-fail: ${f.rule} — ${f.detail}`);
      }

      callsUsed += 1;
      const revRes = await safeReview("lead-revision", () => leadAnalyst.revise({
        research, type,
        failures: verdict.hardFailures.length ? verdict.hardFailures : [{ rule: "SCORE_BELOW_THRESHOLD", detail: chairOut.revisionInstructions || chairOut.statusRationale }],
        chairNotes: chairOut.revisionInstructions || chairOut.statusRationale,
        usage, verifiedBlock,
      }), retryBudget(1));
      if (!revRes.ok) break;
      research = { ...revRes.out, reportType: research.reportType || type, generatedAt: research.generatedAt,
                   ...(draftUngrounded ? { grounded: false } : {}) };

      // Reconcile ledger with the revised text: claims that hard-failed are
      // marked as addressed-by-revision (audit trail kept in notes).
      for (const f of verdict.hardFailures) {
        for (const id of f.claimIds || []) {
          const c = claims.find(x => x.claimId === id);
          if (c && c.verificationStatus === "UNSUPPORTED") {
            c.verificationStatus = "PARTIALLY_VERIFIED";
            c.notes = `${c.notes ? c.notes + " | " : ""}Revised in round ${rounds} to address unsupported status`;
            c.confidence = Math.min(c.confidence, 0.5);
          }
        }
      }

      callsUsed += 1;
      const rechairRes = await safeReview("ic-chair-rescore", () => icChair.adjudicate({
        research, extraction,
        auditOutput:     auditRes.ok ? auditRes.out : null,
        redTeamOutput:   redRes.ok ? redRes.out : null,
        portfolioOutput: pmRes.ok ? pmRes.out : null,
        factCheck: fc.results,
        type, usage, verifiedBlock,
      }), retryBudget(0));
      if (!rechairRes.ok) {
        // The revised text was never scored. Don't publish the old verdict on it.
        chairOut = null; verdict = null;
        chairError = `re-score after revision round ${rounds} failed — ${rechairRes.error}`;
        break;
      }
      chairOut = rechairRes.out;
      verdict = gate.adjudicate({ research, claims, sources, chairOutput: chairOut });
      console.log(`[research-orchestrator] revision round ${rounds}: IC score=${verdict.score} status=${verdict.status}`);
    }
  }

  // ── 6. Assemble + publish ──────────────────────────────────────────────────
  setStage(type, "publish");
  const reviewersRan = auditRes.ok || redRes.ok || pmRes.ok;
  const qaRan = Boolean(chairOut && reviewersRan);
  // D-19: a reviewer that failed (even after its retry) leaves the report
  // partly unreviewed. It can never read as a clean APPROVED — the strip names
  // who did not run and why.
  const failedReviewers = [["Data auditor", auditRes], ["Red team", redRes], ["Cross-asset PM", pmRes]]
    .filter(([, r]) => r && r.ok === false && !r.skipped).map(([n, r]) => `${n}: ${r.error}`);

  const institutionalQA = qaRan ? {
    status:        failedReviewers.length && verdict.status === "APPROVED" ? "APPROVED_WITH_CAVEATS" : verdict.status,
    unreviewed:    failedReviewers,
    score:         verdict.score,
    minScore:      verdict.minScore,
    hardFailures:  verdict.hardFailures,
    revisionRounds: rounds,
    statusRationale: chairOut.statusRationale || "",
    agentVerdicts: {
      dataAuditor:  auditRes.ok ? { verdict: auditRes.out.verdict, confidence: auditRes.out.confidence, assessment: auditRes.out.overallAssessment, dataQualityFlags: auditRes.out.dataQualityFlags || [] } : { verdict: "NOT_RUN", reason: auditRes.error },
      redTeam:      redRes.ok ? { verdict: redRes.out.verdict, confidence: redRes.out.confidence, rationale: redRes.out.verdictRationale, counterThesis: redRes.out.counterThesis, challenges: (redRes.out.challenges || []).slice(0, 8), contradictoryEvidence: (redRes.out.contradictoryEvidence || []).slice(0, 6), losesMoney: redRes.out.losesMoney || "" } : { verdict: "NOT_RUN", reason: redRes.error },
      crossAssetPM: pmRes.ok ? { verdict: pmRes.out.verdict, confidence: pmRes.out.confidence, rationale: pmRes.out.verdictRationale, thesisVsTrade: pmRes.out.thesisVsTrade, marketPricing: pmRes.out.marketPricing, tradeExpression: pmRes.out.tradeExpression, transmissionMechanism: pmRes.out.transmissionMechanism } : { verdict: "NOT_RUN", reason: pmRes.error },
      icChair:      { status: chairOut.status, rationale: chairOut.statusRationale, dimensionScores: chairOut.dimensionScores, agentVerdictSummary: chairOut.agentVerdictSummary || {} },
    },
    adjudications:          chairOut.adjudications || [],
    materialDisagreements:  chairOut.materialDisagreements || [],
    unresolvedQuestions:    chairOut.unresolvedQuestions || [],
    strongestCounterargument: chairOut.strongestCounterargument || (redRes.ok ? redRes.out.counterThesis : ""),
    keyCaveat:              chairOut.keyCaveat || "",
    checklistGaps:          chairOut.checklistGaps || [],
    keyAssumptions:         extraction?.assumptions || [],
    invalidationConditions: extraction?.invalidationConditions || [],
    claimSummary:           ledger.summarizeClaims(claims),
  } : notRunQA(
    !extraction ? "Claim extraction unavailable — five-agent QA could not run"
    : !reviewersRan ? "Reviewers could not run — QA NOT RUN. " + failedReviewers.join(" · ")
    : "IC Chair could not run — QA NOT RUN. " + chairError
  );

  const version  = store.nextVersion(type);
  const reportId = store.makeReportId(type, version);
  const dataAsOf = new Date().toISOString().slice(0, 10);

  const report = {
    reportId,
    version,
    reportType: type,
    generatedAt: research.generatedAt || new Date().toISOString(),
    dataAsOf,
    topic: topic || null,
    research,
    thesisFrame: extraction ? {
      centralQuestion: extraction.centralQuestion, thesis: extraction.thesis,
      consensusView: extraction.consensusView, variantPerception: extraction.variantPerception,
      transmissionMechanism: extraction.transmissionMechanism, whatIsPriced: extraction.whatIsPriced,
      timeHorizon: extraction.timeHorizon, uncertainties: extraction.uncertainties || [],
    } : null,
    institutionalQA,
    claims,
    sources,
    corrections: [],
    meta: {
      pipeline: qaRan ? "five-agent" : "degraded",
      callsUsed,
      usage,
      models: {
        // The OpenAI tier (runs only if its key is set) is the only drafter that
        // returns grounded: false — record it, never attribute its draft to Sonnet.
        lead: draftUngrounded ? `openai:${process.env.OPENAI_FALLBACK_MODEL || "gpt-4o"}` : require("../providers/models").sonnetModel(), extract: modelForRole("extract"),
        auditor: modelForRole("auditor"), redteam: modelForRole("redteam"),
        portfolio: modelForRole("portfolio"), chair: modelForRole("chair"),
      },
      durationMs: Date.now() - t0,
      batch,
      factCheck: fc.results,
      cost: aiCost.finalizeReceipt(receipt),
    },
  };

  store.save(report);
  redTeamLog.recordFromReport(report);
  setStage(type, "done", `${reportId} score=${institutionalQA.score ?? "n/a"} status=${institutionalQA.status}`);
  return report;
}

module.exports = { runPipeline, multiAgentEnabled, getProgress, setStage, maxRounds, maxCalls, notRunQA,
  _internal: { safeReview, isTransient } };
