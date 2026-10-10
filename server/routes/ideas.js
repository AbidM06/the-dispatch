/**
 * server/routes/ideas.js — on-demand, view-only trade idea cards.
 *
 * POST   /api/ideas/news       { headlineId? }        — idea from today's headlines (optionally one headline)
 * POST   /api/ideas/research   { reportId? , type? }  — idea from a research report
 * GET    /api/ideas            ?origin=news|research  — saved idea history (newest first)
 * DELETE /api/ideas/:id                                — dismiss a saved card
 *
 * Each POST is one Claude call (budget-gated). Nothing is ever executed.
 */
"use strict";

const { Router } = require("express");
const cache      = require("../cache");
const finnhub    = require("../providers/finnhub");
const reportStore = require("../research/reportStore");
const { generate } = require("../ideas/generator");
const store      = require("../ideas/store");
const requireWriteAuth = require("../middleware/auth");
const journalMigrate = require("../journal/migrate");

const router = Router();

function aiError(res, err) {
  const msg = err.message || "Idea generation failed";
  if (/BUDGET|budget cap|LOW_COST_MODE|DISABLE_AI|billing|API_CREDITS/i.test(msg + (err.code || ""))) {
    return res.status(503).json({ error: "AI is unavailable right now (budget cap, low-cost mode or API credits) — " + msg, aiStatus: "UNAVAILABLE" });
  }
  return res.status(err.status || 500).json({ error: msg });
}

async function currentHeadlines() {
  const cached = cache.get("news:market");
  if (cached && cached.length) return cached;
  const fresh = await finnhub.getMarketNews("general", 12);
  cache.set("news:market", fresh, finnhub.TTL_NEWS_MS);
  return fresh;
}

function currentCalendar() {
  return cache.get("news:economic-calendar") || [];
}

router.get("/", (req, res) => {
  const origin = ["news", "research"].includes(req.query.origin) ? req.query.origin : undefined;
  res.json({ ideas: store.list({ origin, limit: Math.min(parseInt(req.query.limit, 10) || 50, 200) }) });
});

router.post("/news", requireWriteAuth, async (req, res) => {
  try {
    const headlines = await currentHeadlines();
    const focusId = req.body?.headlineId ?? null;
    if (focusId != null && !headlines.some(h => String(h.id) === String(focusId))) {
      return res.status(404).json({ error: "That headline is no longer in the current news feed — reload News and try again." });
    }
    const card = await generate("news", { headlines, calendar: currentCalendar(), focusId });
    res.json({ idea: card });
  } catch (err) { aiError(res, err); }
});

router.post("/research", requireWriteAuth, async (req, res) => {
  try {
    const { reportId, type } = req.body || {};
    const report = (reportId && reportStore.get(reportId)) || (type && reportStore.latestForType(type));
    if (!report) return res.status(404).json({ error: "No saved research report found — generate a report first." });
    const card = await generate("research", { report, calendar: currentCalendar() });
    res.json({ idea: card });
  } catch (err) { aiError(res, err); }
});

router.delete("/:id", requireWriteAuth, (req, res) => {
  // Dismissing a card must never lose an idea: it is logged first (a no-op for
  // ideas already in the Journal). If that write fails, the card stays.
  try { journalMigrate.ensureLogged(req.params.id); }
  catch (err) { return res.status(500).json({ error: "Could not log this idea to the Journal, so it was not dismissed: " + err.message }); }
  if (!store.remove(req.params.id)) return res.status(404).json({ error: "Idea not found" });
  res.json({ ok: true });
});

module.exports = router;
