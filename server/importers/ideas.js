/**
 * server/importers/ideas.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Persistence layer for Trade Idea Tickets.
 * Stores ideas to /data/trade_ideas.json — same pattern as t212.js.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const IDEAS_PATH = path.join(__dirname, "..", "..", "data", "trade_ideas.json");

/** Generate a unique ID (crypto.randomUUID available Node ≥ 14.17; fallback for safety). */
function generateId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Load all ideas from disk.
 * Returns { version: 1, ideas: [] } if file not found or unreadable.
 */
function loadIdeas() {
  try {
    if (!fs.existsSync(IDEAS_PATH)) return { version: 1, ideas: [] };
    const raw    = fs.readFileSync(IDEAS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.ideas)) return { version: 1, ideas: [] };
    return parsed;
  } catch (err) {
    console.warn("[ideas] Could not load trade_ideas.json:", err.message);
    return { version: 1, ideas: [] };
  }
}

/**
 * Persist ideas array to disk.
 * @param {object[]} ideas
 */
function saveIdeas(ideas) {
  const dir = path.dirname(IDEAS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(IDEAS_PATH, JSON.stringify({ version: 1, ideas }, null, 2), "utf8");
}

/**
 * Add a new idea and persist.
 * Assigns id, openedAt, status, outcome — caller provides all other fields.
 * @param {object} draft  Validated idea fields
 * @returns {object}      The persisted idea with generated fields
 */
function addIdea(draft) {
  const store = loadIdeas();
  const idea  = {
    ...draft,
    id:           generateId(),
    status:       "OPEN",
    outcome:      null,
    openedAt:     new Date().toISOString(),
    closedAt:     null,
    actualPnLPct: null,
    notes:        draft.notes ?? "",
  };
  store.ideas.push(idea);
  saveIdeas(store.ideas);
  return idea;
}

/**
 * Update an existing idea by id (merge patch).
 * @param {string} id     Idea id
 * @param {object} patch  Fields to merge
 * @returns {object}      Updated idea
 * @throws Error (status 404) if id not found
 */
function updateIdea(id, patch) {
  const store = loadIdeas();
  const idx   = store.ideas.findIndex(i => i.id === id);
  if (idx === -1) {
    const err = new Error(`Idea not found: ${id}`);
    err.status = 404;
    throw err;
  }
  const updated       = { ...store.ideas[idx], ...patch };
  store.ideas[idx]    = updated;
  saveIdeas(store.ideas);
  return updated;
}

module.exports = { loadIdeas, saveIdeas, addIdea, updateIdea, IDEAS_PATH };
