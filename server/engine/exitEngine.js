/**
 * server/engine/exitEngine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Scans open ideas against current watchlist prices and macro context.
 * Returns exit signals (close recommendations) with reasons.
 *
 * checkExits(openIdeas, ctx) → ExitSignal[]
 *
 * ExitSignal shape:
 *   { ideaId, ticker, direction, signal: "CLOSE"|"REVIEW", reason, priority: "HIGH"|"MEDIUM"|"LOW",
 *     currentPrice, entry, stop, target, unrealizedPct, daysOpen }
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const HORIZON_DAYS = {
  "1 week":    7,
  "2 weeks":   14,
  "1 month":   30,
  "3 months":  90,
  "6 months":  180,
  "immediate": 1,
};

function parseHorizonDays(horizon) {
  if (!horizon) return 90;
  const h = horizon.toLowerCase().trim();
  for (const [k, v] of Object.entries(HORIZON_DAYS)) {
    if (h.includes(k.replace(" ", ""))) return v;
  }
  // Try matching with spaces
  for (const [k, v] of Object.entries(HORIZON_DAYS)) {
    if (h.includes(k)) return v;
  }
  const num = parseInt(h, 10);
  return isNaN(num) ? 90 : num;
}

/**
 * Check all open ideas for exit conditions.
 *
 * @param {object[]} openIdeas  Ideas with status === "OPEN"
 * @param {object}   ctx        Context from buildCtx (has .watchlist, .rates, .regime)
 * @returns {ExitSignal[]}
 */
function checkExits(openIdeas, ctx) {
  const signals = [];
  const now = Date.now();

  for (const idea of openIdeas) {
    if (!idea || idea.status !== "OPEN") continue;

    const ticker   = idea.ticker;
    const entry    = idea.entry;
    const stop     = idea.stop;
    const target   = idea.target;
    const openedAt = idea.openedAt ? new Date(idea.openedAt).getTime() : null;

    // Get current price from watchlist
    const wlItem       = ctx.watchlist[ticker];
    const currentPrice = wlItem?.price ?? null;

    let unrealizedPct = null;
    if (currentPrice != null && entry != null && entry > 0) {
      unrealizedPct = +((currentPrice - entry) / entry * 100).toFixed(2);
    }

    const daysOpen = openedAt ? +((now - openedAt) / 86_400_000).toFixed(1) : null;

    // ── 1. Target hit ──
    if (target != null && currentPrice != null && currentPrice >= target) {
      signals.push({
        ideaId:        idea.id,
        ticker,
        direction:     idea.direction,
        signal:        "CLOSE",
        reason:        `Target hit: current price ${currentPrice} >= target ${target}. Unrealized: +${unrealizedPct}%.`,
        exitPlaybook:  "exit-target-hit",
        priority:      "HIGH",
        currentPrice,
        entry, stop, target,
        unrealizedPct,
        daysOpen,
      });
      continue;
    }

    // ── 2. Stop hit ──
    if (stop != null && currentPrice != null && currentPrice <= stop) {
      signals.push({
        ideaId:        idea.id,
        ticker,
        direction:     idea.direction,
        signal:        "CLOSE",
        reason:        `Stop hit: current price ${currentPrice} <= stop ${stop}. Unrealized: ${unrealizedPct}%.`,
        exitPlaybook:  "exit-stop-hit",
        priority:      "HIGH",
        currentPrice,
        entry, stop, target,
        unrealizedPct,
        daysOpen,
      });
      continue;
    }

    // ── 3. Time expiry ──
    if (daysOpen != null && idea.horizon) {
      const maxDays = parseHorizonDays(idea.horizon);
      if (daysOpen > maxDays * 1.2) {  // 20% grace period
        signals.push({
          ideaId:        idea.id,
          ticker,
          direction:     idea.direction,
          signal:        "REVIEW",
          reason:        `Horizon expired: open ${daysOpen.toFixed(0)} days vs stated ${idea.horizon} (max ${maxDays} days). Thesis may be stale.`,
          exitPlaybook:  "exit-time-expiry",
          priority:      "MEDIUM",
          currentPrice,
          entry, stop, target,
          unrealizedPct,
          daysOpen,
        });
        continue;
      }
    }

    // ── 4. Regime change ──
    if (idea.regime && ctx.regime && idea.regime !== ctx.regime) {
      const regimeChanged =
        (ctx.rates.hy_spread < 2.8) ||
        (ctx.rates.dgs10 < 3.8) ||
        (ctx.rates.t10y2y < -0.1);

      if (regimeChanged) {
        signals.push({
          ideaId:        idea.id,
          ticker,
          direction:     idea.direction,
          signal:        "REVIEW",
          reason:        `Regime changed: idea generated in "${idea.regime}", now "${ctx.regime}". Review thesis validity.`,
          exitPlaybook:  "exit-regime-change",
          priority:      "MEDIUM",
          currentPrice,
          entry, stop, target,
          unrealizedPct,
          daysOpen,
        });
      }
    }
  }

  // Sort: HIGH first, then by unrealizedPct (worst losses first)
  signals.sort((a, b) => {
    const pOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    const pDiff = (pOrder[a.priority] ?? 2) - (pOrder[b.priority] ?? 2);
    if (pDiff !== 0) return pDiff;
    return (a.unrealizedPct ?? 0) - (b.unrealizedPct ?? 0);
  });

  return signals;
}

module.exports = { checkExits, parseHorizonDays };
