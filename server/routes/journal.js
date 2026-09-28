/**
 * server/routes/journal.js — the trade-idea Journal (stage 1).
 *
 * GET  /api/journal?watched=true|false&origin=news|research&limit=
 * GET  /api/journal/:entryId              (both include stage-2 tracking; see journal/tracker.js)
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
const requireWriteAuth = require("../middleware/auth");

const router = Router();

// Ideas generated before the Journal existed are logged once, flagged
// "backfilled" — at server start, and here in case that failed.
const { ensureBackfilled } = require("../journal/migrate");

function send(res, fn) {
  try { res.json({ entry: fn() }); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
}

router.get("/", (req, res) => {
  ensureBackfilled();
  const watched = req.query.watched === "true" ? true : req.query.watched === "false" ? false : undefined;
  const origin  = ["news", "research"].includes(req.query.origin) ? req.query.origin : undefined;
  const limit   = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  const tracking = tracker.getState();
  const entries = journal.list({ watched, origin, limit }).map(e => ({ ...e, tracking: tracking.entries[e.entryId] || null }));
  res.json({ entries, stats: tracker.stats(tracking.entries), trackingUpdatedAt: tracking.updatedAt });
});

router.get("/:entryId", (req, res) => {
  ensureBackfilled();
  const e = journal.getEntry(req.params.entryId);
  if (!e) return res.status(404).json({ error: "Journal entry not found" });
  res.json({ entry: { ...e, tracking: tracker.getState().entries[e.entryId] || null } });
});

router.post("/:entryId/watch", requireWriteAuth, (req, res) =>
  send(res, () => journal.setWatch(req.params.entryId, req.body?.watched !== false)));

router.post("/:entryId/pitch", requireWriteAuth, (req, res) =>
  send(res, () => journal.addPitch(req.params.entryId, req.body?.text, { beforeReveal: req.body?.beforeReveal === true })));

router.post("/:entryId/manual-price", requireWriteAuth, (req, res) =>
  send(res, () => journal.addManualPrice(req.params.entryId, req.body?.price, req.body?.note)));

module.exports = router;
