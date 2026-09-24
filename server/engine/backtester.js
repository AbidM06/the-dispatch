/**
 * server/engine/backtester.js
 * ─────────────────────────────────────────────────────────────────────────────
 * TRIGGER-FREQUENCY count on hand-entered demo data. NOT a backtest of returns.
 *
 * It counts how often each playbook's trigger condition would have been true
 * on the seven hand-typed monthly points in RATES_HISTORY_SEED. It never
 * computes a return, a fill, a hit rate or a P&L, so nothing it produces is
 * evidence of trading performance — and it must not be presented as such.
 *
 * Removed fabrications: the 2Y yield used to be synthesised as `y10 − 2.00`
 * (so the curve was always exactly +2.00pp before rounding), missing inputs
 * were filled with 2.3 / 3.0, the book was set to £1,110 with HHI 2000, and
 * seed watchlist prices stood in for market data. Missing inputs are now null,
 * so playbooks that need them do not trigger.
 *
 * runBacktest(options) → BacktestResult
 *
 * BacktestResult shape:
 *   {
 *     runs:         number,       // total month-playbook combinations tested
 *     months:       number,       // number of historical months
 *     byPlaybook:   PlaybookPerf[],
 *     byMonth:      MonthPerf[],
 *     regimeMap:    { [regime]: { monthsPresent, totalTriggered, avgTriggeredPerMonth } },
 *     topSetups:    string[],     // playbook IDs most frequently triggered
 *     generatedAt:  string,
 *   }
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const seeds         = require("../../seeds/fallback");
const { PLAYBOOKS } = require("./playbooks");
const { computeSignals } = require("./strategies");
const { classifyLevels } = require("../analytics/regime");

const WHAT_THIS_IS = "Trigger frequency on hand-entered monthly demo data (seeds RATES_HISTORY_SEED / HY_HISTORY_SEED). Counts how often each trigger condition was true. It does not compute returns, fills or hit rates and is not evidence of trading performance.";

/**
 * Run backtesting across all historical months in RATES_HISTORY_SEED.
 * For each month, builds a context and tests which playbooks would have triggered.
 *
 * @param {object} options
 * @param {string[]} [options.categories] — playbook categories to test (default all)
 * @returns {BacktestResult}
 */
