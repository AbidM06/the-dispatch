/**
 * server/journal/migrate.js — log idea cards that predate the Journal.
 *
 * Runs once at server start and again (cheaply) before any card is dismissed:
 * an idea must be in the Journal before DELETE /api/ideas/:id can remove its
 * card, otherwise a pre-Journal idea could vanish without ever being logged.
 */
"use strict";

const journal   = require("./store");
const ideaStore = require("../ideas/store");

let done = false;

/** Backfill every stored card once per process. Never throws. */
function ensureBackfilled() {
  if (done) return;
  try {
    const n = journal.backfill(ideaStore.list({ limit: 100000 }).slice().reverse());
    done = true;                                   // only after it succeeded — a failure retries next time
    if (n) console.log(`[journal] backfilled ${n} earlier idea(s)`);
  } catch (err) {
    console.warn("[journal] backfill failed:", err.message);
  }
}

/**
 * ensureLogged — guarantee one card is in the Journal (backfilling it if not).
 * Throws if it cannot be written, so the caller can refuse to delete the card.
 */
function ensureLogged(ideaId) {
  if (journal.findEntryByIdea(ideaId)) return;
  const card = ideaStore.list({ limit: 100000 }).find(c => c.id === ideaId);
  if (card) journal.logIdea(card, { backfilled: true });
}

module.exports = { ensureBackfilled, ensureLogged, _reset: () => { done = false; } };
