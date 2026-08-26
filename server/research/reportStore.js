/**
 * server/research/reportStore.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Versioned research report persistence (§9, §22).
 *
 * - Immutable reportId per published report: RPT-<type>-<timestamp36>-v<n>
 * - Version increments per report type; older versions are preserved so a
 *   conversation can keep interrogating the exact report it started on.
 * - Corrections append to the report's corrections[] array (audit trail —
 *   claims are marked CORRECTED, never silently mutated) (§12).
 * - Disk persistence under data/research_reports/ (gitignored dir), skipped
 *   in tests (NODE_ENV=test) — mirrors cache.js behaviour.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const fs   = require("fs");
const path = require("path");

const IS_TEST  = process.env.NODE_ENV === "test";
const STORE_DIR = path.join(__dirname, "..", "..", "data", "research_reports");
const MAX_PER_TYPE = 10; // keep the last N versions per type on disk/memory

const _reports = new Map();   // reportId -> report object
const _latestByType = new Map(); // type -> reportId

function _ensureDir() {
  try { fs.mkdirSync(STORE_DIR, { recursive: true }); } catch (_) {}
}

function _diskPath(reportId) {
  return path.join(STORE_DIR, `${reportId.replace(/[^A-Za-z0-9_-]/g, "")}.json`);
}

function _persist(report) {
  if (IS_TEST) return;
  try {
    _ensureDir();
    fs.writeFileSync(_diskPath(report.reportId), JSON.stringify(report, null, 2), "utf8");
  } catch (err) {
    console.warn("[reportStore] persist failed:", err.message);
  }
}

function _loadFromDisk() {
  if (IS_TEST) return;
  try {
    if (!fs.existsSync(STORE_DIR)) return;
    const files = fs.readdirSync(STORE_DIR).filter(f => f.endsWith(".json"));
    for (const f of files) {
      try {
        const report = JSON.parse(fs.readFileSync(path.join(STORE_DIR, f), "utf8"));
        if (report?.reportId) {
          _reports.set(report.reportId, report);
          const cur = _latestByType.get(report.reportType);
          const curReport = cur ? _reports.get(cur) : null;
          if (!curReport || (report.version || 0) > (curReport.version || 0)) {
            _latestByType.set(report.reportType, report.reportId);
          }
        }
      } catch (_) {}
    }
    if (_reports.size > 0) console.log(`[reportStore] restored ${_reports.size} research report(s) from disk`);
  } catch (err) {
    console.warn("[reportStore] load failed:", err.message);
  }
}
_loadFromDisk();

function nextVersion(type) {
  let max = 0;
  for (const r of _reports.values()) {
    if (r.reportType === type && (r.version || 0) > max) max = r.version || 0;
  }
  return max + 1;
}

function makeReportId(type, version) {
  return `RPT-${type}-${Date.now().toString(36)}-v${version}`;
}

/** Save a newly published report object. Returns the stored report. */
function save(report) {
  _reports.set(report.reportId, report);
  _latestByType.set(report.reportType, report.reportId);
  _persist(report);
  _pruneOld(report.reportType);
  return report;
}

function _pruneOld(type) {
  const ofType = [..._reports.values()].filter(r => r.reportType === type)
    .sort((a, b) => (b.version || 0) - (a.version || 0));
  for (const old of ofType.slice(MAX_PER_TYPE)) {
    _reports.delete(old.reportId);
    if (!IS_TEST) { try { fs.unlinkSync(_diskPath(old.reportId)); } catch (_) {} }
  }
}

function get(reportId) {
  return _reports.get(reportId) || null;
}

function latestForType(type) {
  const id = _latestByType.get(type);
  return id ? _reports.get(id) : null;
}

/**
 * Append a correction (audit trail). Marks the claim CORRECTED and records
 * old/new values; never rewrites the claim statement (§12).
 */
function addCorrection(reportId, correction) {
  const report = _reports.get(reportId);
  if (!report) return null;
  report.corrections = report.corrections || [];
  const entry = {
    correctionId:   `COR-${String(report.corrections.length + 1).padStart(3, "0")}`,
    claimId:        correction.claimId || null,
    oldValue:       correction.oldValue || "",
    correctedValue: correction.correctedValue || "",
    reason:         correction.reason || "",
    sourceIds:      Array.isArray(correction.sourceIds) ? correction.sourceIds : [],
    correctedAt:    new Date().toISOString(),
  };
  report.corrections.push(entry);
  if (entry.claimId && Array.isArray(report.claims)) {
    const claim = report.claims.find(c => c.claimId === entry.claimId);
    if (claim) {
      claim.verificationStatus = "CORRECTED";
      claim.notes = claim.notes
        ? `${claim.notes} | Corrected (${entry.correctionId}): ${entry.reason}`
        : `Corrected (${entry.correctionId}): ${entry.reason}`;
    }
  }
  _persist(report);
  return entry;
}

/** For tests. */
function _reset() {
  _reports.clear();
  _latestByType.clear();
}

module.exports = { save, get, latestForType, nextVersion, makeReportId, addCorrection, _reset };
