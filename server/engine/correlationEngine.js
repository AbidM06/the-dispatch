/**
 * server/engine/correlationEngine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure computation engine for cross-asset correlation and backtesting.
 * No I/O, no API calls. Accepts pre-fetched FRED series data.
 *
 * Methodology (S&T Sales desk quality):
 *   1. Pearson correlation (full period + in/out-sample split)
 *   2. Rolling 12-month correlation (stability check)
 *   3. MA Crossover strategy: signal from series A → position in series B
 *      - In-sample (8yr): optimise fast/slow MA parameter pair by Sharpe
 *      - Out-of-sample (2yr): apply best params — NO re-optimisation
 *   4. Performance metrics: total return, annualised return, Sharpe,
 *      max drawdown, hit rate, number of signal changes
 *
 * Data split:
 *   In-sample:     Jan 2014 – Mar 2024  (≈ 123 monthly observations)
 *   Out-of-sample: Apr 2024 – present   (≈ 24+ monthly observations)
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

// ── Date split boundaries ─────────────────────────────────────────────────────
const IN_SAMPLE_END    = "2024-03-31";
const OUT_SAMPLE_START = "2024-04-01";

// ── Parameter grid for MA crossover optimisation (fast, slow months) ─────────
const PARAM_GRID = [
  [3, 9], [4, 12], [5, 15], [6, 18], [3, 12], [5, 20],
];

// ── Cross-asset pair definitions ───────────────────────────────────────────────
// direction: +1 = "driver up → target up", -1 = "driver up → target down"
const PAIRS_CONFIG = [
  {
    id:           "gold-real-yield",
    name:         "Gold vs 10Y Real Yield",
    driverSeries: "DFII10",
    targetSeries: "GOLDAMGBD228NLBM",
    direction:    -1,
    mechanism:    "Gold is a zero-yield asset — its opportunity cost rises in lock-step with real yields. When DFII10 rises, holding gold vs TIPS becomes less attractive, mechanically depressing the gold price. The relationship is strongest during rate-hiking cycles and tends to break down only during acute geopolitical stress (safe-haven override).",
    salesPoint:   "Real yields at 1.85% sit in the historically uncomfortable zone for gold. The model signals that further real yield compression — driven by a Fed pivot or flight-to-safety bid in Treasuries — is the primary catalyst for a gold re-rating. Cleanest single-asset expression of a dovish pivot trade for commodity macro clients.",
    clientRelevance: ["Hedge Fund (Global Macro)", "Asset Manager (Long-Only)", "Private Bank / Wealth Manager"],
  },
  {
    id:           "wti-eurusd",
    name:         "WTI Oil vs EUR/USD",
    driverSeries: "DEXUSEU",
    targetSeries: "DCOILWTICO",
    direction:    +1,
    mechanism:    "Oil is invoiced in USD globally. A weaker dollar (higher EUR/USD) makes oil cheaper for non-USD buyers, stimulating incremental demand and pushing USD-denominated prices higher. Secondary mechanism: petrodollar recycling. Oil exporters accumulate USD revenue and diversify into EUR assets, creating a bidirectional reinforcement — strong oil → EUR bid → oil self-reinforcing.",
    salesPoint:   "The USD/oil correlation is the cleanest expression of the petrodollar thesis. A structural USD weakening cycle — driven by US twin-deficit concerns or Fed rate cuts — would be a simultaneous long oil, long EM, short USD catalyst worth flagging to commodity and macro clients. Current EUR/USD at sub-1.10 with oil above $70 is a historical divergence worth monitoring.",
    clientRelevance: ["Hedge Fund (Global Macro)", "Insurance Company", "Pension Fund"],
  },
  {
    id:           "hy-vix",
    name:         "HY Credit Spreads vs VIX",
    driverSeries: "BAMLH0A0HYM2",
    targetSeries: "VIXCLS",
    direction:    +1,
    // The old text asserted a fixed 4–8 week lead of credit over equity vol, and
    // a "recent" widening to 3.17% (a March 2026 seed value) as current. Neither
    // was measured here. The lead/lag is what the correlation lab should TEST.
    mechanism:    "Hypothesis to test: HY spreads and equity volatility both respond to risk appetite and default risk, and some practitioners argue credit moves first. Whether a lead exists, and how long it is, is an empirical question for the lag analysis in this lab — no lead time is assumed.",
    salesPoint:   "Pitch framing: 'Is credit telling us something equity vol is not?' Support it with the measured correlation and lag from this lab and dated levels of HY OAS and VIX — not with a remembered rule of thumb.",
    clientRelevance: ["Hedge Fund (Global Macro)", "Asset Manager (Long-Only)", "Mutual Fund"],
  },
  {
    id:           "copper-breakeven",
    name:         "Copper vs 10Y Breakeven Inflation",
    driverSeries: "T10YIE",
    targetSeries: "PCOPPUSDM",
    direction:    +1,
    mechanism:    "Copper is the most economically sensitive industrial metal — 'Dr. Copper' as macro barometer. Breakeven inflation rises when markets price stronger economic activity and future prices. Both series are co-driven by the underlying growth and industrial cycle, making their correlation a genuine economic signal. The divergence between the two is a regime-change indicator: copper falling while breakevens hold signals supply-driven inflation (stagflationary), not demand-driven.",
    salesPoint:   "The copper-breakeven pair is a cycle-phase detector. When they decorrelate — copper dropping while breakevens remain elevated — it historically signals stagflationary dynamics rather than a healthy demand expansion. This is the exact setup worth flagging to commodities and multi-asset clients: inflation that is not accompanied by real activity tends to compress equity multiples while supporting real assets over nominal bonds.",
    clientRelevance: ["Hedge Fund (Global Macro)", "Pension Fund", "Asset Manager (Long-Only)"],
  },
  {
    id:           "dgs10-hy",
    name:         "10Y Yield vs HY Spreads",
    driverSeries: "DGS10",
    targetSeries: "BAMLH0A0HYM2",
    direction:    +1,
    mechanism:    "Rising nominal yields increase the debt service burden on leveraged borrowers, directly pressuring HY issuers' ability to refinance and service floating-rate obligations. The relationship is strongest during monetary tightening cycles (2022–2023 a prime example: DGS10 rose 300bps while HY OAS widened 200bps). At extremes it can invert: if yields rise because of strong growth, spreads may tighten as default risk falls — the relationship is thus regime-conditional.",
    salesPoint:   "The rate-credit transmission is the core fixed income sales narrative. Clients need to understand whether spread widening is systematic (driven by rate levels — structural) or idiosyncratic (driven by issuer-specific credit deterioration). A decomposition of their HY exposure by rate sensitivity vs. spread-only risk is a compelling conversation starter, particularly for insurance companies and pension funds with credit allocations.",
    clientRelevance: ["Insurance Company", "Pension Fund", "Asset Manager (Long-Only)"],
  },
];

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Data alignment
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Align two series by date (intersection only).
 * Returns { dates, a, b } — arrays of equal length.
 */
