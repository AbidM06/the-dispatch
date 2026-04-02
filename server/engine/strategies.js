/**
 * server/engine/strategies.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Three quantitative strategy signal modules.
 * All work with the limited data available (rates history + watchlist chg%).
 * No external API calls — pure computation on seeded/cached data.
 *
 * Each module returns:
 *   { signal: "long"|"short"|"flat", conviction: 0–100, meta: { ... } }
 *
 * IMPORTANT: conviction and signal are based on available data only.
 * meta.note always states what data was used and any limitations.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

// ── 1. Moving Average Crossover ───────────────────────────────────────────────
/**
 * Uses RATES_HISTORY_SEED (monthly DGS10 values) to compute a short MA vs long MA.
 * Short MA = last 3 months average; Long MA = last 6 months average.
 *
 * Interpretation: falling rates (short < long) = equity tailwind = LONG signal.
 * Rising rates (short > long) = equity headwind = SHORT signal.
 *
 * @param {Array}  ratesHistory  Array of { y10: number, ... } objects (oldest first)
 * @returns {{ signal, conviction, meta }}
 */
function movingAverageCrossover(ratesHistory = []) {
  const valid = ratesHistory.filter(r => typeof r.y10 === "number");

  if (valid.length < 2) {
    return {
      signal:     "flat",
      conviction: 0,
      meta:       { dataPoints: valid.length, note: "Insufficient data for MA calculation (need ≥2 points)." },
    };
  }

  const last = Math.min(valid.length, 6);
  const longPeriod  = last;
  const shortPeriod = Math.min(3, last);

  const longSlice  = valid.slice(-longPeriod);
  const shortSlice = valid.slice(-shortPeriod);

  const longMA  = longSlice.reduce((s, r) => s + r.y10, 0)  / longSlice.length;
  const shortMA = shortSlice.reduce((s, r) => s + r.y10, 0) / shortSlice.length;

  const spread    = shortMA - longMA;        // negative = rates falling = LONG
  const absSpr    = Math.abs(spread);
  const conviction = Math.min(Math.round(absSpr * 200), 80); // scale: 0.4% spread → 80 conv

  let signal;
  if (spread < -0.05)      signal = "long";   // short MA meaningfully below long MA — rates falling
  else if (spread > 0.05)  signal = "short";  // short MA above long MA — rates rising
  else                     signal = "flat";

  return {
    signal,
    conviction: signal === "flat" ? 0 : conviction,
    meta: {
      shortMA:    +shortMA.toFixed(3),
      longMA:     +longMA.toFixed(3),
      spread:     +spread.toFixed(3),
      dataPoints: valid.length,
      note: `MA crossover using ${shortPeriod}m / ${longPeriod}m DGS10 averages. ` +
            `${valid.length < 6 ? "Limited history — " + valid.length + " months available." : "Full 6-month history."}`,
    },
  };
}

// ── 2. Momentum Breakout ──────────────────────────────────────────────────────
/**
 * Uses today's AMD 1-day price change (chg%) as a momentum signal.
 * Simple threshold: chg > +1.5% = momentum LONG; chg < -1.5% = momentum SHORT.
 *
 * Limitation: this is 1-day momentum only (no multi-day history available).
 * meta.note is explicit about this limitation.
 *
 * @param {object} watchlistPrices  { AMD: { price, chg }, NVDA: { price, chg }, ... }
 * @returns {{ signal, conviction, meta }}
 */
function momentumBreakout(watchlistPrices = {}) {
  const amdChg  = watchlistPrices.AMD?.chg;
  const nvdaChg = watchlistPrices.NVDA?.chg;

  if (amdChg == null) {
    return {
      signal:     "flat",
      conviction: 0,
      meta:       { dataPoints: 0, note: "AMD price change not available." },
    };
  }

  const sectorAvg = nvdaChg != null ? (amdChg + nvdaChg) / 2 : amdChg;
  const relMomentum = nvdaChg != null ? amdChg - nvdaChg : amdChg;

  let signal;
  if (amdChg > 1.5)       signal = "long";
  else if (amdChg < -1.5) signal = "short";
  else                     signal = "flat";

  const conviction = signal === "flat" ? 0 : Math.min(Math.round(Math.abs(amdChg) * 15), 75);

  return {
    signal,
    conviction,
    meta: {
      amdChg:       +amdChg.toFixed(2),
      nvdaChg:      nvdaChg != null ? +nvdaChg.toFixed(2) : null,
      sectorAvg:    +sectorAvg.toFixed(2),
      relMomentum:  +relMomentum.toFixed(2),
      dataPoints:   nvdaChg != null ? 2 : 1,
      note:         "1-day momentum only (no multi-day history). Based on watchlist chg% from most recent fetch.",
    },
  };
}

