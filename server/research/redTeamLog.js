/**
 * server/research/redTeamLog.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Append-only log of what the Red Team warned about, per published report.
 *
 * Purpose: calibration. A red team is only useful if its warnings mean
 * something, and the only way to know is to check later whether the risks it
 * raised actually happened. Each entry records the warnings as written and an
 * empty `outcome` per warning; the Journal scores them once their horizon has
 * passed. Nothing here is ever edited in place — outcomes are appended as
 * separate records keyed by warningId.
 *
 * Persisted to data/redteam_log.jsonl (gitignored). Memory-only in tests.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const fs   = require("fs");
const path = require("path");

const IS_TEST = process.env.NODE_ENV === "test";
function logPath() {
  return process.env.REDTEAM_LOG_PATH || path.join(__dirname, "../../data/redteam_log.jsonl");
}

let _memory = [];

function append(entry) {
  if (IS_TEST && !process.env.REDTEAM_LOG_PATH) { _memory.push(entry); return; }
  try {
    const file = logPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.warn("[redTeamLog] append failed:", err.message);
  }
}

/**
 * recordFromReport — log the red team's evidence-backed warnings for a report.
 * Low-severity, purely hypothetical objections are kept but marked, so later
 * scoring can compare evidence-backed warnings with speculative ones.
 */
function recordFromReport(report) {
  const rt = report?.institutionalQA?.agentVerdicts?.redTeam;
  if (!rt || rt.verdict === "NOT_RUN") return null;

  const warnings = [];
  (rt.challenges || []).forEach((c, i) => warnings.push({
    warningId: `${report.reportId}-W${i + 1}`,
    kind: "challenge",
    text: c.challenge,
    severity: c.severity || "LOW",
    evidenceBased: Boolean(c.evidenceBased),
    outcome: null,
  }));
  if (rt.losesMoney) warnings.push({
    warningId: `${report.reportId}-W${warnings.length + 1}`,
    kind: "trade-loses-money-path",
    text: rt.losesMoney,
    severity: "MEDIUM",
    evidenceBased: false,
    outcome: null,
  });

  const entry = {
    type:        "warnings",
    reportId:    report.reportId,
    reportType:  report.reportType,
    loggedAt:    new Date().toISOString(),
    thesisVerdict: rt.verdict,
    counterThesis: rt.counterThesis || "",
    horizon:     report.thesisFrame?.timeHorizon || null,
    warnings,
  };
  append(entry);
  return entry;
}

/** list — newest first. Outcome records (type:"outcome") are merged onto their warnings. */
function list({ limit = 50 } = {}) {
  let lines = [];
  if (IS_TEST && !process.env.REDTEAM_LOG_PATH) {
    lines = _memory.slice();
  } else {
    try {
      lines = fs.readFileSync(logPath(), "utf8").split("\n").filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch { lines = []; }
  }
  const outcomes = new Map(lines.filter(l => l.type === "outcome").map(o => [o.warningId, o]));
  return lines
    .filter(l => l.type === "warnings")
    .map(e => ({ ...e, warnings: e.warnings.map(w => ({ ...w, outcome: outcomes.get(w.warningId) || null })) }))
    .reverse()
    .slice(0, limit);
}

function _reset() { _memory = []; }

module.exports = { recordFromReport, list, append, _reset };