function runBacktest(options = {}) {
  const categories = options.categories ?? ["macro", "structure", "portfolio"];
  const filteredPlaybooks = PLAYBOOKS.filter(p => categories.includes(p.category));

  const ratesHistory = seeds.RATES_HISTORY_SEED;
  const hyHistory    = seeds.HY_HISTORY_SEED ?? [];

  const monthResults = [];
  const playbookAcc  = {}; // { [playbookId]: { triggered, totalConf, months: [] } }
  const regimeAcc    = {}; // { [regime]: { triggered, months: [] } }

  // initialise accumulators
  for (const pb of filteredPlaybooks) {
    playbookAcc[pb.id] = { triggered: 0, totalConf: 0, months: [] };
  }

  let totalRuns = 0;

  for (let i = 0; i < ratesHistory.length; i++) {
    const ratesPoint = ratesHistory[i];
    const hyPoint    = hyHistory[i] ?? null;

    // Build rates scalars
    const rates = {
      dgs10:     Number.isFinite(ratesPoint.y10)  ? ratesPoint.y10  : null,
      dfii10:    Number.isFinite(ratesPoint.real) ? ratesPoint.real : null,
      t10yie:    Number.isFinite(ratesPoint.bei)  ? ratesPoint.bei  : null,
      hy_spread: Number.isFinite(hyPoint?.oas)    ? hyPoint.oas     : null,
      t10y2y:    null,   // no 2Y in the seed history; never synthesised
    };

    // Build history slice for signals
    const historySlice = ratesHistory.slice(0, i + 1);

    const watchlistMap = {};   // no historical prices; price-based triggers do not fire

    const signals = computeSignals(rates, historySlice, watchlistMap);
    const regime  = classifyLevels(rates).regime;

    const ctx = {
      rates,
      deltas: {
        dgs10_d:     i > 0 ? Math.round((rates.dgs10 - ratesHistory[i-1].y10) * 100) : null,
        dfii10_d:    i > 0 && Number.isFinite(ratesHistory[i-1].real) && rates.dfii10 != null ? Math.round((rates.dfii10 - ratesHistory[i-1].real) * 100) : null,
        t10yie_d:    i > 0 && Number.isFinite(ratesHistory[i-1].bei)  && rates.t10yie != null ? Math.round((rates.t10yie - ratesHistory[i-1].bei) * 100)  : null,
        hy_spread_d: i > 0 && Number.isFinite(hyHistory[i-1]?.oas)    && rates.hy_spread != null ? Math.round((rates.hy_spread - hyHistory[i-1].oas) * 100) : null,
        t10y2y_d:    null,
      },
      portfolio: { rows: [], totalGBP: 0, weights: {}, hhi: 0, usdPct: 0 },
      watchlist: watchlistMap,
      ratesAsOf: {},
      regime,
      signals,
      today: new Date(2026, i, 1),
      _usdgbp: null,
    };

    const monthTriggered = [];

    for (const pb of filteredPlaybooks) {
      totalRuns++;
      let triggered = false;
      try {
        triggered = pb.trigger(ctx);
      } catch (_) {}

      if (triggered) {
        let conf = 55;
        try {
          const partial = pb.template(ctx);
          conf = partial.confidence ?? 55;
        } catch (_) {}

        playbookAcc[pb.id].triggered++;
        playbookAcc[pb.id].totalConf += conf;
        playbookAcc[pb.id].months.push(ratesPoint.m);
        monthTriggered.push({ playbookId: pb.id, confidence: conf });
      }
    }

    // Regime accumulator
    if (!regimeAcc[regime]) regimeAcc[regime] = { triggered: 0, months: [] };
    regimeAcc[regime].triggered += monthTriggered.length;
    regimeAcc[regime].months.push(ratesPoint.m);

    monthResults.push({
      month:     ratesPoint.m,
      regime,
      rates:     { dgs10: rates.dgs10, dfii10: rates.dfii10, hy_spread: rates.hy_spread, t10y2y: rates.t10y2y },
      triggered: monthTriggered,
    });
  }

  // Summarise by playbook
  const byPlaybook = filteredPlaybooks.map(pb => {
    const acc = playbookAcc[pb.id];
    return {
      playbookId:      pb.id,
      name:            pb.name,
      category:        pb.category,
      triggerRate:     ratesHistory.length > 0 ? +(acc.triggered / ratesHistory.length * 100).toFixed(1) : 0,
      timesTriggered:  acc.triggered,
      avgConfidence:   acc.triggered > 0 ? +(acc.totalConf / acc.triggered).toFixed(1) : null,
      triggeredMonths: acc.months,
    };
  }).sort((a, b) => b.timesTriggered - a.timesTriggered);

  // Summarise by regime
  const regimeMap = Object.fromEntries(
    Object.entries(regimeAcc).map(([regime, d]) => [regime, {
      monthsPresent:         d.months.length,
      totalTriggered:        d.triggered,
      avgTriggeredPerMonth:  d.months.length > 0 ? +(d.triggered / d.months.length).toFixed(1) : 0,
    }])
  );

  const topSetups = byPlaybook.slice(0, 3).map(p => p.playbookId);

  return {
    kind:        "demo",
    measures:    "trigger-frequency",
    whatThisIs:  WHAT_THIS_IS,
    limitations: [
      "Seven hand-typed monthly observations — far too few to estimate anything.",
      "No 2Y history, so curve-level and curve-change triggers cannot fire.",
      "No historical prices, so no returns, stops, targets or hit rates are evaluated.",
      "Trigger thresholds were chosen with the same data in view (look-ahead).",
    ],
    runs:        totalRuns,
    months:      ratesHistory.length,
    byPlaybook,
    byMonth:     monthResults,
    regimeMap,
    topSetups,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { runBacktest };
