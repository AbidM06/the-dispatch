/**
 * server/journal/store.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The trade-idea Journal — stage 1: immutable logging (DECISIONS D-14, D-16).
 *
 * APPEND-ONLY. data/journal.jsonl holds one event per line; nothing is ever
 * rewritten or deleted. An entry is the fold of its events:
 *
 *   idea_logged   — the idea exactly as generated (a frozen copy + SHA-256 of
 *                   it), the reference price with an explicit status, and the
 *                   declared horizon. Written once, at generation time.
 *   watch         — "watch closely" on/off (latest event wins).
 *   pitch         — the owner's own pitch, marked whether it was written
 *                   before or after the AI's idea was revealed.
 *   manual_price  — a hypothetical entry price the owner typed in. Stored
 *                   separately: it never changes the original reference price.
 *
 * Why every idea: judging the system only by ideas picked after they looked
 * promising is selection bias. Everything generated is logged; "watch" is a
 * filter, not a gate.
 *
 * Why the hash: an entry's `idea` must be exactly what was generated. The hash
 * lets anyone check that nothing edited it later (`integrity` on read).
 *
 * Outcome tracking and scoring are stage 2; reflections and lessons stage 3.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const IS_TEST = process.env.NODE_ENV === "test";
function filePath() {
  return process.env.JOURNAL_PATH || path.join(__dirname, "../../data/journal.jsonl");
}
const persistent = () => !IS_TEST || Boolean(process.env.JOURNAL_PATH);

let _memory = [];      // test mode (no JOURNAL_PATH) keeps events in memory

// ── low-level event log ──────────────────────────────────────────────────────
function readEvents() {
  if (!persistent()) return _memory.slice();
  let raw;
  try { raw = fs.readFileSync(filePath(), "utf8"); } catch { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { console.warn("[journal] skipped an unreadable line"); }
  }
  return out;
}

function appendEvent(ev) {
  const event = { ...ev, at: ev.at || new Date().toISOString() };
  if (!persistent()) { _memory.push(event); return event; }
  const file = filePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(event) + "\n");   // sync: a logged idea is on disk before we answer
  return event;
}

// ── helpers ──────────────────────────────────────────────────────────────────
/** Stable JSON (sorted keys) so the hash does not depend on key order. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stable(v[k])).join(",")}}`;
  return JSON.stringify(v);
}
function hashIdea(idea) {
  return crypto.createHash("sha256").update(stable(idea)).digest("hex");
}

const STALE_AFTER_DAYS = 5;   // a quote older than this at generation time is recorded as stale

/**
 * referenceFrom — the price the idea is measured from, with an explicit status.
 *   ok       — a Markets value, not flagged stale, observed within STALE_AFTER_DAYS
 *   stale    — flagged stale by the Markets service, or older than STALE_AFTER_DAYS
 *   missing  — the instrument is not in the Markets snapshot (nothing to measure from)
 *   unknown  — backfilled from a card logged before freshness was recorded
 */
function referenceFrom(card, { backfilled = false } = {}) {
  const p = card.priceAtIdea;
  if (!p || p.value == null || !Number.isFinite(Number(p.value))) {
    return { status: "missing", value: null, marketId: card.marketId || null, snapshotAt: card.marketsSnapshotAt || null,
             reason: "Instrument not found in the Markets snapshot when the idea was generated." };
  }
  const asOfMs  = Date.parse(p.asOf);
  const ageDays = Number.isFinite(asOfMs) ? (Date.parse(card.createdAt) - asOfMs) / 86_400_000 : null;
  let status = "ok", reason = null;
  if (backfilled && p.freshness == null) {
    status = "unknown"; reason = "Logged retroactively; freshness was not recorded for this idea.";
  } else if (p.freshness === "stale") {
    status = "stale"; reason = "The Markets service flagged this price as stale (every live source failed).";
  } else if (ageDays != null && ageDays > STALE_AFTER_DAYS) {
    status = "stale"; reason = `Price was ${ageDays.toFixed(1)} days old when the idea was generated.`;
  }
  return {
    status, reason,
    value: Number(p.value), source: p.source || null, asOf: p.asOf || null, url: p.url || null,
    freshness: p.freshness || null, marketId: card.marketId || null, snapshotAt: card.marketsSnapshotAt || null,
  };
}

/**
 * horizonFrom — map the card's free-text horizon to the agreed buckets:
 * tactical ≤ 2 weeks, swing ≤ 3 months, strategic ≤ 12 months (by the upper
 * bound of a range). Anything unreadable is "undeclared" — never guessed.
 */
function horizonFrom(raw) {
  const text = String(raw || "").toLowerCase();
  const m = text.match(/(\d+(?:\.\d+)?)\s*(?:[-–to]+\s*(\d+(?:\.\d+)?))?\s*(day|d\b|week|wk|w\b|month|mo|m\b|quarter|q\b|year|yr|y\b)/);
  if (!m) return { raw: raw || null, category: "undeclared", maxDays: null };
  const upper = parseFloat(m[2] || m[1]);
  const unit  = m[3][0];
  const perUnit = { d: 1, w: 7, m: 30.4, q: 91.3, y: 365 }[unit];
  const maxDays = Math.round(upper * perUnit);
  const category = maxDays <= 14 ? "tactical" : maxDays <= 93 ? "swing" : maxDays <= 366 ? "strategic" : "undeclared";
  return { raw: raw || null, category, maxDays };
}

