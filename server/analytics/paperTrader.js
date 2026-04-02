/**
 * server/analytics/paperTrader.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Compute paper-trade performance metrics from closed ideas.
 * Pure function — no I/O, no external dependencies.
 *
 * computeMetrics(ideas) → PaperMetrics
 *
 * PaperMetrics shape:
 *   {
 *     total:        number,
 *     open:         number,
 *     closed:       number,
 *     cancelled:    number,
 *     hitRate:      number | null,   // % closed that are HIT
 *     stopRate:     number | null,
 *     avgPnLPct:    number | null,   // mean actualPnLPct for all closed
 *     avgWinPct:    number | null,   // mean for HIT
 *     avgLossPct:   number | null,   // mean for STOPPED
 *     expectancy:   number | null,   // hitRate*avgWin + stopRate*avgLoss (in %)
 *     avgRMultiple: number | null,
 *     avgHoldDays:  number | null,
 *     mfe:          number | null,   // theoretical: mean (target-entry)/entry for OPEN
 *     mae:          number | null,   // theoretical: mean (entry-stop)/entry for OPEN
 *     byTicker:     { [ticker]: { count, hitRate, avgPnL } },
 *     byDirection:  { LONG: {...}, SHORT: {...} },
 *   }
 *
 * All division is guarded — no NaN/Infinity.
 * null returned for any metric requiring closed ideas when none exist.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

// ── Helpers ───────────────────────────────────────────────────────────────────

function avg(arr) {
  if (!arr.length) return null;
  return +(arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(2);
}

function safeDiv(a, b) {
  return b !== 0 ? a / b : 0;
}

function pct(hits, total) {
  return total > 0 ? +(hits / total * 100).toFixed(1) : null;
}

// ── Core ──────────────────────────────────────────────────────────────────────

/**
 * Compute paper-trade performance metrics from an array of idea objects.
 *
 * @param {object[]} ideas  Array of idea/ticket objects from trade_ideas.json or ideaLog
 * @returns {PaperMetrics}
 */
function computeMetrics(ideas = []) {
  const all       = ideas.filter(i => i && typeof i === "object");
  const open      = all.filter(i => i.status === "OPEN");
  const closed    = all.filter(i => i.status === "CLOSED");
  const cancelled = all.filter(i => i.status === "CANCELLED");
  const hits      = closed.filter(i => i.outcome === "HIT");
  const stopped   = closed.filter(i => i.outcome === "STOPPED");

  // ── Rates ──
  const hitRate  = pct(hits.length,    closed.length);
  const stopRate = pct(stopped.length, closed.length);

  // ── PnL averages ──
  const closedPnls = closed
    .map(i => i.actualPnLPct)
    .filter(v => typeof v === "number" && isFinite(v));

  const winPnls  = hits.map(i => i.actualPnLPct).filter(v => typeof v === "number" && isFinite(v));
  const lossPnls = stopped.map(i => i.actualPnLPct).filter(v => typeof v === "number" && isFinite(v));

  const avgPnLPct  = avg(closedPnls);
  const avgWinPct  = avg(winPnls);
  const avgLossPct = avg(lossPnls);

  // ── Expectancy = hitRate% × avgWin + stopRate% × avgLoss ──
  let expectancy = null;
  if (hitRate !== null && avgWinPct !== null && stopRate !== null && avgLossPct !== null) {
    expectancy = +(safeDiv(hitRate, 100) * avgWinPct + safeDiv(stopRate, 100) * avgLossPct).toFixed(2);
  }

  // ── R-Multiple avg ──
  const rMultiples = closed
    .filter(i => i.actualPnLPct != null && i.entry && i.stop)
    .map(i => {
      const riskPct = Math.abs(i.entry - i.stop) / i.entry * 100;
      return riskPct > 0 ? i.actualPnLPct / riskPct : null;
    })
    .filter(r => r !== null && isFinite(r));

  const avgRMultiple = avg(rMultiples);

  // ── Average hold days ──
  const holdTimes = closed
    .filter(i => i.openedAt && i.closedAt)
    .map(i => (new Date(i.closedAt) - new Date(i.openedAt)) / 86_400_000)
    .filter(d => isFinite(d) && d >= 0);

  const avgHoldDays = avg(holdTimes);

  // ── Theoretical MFE / MAE (open ideas, using entry/target/stop if present) ──
  const mfeValues = open
    .filter(i => i.entry && i.target && i.entry > 0)
    .map(i => Math.abs(i.target - i.entry) / i.entry * 100)
    .filter(v => isFinite(v));

  const maeValues = open
    .filter(i => i.entry && i.stop && i.entry > 0)
    .map(i => Math.abs(i.entry - i.stop) / i.entry * 100)
    .filter(v => isFinite(v));

  const mfe = avg(mfeValues);
  const mae = avg(maeValues);

  // ── By-ticker breakdown ──
  const tickerMap = {};
  for (const idea of closed) {
    const t = idea.ticker ?? "UNKNOWN";
    if (!tickerMap[t]) tickerMap[t] = { ideas: [] };
    tickerMap[t].ideas.push(idea);
  }

  const byTicker = {};
  for (const [ticker, { ideas: tIdeas }] of Object.entries(tickerMap)) {
    const tHits  = tIdeas.filter(i => i.outcome === "HIT");
    const tPnls  = tIdeas.map(i => i.actualPnLPct).filter(v => typeof v === "number" && isFinite(v));
    byTicker[ticker] = {
      count:   tIdeas.length,
      hitRate: pct(tHits.length, tIdeas.length),
      avgPnL:  avg(tPnls),
    };
  }

  // ── By-direction breakdown ──
  function dirStats(direction) {
    const dIdeas   = closed.filter(i => i.direction === direction);
    const dHits    = dIdeas.filter(i => i.outcome === "HIT");
    const dPnls    = dIdeas.map(i => i.actualPnLPct).filter(v => typeof v === "number" && isFinite(v));
    return {
      count:   dIdeas.length,
      hitRate: pct(dHits.length, dIdeas.length),
      avgPnL:  avg(dPnls),
    };
  }

  const byDirection = {
    LONG:  dirStats("LONG"),
    SHORT: dirStats("SHORT"),
  };

  return {
    total:        all.length,
    open:         open.length,
    closed:       closed.length,
    cancelled:    cancelled.length,
    hitRate,
    stopRate,
    avgPnLPct,
    avgWinPct,
    avgLossPct,
    expectancy,
    avgRMultiple,
    avgHoldDays,
    mfe,
    mae,
    byTicker,
    byDirection,
  };
}

module.exports = { computeMetrics };
