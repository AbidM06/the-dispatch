/**
 * server/importers/savedModels.js
 * ─────────────────────────────────────────────────────────────────────────────
 * File-backed persistence for user-built custom backtest models.
 * Stored at data/saved_models.json (gitignored alongside portfolio_snapshot.json).
 *
 * Schema per model:
 *   id         — unique string ("model-{timestamp}-{rand}")
 *   name       — user-supplied label
 *   config     — full backtest config (driverSeriesId, targetSeriesId, dates, strategy…)
 *   result     — runCustomBacktest() output (metrics, signals, equity curve)
 *   regime     — macro regime snapshot at save time
 *   savedAt    — ISO timestamp
 *   narrativeData — AI talking points (null until narrated)
 *   narrativeAt   — ISO timestamp of last narration
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const fs   = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "../../data/saved_models.json");

function readAll() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function writeAll(models) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(models, null, 2), "utf8");
}

function listModels() {
  return readAll();
}

function saveModel({ name, config, result, regime }) {
  const models = readAll();
  const id = `model-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const model = {
    id,
    name,
    config,
    result,
    regime:        regime ?? null,
    savedAt:       new Date().toISOString(),
    narrativeData: null,
    narrativeAt:   null,
  };
  models.push(model);
  writeAll(models);
  return model;
}

function getModel(id) {
  return readAll().find(m => m.id === id) ?? null;
}

function deleteModel(id) {
  const models = readAll().filter(m => m.id !== id);
  writeAll(models);
}

function updateModel(id, updates) {
  const models = readAll();
  const idx = models.findIndex(m => m.id === id);
  if (idx < 0) return null;
  models[idx] = { ...models[idx], ...updates };
  writeAll(models);
  return models[idx];
}

module.exports = { listModels, saveModel, getModel, deleteModel, updateModel };
