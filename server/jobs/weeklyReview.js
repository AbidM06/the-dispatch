/**
 * server/jobs/weeklyReview.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Generate a weekly markdown review report and save to reports/YYYY-MM-DD.md.
 *
 * generateWeeklyReport(ideas, metrics, regime) → string  (markdown)
 * saveWeeklyReport(markdown)                             → filePath
 *
 * Triggered: Sunday 18:00 by ideaScheduler, or via POST /api/ideas/weekly-report.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const REPORTS_DIR = path.join(__dirname, "..", "..", "reports");

// ── Helpers ───────────────────────────────────────────────────────────────────

function pad2(n) { return String(n).padStart(2, "0"); }

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function safeFixed(val, dp = 1) {
  if (val == null || !isFinite(val)) return "—";
  return Number(val).toFixed(dp);
}

function safePct(val) {
  if (val == null || !isFinite(val)) return "—";
  return `${val >= 0 ? "+" : ""}${Number(val).toFixed(1)}%`;
}

// ── Report generation ─────────────────────────────────────────────────────────

/**
 * Generate a weekly markdown report from closed/open ideas and performance metrics.
 *
 * @param {object[]} ideas    All ideas (any status)
 * @param {object}   metrics  PaperMetrics from paperTrader.computeMetrics()
 * @param {string}   regime   Current regime label (optional)
 * @returns {string}  Markdown string
 */
function generateWeeklyReport(ideas = [], metrics = {}, regime = "Unknown") {
  const date     = todayStr();
  const closed   = ideas.filter(i => i.status === "CLOSED");
  const open     = ideas.filter(i => i.status === "OPEN");
  const blocked  = ideas.filter(i => i.engineDecision === "blocked" || i.engineDecision === "caution");

  // ── Ideas table rows ──
  const tableRows = closed.map(idea => {
    const rMultiple = (idea.actualPnLPct != null && idea.entry && idea.stop)
      ? (() => {
          const riskPct = Math.abs(idea.entry - idea.stop) / idea.entry * 100;
          return riskPct > 0 ? (idea.actualPnLPct / riskPct).toFixed(2) : "—";
        })()
      : "—";

    const holdDays = (idea.openedAt && idea.closedAt)
      ? Math.round((new Date(idea.closedAt) - new Date(idea.openedAt)) / 86_400_000)
      : "—";

    const outcome = idea.outcome ?? idea.status ?? "—";
    const pnlStr  = idea.actualPnLPct != null ? safePct(idea.actualPnLPct) : "—";

    return `| ${idea.ticker ?? "—"} | ${idea.direction ?? "—"} | ${outcome} | ${pnlStr} | ${rMultiple} | ${holdDays}d |`;
  });

  // ── Process improvement suggestions ──
  const improvements = [];
  const hitRate = metrics.hitRate;
  const avgR    = metrics.avgRMultiple;

  if (hitRate !== null && hitRate < 40) {
    improvements.push("Hit rate below 40% — review trigger conditions for over-triggering. Consider raising conviction threshold to 65+.");
  } else if (hitRate !== null && hitRate >= 60) {
    improvements.push("Hit rate above 60% — strong signal quality. Consider increasing position sizing on high-conviction setups.");
  }

  if (avgR !== null && avgR < 1.0) {
    improvements.push("Avg R-multiple below 1.0 — exits too early or targets too close. Review target logic for each playbook.");
  } else if (avgR !== null && avgR >= 2.0) {
    improvements.push("Avg R-multiple above 2.0 — excellent reward/risk. Maintain current exit discipline.");
  }

  if (metrics.closed === 0 && metrics.open > 0) {
    improvements.push(`${metrics.open} ideas open but none closed yet — too early to assess strategy performance.`);
  }

  if (improvements.length === 0) {
    improvements.push("No specific process improvement identified this week — continue monitoring.");
  }

  // ── False positives / regime mistakes ──
  const falsePosItems = blocked.map(i =>
    `- ${i.ticker ?? "?"} ${i.direction ?? "?"}: ${(i.engineReasons ?? []).slice(0, 2).join("; ") || "No reason recorded"}`
  );

  // ── Assemble markdown ──
  const lines = [
    `# Weekly Review — ${date}`,
    ``,
    `## Market Regime`,
    regime,
    ``,
    `## Ideas Summary`,
    ``,
    closed.length > 0
      ? [
          `| Ticker | Dir | Outcome | P&L% | R-Multiple | Hold |`,
          `|--------|-----|---------|------|------------|------|`,
          ...tableRows,
        ].join("\n")
      : "_No closed ideas this week._",
    ``,
    `### Open Ideas (${open.length})`,
    open.length > 0
      ? open.map(i => `- **${i.ticker}** ${i.direction}: ${i.thesis ?? i.rationale ?? "—"} (opened ${(i.openedAt ?? i.generatedAt ?? "—").slice(0, 10)})`).join("\n")
      : "_No open ideas._",
    ``,
    `## Performance Metrics`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Hit Rate | ${hitRate !== null ? hitRate + "%" : "—"} |`,
    `| Stop Rate | ${metrics.stopRate !== null ? metrics.stopRate + "%" : "—"} |`,
    `| Avg P&L% | ${safePct(metrics.avgPnLPct)} |`,
    `| Avg Win% | ${safePct(metrics.avgWinPct)} |`,
    `| Avg Loss% | ${safePct(metrics.avgLossPct)} |`,
    `| Expectancy | ${safePct(metrics.expectancy)} |`,
    `| Avg R-Multiple | ${safeFixed(metrics.avgRMultiple, 2)}× |`,
    `| Avg Hold Days | ${safeFixed(metrics.avgHoldDays, 1)} days |`,
    ``,
    `## False Positives & Regime Mistakes`,
    ``,
    falsePosItems.length > 0 ? falsePosItems.join("\n") : "_None logged this week._",
    ``,
    `## Process Improvements`,
    ``,
    improvements.map(s => `- ${s}`).join("\n"),
    ``,
    `---`,
    `_Generated ${new Date().toISOString()} by The Dispatch Idea Engine v1.0_`,
  ];

  return lines.join("\n");
}

/**
 * Write a markdown report to reports/YYYY-MM-DD.md.
 * Creates the reports/ directory if it does not exist.
 *
 * @param {string} markdown  Report content
 * @returns {string}  Absolute file path written
 */
function saveWeeklyReport(markdown) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const filename = `${todayStr()}.md`;
  const filePath = path.join(REPORTS_DIR, filename);
  fs.writeFileSync(filePath, markdown, { encoding: "utf8" });
  console.log(`[weeklyReview] Report saved: ${filePath}`);
  return filePath;
}

module.exports = { generateWeeklyReport, saveWeeklyReport };
