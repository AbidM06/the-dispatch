/**
 * server/news/store.js — append-only store of news cards (WO-03).
 *
 * data/news_cards.jsonl (gitignored; memory-only in tests unless NEWS_CARDS_PATH is set).
 * One line per card, never rewritten: { card, removedSentences, hash }. `hash` is a SHA-256
 * of the card as generated (sorted keys, like Journal entries), so a later edit to the file
 * shows as integrity "MODIFIED" on read. The removed sentences are kept for audit only —
 * list() and get() never return their text (D-33).
 */
"use strict";

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const IS_TEST = process.env.NODE_ENV === "test";
const filePath = () => process.env.NEWS_CARDS_PATH || path.join(__dirname, "../../data/news_cards.jsonl");
const persistent = () => !IS_TEST || Boolean(process.env.NEWS_CARDS_PATH);
let _memory = [];

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stable(v[k])).join(",")}}`;
  return JSON.stringify(v);
}
const hashCard = (card) => crypto.createHash("sha256").update(stable(card)).digest("hex");

function readAll() {
  if (!persistent()) return _memory.slice();
  let raw;
  try { raw = fs.readFileSync(filePath(), "utf8"); } catch { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { console.warn("[news-cards] skipped an unreadable line"); }
  }
  return out;
}

/** Append a card. Returns the served card (with its hash). Throws if the write fails — the route then says so. */
function append(card, removedSentences = []) {
  const hash = hashCard(card);
  const rec = { card, removedSentences, hash };
  if (!persistent()) _memory.push(JSON.parse(JSON.stringify(rec)));
  else {
    const file = filePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + "\n");
  }
  return { ...card, hash };
}

/** The served form: the card + its hash + integrity. Never the removed text. */
function served(rec) {
  return { ...rec.card, hash: rec.hash, integrity: hashCard(rec.card) === rec.hash ? "intact" : "MODIFIED" };
}

function list({ limit = 50 } = {}) {
  return readAll().reverse().slice(0, limit).map(served);
}
function get(id) {
  const rec = readAll().find(r => r.card && r.card.id === id);
  return rec ? served(rec) : null;
}
function latest() {
  const all = readAll();
  return all.length ? served(all[all.length - 1]) : null;
}

function _reset() { _memory = []; }

module.exports = { append, list, get, latest, hashCard, _reset, _readAll: readAll };
