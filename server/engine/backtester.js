/**
 * server/engine/backtester.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Deterministic historical backtest using RATES_HISTORY_SEED.
 * Scores each playbook against each historical monthly context.
 * No API calls — pure computation on seeded data.
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

/**
 * Classify regime from a rates snapshot.
 */
function classifyRegime(r) {
  const labels = [];
  if      (r.t10y2y < 0)   labels.push("Inverted curve");
  else if (r.t10y2y < 0.3) labels.push("Flat curve");
  else                      labels.push("Bear steepener");
  if      (r.dfii10 > 2.0) labels.push("High real yields");
  else if (r.dfii10 > 1.5) labels.push("Elevated real yields");
  if      (r.hy_spread > 4.5)                             labels.push("Credit stress");
  else if (r.hy_spread > 3.5)                             labels.push("Risk-off");
  else if (r.hy_spread > 3.0 && r.dfii10 > 1.5)          labels.push("Bear flattener");
  if (r.dgs10 > 4.5) labels.push("Rates restrictive");
  return labels.length ? labels.join(" + ") : "Broadly neutral";
}

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
      dgs10:     ratesPoint.y10,
      dfii10:    ratesPoint.real ?? ratesPoint.y10 - 2.0,
      t10yie:    ratesPoint.bei  ?? 2.3,
      hy_spread: hyPoint?.oas    ?? 3.0,
      t10y2y:    ratesPoint.y10 - 2.0,  // approximate 2Y as y10 - 2.0 spread
    };

    // Build history slice for signals
    const historySlice = ratesHistory.slice(0, i + 1);

    const watchlistMap = seeds.WATCHLIST_SEED.reduce((acc, w) => {
      acc[w.sym] = { price: w.price, chg: w.chg };
      return acc;
    }, {});

    const signals = computeSignals(rates, historySlice, watchlistMap);
    const regime  = classifyRegime(rates);

    const ctx = {
      rates,
      deltas: {
        dgs10_d:     i > 0 ? +(rates.dgs10 - ratesHistory[i-1].y10) * 100 : 0,
        dfii10_d:    0,
        t10yie_d:    0,
        hy_spread_d: 0,
        t10y2y_d:    0,
      },
      portfolio: {
        rows:     seeds.POSITIONS_SEED.map(p => ({ ticker: p.ticker, valGBP: null })),
        totalGBP: 1110,
        weights:  {},
        hhi:      2000,
        usdPct:   12.5,
      },
      watchlist: watchlistMap,
      regime,
      signals,
      today: new Date(2026, i, 1),
      _usdgbp: seeds.FX_SEED.usdgbp.value,
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
