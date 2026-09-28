/**
 * server/research/claimLedger.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Machine-readable claim ledger utilities (§7).
 *
 * Claim shape:
 * {
 *   claimId: "CLM-001",
 *   statement: string,
 *   classification: FACT | ESTIMATE | FORECAST | OPINION | INFERENCE,
 *   materiality: HIGH | MEDIUM | LOW,
 *   sourceIds: [],
 *   confidence: 0..1,
 *   asOf: "YYYY-MM-DD" | null,
 *   verificationStatus: VERIFIED | PARTIALLY_VERIFIED | CONFLICTING_DATA |
 *                       STALE | UNSUPPORTED | ESTIMATE | FORECAST | OPINION |
 *                       NOT_CHECKED | CORRECTED,
 *   agentsAgreeing: [], agentsDisagreeing: [], notes: string
 * }
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const CLASSIFICATIONS = new Set(["FACT", "ESTIMATE", "FORECAST", "OPINION", "INFERENCE"]);
const MATERIALITIES   = new Set(["HIGH", "MEDIUM", "LOW"]);
const VERIFICATION_STATUSES = new Set([
  "VERIFIED", "PARTIALLY_VERIFIED", "CONFLICTING_DATA", "STALE",
  "UNSUPPORTED", "ESTIMATE", "FORECAST", "OPINION", "NOT_CHECKED", "CORRECTED",
]);

function pad3(n) { return String(n).padStart(3, "0"); }

/**
 * Normalize raw model-emitted claims into valid ledger entries.
 * Invalid entries are repaired where possible, dropped when meaningless.
 * Duplicate statements are deduplicated (first occurrence wins).
 */
function normalizeClaims(rawClaims) {
  if (!Array.isArray(rawClaims)) return [];
  const seenStatements = new Set();
  const out = [];
  for (const raw of rawClaims) {
    if (!raw || typeof raw !== "object") continue;
    const statement = typeof raw.statement === "string" ? raw.statement.trim() : "";
    if (!statement) continue;
    const dedupKey = statement.toLowerCase().replace(/\s+/g, " ");
    if (seenStatements.has(dedupKey)) continue;
    seenStatements.add(dedupKey);

    const classification = CLASSIFICATIONS.has(raw.classification) ? raw.classification : "INFERENCE";
    const materiality    = MATERIALITIES.has(raw.materiality) ? raw.materiality : "MEDIUM";
    let confidence = typeof raw.confidence === "number" ? raw.confidence : 0.5;
    if (confidence > 1) confidence = confidence / 100; // tolerate 0-100 scale
    confidence = Math.max(0, Math.min(1, confidence));

    out.push({
      claimId:            `CLM-${pad3(out.length + 1)}`,
      statement,
      classification,
      materiality,
      sourceIds:          Array.isArray(raw.sourceIds) ? raw.sourceIds.filter(s => typeof s === "string") : [],
      confidence:         Math.round(confidence * 100) / 100,
      asOf:               typeof raw.asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.asOf) ? raw.asOf : null,
      verificationStatus: VERIFICATION_STATUSES.has(raw.verificationStatus) ? raw.verificationStatus : "NOT_CHECKED",
      agentsAgreeing:     Array.isArray(raw.agentsAgreeing) ? raw.agentsAgreeing : ["lead"],
      agentsDisagreeing:  Array.isArray(raw.agentsDisagreeing) ? raw.agentsDisagreeing : [],
      notes:              typeof raw.notes === "string" ? raw.notes : "",
    });
  }
  return out;
}

/**
 * Merge auditor verdicts into the ledger.
 * verdicts: [{ claimId, verificationStatus, confidence?, sourceIds?, asOf?, notes? }]
 * Never silently discards existing data — auditor notes are appended.
 */
function applyAuditVerdicts(claims, verdicts) {
  if (!Array.isArray(verdicts)) return claims;
  const byId = new Map(claims.map(c => [c.claimId, c]));
  for (const v of verdicts) {
    if (!v || typeof v !== "object") continue;
    const claim = byId.get(v.claimId);
    if (!claim) continue;
    if (VERIFICATION_STATUSES.has(v.verificationStatus)) {
      claim.verificationStatus = v.verificationStatus;
    }
    if (typeof v.confidence === "number") {
      let conf = v.confidence > 1 ? v.confidence / 100 : v.confidence;
      claim.confidence = Math.round(Math.max(0, Math.min(1, conf)) * 100) / 100;
    }
    if (Array.isArray(v.sourceIds)) {
      claim.sourceIds = [...new Set([...claim.sourceIds, ...v.sourceIds.filter(s => typeof s === "string")])];
    }
    if (typeof v.asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.asOf)) claim.asOf = v.asOf;
    if (typeof v.notes === "string" && v.notes.trim()) {
      claim.notes = claim.notes ? `${claim.notes} | Auditor: ${v.notes.trim()}` : `Auditor: ${v.notes.trim()}`;
    }
    if (v.verificationStatus === "VERIFIED" || v.verificationStatus === "PARTIALLY_VERIFIED") {
      if (!claim.agentsAgreeing.includes("data_auditor")) claim.agentsAgreeing.push("data_auditor");
    } else if (v.verificationStatus === "UNSUPPORTED" || v.verificationStatus === "CONFLICTING_DATA") {
      if (!claim.agentsDisagreeing.includes("data_auditor")) claim.agentsDisagreeing.push("data_auditor");
    }
  }
  return claims;
}

/** Claims that trip the hard-fail rule: thesis-critical (HIGH) + UNSUPPORTED. */
function unsupportedMaterialClaims(claims) {
  return claims.filter(c =>
    c.materiality === "HIGH" &&
    c.classification === "FACT" &&
    c.verificationStatus === "UNSUPPORTED"
  );
}

/** Claims flagged stale by the auditor. */
function staleClaims(claims) {
  return claims.filter(c => c.verificationStatus === "STALE");
}

/** Ledger summary stats for the QA panel. */
function summarizeClaims(claims) {
  const total = claims.length;
  const verified = claims.filter(c =>
    c.verificationStatus === "VERIFIED" || c.verificationStatus === "PARTIALLY_VERIFIED"
  ).length;
  const byStatus = {};
  for (const c of claims) byStatus[c.verificationStatus] = (byStatus[c.verificationStatus] || 0) + 1;
  const lowConfidence = claims.filter(c => c.confidence < 0.5).map(c => c.claimId);
  return { total, verified, byStatus, lowConfidence };
}

module.exports = {
  CLASSIFICATIONS,
  MATERIALITIES,
  VERIFICATION_STATUSES,
  normalizeClaims,
  applyAuditVerdicts,
  unsupportedMaterialClaims,
  staleClaims,
  summarizeClaims,
};
