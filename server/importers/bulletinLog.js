/**
 * server/importers/bulletinLog.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Rolling JSONL log of daily morning bulletins.
 * Stored at data/bulletin_log.jsonl — one JSON object per line.
 *
 * Each entry:
 *   date         — "YYYY-MM-DD"
 *   bulletinId   — "YYYY-MM-DD-<source>"
 *   generatedAt  — ISO timestamp
 *   article      — { headline, source, url, publishedAt, summary }
 *   newsSummary  — short plain summary: what happened, why it matters, concern, what to watch
 *                  (entries before 2026-10 carry `pitchScript` instead — a read-aloud script)
 *   analysis     — { economistView, tradingView, risks }
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const fs   = require("fs");
const path = require("path");

const DEFAULT_LOG = path.join(__dirname, "../../data/bulletin_log.jsonl");
// BULLETIN_LOG_PATH lets tests use a temp file; read per call so it can change.
const logFile = () => process.env.BULLETIN_LOG_PATH || DEFAULT_LOG;

function ensureDir() {
  fs.mkdirSync(path.dirname(logFile()), { recursive: true });
}

/** Append one bulletin to the JSONL log. */
function appendBulletin(bulletin) {
  ensureDir();
  fs.appendFileSync(logFile(), JSON.stringify(bulletin) + "\n", "utf8");
}

/**
 * Before 2026-10 a failed AI call saved a canned "deterministic" bulletin
 * (bulletinId `<date>-deterministic`) that read like real analysis. Those are
 * invented text (D-02) — they stay in the file but are never served again, so
 * they can no longer be mistaken for today's bulletin or block a real one.
 */
function isLegacyFallback(b) {
  return typeof b?.bulletinId === "string" && b.bulletinId.endsWith("-deterministic");
}

/** Read all bulletins from the log, newest first. Skips corrupted lines and legacy fallbacks. */
function readAll() {
  try {
    const raw = fs.readFileSync(logFile(), "utf8");
    return raw
      .split("\n")
      .filter(l => l.trim())
      .reduce((acc, l) => {
        try {
          const b = JSON.parse(l);
          if (!isLegacyFallback(b)) acc.push(b);
        } catch { /* skip malformed line */ }
        return acc;
      }, [])
      .reverse(); // newest first
  } catch {
    return [];
  }
}

/** Get the most recent bulletin, or null if none exists. */
function getLatest() {
  const all = readAll();
  return all.length > 0 ? all[0] : null;
}

/** Get today's bulletin if it has already been generated, else null. */
function getTodaysBulletin() {
  const today = new Date().toISOString().slice(0, 10);
  const all   = readAll();
  return all.find(b => b.date === today) ?? null;
}

/** Get the last N days of bulletins. */
function getHistory(days = 7) {
  return readAll().slice(0, days);
}

module.exports = { appendBulletin, readAll, getLatest, getTodaysBulletin, getHistory };