// ── 3. Mean Reversion Signal ──────────────────────────────────────────────────
/**
 * Computes a z-score of the current DGS10 vs the 6-month RATES_HISTORY mean/stdev.
 * z > +1.5 → rates abnormally high → LONG equities (rates to compress)
 * z < -1.5 → rates abnormally low  → SHORT equities (rates to rise)
 *
 * Equity interpretation: high rates → equity headwind; BUT we model mean reversion
 * of RATES → if rates are abnormally high and will compress, equities benefit.
 *
 * @param {{ dgs10, ... }}  currentRates
 * @param {Array}           ratesHistory   Array of { y10: number, ... }
 * @returns {{ signal, conviction, meta }}
 */
function meanReversionSignal(currentRates = {}, ratesHistory = []) {
  const current = currentRates.dgs10;
  if (current == null) {
    return {
      signal: "flat", conviction: 0,
      meta:   { dataPoints: 0, note: "DGS10 not available." },
    };
  }

  const valid = ratesHistory.filter(r => typeof r.y10 === "number").map(r => r.y10);
  if (valid.length < 3) {
    return {
      signal: "flat", conviction: 0,
      meta:   { dataPoints: valid.length, zScore: null, note: "Need ≥3 data points for z-score." },
    };
  }

  const mean   = valid.reduce((s, v) => s + v, 0) / valid.length;
  const variance = valid.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / valid.length;
  const stddev = Math.sqrt(variance);

  if (stddev === 0) {
    return {
      signal: "flat", conviction: 0,
      meta:   { dataPoints: valid.length, zScore: 0, mean, stddev: 0, note: "Zero variance — cannot compute z-score." },
    };
  }

  const zScore = (current - mean) / stddev;

  // Equity signal: rates ABOVE mean → will revert DOWN → LONG equities
  // Rates BELOW mean → will revert UP → SHORT equities (rates headwind incoming)
  let signal;
  if (zScore > 1.5)       signal = "long";  // rates high → compression → equity LONG
  else if (zScore < -1.5) signal = "short"; // rates low → rise → equity SHORT
  else                    signal = "flat";

  const conviction = signal === "flat" ? 0 : Math.min(Math.round(Math.abs(zScore) * 25), 80);

  return {
    signal,
    conviction,
    meta: {
      zScore:     +zScore.toFixed(2),
      current:    +current.toFixed(3),
      mean:       +mean.toFixed(3),
      stddev:     +stddev.toFixed(3),
      dataPoints: valid.length,
      note: `DGS10 z-score of ${zScore.toFixed(2)} vs ${valid.length}-month history. ` +
            `${Math.abs(zScore) >= 1.5 ? "Significant deviation — mean reversion expected." : "Within normal range."}`,
    },
  };
}

// ── Combined signal computation ───────────────────────────────────────────────

/**
 * Compute all three signals and return as a single signals object.
 * Used by ideaEngine.js to build the ctx.signals field.
 *
 * @param {object} currentRates     { dgs10, dfii10, t10yie, hy_spread, t10y2y }
 * @param {Array}  ratesHistory     RATES_HISTORY_SEED or cached equivalent
 * @param {object} watchlistPrices  { AMD: { price, chg }, ... }
 * @returns {{ maSignal, momentumSignal, reversionSignal, details }}
 */
function computeSignals(currentRates, ratesHistory, watchlistPrices) {
  const ma        = movingAverageCrossover(ratesHistory);
  const momentum  = momentumBreakout(watchlistPrices);
  const reversion = meanReversionSignal(currentRates, ratesHistory);

  return {
    maSignal:         ma.signal,
    maConviction:     ma.conviction,
    momentumSignal:   momentum.signal,
    momentumConviction: momentum.conviction,
    reversionSignal:  reversion.signal,
    reversionConviction: reversion.conviction,
    details: { ma, momentum, reversion },
  };
}

module.exports = {
  movingAverageCrossover,
  momentumBreakout,
  meanReversionSignal,
  computeSignals,
};
