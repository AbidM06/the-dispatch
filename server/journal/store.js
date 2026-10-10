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
 *   outcome       — stage 2: the FINAL tracked result (target/stop hit,
 *                   expired, uncertain, never entered), written once by
 *                   journal/tracker.js. Open ideas are not written here.
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

const STALE_AFTER_DAYS = 5;   // a daily / intraday quote older than this at generation time is recorded as stale

/**
 * A monthly series (CPI, payrolls…) is legitimately weeks old between
 * releases, so the age cutoff would mark every current release stale. For
 * those only the Markets service's own stale flag (every source failed) counts.
 * Older cards carry just the freshness label, so the label is checked too.
 */
function isMonthly(p) {
  return p.cadence === "monthly" || p.freshness === "Monthly data";
}

/**
 * referenceFrom — the price the idea is measured from, with an explicit status.
 *   ok       — a Markets value, not flagged stale, observed within STALE_AFTER_DAYS
 *              (monthly series: not flagged stale — their age is normal)
 *   stale    — flagged stale by the Markets service, or (daily/intraday only)
 *              older than STALE_AFTER_DAYS
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
  } else if (!isMonthly(p) && ageDays != null && ageDays > STALE_AFTER_DAYS) {
    status = "stale"; reason = `Price was ${ageDays.toFixed(1)} days old when the idea was generated.`;
  }
  return {
    status, reason,
    value: Number(p.value), source: p.source || null, asOf: p.asOf || null, releasedAt: p.releasedAt || null, url: p.url || null,
    freshness: p.freshness || null, cadence: p.cadence || (isMonthly(p) ? "monthly" : null), marketId: card.marketId || null, snapshotAt: card.marketsSnapshotAt || null,
  };
}

/**
 * horizonFrom — map the card's free-text horizon to the agreed buckets:
 * tactical ≤ 2 weeks, swing ≤ 3 months, strategic ≤ 12 months, by the LONGEST
 * duration named. Every number–unit pair is read, so mixed units work
 * ("2 weeks to 3 months" → 3 months); a bare number borrows the next unit
 * ("2-6 weeks" → 6 weeks); hyphenated forms count ("6-month"), but an
 * instrument tenor does not ("10-year yield"). Anything unreadable is
 * "undeclared" — never guessed.
 */
