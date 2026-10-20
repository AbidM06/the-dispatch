/**
 * server/routes/journal.js — the trade-idea Journal (stage 1).
 *
 * GET  /api/journal?watched=true|false&origin=news|research&limit=
 * GET  /api/journal/:entryId              (both include stage-2 tracking; see journal/tracker.js)
 * GET  /api/journal/:entryId/chart        real daily prices over a range covering the idea's age, plus the
 *                                          idea's own entry zone / target / stop (read-only; no AI, no cost)
 * POST /api/journal/:entryId/watch         { watched }            (auth)
 * POST /api/journal/:entryId/pitch         { text, beforeReveal } (auth)
 * POST /api/journal/:entryId/manual-price  { price, note }        (auth)
 *
 * There is deliberately no PUT/PATCH/DELETE: the Journal is append-only
 * (server/journal/store.js). Nothing here calls a paid API.
 */
"use strict";

const { Router } = require("express");
const journal    = require("../journal/store");
const tracker    = require("../journal/tracker");
const markets    = require("../markets/service");
const requireWriteAuth = require("../middleware/auth");

const router = Router();

// Ideas generated before the Journal existed are logged once, flagged
// "backfilled" — at server start, and here in case that failed.
const { ensureBackfilled } = require("../journal/migrate");

function send(res, fn) {
  // Mutations return the entry WITH its tracking, like the GETs, so the client
  // can swap it in without losing the result badge.
  try { const e = fn(); res.json({ entry: { ...e, tracking: tracker.trackingFor(e) } }); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
}

router.get("/", (req, res) => {
  ensureBackfilled();
  const watched = req.query.watched === "true" ? true : req.query.watched === "false" ? false : undefined;
  const origin  = ["news", "research"].includes(req.query.origin) ? req.query.origin : undefined;
  const limit   = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  const tracking = tracker.getState();
  const trackingFor = (e) => tracker.trackingFor(e, tracking);
  const entries = journal.list({ watched, origin, limit }).map(e => ({ ...e, tracking: trackingFor(e) }));
  // Stats cover every entry (not just the filtered view), including outcomes
  // restored from the Journal itself.
  const all = Object.fromEntries(journal.list({ limit: 100000 }).map(e => [e.entryId, trackingFor(e)]).filter(([, t]) => t));
  res.json({ entries, stats: tracker.stats(all), trackingUpdatedAt: tracking.updatedAt });
});

router.get("/:entryId", (req, res) => {
  ensureBackfilled();
  const e = journal.getEntry(req.params.entryId);
  if (!e) return res.status(404).json({ error: "Journal entry not found" });
  res.json({ entry: { ...e, tracking: tracker.trackingFor(e) } });
});

/** Shortest daily range (6M / 1Y / 5Y) that still shows ~a month of context before the idea. */
function chartRange(createdAt, now = Date.now()) {
  const ageDays = Math.max(0, (now - Date.parse(createdAt)) / 86_400_000);
  return ageDays <= 150 ? "1d" : ageDays <= 330 ? "1y" : "5y";
}

router.get("/:entryId/chart", async (req, res) => {
  try {
    ensureBackfilled();
    const e = journal.getEntry(req.params.entryId);
    if (!e) return res.status(404).json({ error: "Journal entry not found" });
    const idea = e.idea || {};
    if (!idea.marketId) return res.status(404).json({ error: "This idea has no Markets instrument, so there is no price chart for it." });
    // A missing level must stay missing: Number(null) is 0, which would draw a line at zero.
    const level = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
    const levels = {
      entryLow: level(idea.entryLow), entryHigh: level(idea.entryHigh), target: level(idea.target), stop: level(idea.stop),
      direction: idea.direction || null,
    };
    if (![levels.entryLow, levels.entryHigh, levels.target, levels.stop].every(Number.isFinite)) {
      return res.status(422).json({ error: "This idea's levels are incomplete, so they cannot be drawn." });
    }
    const tf = chartRange(idea.createdAt);
    // Dynamic markets (Polymarket) are priced from the history source saved on the card.
    // Cut to the window the chart labels: Polymarket's history is "max" and FRED's a year or more.
    const hist = markets.trimToRange(await markets.getHistory(idea.marketId, tf, { source: idea.marketHistory || undefined }), tf);
    res.json({ ...hist, entryId: e.entryId, levels });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post("/:entryId/watch", requireWriteAuth, (req, res) =>
  send(res, () => journal.setWatch(req.params.entryId, req.body?.watched !== false)));

router.post("/:entryId/pitch", requireWriteAuth, (req, res) =>
  send(res, () => journal.addPitch(req.params.entryId, req.body?.text, { beforeReveal: req.body?.beforeReveal === true })));

router.post("/:entryId/manual-price", requireWriteAuth, (req, res) =>
  send(res, () => journal.addManualPrice(req.params.entryId, req.body?.price, req.body?.note)));

router.chartRange = chartRange;
module.exports = router;
