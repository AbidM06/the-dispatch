/**
 * server/ideas/store.js — saved idea cards (view-only history).
 * Persisted to data/idea_cards.json (gitignored), newest first, capped.
 */
"use strict";

const fs   = require("fs");
const path = require("path");

const IS_TEST  = process.env.NODE_ENV === "test";
const FILE     = process.env.IDEA_CARDS_PATH || path.join(__dirname, "../../data/idea_cards.json");
const MAX_KEEP = 200;

let cards = null;

function load() {
  if (cards) return cards;
  cards = [];
  if (IS_TEST && !process.env.IDEA_CARDS_PATH) return cards;
  try { cards = JSON.parse(fs.readFileSync(FILE, "utf8")); if (!Array.isArray(cards)) cards = []; } catch { cards = []; }
  return cards;
}

function persist() {
  if (IS_TEST && !process.env.IDEA_CARDS_PATH) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + ".tmp", JSON.stringify(cards, null, 2));
    fs.renameSync(FILE + ".tmp", FILE);
  } catch (err) { console.warn("[ideas] persist failed:", err.message); }
}

function add(card) {
  load().unshift(card);
  if (cards.length > MAX_KEEP) cards.length = MAX_KEEP;
  persist();
  return card;
}

function list({ origin, limit = 50 } = {}) {
  return load().filter(c => !origin || c.origin === origin).slice(0, limit);
}

function remove(id) {
  const before = load().length;
  cards = cards.filter(c => c.id !== id);
  if (cards.length !== before) persist();
  return cards.length !== before;
}

function _reset() { cards = null; }

module.exports = { add, list, remove, _reset };
