/**
 * server/research/qualityGate.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Final institutional quality gate (§6, §17).
 *
 * Two layers:
 *   1. Deterministic hard-fail checks — computed from the claim ledger,
 *      source registry, and scenario structure. These fail the report
 *      REGARDLESS of the IC Chair's score.
 *   2. Weighted score — the IC Chair emits 0-100 sub-scores per dimension;
 *      this module combines them with configurable weights and compares
 *      against RESEARCH_MIN_QA_SCORE (default 85).
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const ledger = require("./claimLedger");

const SCORE_DIMENSIONS = [
  "thesisClarity", "evidenceQuality", "sourceQuality", "dataFreshness",
  "factualAccuracy", "causalLogic", "differentiation", "scenarioQuality",
  "riskAnalysis", "catalystIdentification", "marketPricingAwareness",
  "crossAssetConsistency", "portfolioRelevance", "falsifiability",
  "intellectualHonesty",
];

// Default equal-ish weights, factual dimensions weighted up.
const DEFAULT_WEIGHTS = {
  thesisClarity: 1, evidenceQuality: 1.5, sourceQuality: 1.25, dataFreshness: 1,
  factualAccuracy: 1.5, causalLogic: 1.25, differentiation: 1, scenarioQuality: 1,
  riskAnalysis: 1, catalystIdentification: 0.75, marketPricingAwareness: 1,
  crossAssetConsistency: 0.75, portfolioRelevance: 0.75, falsifiability: 1.25,
  intellectualHonesty: 1.25,
};

function minScore() {
  const v = parseInt(process.env.RESEARCH_MIN_QA_SCORE, 10);
  return Number.isFinite(v) ? v : 85;
}

/** Weighted 0-100 composite from the chair's dimension scores. */
function compositeScore(dimensionScores, weights = DEFAULT_WEIGHTS) {
  let totalW = 0, sum = 0;
  for (const dim of SCORE_DIMENSIONS) {
    const raw = dimensionScores?.[dim];
    if (typeof raw !== "number" || isNaN(raw)) continue;
    const w = weights[dim] ?? 1;
    sum += Math.max(0, Math.min(100, raw)) * w;
    totalW += w;
  }
  if (totalW === 0) return 0;
  return Math.round(sum / totalW);
}

/** Extract scenario probabilities from any of the report shapes in this app. */
function scenarioProbabilities(research) {
  const out = [];
  const sc = research?.scenarios;
  if (sc && typeof sc === "object" && !Array.isArray(sc)) {
    for (const key of ["bear", "base", "bull", "baseline", "stress"]) {
      const s = sc[key];
      if (!s || typeof s !== "object") continue;
      let p = s.probability;
      if (typeof p === "string") p = parseFloat(p.replace(/[^\d.]/g, ""));
      if (typeof p === "number" && !isNaN(p)) out.push({ key, probability: p });
    }
  }
  return out;
}

/**
 * Hard-fail checks (§6). Returns array of { rule, detail } — empty = pass.
 * Only rules that are computable deterministically are enforced here; the
 * rest are the IC Chair's judgment, reflected in its scores/verdict.
 */
function hardFailChecks({ research, claims, sources }) {
  const failures = [];

  // 1. Thesis-critical claim UNSUPPORTED
  const unsupported = ledger.unsupportedMaterialClaims(claims);
  if (unsupported.length > 0) {
    failures.push({
      rule: "UNSUPPORTED_MATERIAL_CLAIM",
      detail: `${unsupported.length} HIGH-materiality factual claim(s) are UNSUPPORTED: ` +
              unsupported.map(c => c.claimId).join(", "),
      claimIds: unsupported.map(c => c.claimId),
    });
  }

  // 2. Scenario probabilities must sum to ~100% (when 3-way probabilities exist)
  const probs = scenarioProbabilities(research);
  if (probs.length >= 3) {
    const total = probs.reduce((a, p) => a + p.probability, 0);
    if (Math.abs(total - 100) > 10) {
      failures.push({
        rule: "SCENARIO_PROBABILITY_SUM",
        detail: `Scenario probabilities sum to ${total}% (expected ~100%): ` +
                probs.map(p => `${p.key}=${p.probability}%`).join(", "),
      });
    }
  }

  // 3. Material market-data staleness without disclosure:
  //    HIGH-materiality claims flagged STALE by the auditor.
  const stale = ledger.staleClaims(claims).filter(c => c.materiality === "HIGH");
  if (stale.length > 0) {
    failures.push({
      rule: "STALE_MATERIAL_DATA",
      detail: `${stale.length} HIGH-materiality claim(s) rely on stale data: ` +
              stale.map(c => c.claimId).join(", "),
      claimIds: stale.map(c => c.claimId),
    });
  }

  // 4. Fabricated source detection — a source with a URL that failed validation
  //    is stored with url:null, which is honest. But a claim citing a
  //    sourceId that does not exist in the registry indicates fabrication.
  const sourceIds = new Set((sources || []).map(s => s.sourceId));
  const fabricated = claims.filter(c => c.sourceIds.some(id => !sourceIds.has(id)));
  if (fabricated.length > 0) {
    failures.push({
      rule: "DANGLING_SOURCE_REFERENCE",
      detail: `${fabricated.length} claim(s) cite source IDs missing from the registry.`,
      claimIds: fabricated.map(c => c.claimId),
    });
  }

  return failures;
}

/**
 * Final adjudication combining chair verdict + deterministic checks.
 * Returns { status, score, hardFailures, minScore }.
 * Status: APPROVED | APPROVED_WITH_CAVEATS | REVISION_REQUIRED | REJECTED
 */
function adjudicate({ research, claims, sources, chairOutput }) {
  const hardFailures = hardFailChecks({ research, claims, sources });
  const score = compositeScore(chairOutput?.dimensionScores);
  const threshold = minScore();

  let status;
  const chairStatus = chairOutput?.status;

  if (chairStatus === "REJECTED") {
    status = "REJECTED";
  } else if (hardFailures.length > 0) {
    status = "REVISION_REQUIRED";
  } else if (score < threshold) {
    status = chairStatus === "APPROVED" || chairStatus === "APPROVED_WITH_CAVEATS"
      ? "REVISION_REQUIRED"
      : (chairStatus || "REVISION_REQUIRED");
  } else if (chairStatus === "REVISION_REQUIRED") {
    // The chair's revision demand stands even when the numeric score passes —
    // adjudication is not overridden by arithmetic.
    status = "REVISION_REQUIRED";
  } else {
    // Score passes and no hard failures — respect chair's caveats if any
    status = chairStatus === "APPROVED_WITH_CAVEATS" ? "APPROVED_WITH_CAVEATS" : "APPROVED";
  }

  return { status, score, hardFailures, minScore: threshold };
}

module.exports = {
  SCORE_DIMENSIONS,
  DEFAULT_WEIGHTS,
  compositeScore,
  hardFailChecks,
  scenarioProbabilities,
  adjudicate,
  minScore,
};