function alignSeries(dataA, dataB) {
  const mapB = new Map(dataB.map(o => [o.date, o.value]));
  const dates = [], a = [], b = [];
  for (const obs of dataA) {
    const bVal = mapB.get(obs.date);
    if (bVal !== undefined) {
      dates.push(obs.date);
      a.push(obs.value);
      b.push(bVal);
    }
  }
  return { dates, a, b };
}

/**
 * Split aligned arrays into in-sample and out-of-sample portions.
 */
function splitByDate(dates, a, b) {
  const boundary = OUT_SAMPLE_START;
  let splitIdx = dates.findIndex(d => d >= boundary);
  if (splitIdx === -1) splitIdx = dates.length; // all in-sample if not enough data

  return {
    inDates:  dates.slice(0, splitIdx),
    inA:      a.slice(0, splitIdx),
    inB:      b.slice(0, splitIdx),
    outDates: dates.slice(splitIdx),
    outA:     a.slice(splitIdx),
    outB:     b.slice(splitIdx),
  };
}

/**
 * Split aligned arrays using caller-supplied date boundaries (custom backtest).
 * isSampleEnd:   last date of in-sample window (inclusive)
 * oosSampleStart: first date of out-of-sample window (inclusive)
 * oosSampleEnd:  last date of OOS window (inclusive, null = present)
 */
