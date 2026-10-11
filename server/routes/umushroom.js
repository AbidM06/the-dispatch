/**
 * server/routes/umushroom.js — read-only view of the public UMushroom repo
 * for the Journal tab. See server/umushroom/source.js.
 *
 * GET /api/umushroom             summary, positions, triggers, latest note, decision log, challenges, reflections
 * GET /api/umushroom/note/:date  one archived morning note
 *
 * No POST routes, no AI, no cost. The scheduled note job lives outside the
 * Dispatch (D-07 stands) and writes only to the UMushroom repo.
 */
"use strict";

const { Router } = require("express");
const source = require("../umushroom/source");

const router = Router();

router.get("/", async (_req, res) => {
  res.json(await source.load());
});

router.get("/note/:date", async (req, res) => {
  try { res.json(await source.loadNote(req.params.date)); }
  catch (err) { res.status(err.status || 502).json({ error: err.message }); }
});

module.exports = router;
