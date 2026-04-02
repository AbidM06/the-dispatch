/**
 * server/importers/ideaLog.js
 * ─────────────────────────────────────────────────────────────────────────────
 * JSONL append/read helper for the idea engine audit trail.
 *
 * File paths:
 *   data/ideas_log.jsonl    — one line per engine run (array of tickets)
 *   data/signals_log.jsonl  — one line per signal snapshot
 *
 * Each line: JSON.stringify({ ts: ISO, ...record }) + "\n"
 *
 * Design:
 *   - appendToLog: fs.appendFileSync (atomic for single-process; no external deps)
 *   - readLog:    read entire file, split on newline, filter by ts >= cutoff
 *   - Missing file → return [] (graceful degradation)
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const fs   = require("fs");
const path = require("path");

// ── Default file paths ────────────────────────────────────────────────────────

const DATA_DIR          = path.join(__dirname, "..", "..", "data");
const IDEAS_LOG_PATH    = path.join(DATA_DIR, "ideas_log.jsonl");
const SIGNALS_LOG_PATH  = path.join(DATA_DIR, "signals_log.jsonl");

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Ensure data/ directory exists (idempotent).
 */
function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (_) {}
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Append a record to a JSONL log file.
 * The record is merged with a `ts` (ISO timestamp) field.
 *
 * @param {string} filePath  Absolute path to .jsonl file
 * @param {object} record    Data to append (will be merged with { ts })
 */
function appendToLog(filePath, record) {
  ensureDataDir();
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
  fs.appendFileSync(filePath, line, { encoding: "utf8" });
}

/**
 * Read the last N days from a JSONL log file.
 * Returns an array of parsed objects, oldest first.
 * Returns [] if the file does not exist or is empty.
 *
 * @param {string} filePath  Absolute path to .jsonl file
 * @param {number} days      Number of days to look back (default 30)
 * @returns {object[]}
 */
function readLog(filePath, days = 30) {
  if (!fs.existsSync(filePath)) return [];

  let raw = "";
  try {
    raw = fs.readFileSync(filePath, { encoding: "utf8" });
  } catch (_) {
    return [];
  }

  const cutoff = new Date(Date.now() - days * 86_400_000);
  const results = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.ts && new Date(obj.ts) >= cutoff) {
        results.push(obj);
      }
    } catch (_) {
      // skip malformed lines
    }
  }

  return results;
}

/**
 * Convenience: append to ideas log.
 * @param {object} record  e.g. { ideas: [...], regime: "Bear flattener..." }
 */
function appendIdeasLog(record) {
  appendToLog(IDEAS_LOG_PATH, record);
}

/**
 * Convenience: read ideas log.
 * @param {number} days
 * @returns {object[]}
 */
function readIdeasLog(days = 30) {
  return readLog(IDEAS_LOG_PATH, days);
}

/**
 * Convenience: append to signals log.
 * @param {object} record  e.g. { signals: {...} }
 */
function appendSignalsLog(record) {
  appendToLog(SIGNALS_LOG_PATH, record);
}

/**
 * Convenience: read signals log.
 * @param {number} days
 * @returns {object[]}
 */
function readSignalsLog(days = 30) {
  return readLog(SIGNALS_LOG_PATH, days);
}

// ── Execution log ──────────────────────────────────────────────────────────────

const EXECUTION_LOG_PATH = path.join(DATA_DIR, "execution_log.jsonl");

/**
 * Append a record to the execution audit log.
 * @param {object} record  e.g. { ideaId, ticker, direction, decision, reasons, ... }
 */
function appendExecutionLog(record) {
  appendToLog(EXECUTION_LOG_PATH, record);
}

/**
 * Read execution log entries from the last N days.
 * @param {number} days
 * @returns {object[]}
 */
function readExecutionLog(days = 30) {
  return readLog(EXECUTION_LOG_PATH, days);
}

module.exports = {
  appendToLog,
  readLog,
  appendIdeasLog,
  readIdeasLog,
  appendSignalsLog,
  readSignalsLog,
  appendExecutionLog,
  readExecutionLog,
  IDEAS_LOG_PATH,
  SIGNALS_LOG_PATH,
  EXECUTION_LOG_PATH,
};