function splitByCustomDates(dates, a, b, isSampleEnd, oosSampleStart, oosSampleEnd) {
  const splitEnd   = isSampleEnd   || IN_SAMPLE_END;
  const splitStart = oosSampleStart || OUT_SAMPLE_START;

  let isEndIdx = dates.findIndex(d => d > splitEnd);
  if (isEndIdx === -1) isEndIdx = dates.length;

  let oosStartIdx = dates.findIndex(d => d >= splitStart);
  if (oosStartIdx === -1) oosStartIdx = dates.length;

  let outDates = dates.slice(oosStartIdx);
  let outA     = a.slice(oosStartIdx);
  let outB     = b.slice(oosStartIdx);

  if (oosSampleEnd) {
    const endIdx = outDates.findIndex(d => d > oosSampleEnd);
    if (endIdx !== -1) {
      outDates = outDates.slice(0, endIdx);
      outA     = outA.slice(0, endIdx);
      outB     = outB.slice(0, endIdx);
    }
  }

  return {
    inDates:  dates.slice(0, isEndIdx),
    inA:      a.slice(0, isEndIdx),
    inB:      b.slice(0, isEndIdx),
    outDates, outA, outB,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Pearson correlation
// ═════════════════════════════════════════════════════════════════════════════

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

/**
 * Pearson correlation coefficient. Returns null if insufficient data or zero variance.
 */
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3 || n !== ys.length) return null;
  const mX = mean(xs), mY = mean(ys);
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mX, dy = ys[i] - mY;
    num  += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  if (den === 0) return null;
  return Math.round(num / den * 1000) / 1000; // 3 decimal places
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Rolling correlation
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Rolling Pearson correlation with a sliding window (default 12 months).
 * Returns [{ date, r }] — one entry per month once window is filled.
 */
function rollingCorrelation(dates, a, b, window = 12) {
  const result = [];
  for (let i = window - 1; i < a.length; i++) {
    const sliceA = a.slice(i - window + 1, i + 1);
    const sliceB = b.slice(i - window + 1, i + 1);
    const r = pearson(sliceA, sliceB);
    if (r !== null) {
      result.push({ date: dates[i], r });
    }
  }
  return result;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — MA Crossover strategy
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Moving average of last `n` values ending at index `i`.
 */
function ma(arr, i, n) {
  if (i < n - 1) return null;
  let s = 0;
  for (let j = i - n + 1; j <= i; j++) s += arr[j];
  return s / n;
}

/**
 * Generate MA crossover signals from a driver series.
 *
 * direction: +1 = "driver up → target up (go long)"
 *            -1 = "driver up → target down (go long when driver falls)"
 *
 * Signal logic:
 *   fastMA > slowMA → driver is rising → signal = direction * (+1)
 *   fastMA < slowMA → driver is falling → signal = direction * (-1)
 *
 * Returns [{ date, signal: 1|-1, fastMA, slowMA }] from index (slow-1) onward.
 */
function maSignals(dates, driver, fast, slow, direction) {
  const signals = [];
  for (let i = slow - 1; i < driver.length; i++) {
    const f = ma(driver, i, fast);
    const s = ma(driver, i, slow);
    if (f === null || s === null) continue;
    const rawSignal = f > s ? 1 : -1;
    signals.push({
      date:    dates[i],
      signal:  direction * rawSignal,
      fastMA:  Math.round(f * 1000) / 1000,
      slowMA:  Math.round(s * 1000) / 1000,
    });
  }
  return signals;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4b — Z-Score mean reversion signals
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Generate signals from a rolling z-score of the driver series.
 *
 * Mean-reversion logic:
 *   z > +threshold → driver overbought → will revert DOWN
 *     If direction = +1 (driver up → target up):  target will also revert → go SHORT target (sig = -1)
 *     If direction = -1 (driver up → target down): target will revert UP  → go LONG target  (sig = +1)
 *   z < -threshold → driver oversold  → will revert UP
 *     Opposite of above.
 *
 * Holds last signal until a new threshold is crossed — avoids constant churning.
 * Returns [{ date, signal: 1|-1|0, z }]
 */
function zscoreSignals(dates, driver, zWindow = 12, threshold = 1.5, direction) {
  const result = [];
  let currentSig = 0; // start flat until first threshold crossing

  for (let i = zWindow - 1; i < driver.length; i++) {
    const slice = driver.slice(i - zWindow + 1, i + 1);
    const m  = mean(slice);
    const sd = stddev(slice);
    const z  = sd > 0 ? (driver[i] - m) / sd : 0;

    if (sd > 0) {
      // Overbought driver → bet on reversion → take position against direction
      if (z >  threshold) currentSig = -direction;
      // Oversold driver → bet on reversion upward → take position with direction
      if (z < -threshold) currentSig =  direction;
    }
    result.push({ date: dates[i], signal: currentSig, z: Math.round(z * 100) / 100 });
  }
  return result;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — Backtest performance metrics
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Compute monthly returns from a price/level series.
 * Returns [{ date, ret }] from index 1 onward.
 */
function monthlyReturns(dates, values) {
  const rets = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] === 0) continue;
    rets.push({ date: dates[i], ret: (values[i] - values[i - 1]) / values[i - 1] });
  }
  return rets;
}

/**
 * Compute backtest metrics from strategy returns.
 * signal[t] is applied to return[t+1] (no lookahead).
 * riskFreeMonthly: monthly risk-free rate for Sharpe (default 4.5% annual / 12).
 */
function computeMetrics(targetDates, targetValues, signalArr) {
  if (!signalArr.length || targetValues.length < 2) {
    return { totalReturn: null, annReturn: null, sharpe: null, maxDD: null, hitRate: null, signals: 0, equityCurve: [] };
  }

  // Build a date→signal map
  const sigMap = new Map(signalArr.map(s => [s.date, s.signal]));

  // Align signals to target returns (signal from month T applies to return at T+1)
  const rets    = monthlyReturns(targetDates, targetValues);
  const stratR  = [];
  const bhR     = [];
  let   prevSig = 1; // default long if no signal yet

  for (const { date, ret } of rets) {
    // Signal from the previous month (applied to this month's return)
    const prevMonthDate = targetDates[targetDates.indexOf(date) - 1];
    if (prevMonthDate && sigMap.has(prevMonthDate)) {
      prevSig = sigMap.get(prevMonthDate);
    }
    if (sigMap.has(date)) prevSig = sigMap.get(date); // fallback: same-month signal
    stratR.push(prevSig * ret);
    bhR.push(ret);
  }

  if (!stratR.length) {
    return { totalReturn: null, annReturn: null, sharpe: null, maxDD: null, hitRate: null, signals: 0, equityCurve: [] };
  }

  // Equity curves (cumulative)
  let stratEq = 1, bhEq = 1;
  const equityCurve = [];
  for (let i = 0; i < stratR.length; i++) {
    stratEq *= (1 + stratR[i]);
    bhEq    *= (1 + bhR[i]);
    equityCurve.push({
      date:     rets[i].date,
      strategy: Math.round(stratEq * 1000) / 1000,
      buyHold:  Math.round(bhEq * 1000) / 1000,
    });
  }

  // Total + annualised return
  const totalReturn = stratEq - 1;
  const n           = stratR.length;
  const annReturn   = (1 + totalReturn) ** (12 / n) - 1;

  // Sharpe (annualised) — monthly risk-free ≈ 4.5% / 12 = 0.00375
  const rfMonthly = 0.045 / 12;
  const excessR   = stratR.map(r => r - rfMonthly);
  const meanEx    = mean(excessR);
  const sdEx      = stddev(excessR);
  const sharpe    = sdEx === 0 ? null : Math.round((meanEx / sdEx * Math.sqrt(12)) * 100) / 100;

  // Max drawdown
  let peak = 1, curEq = 1, maxDD = 0;
  for (const r of stratR) {
    curEq *= (1 + r);
    if (curEq > peak) peak = curEq;
    const dd = (curEq - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }

  // Hit rate: fraction of periods where signal direction matched return direction
  const hits = stratR.filter(r => r > 0).length;
  const hitRate = Math.round(hits / n * 1000) / 10; // as %

  // Signal changes (number of trades)
  const signalChanges = signalArr.reduce((cnt, s, i) => {
    if (i === 0) return 0;
    return cnt + (s.signal !== signalArr[i - 1].signal ? 1 : 0);
  }, 0);

  return {
    totalReturn: Math.round(totalReturn * 1000) / 10,     // %
    annReturn:   Math.round(annReturn * 1000) / 10,       // %
    sharpe,
    maxDD:       Math.round(maxDD * 1000) / 10,           // %
    hitRate,
    signals:     signalChanges,
    equityCurve,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — Parameter grid optimisation (in-sample only)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Test all (fast, slow) pairs on in-sample data.
 * Returns { bestParams: { fast, slow }, paramGrid: [...all results] }.
 * Selects by highest Sharpe ratio.
 */
function optimizeParams(inDates, inDriver, inTarget, direction) {
  const results = [];

  for (const [fast, slow] of PARAM_GRID) {
    const sigs    = maSignals(inDates, inDriver, fast, slow, direction);
    const metrics = computeMetrics(inDates, inTarget, sigs);
    results.push({
      fast, slow,
      sharpe:      metrics.sharpe,
      totalReturn: metrics.totalReturn,
      hitRate:     metrics.hitRate,
      signals:     metrics.signals,
    });
  }

  // Best by Sharpe; fall back to total return if Sharpe is null
  const best = results.reduce((b, r) => {
    const bScore = b.sharpe ?? b.totalReturn ?? -Infinity;
    const rScore = r.sharpe ?? r.totalReturn ?? -Infinity;
    return rScore > bScore ? r : b;
  });

  return { bestParams: { fast: best.fast, slow: best.slow }, paramGrid: results };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — Full pair backtest
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Run the complete backtest for one pair.
 * seriesMap: Map<id, [{date, value}]>
 */
function runPairBacktest(pairConfig, seriesMap) {
  const { id, name, driverSeries, targetSeries, direction, mechanism, salesPoint, clientRelevance } = pairConfig;

  const driverData = seriesMap.get(driverSeries);
  const targetData = seriesMap.get(targetSeries);

  if (!driverData?.length || !targetData?.length) {
    return {
      id, name, mechanism, salesPoint, clientRelevance,
      error:                `Missing series data (${!driverData?.length ? driverSeries : targetSeries})`,
      fullCorrelation:      null,
      inSampleCorrelation:  null,
      outSampleCorrelation: null,
      rollingCorrelation:   [],
      backtest:             null,
      currentSignal:        0,
    };
  }

  // Align
  const { dates, a: driver, b: target } = alignSeries(driverData, targetData);
  if (dates.length < 24) {
    return {
      id, name, mechanism, salesPoint, clientRelevance,
      error:                `Insufficient aligned data (${dates.length} months)`,
      fullCorrelation:      null,
      inSampleCorrelation:  null,
      outSampleCorrelation: null,
      rollingCorrelation:   [],
      backtest:             null,
      currentSignal:        0,
    };
  }

  const { inDates, inA: inDriver, inB: inTarget, outDates, outA: outDriver, outB: outTarget } = splitByDate(dates, driver, target);

  // Pearson correlations (driver = seriesA, target = seriesB)
  const fullCorrelation      = pearson(driver, target);
  const inSampleCorrelation  = inDates.length >= 3 ? pearson(inDriver, inTarget) : null;
  const outSampleCorrelation = outDates.length >= 3 ? pearson(outDriver, outTarget) : null;

  // Rolling correlation (full series)
  const rolling = rollingCorrelation(dates, driver, target, 12);

  // Optimise parameters on in-sample data
  const { bestParams, paramGrid } = optimizeParams(inDates, inDriver, inTarget, direction);
  const { fast, slow } = bestParams;

  // In-sample metrics (with optimised params)
  const inSigs    = maSignals(inDates, inDriver, fast, slow, direction);
  const inMetrics = computeMetrics(inDates, inTarget, inSigs);

  // Out-of-sample metrics (NO re-optimisation — strict walk-forward)
  let outMetrics = { totalReturn: null, annReturn: null, sharpe: null, maxDD: null, hitRate: null, signals: 0, equityCurve: [] };
  if (outDates.length >= slow + 2) {
    // Seed the MA computation with the tail of in-sample data to avoid cold-start
    const seedLen   = slow;
    const seedD     = [...inDriver.slice(-seedLen), ...outDriver];
    const seedDates = [...inDates.slice(-seedLen), ...outDates];
    const allSigs   = maSignals(seedDates, seedD, fast, slow, direction);
    // Keep only signals that fall in the out-of-sample period
    const outSigs   = allSigs.filter(s => s.date >= OUT_SAMPLE_START);
    outMetrics      = computeMetrics(outDates, outTarget, outSigs);
  }

  // Combined equity curve: stitch in-sample + out-of-sample
  // Renormalize out-sample curve to start at in-sample final value
  const inFinal   = inMetrics.equityCurve.slice(-1)[0]?.strategy ?? 1;
  const combinedCurve = [
    ...inMetrics.equityCurve.map(p => ({ ...p, phase: "in-sample" })),
    ...outMetrics.equityCurve.map(p => ({
      date:     p.date,
      strategy: Math.round(inFinal * p.strategy * 1000) / 1000,
      buyHold:  p.buyHold,
      phase:    "out-of-sample",
    })),
  ];

  // Current signal: use the last `slow` months of data
  const recentDates  = dates.slice(-slow - fast);
  const recentDriver = driver.slice(-slow - fast);
  const recentSigs   = maSignals(recentDates, recentDriver, fast, slow, direction);
  const currentSignal = recentSigs.length > 0 ? recentSigs[recentSigs.length - 1].signal : 0;

  return {
    id, name, mechanism, salesPoint, clientRelevance,
    error:                null,
    driverSeries, targetSeries,
    fullCorrelation,
    inSampleCorrelation,
    outSampleCorrelation,
    rollingCorrelation:   rolling,
    seriesA: { id: driverSeries, data: driverData.slice(-60) },  // last 5 years for charts
    seriesB: { id: targetSeries, data: targetData.slice(-60) },
    backtest: {
      bestParams,
      paramGrid,
      inSample:   { ...inMetrics, n: inDates.length },
      outSample:  { ...outMetrics, n: outDates.length },
      equityCurve: combinedCurve.slice(-120), // last 10 years max
    },
    currentSignal,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — Correlation matrix
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Build NxN Pearson correlation matrix for all series.
 * Returns { series: [{ id, name }], values: number[][] }.
 */
function buildCorrelationMatrix(allSeries) {
  const valid = allSeries.filter(s => s.data && s.data.length >= 12);
  const n     = valid.length;
  const names = valid.map(s => ({ id: s.id, name: s.name, color: s.color }));

  const values = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => {
      if (i === j) return 1.0;
      const { a, b } = alignSeries(valid[i].data, valid[j].data);
      return pearson(a, b);
    })
  );

  return { series: names, values };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9 — Macro regime classifier
// ═════════════════════════════════════════════════════════════════════════════

function getCurrentRegime(allSeries) {
  const get = (id) => {
    const s = allSeries.find(x => x.id === id);
    if (!s?.data?.length) return null;
    return s.data[s.data.length - 1]?.value ?? null;
  };

  const dgs10    = get("DGS10");
  const dfii10   = get("DFII10");
  const hy_spread = get("BAMLH0A0HYM2");
  const t10y_ie  = get("T10YIE");
  const eurusd   = get("DEXUSEU");
  const vix      = get("VIXCLS");

  const parts = [];
  if (dgs10 !== null)    parts.push(`10Y ${dgs10}%`);
  if (dfii10 !== null)   parts.push(`real yield ${dfii10}%`);
  if (hy_spread !== null) parts.push(`HY OAS ${hy_spread}%`);
  if (t10y_ie !== null)  parts.push(`BEI ${t10y_ie}%`);
  if (vix !== null)      parts.push(`VIX ${vix}`);

  const riskOff    = hy_spread !== null && hy_spread > 3.5;
  const highReal   = dfii10 !== null && dfii10 > 1.8;
  const highBEI    = t10y_ie !== null && t10y_ie > 2.4;

  let label = "Uncertain";
  // Was "Bear Flattener / Risk-Off": a curve direction named from a credit
  // spread and a real-yield level, neither of which is a curve movement.
  if (riskOff && highReal)   label = "Wide Credit + High Real Yields";
  else if (riskOff)           label = "Credit Stress / Risk-Off";
  else if (highReal && highBEI) label = "Stagflationary Pressure";
  else if (highReal)          label = "Higher-For-Longer";
  else if (!riskOff && !highReal) label = "Goldilocks / Risk-On";

  return { label, metrics: { dgs10, dfii10, hy_spread, t10y_ie, eurusd, vix } };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9b — Custom backtest runner
// ═════════════════════════════════════════════════════════════════════════════

/**
 * runCustomBacktest — user-configurable backtest.
 *
 * config keys:
 *   driverSeriesId, targetSeriesId — FRED series IDs (must exist in seriesMap)
 *   direction        — +1 or -1
 *   strategy         — "ma-crossover" | "zscore-reversion"
 *   isSampleStart    — ISO date string, default "2014-01-01"
 *   isSampleEnd      — ISO date string, default IN_SAMPLE_END
 *   oosSampleStart   — ISO date string, default OUT_SAMPLE_START
 *   oosSampleEnd     — ISO date string | null (null = present)
 *   maFast, maSlow   — explicit MA params (null = auto-optimize by Sharpe)
 *   zscoreWindow     — rolling z-score lookback in months (default 12)
 *   zscoreThreshold  — z-score threshold to trigger a signal (default 1.5)
 *   name             — friendly label for display
 *
 * seriesMap: Map<seriesId, [{date, value}]>
 */
function runCustomBacktest(config, seriesMap) {
  const {
    driverSeriesId,
    targetSeriesId,
    direction       = 1,
    strategy        = "ma-crossover",
    isSampleStart   = "2014-01-01",
    isSampleEnd     = IN_SAMPLE_END,
    oosSampleStart  = OUT_SAMPLE_START,
    oosSampleEnd    = null,
    maFast          = null,
    maSlow          = null,
    zscoreWindow    = 12,
    zscoreThreshold = 1.5,
    name            = `${driverSeriesId} → ${targetSeriesId}`,
  } = config;

  const driverData = seriesMap.get(driverSeriesId);
  const targetData = seriesMap.get(targetSeriesId);

  if (!driverData?.length || !targetData?.length) {
    return {
      id: "custom", name, driverSeriesId, targetSeriesId, direction, strategy,
      error: `Missing series data (${!driverData?.length ? driverSeriesId : targetSeriesId})`,
      fullCorrelation: null, inSampleCorrelation: null, outSampleCorrelation: null,
      rollingCorrelation: [], backtest: null, currentSignal: 0,
    };
  }

  // Align and filter to history start
  const { dates: allDates, a: allDriver, b: allTarget } = alignSeries(driverData, targetData);
  const histStart = isSampleStart || "2014-01-01";
  const startIdx  = allDates.findIndex(d => d >= histStart);
  const dates  = startIdx > 0 ? allDates.slice(startIdx)  : allDates;
  const driver = startIdx > 0 ? allDriver.slice(startIdx) : allDriver;
  const target = startIdx > 0 ? allTarget.slice(startIdx) : allTarget;

  if (dates.length < 24) {
    return {
      id: "custom", name, driverSeriesId, targetSeriesId, direction, strategy,
      error: `Insufficient aligned data for chosen window (${dates.length} months — need ≥ 24)`,
      fullCorrelation: null, inSampleCorrelation: null, outSampleCorrelation: null,
      rollingCorrelation: [], backtest: null, currentSignal: 0,
    };
  }

  // IS/OOS split with custom boundaries
  const { inDates, inA: inDriver, inB: inTarget, outDates, outA: outDriver, outB: outTarget } =
    splitByCustomDates(dates, driver, target, isSampleEnd, oosSampleStart, oosSampleEnd);

  // Pearson correlations
  const fullCorrelation      = pearson(driver, target);
  const inSampleCorrelation  = inDates.length >= 3 ? pearson(inDriver, inTarget) : null;
  const outSampleCorrelation = outDates.length >= 3 ? pearson(outDriver, outTarget) : null;

  // Rolling 12m correlation (full window)
  const rolling = rollingCorrelation(dates, driver, target, 12);

  const EMPTY_METRICS = { totalReturn: null, annReturn: null, sharpe: null, maxDD: null, hitRate: null, signals: 0, equityCurve: [] };
  let inMetrics  = EMPTY_METRICS;
  let outMetrics = EMPTY_METRICS;
  let bestParams = {};
  let paramGrid  = null;
  let currentSignal = 0;

  if (strategy === "zscore-reversion") {
    // ── Z-Score Mean Reversion ─────────────────────────────────────────────
    const allSigs  = zscoreSignals(dates, driver, zscoreWindow, zscoreThreshold, direction);
    const inSigs   = allSigs.filter(s => s.date <= isSampleEnd);
    const outSigs  = allSigs.filter(s => s.date >= oosSampleStart && (!oosSampleEnd || s.date <= oosSampleEnd));

    inMetrics  = inDates.length  >= 3 ? computeMetrics(inDates,  inTarget,  inSigs)  : EMPTY_METRICS;
    outMetrics = outDates.length >= 3 ? computeMetrics(outDates, outTarget, outSigs) : EMPTY_METRICS;
    bestParams = { zscoreWindow, zscoreThreshold };
    currentSignal = allSigs.length > 0 ? allSigs[allSigs.length - 1].signal : 0;

  } else {
    // ── MA Crossover — auto-optimize or use provided params ────────────────
    let fast, slow;
    if (maFast && maSlow) {
      fast = maFast; slow = maSlow;
    } else if (inDates.length >= 20) {
      const opt = optimizeParams(inDates, inDriver, inTarget, direction);
      fast = opt.bestParams.fast; slow = opt.bestParams.slow;
      paramGrid = opt.paramGrid;
    } else {
      fast = 3; slow = 9; // fallback for short windows
      console.warn(`[correlationEngine] runCustomBacktest: IS window too short for optimisation (${inDates.length} obs); falling back to fast=3/slow=9`);
    }
    bestParams = { fast, slow };

    const inSigs = maSignals(inDates, inDriver, fast, slow, direction);
    inMetrics    = computeMetrics(inDates, inTarget, inSigs);

    if (outDates.length >= slow + 2) {
      // Seed OOS with IS tail to avoid MA cold-start
      const seedLen   = slow;
      const seedD     = [...inDriver.slice(-seedLen), ...outDriver];
      const seedDates = [...inDates.slice(-seedLen), ...outDates];
      const allSigs   = maSignals(seedDates, seedD, fast, slow, direction);
      const outSigs   = allSigs.filter(s => s.date >= oosSampleStart && (!oosSampleEnd || s.date <= oosSampleEnd));
      outMetrics      = computeMetrics(outDates, outTarget, outSigs);
    }

    // Current live signal
    const recentDates  = dates.slice(-slow - fast);
    const recentDriver = driver.slice(-slow - fast);
    const recentSigs   = maSignals(recentDates, recentDriver, fast, slow, direction);
    currentSignal = recentSigs.length > 0 ? recentSigs[recentSigs.length - 1].signal : 0;
  }

  // Combined equity curve (IS then OOS, renormalised to continue from IS terminal value)
  const inFinal = inMetrics.equityCurve.slice(-1)[0]?.strategy ?? 1;
  const combinedCurve = [
    ...inMetrics.equityCurve.map(p => ({ ...p, phase: "in-sample" })),
    ...outMetrics.equityCurve.map(p => ({
      date:     p.date,
      strategy: Math.round(inFinal * p.strategy * 1000) / 1000,
      buyHold:  p.buyHold,
      phase:    "out-of-sample",
    })),
  ];

  return {
    id:   "custom",
    name,
    driverSeriesId,
    targetSeriesId,
    direction,
    strategy,
    error:                null,
    fullCorrelation,
    inSampleCorrelation,
    outSampleCorrelation,
    rollingCorrelation:   rolling,
    seriesA: { id: driverSeriesId, data: driverData.slice(-60) },
    seriesB: { id: targetSeriesId, data: targetData.slice(-60) },
    config:  { isSampleStart, isSampleEnd, oosSampleStart, oosSampleEnd, strategy, ...bestParams },
    backtest: {
      bestParams,
      paramGrid,
      inSample:  { ...inMetrics,  n: inDates.length  },
      outSample: { ...outMetrics, n: outDates.length },
      equityCurve: combinedCurve.slice(-120),
    },
    currentSignal,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 10 — Top-level orchestrator
// ═════════════════════════════════════════════════════════════════════════════

/**
 * runFullAnalysis — main entry point.
 * allSeries: array of { id, name, color, data: [{date, value}] }
 * Returns the full correlation + backtest result.
 */
function runFullAnalysis(allSeries) {
  // Build a fast lookup map
  const seriesMap = new Map(allSeries.map(s => [s.id, s.data]));

  // Correlation matrix across all series with data
  const matrix = buildCorrelationMatrix(allSeries);

  // Per-pair backtest
  const pairs = PAIRS_CONFIG.map(p => runPairBacktest(p, seriesMap));

  // Current regime
  const regime = getCurrentRegime(allSeries);

  // Data quality summary
  const dataSummary = allSeries.map(s => ({
    id:         s.id,
    name:       s.name,
    points:     s.data?.length ?? 0,
    firstDate:  s.data?.[0]?.date ?? null,
    lastDate:   s.data?.slice(-1)[0]?.date ?? null,
    error:      s.error ?? null,
  }));

  return {
    matrix,
    pairs,
    regime,
    dataSummary,
    methodology: {
      inSampleWindow:    `Jan 2014 – Mar 2024 (8 years)`,
      outSampleWindow:   `Apr 2024 – present (walk-forward, no re-optimisation)`,
      correlationMethod: "Pearson r (full period + rolling 12-month window)",
      signalMethod:      "MA crossover on driver series → position in correlated asset",
      paramOptimisation: "Grid search: (fast, slow) ∈ {(3,9),(4,12),(5,15),(6,18),(3,12),(5,20)} — maximise in-sample Sharpe",
      sharpeBase:        "Risk-free rate: 4.5% p.a. annualised monthly",
      dataSource:        "FRED (Federal Reserve Bank of St. Louis) — monthly observations",
    },
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  runFullAnalysis,
  runCustomBacktest,
  getCurrentRegime,
  // Exported for testing / custom routes
  pearson,
  rollingCorrelation,
  alignSeries,
  maSignals,
  zscoreSignals,
  computeMetrics,
  buildCorrelationMatrix,
  PAIRS_CONFIG,
};
