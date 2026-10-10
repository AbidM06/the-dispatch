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
 *   pitchScript  — full text of the 1-minute pitch
 *   analysis     — { economistView, tradingView, risks }
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const fs   = require("fs");
const path = require("path");

const LOG_FILE = path.join(__dirname, "../../data/bulletin_log.jsonl");

function ensureDir() {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
}

/** Append one bulletin to the JSONL log. */
function appendBulletin(bulletin) {
  ensureDir();
  fs.appendFileSync(LOG_FILE, JSON.stringify(bulletin) + "\n", "utf8");
}

/** Read all bulletins from the log, newest first. Skips corrupted lines. */
function readAll() {
  try {
    const raw = fs.readFileSync(LOG_FILE, "utf8");
    return raw
      .split("\n")
      .filter(l => l.trim())
      .reduce((acc, l) => {
        try { acc.push(JSON.parse(l)); } catch { /* skip malformed line */ }
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