const UNIT_DAYS = { d: 1, w: 7, m: 30.4, q: 91.3, y: 365 };
// A duration followed by one of these names an instrument's tenor ("10-year
// yield", "2y swap"), not how long the trade runs, so it is not a horizon.
// Multi-leg phrases are followed through ("2-year vs 10-year yields", "2y/10y
// curve"): every maturity in the chain belongs to the instrument.
//
// Commas are ambiguous: "2-year, 10-year and 30-year yields" is a basket of
// tenors, but "1 month, 10-year real yields" is a horizon then an instrument.
// The difference is how the first duration is written — tenors are written
// compactly ("2-year", "10y", "5yr"), holding periods in words ("1 month").
// So a comma joins legs only after a compactly written duration.
const TENOR_UNIT = String.raw`(?:years?|yrs?|y|months?|mos?|m|weeks?|wks?|w)\b`;
const INSTRUMENT = String.raw`\s+(?:(?:us|uk|german|japanese|real|nominal|inflation|treasury|gov(?:ernment|t)?)\s+)?(?:yields?|notes?|bonds?|treasur(?:y|ies)|t-?(?:notes?|bills?|bonds?)|tsys?|gilts?|schatz|bobls?|buxls?|acgbs?|kgbs?|govvies|sovereigns?|munis?|ois|irs|cds|sonia|estr|€str|bunds?|swaps?|breakevens?|rates?|bills?|ust|tips|jgbs?|oats?|btps?|sofr|libor|forwards?|futures?|tenor|paper|spreads?|inflation|curve)\b`;
function tenorChain(separators) {
  const leg = String.raw`\s*(?:${separators})\s*\d+(?:\.\d+)?\s*-?\s*${TENOR_UNIT}`;
  return new RegExp(String.raw`^[a-z]*(?:${leg})*${INSTRUMENT}`);
}
const TENOR_AFTER       = tenorChain(String.raw`vs\.?|versus|/|&|and|-|–`);
const TENOR_AFTER_COMMA = tenorChain(String.raw`vs\.?|versus|/|&|and|-|–|,`);
const COMPACT_TENOR = /^\d+(?:\.\d+)?(?:-[a-z]+|(?:y|yr|yrs|m|mo|w|wk))$/;   // "2-year", "10y", "5yr"
function isTenor(match, rest) {
  return (COMPACT_TENOR.test(match) ? TENOR_AFTER_COMMA : TENOR_AFTER).test(rest);
}
function horizonFrom(raw) {
  const text = String(raw || "").toLowerCase();
  // Number, then an optional space or hyphen ("6 months", "6-month"), then a unit;
  // or a bare number that is the start of a range ("2" in "2-6 weeks").
  const re = /(\d+(?:\.\d+)?)(?:\s*-?\s*(day|d\b|week|wk|w\b|month|mo|m\b|quarter|q\b|year|yr|y\b)|(?=\s*(?:-|–|to)\s*\d))/g;
  let maxDays = null, pending = [], m;
  while ((m = re.exec(text))) {
    const n = parseFloat(m[1]);
    if (!m[2]) { pending.push(n); continue; }          // "2" in "2-6 weeks": unit comes next
    if (isTenor(m[0], text.slice(m.index + m[0].length))) { pending = []; continue; }
    const per = UNIT_DAYS[m[2][0]];
    for (const v of [...pending, n]) maxDays = Math.max(maxDays ?? 0, Math.round(v * per));
    pending = [];
  }
  if (maxDays == null) return { raw: raw || null, category: "undeclared", maxDays: null };
  return { raw: raw || null, category: bucket(maxDays), maxDays };
}

/**
 * horizonFor — the idea's declared holding period. New cards carry
 * horizonDays from the model (source "declared"); older ones fall back to
 * reading the text (source "parsed").
 */
function bucket(days) {
  return days <= 14 ? "tactical" : days <= 93 ? "swing" : days <= 366 ? "strategic" : "undeclared";
}
function horizonFor(card) {
  const d = Number(card.horizonDays);
  if (Number.isInteger(d) && d >= 1) return { raw: card.horizon || null, category: bucket(d), maxDays: d, source: "declared" };
  return { ...horizonFrom(card.horizon), source: "parsed" };
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
    horizon: horizonFor(card),
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

/** recordOutcome — append the final tracked result once (later calls are no-ops). */
function recordOutcome(entryId, result) {
  const e = requireEntry(entryId);
  if (e.outcome) return e;
  const keep = ["status", "fillDate", "fillPrice", "exitDate", "exitPrice", "R", "returnPct", "spx", "note", "closeOnly", "plan"];
  appendEvent({ type: "outcome", entryId, result: Object.fromEntries(keep.filter(k => result[k] !== undefined).map(k => [k, result[k]])) });
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
        watched: false, pitches: [], manualPrices: [], outcome: null,
      });
      continue;
    }
    const e = entries.get(ev.entryId);
    if (!e) continue;
    if (ev.type === "watch") e.watched = Boolean(ev.watched);
    else if (ev.type === "pitch") e.pitches.push({ text: ev.text, beforeReveal: ev.beforeReveal, at: ev.at });
    else if (ev.type === "manual_price") e.manualPrices.push({ price: ev.price, note: ev.note, at: ev.at });
    else if (ev.type === "outcome" && !e.outcome) e.outcome = { ...ev.result, recordedAt: ev.at };
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
  logIdea, setWatch, addPitch, addManualPrice, recordOutcome,
  getEntry, findEntryByIdea, list, backfill,
  _internal: { referenceFrom, horizonFrom, horizonFor, hashIdea, readEvents, STALE_AFTER_DAYS },
  _reset,
};
