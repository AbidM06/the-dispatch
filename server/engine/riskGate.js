/**
 * server/engine/riskGate.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Engine-level risk gate — wraps riskCheck.runPreTradeCheck() and returns
 * a simple "allowed" | "caution" | "blocked" decision for the idea engine.
 *
 * Key differences from plain riskCheck:
 *   - Entry/stop/target may be null (engine tickets use narrative logic, not
 *     bare numbers) — R-ratio WARN is accepted and does not cause "blocked".
 *   - Low-liquidity ETFs (HBKS, HIJS, HIES) get an additional liquidity note.
 *   - Event-risk within 3 days → stricter "caution" lockout reason.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const { runPreTradeCheck, parseEventDate } = require("../analytics/riskCheck");
const seeds = require("../../seeds/fallback");

// LSE ETFs not listed on Alpaca — flag liquidity note
const LOW_LIQUIDITY_TICKERS = new Set(["HBKS", "HIJS", "HIES", "HIUS", "SGLN"]);

// Near-term event lockout window (days)
const EVENT_LOCKOUT_DAYS = 3;

/**
 * Gate an engine-generated idea ticket through risk checks.
 *
 * @param {object}   ticket         Partial engine ticket with ticker, direction, sizePct, horizon
 * @param {object[]} portfolioRows  Current portfolio rows { ticker, valGBP }
 * @param {number}   totalGBP       Current portfolio total GBP
 * @param {number}   usdgbp         Current USD/GBP rate
 * @returns {{ decision: "allowed"|"caution"|"blocked", reasons: string[], checks: object[], riskFlags: object[] }}
 */
function gateIdea(ticket, portfolioRows = [], totalGBP = 0, usdgbp = 0.76) {
  // Build a pseudo-idea object for riskCheck — entry/stop/target may be null
  const pseudoIdea = {
    ticker:    ticket.ticker,
    direction: ticket.direction,
    sizePct:   ticket.sizePct ?? 5,
    entry:     ticket.entry   ?? null,
    stop:      ticket.stop    ?? null,
    target:    ticket.target  ?? null,
    horizon:   ticket.horizon ?? "3 months",
  };

  const result   = runPreTradeCheck(pseudoIdea, portfolioRows, totalGBP, usdgbp);
  const reasons  = [];
  const riskFlags = result.checks.filter(c => c.status !== "OK");

  // ── Determine base decision ─────────────────────────────────────────────────
  // R-ratio is always WARN when entry/stop/target are null — don't let that
  // alone cause "blocked". Demote BLOCK→WARN for R-ratio when no prices given.
  const hasHardBlock = result.checks.some(c => {
    if (c.name === "R-Ratio" && !pseudoIdea.entry) return false; // not a hard block without prices
    return c.status === "BLOCK";
  });

  const hasWarn = result.checks.some(c => c.status !== "OK");

  let decision = hasHardBlock ? "blocked" : hasWarn ? "caution" : "allowed";

  // ── Additional engine-level checks ─────────────────────────────────────────

  // 1. Event-risk near-term lockout (< 3 days)
  const allEvents = [...(seeds.EARNINGS_CAL ?? []), ...(seeds.MACRO_CAL ?? [])];
  for (const ev of allEvents) {
    const d = parseEventDate(ev.date);
    if (!d) continue;
    const daysAway = (d - Date.now()) / 86_400_000;
    if (daysAway < 0 || daysAway > EVENT_LOCKOUT_DAYS) continue;
    if (ev.ticker === ticket.ticker || ev.importance === "HIGH") {
      reasons.push(`Near-term event lockout: ${ev.event} (${ev.ticker}) on ${ev.date} — ${Math.ceil(daysAway)}d away.`);
      if (decision === "allowed") decision = "caution";
    }
  }

  // 2. Low-liquidity note for LSE ETFs
  if (LOW_LIQUIDITY_TICKERS.has(ticket.ticker)) {
    reasons.push(`${ticket.ticker} is T212-only (LSE ETF — not available on Alpaca paper trading). Idea logged locally.`);
    // Not a blocker — just informational
  }

  // 3. Populate reasons from risk checks
  for (const check of riskFlags) {
    reasons.push(`[${check.status}] ${check.name}: ${check.detail}`);
  }

  // 4. BLOCK reasons from hard blocks
  for (const check of result.checks) {
    if (check.status === "BLOCK" && check.name !== "R-Ratio") {
      reasons.push(`BLOCKED by ${check.name}`);
    }
  }

  return {
    decision,
    reasons,
    checks:    result.checks,
    riskFlags,
  };
}

module.exports = { gateIdea };
