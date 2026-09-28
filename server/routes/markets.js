/**
 * server/routes/markets.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GET  /api/markets               — last Markets snapshot (never triggers a fetch,
 *                                   except the very first time when none exists)
 * POST /api/markets/refresh       — manual "Refresh now" (write-auth guarded)
 * GET  /api/markets/history/:id   — chart history, ?tf=1d (6 months daily) | 1h (1 month hourly)
 * GET  /api/markets/status        — scheduler status (next/last run)
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const { Router } = require("express");
const markets    = require("../markets/service");
const scheduler  = require("../jobs/marketsScheduler");
const requireWriteAuth = require("../middleware/auth");

const router = Router();
const MIN_MANUAL_GAP_MS = 60_000; // ignore double-clicks / rapid repeats

router.get("/", async (req, res, next) => {
  try {
    let snap = markets.getSnapshot();
    if (!snap) snap = await markets.refresh("first-load");
    res.json({ ...snap, refreshing: markets.isRefreshing(), schedule: scheduler.getStatus() });
  } catch (err) { next(err); }
});

router.post("/refresh", requireWriteAuth, async (req, res, next) => {
  try {
    const snap = markets.getSnapshot();
    if (snap && Date.now() - Date.parse(snap.generatedAt) < MIN_MANUAL_GAP_MS && !req.body?.force) {
      return res.json({ ...snap, refreshing: false, skipped: "refreshed under a minute ago", schedule: scheduler.getStatus() });
    }
    const fresh = await markets.refresh("manual");
    // Journal stage 2: re-score ideas on the new prices (free data, no AI).
    require("../journal/tracker").updateAll().catch(err => console.warn("[journal] tracking update failed:", err.message));
    res.json({ ...fresh, refreshing: false, schedule: scheduler.getStatus() });
  } catch (err) { next(err); }
});

router.get("/status", (req, res) => res.json(scheduler.getStatus()));

router.get("/history/:id", async (req, res) => {
  try {
    res.json(await markets.getHistory(req.params.id, req.query.tf));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
