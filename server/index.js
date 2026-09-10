/**
 * server/index.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Express application entry point for The Dispatch API server.
 *
 * Architecture:
 *   PORT 3001               ← Express
 *   /api/snapshot           ← FRED + Alpha Vantage (cached)
 *   /api/risk               ← seed/deterministic (GET) | AI / deterministic (POST /refresh)
 *   /api/events             ← seed/deterministic (GET) | AI / deterministic (POST /refresh)
 *   /api/explain/:ticker    ← Anthropic AI (cached per ticker)
 *   /                       ← serves client/ as static files
 *
 * Environment variables (see .env.example):
 *   ANTHROPIC_API_KEY, ALPHA_VANTAGE_API_KEY, FRED_API_KEY
 *   PORT (default 3001)
 *   LOW_COST_MODE=true — disables AI calls; returns deterministic narrative
 *   ANTHROPIC_DAILY_CAP, ANTHROPIC_MONTHLY_CAP — budget limits (default 5/50)
 * ─────────────────────────────────────────────────────────────────────────────
 */

require("dotenv").config();

const express  = require("express");
const cors     = require("cors");
const path     = require("path");

// ── Route handlers ────────────────────────────────────────────────────────────
const snapshotRouter  = require("./routes/snapshot");
const riskRouter      = require("./routes/risk");
const eventsRouter    = require("./routes/events");
const explainRouter   = require("./routes/explain");
const ideasRouter     = require("./routes/ideas");
const briefRouter     = require("./routes/brief");
const newsRouter      = require("./routes/news");
const glossaryRouter  = require("./routes/glossary");
const macroRouter        = require("./routes/macro");
const correlationsRouter       = require("./routes/correlations");
const analyticsNarrativeRouter = require("./routes/analyticsNarrative");
const correlationsCustomRouter = require("./routes/correlationsCustom");
const momentumRouter           = require("./routes/momentum");
const researchRouter           = require("./routes/research");
const bulletinRouter           = require("./routes/bulletin");

const app  = express();
const PORT = parseInt(process.env.PORT, 10) || 3001;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Request logging ───────────────────────────────────────────────────────────
app.use((req, _res, next) => {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${req.method} ${req.path}`);
  next();
});

// ── API routes ────────────────────────────────────────────────────────────────
app.use("/api/snapshot",  snapshotRouter);
app.use("/api/risk",      riskRouter);
app.use("/api/events",    eventsRouter);
app.use("/api/explain",   explainRouter);
app.use("/api/ideas",     ideasRouter);
app.use("/api/brief",     briefRouter);
app.use("/api/news",      newsRouter);
app.use("/api/glossary",  glossaryRouter);
app.use("/api/macro",         macroRouter);
app.use("/api/correlations",  correlationsRouter);
app.use("/api/correlations",  analyticsNarrativeRouter);
app.use("/api/correlations",  correlationsCustomRouter);
app.use("/api/analytics",    momentumRouter);
app.use("/api/research",      researchRouter);
app.use("/api/bulletin",      bulletinRouter);

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  const budget = require("./providers/budget");
  const status = budget.getStatus();

  res.json({
    status:      "ok",
    uptime:      Math.round(process.uptime()),
    timestamp:   new Date().toISOString(),
    lowCostMode: process.env.LOW_COST_MODE === "true",
    env: {
      anthropic:    !!process.env.ANTHROPIC_API_KEY,
      alphaVantage: !!process.env.ALPHA_VANTAGE_API_KEY,
      fred:         !!process.env.FRED_API_KEY,
      disableAi:    process.env.DISABLE_AI === "true",
    },
    budget: {
      daily:       status.daily,
      monthly:     status.monthly,
      apiFallback: budget.getApiFallbackInfo(),
    },
  });
});

// ── Static client ─────────────────────────────────────────────────────────────
const CLIENT_DIR = path.join(__dirname, "..", "client");
app.use(express.static(CLIENT_DIR));

// SPA fallback — serve index.html for any non-API route
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(CLIENT_DIR, "index.html"));
});

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error("[Server Error]", err.message);
  const status = err.status || 500;
  res.status(status).json({
    error:  err.message || "Internal server error",
    status,
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    const lowCost = process.env.LOW_COST_MODE === "true";
    console.log(`\n╔══════════════════════════════════════════╗`);
    console.log(`║  The Dispatch — API server started       ║`);
    console.log(`║  http://localhost:${PORT}                   ║`);
    console.log(`╚══════════════════════════════════════════╝`);
    if (lowCost) {
      console.log(`\n⚡ LOW_COST_MODE=true — AI calls disabled; deterministic narrative active.`);
    }
    console.log(`\nAPI endpoints:`);
    console.log(`  GET  /api/health`);
    console.log(`  GET  /api/snapshot`);
    console.log(`  GET  /api/risk`);
    console.log(`  POST /api/risk/refresh`);
    console.log(`  GET  /api/events`);
    console.log(`  POST /api/events/refresh`);
    console.log(`  GET  /api/explain/:ticker`);
    console.log(`  GET  /api/brief`);
    console.log(`  GET  /api/ideas`);
    console.log(`  POST /api/ideas`);
    console.log(`  GET  /api/ideas/stats`);
    console.log(`  POST /api/ideas/generate`);
    console.log(`  GET  /api/ideas/latest`);
    console.log(`  GET  /api/ideas/history`);
    console.log(`  GET  /api/ideas/playbooks`);
    console.log(`  GET  /api/ideas/performance`);
    console.log(`  POST /api/ideas/weekly-report`);
    console.log(`  GET  /api/ideas/alpaca`);
    console.log(`  GET  /api/ideas/exits`);
    console.log(`  GET  /api/ideas/backtest`);
    console.log(`  GET  /api/ideas/execution-log`);
    console.log(`  POST /api/ideas/sync`);
    console.log(`  GET  /api/news`);
    console.log(`  GET  /api/news/calendar`);
    console.log(`  GET  /api/news/:ticker`);
    console.log(`  GET  /api/glossary`);
    console.log(`  GET  /api/glossary/term-of-the-day`);
    console.log(`  GET  /api/glossary/:slug\n`);

    const missing = [];
    if (!process.env.ANTHROPIC_API_KEY)    missing.push("ANTHROPIC_API_KEY");
    if (!process.env.ALPHA_VANTAGE_API_KEY) missing.push("ALPHA_VANTAGE_API_KEY");
    if (!process.env.FRED_API_KEY)          missing.push("FRED_API_KEY");
    if (missing.length && !lowCost) {
      console.warn(`⚠  Missing env vars: ${missing.join(", ")}`);
      console.warn(`   Copy .env.example → .env and add your keys.\n`);
    }

    // ── Start idea engine scheduler ──────────────────────────────────────────
    if (process.env.NODE_ENV !== "test") {
      const { start: startScheduler } = require("./jobs/ideaScheduler");
      startScheduler();
      const { start: startAiRefresh } = require("./jobs/aiRefreshJob");
      startAiRefresh();
      const { start: startBulletin } = require("./jobs/bulletinScheduler");
      startBulletin();
      // Pre-generates all six research reports via the Batch API at 50% cost.
      const { start: startResearchBatch } = require("./jobs/researchBatchJob");
      startResearchBatch();
    }
  });
}

module.exports = app;