// ── writes ───────────────────────────────────────────────────────────────────
function newEntryId() {
  return "JRN-" + crypto.randomBytes(5).toString("hex");
}

/**
 * logIdea — record a freshly generated idea. Idempotent per idea id: a second
 * call for the same idea returns the existing entry rather than duplicating it.
 */
function logIdea(card, { backfilled = false } = {}) {
  if (!card || !card.id) throw new Error("logIdea: card with an id is required");
  const existing = findEntryByIdea(card.id);
  if (existing) return existing;
  const idea = JSON.parse(JSON.stringify(card));        // frozen copy
  const ev = appendEvent({
    type: "idea_logged",
    entryId: newEntryId(),
    ideaId: card.id,
    at: backfilled ? new Date().toISOString() : (card.createdAt || new Date().toISOString()),
    backfilled,
    idea,
    ideaHash: hashIdea(idea),
    reference: referenceFrom(card, { backfilled }),
    horizon: horizonFrom(card.horizon),
  });
  return getEntry(ev.entryId);
}

function requireEntry(entryId) {
  const e = getEntry(entryId);
  if (!e) { const err = new Error("Journal entry not found"); err.status = 404; throw err; }
  return e;
}

function setWatch(entryId, watched) {
  requireEntry(entryId);
  appendEvent({ type: "watch", entryId, watched: Boolean(watched) });
  return getEntry(entryId);
}

function addPitch(entryId, text, { beforeReveal }) {
  requireEntry(entryId);
  const t = String(text || "").trim();
  if (!t) { const err = new Error("Pitch text is required"); err.status = 400; throw err; }
  appendEvent({ type: "pitch", entryId, text: t.slice(0, 4000), beforeReveal: Boolean(beforeReveal) });
  return getEntry(entryId);
}

function addManualPrice(entryId, price, note) {
  requireEntry(entryId);
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) { const err = new Error("Price must be a positive number"); err.status = 400; throw err; }
  appendEvent({ type: "manual_price", entryId, price: p, note: String(note || "").slice(0, 500) || null });
  return getEntry(entryId);
}

// ── reads (fold events into entries) ─────────────────────────────────────────
function foldAll() {
  const entries = new Map();
  for (const ev of readEvents()) {
    if (ev.type === "idea_logged") {
      if (entries.has(ev.entryId)) continue;           // first write wins; duplicates ignored
      entries.set(ev.entryId, {
        entryId: ev.entryId, ideaId: ev.ideaId, loggedAt: ev.at, backfilled: Boolean(ev.backfilled),
        idea: ev.idea, ideaHash: ev.ideaHash,
        integrity: hashIdea(ev.idea) === ev.ideaHash ? "intact" : "MODIFIED",
        reference: ev.reference, horizon: ev.horizon,
        watched: false, pitches: [], manualPrices: [],
      });
      continue;
    }
    const e = entries.get(ev.entryId);
    if (!e) continue;
    if (ev.type === "watch") e.watched = Boolean(ev.watched);
    else if (ev.type === "pitch") e.pitches.push({ text: ev.text, beforeReveal: ev.beforeReveal, at: ev.at });
    else if (ev.type === "manual_price") e.manualPrices.push({ price: ev.price, note: ev.note, at: ev.at });
  }
  return entries;
}

function getEntry(entryId) {
  return foldAll().get(entryId) || null;
}

function findEntryByIdea(ideaId) {
  for (const e of foldAll().values()) if (e.ideaId === ideaId) return e;
  return null;
}

/** list — newest first. Filters: watched (bool), origin ("news"|"research"). */
function list({ watched, origin, limit = 200 } = {}) {
  return [...foldAll().values()]
    .filter(e => watched === undefined || e.watched === watched)
    .filter(e => !origin || e.idea.origin === origin)
    .sort((a, b) => String(b.idea.createdAt || b.loggedAt).localeCompare(String(a.idea.createdAt || a.loggedAt)))
    .slice(0, limit);
}

/**
 * backfill — log ideas generated before the Journal existed, flagged
 * `backfilled` with reference status "unknown" when freshness wasn't recorded.
 * Idempotent: ideas already in the Journal are skipped.
 */
function backfill(cards = []) {
  let added = 0;
  for (const c of cards) {
    if (!c || !c.id || findEntryByIdea(c.id)) continue;
    logIdea(c, { backfilled: true });
    added++;
  }
  return added;
}

function _reset() { _memory = []; }

module.exports = {
  logIdea, setWatch, addPitch, addManualPrice,
  getEntry, findEntryByIdea, list, backfill,
  _internal: { referenceFrom, horizonFrom, hashIdea, readEvents, STALE_AFTER_DAYS },
  _reset,
};
