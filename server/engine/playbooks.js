/**
 * server/engine/playbooks.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 13 deterministic trade playbooks for the Idea Engine.
 *
 * Rules every template follows:
 *  - Levels (entry/stop/target) come from a SOURCED price with its date, or
 *    they are null. There are no fallback prices.
 *  - A rate LEVEL is never described as a movement (steepening, widening) or
 *    as an event (a CPI surprise, a Fed decision).
 *  - Claims about how assets behave (betas, lead times, historical episodes,
 *    per-cut valuation effects) are either removed or labelled assumptions.
 * Pure functions — no I/O, no API calls.
 *
 * Each playbook exposes:
 *   id          — kebab-case slug
 *   name        — human label
 *   category    — "macro" | "structure" | "portfolio"
 *   description — learning explainer (shown in /api/ideas/playbooks)
 *   trigger(ctx)  — returns bool: fires when market conditions are met
 *   template(ctx) — returns partial EngineTicket fields
 *   invalidation  — string: what would negate the thesis
 *   riskNotes     — string: key risk considerations
 *   requiredData  — string[]: data series this playbook depends on
 *
 * ctx shape (passed by ideaEngine.js):
 * {
 *   rates:     { dgs10, dfii10, t10yie, hy_spread, t10y2y }   scalars
 *   deltas:    { dgs10_d, dfii10_d, t10yie_d, hy_spread_d, t10y2y_d, windows }
 *              Δbp over the dated FRED history window; null when unavailable
 *   portfolio: { rows, totalGBP, weights:{ticker:%}, hhi, usdPct }
 *   watchlist: { AMD:{price,chg}, NVDA:{price,chg}, ... }
 *   regime:    string
 *   signals:   { maSignal, momentumSignal, reversionSignal }
 *   today:     Date
 * }
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

// ── Helpers ───────────────────────────────────────────────────────────────────

function w(ctx, ticker) {
  return (ctx.portfolio.weights[ticker] ?? 0) * 100;
}

// LSE-listed holdings are GBP; US watchlist names are USD. The old templates
// printed AMD's USD price with a £ sign.
const CCY = { AMD: "USD", NVDA: "USD", MSFT: "USD", TSLA: "USD", MU: "USD", AMAT: "USD", LRCX: "USD",
              SGLN: "GBP", HIES: "GBP", HIUS: "GBP", HIJS: "GBP", HBKS: "GBP" };
const SYM = { USD: "$", GBP: "£" };

/**
 * priceOf — the latest SOURCED price for a ticker, with its date, or null.
 *
 * Every template used to call `priceFmt(ctx, "SGLN", 74.00)`: the fallback
 * price was used whenever the ticker had no feed — which, for the LSE ETFs,
 * was always. Entry, stop and target were therefore percentages of a number
 * typed into this file, and they flowed into sizing. There is no fallback now.
 */
function priceOf(ctx, ticker) {
  const q = ctx.watchlist?.[ticker];
  if (q && Number.isFinite(q.price)) {
    return { price: q.price, date: q.date || null, source: q.source || null, currency: CCY[ticker] || "USD",
             priceType: "daily close (not an executable quote)" };
  }
  const row = (ctx.portfolio?.rows || []).find(r => r.ticker === ticker);
  const p = row && (Number.isFinite(row.priceGBP) ? row.priceGBP : Number.isFinite(row.priceUSD) ? row.priceUSD : null);
  if (Number.isFinite(p)) {
    return { price: p, date: row.date || null, source: row.source || "portfolio snapshot",
             currency: Number.isFinite(row.priceGBP) ? "GBP" : "USD", priceType: "portfolio snapshot price" };
  }
  return null;
}

/**
 * plan — entry/stop/target from a sourced price and percentage rules.
 * Unpriced: levels are null and the text states the rule instead of a number.
 */
function plan(ctx, ticker, stopPct, targetPct) {
  const q = priceOf(ctx, ticker);
  const ccy = q?.currency || CCY[ticker] || "USD";
  const sym = SYM[ccy] || "";
  if (!q) {
    return {
      entry: null, stop: null, target: null, priced: false,
      priceBasis: { available: false, reason: `No price feed for ${ticker}${CCY[ticker] === "GBP" ? " (LSE-listed; no free source configured)" : ""}.` },
      entryText:  `No sourced price for ${ticker} — entry level not computed.`,
      stopText:   `Rule: stop ${stopPct}% below entry (level not computed — no price).`,
      targetText: `Rule: target ${targetPct}% above entry (level not computed — no price).`,
      rr:         (targetPct / stopPct).toFixed(1),
    };
  }
  const entry  = +q.price.toFixed(4);
  const stop   = +(entry * (1 - stopPct / 100)).toFixed(4);
  const target = +(entry * (1 + targetPct / 100)).toFixed(4);
  return {
    entry, stop, target, priced: true,
    priceBasis: { available: true, price: q.price, currency: ccy, date: q.date, source: q.source, priceType: q.priceType },
    entryText:  `Reference price ${sym}${entry.toFixed(2)} (${q.source || "source n/a"}, ${q.priceType}, ${q.date || "date n/a"}).`,
    stopText:   `Stop ${sym}${stop.toFixed(2)} (${stopPct}% below reference).`,
    targetText: `Target ${sym}${target.toFixed(2)} (${targetPct}% above reference).`,
    rr:         ((target - entry) / (entry - stop)).toFixed(1),
  };
}

const f2 = v => Number(v).toFixed(2);
const bp = v => Math.round(Number(v) * 100);
const fin = v => Number.isFinite(v);

/**
 * CONTESTED_INSTRUMENTS — tickers whose identity or asset class is asserted
 * inconsistently in this repository; no playbook may generate ideas in them.
 *
 * HBKS: shariahFilter.js catalogues it as "iShares MSCI UK Islamic UCITS ETF"
 * (an EQUITY index name), while two playbooks, the learning layer and the
 * glossary described the same ticker as a sukuk/duration ETF with a beta of
 * 0.62 and a ~3-year duration. None of those figures had a source, and the
 * ticker collides across venues. External lookup is unavailable here, so every
 * HBKS idea is held and the asset-class claims are removed until the fund is
 * identified by ISIN from its factsheet.
 */
const CONTESTED_INSTRUMENTS = {
  HBKS: "Identity unverified: catalogued as an MSCI UK Islamic (equity) ETF but previously described elsewhere as a sukuk/duration fund. Verify by ISIN against the issuer factsheet before re-enabling.",
};

function isContested(ticker) {
  return Object.prototype.hasOwnProperty.call(CONTESTED_INSTRUMENTS, ticker);
}

const HEURISTIC = "Trigger thresholds are this app's heuristics, not estimated relationships.";

// ── Macro Playbooks (7) ───────────────────────────────────────────────────────

const hotCPI = {
  id:          "hot-cpi",
  name:        "High Breakeven Inflation",
  category:    "macro",
  // The name used to promise a "Hot CPI" playbook that detected "above-consensus
  // inflation". It reads a BREAKEVEN — market-implied inflation compensation
  // over ten years — and has no CPI release or consensus input at all.
  description: "Fires when 10-year breakeven inflation (T10YIE) is above 2.5%. A breakeven is the " +
               "nominal–TIPS yield gap: market-implied average inflation over ten years plus risk " +
               "premia. It is not a CPI print and says nothing about a surprise versus consensus. " +
               "Expression: gold (SGLN), on the assumption that it hedges inflation — an assumption, " +
               "not an estimated relationship. " + HEURISTIC,
  invalidation: "T10YIE falls back below 2.2%; real yields rise sharply (gold has no yield).",
  riskNotes:    "Gold is already held (SGLN). Avoid over-concentration above 25% weight.",
  requiredData: ["T10YIE", "SGLN price"],

  trigger(ctx) {
    return fin(ctx.rates.t10yie) && ctx.rates.t10yie > 2.5;
  },

  template(ctx) {
    const p = plan(ctx, "SGLN", 5, 11);
    return {
      ticker: "SGLN", direction: "LONG", horizon: "3 months", confidence: 62, sizePct: 3,
      entry: p.entry, stop: p.stop, target: p.target, priceBasis: p.priceBasis,
      entryLogic:   `${p.entryText} Trigger: 10Y breakeven ${f2(ctx.rates.t10yie)}% (T10YIE, ${ctx.ratesAsOf?.t10yie || "date n/a"}) above 2.5%.`,
      stopLogic:    p.stopText,
      targetLogic:  `${p.targetText} Reward/risk by construction ≈ ${p.rr}×.`,
      sizingRule:   `3% allocation. Total SGLN (current ${w(ctx,'SGLN').toFixed(1)}% + new 3%) must stay below 25%.`,
      rationale:    `10Y breakeven ${f2(ctx.rates.t10yie)}% is above this app's 2.5% threshold. That is a level of market-implied inflation compensation, not evidence of a CPI surprise. Gold is used here as an assumed inflation hedge.`,
      expectedDrivers: ["Breakeven inflation above 2.5%", "Assumed gold inflation-hedge behaviour"],
      requiredDataFreshness: "T10YIE daily (FRED); SGLN price — no free feed",
    };
  },
};

const softCPI = {
  id:          "soft-cpi",
  name:        "Low Breakeven + Tight Credit",
  category:    "macro",
  description: "Fires when 10-year breakeven inflation is below 2.0% AND HY OAS is below 3.0%. " +
               "Both are levels; neither is a CPI release. The view expressed is that lower " +
               "inflation compensation and tight credit are a supportive backdrop for rate-sensitive " +
               "growth equity (AMD). " + HEURISTIC,
  invalidation: "Breakeven back above 2.3%; HY OAS above 3.5%.",
  riskNotes:    "Single-stock, high-volatility expression. Keep AMD total weight below 20%.",
  requiredData: ["T10YIE", "BAMLH0A0HYM2", "AMD price"],

  trigger(ctx) {
    return fin(ctx.rates.t10yie) && fin(ctx.rates.hy_spread) && ctx.rates.t10yie < 2.0 && ctx.rates.hy_spread < 3.0;
  },

  template(ctx) {
    const p = plan(ctx, "AMD", 9, 20);
    return {
      ticker: "AMD", direction: "LONG", horizon: "3 months", confidence: 60, sizePct: 4,
      entry: p.entry, stop: p.stop, target: p.target, priceBasis: p.priceBasis,
      entryLogic:   `${p.entryText} Trigger: breakeven ${f2(ctx.rates.t10yie)}% < 2.0% and HY OAS ${bp(ctx.rates.hy_spread)}bp < 300bp.`,
      stopLogic:    p.stopText,
      targetLogic:  `${p.targetText} Reward/risk by construction ≈ ${p.rr}×.`,
      sizingRule:   `4% allocation. Total AMD (current ${w(ctx,'AMD').toFixed(1)}% + 4%) should not exceed 20%.`,
      rationale:    `Breakeven ${f2(ctx.rates.t10yie)}% and HY OAS ${bp(ctx.rates.hy_spread)}bp are both below this app's thresholds. The view is that this backdrop is supportive for rate-sensitive growth equity; no valuation sensitivity or company catalyst is asserted.`,
      expectedDrivers: ["Low inflation compensation", "Tight credit spreads"],
      requiredDataFreshness: "T10YIE, BAMLH0A0HYM2 daily (FRED); AMD daily close",
    };
  },
};

const hawkishFed = {
  id:          "hawkish-fed",
  name:        "High Nominal Yields",
  category:    "macro",
  description: "Fires when the 10-year Treasury yield is above 4.5% and the 10Y–2Y curve is above " +
               "+0.3pp. Both are LEVELS; this does not identify Fed policy or its direction. The view " +
               "expressed is defensive (gold, SGLN) while nominal yields are high. " + HEURISTIC,
  invalidation: "DGS10 back below 4.2%.",
  riskNotes:    "Gold pays no yield, so high real yields are a headwind for it as well; this is a judgement call, not a hedge with a measured beta.",
  requiredData: ["DGS10", "T10Y2Y", "SGLN price"],

  trigger(ctx) {
    return fin(ctx.rates.dgs10) && fin(ctx.rates.t10y2y) && ctx.rates.dgs10 > 4.5 && ctx.rates.t10y2y > 0.3;
  },

  template(ctx) {
    const p = plan(ctx, "SGLN", 6, 10);
    return {
      ticker: "SGLN", direction: "LONG", horizon: "2 months", confidence: 55, sizePct: 3,
      entry: p.entry, stop: p.stop, target: p.target, priceBasis: p.priceBasis,
      entryLogic:   `${p.entryText} Trigger: 10Y ${f2(ctx.rates.dgs10)}% > 4.5% with 10Y–2Y ${f2(ctx.rates.t10y2y)}pp > 0.3pp.`,
      stopLogic:    `${p.stopText} Also exit if DGS10 falls below 4.0%.`,
      targetLogic:  `${p.targetText} Reward/risk by construction ≈ ${p.rr}×.`,
      sizingRule:   `3% allocation. Current SGLN ${w(ctx,'SGLN').toFixed(1)}%. Keep total below 25%.`,
      rationale:    `10Y Treasury ${f2(ctx.rates.dgs10)}% and a positively sloped curve (${f2(ctx.rates.t10y2y)}pp). These levels alone do not establish the Fed's stance; the defensive tilt is a judgement, and no historical outperformance claim is made.`,
      expectedDrivers: ["High nominal yields", "Defensive tilt"],
      requiredDataFreshness: "DGS10, T10Y2Y daily (FRED); SGLN price — no free feed",
    };
  },
};

const dovishFed = {
  id:          "dovish-fed",
  name:        "Lower Nominal and Real Yields",
  category:    "macro",
  description: "Fires when the 10-year yield is below 4.0% AND the 10-year real yield (DFII10) is " +
               "below 1.5%. Levels only — this does not detect rate cuts or their pricing. The view is " +
               "that lower discount rates are supportive for long-duration growth equity (AMD). " + HEURISTIC,
  invalidation: "DGS10 back above 4.3% or DFII10 above 1.8%.",
  riskNotes:    "High-volatility single stock. Use the defined stop.",
  requiredData: ["DGS10", "DFII10", "AMD price"],

  trigger(ctx) {
    return fin(ctx.rates.dgs10) && fin(ctx.rates.dfii10) && ctx.rates.dgs10 < 4.0 && ctx.rates.dfii10 < 1.5;
  },

  template(ctx) {
    const p = plan(ctx, "AMD", 10, 25);
    return {
      ticker: "AMD", direction: "LONG", horizon: "6 months", confidence: 60, sizePct: 5,
      entry: p.entry, stop: p.stop, target: p.target, priceBasis: p.priceBasis,
      entryLogic:   `${p.entryText} Trigger: DGS10 ${f2(ctx.rates.dgs10)}% < 4.0% and DFII10 ${f2(ctx.rates.dfii10)}% < 1.5%.`,
      stopLogic:    p.stopText,
      targetLogic:  `${p.targetText} Reward/risk by construction ≈ ${p.rr}×. No fair-value-per-cut estimate is made.`,
      sizingRule:   `5% allocation, max total AMD 20%. Current ${w(ctx,'AMD').toFixed(1)}%.`,
      rationale:    `DGS10 ${f2(ctx.rates.dgs10)}% and DFII10 ${f2(ctx.rates.dfii10)}% are below this app's thresholds. Lower discount rates are the assumed channel; the size of any multiple effect is not estimated, and no company catalyst is asserted.`,
      expectedDrivers: ["Lower real discount rate (assumed channel)"],
      requiredDataFreshness: "DGS10, DFII10 daily (FRED); AMD daily close",
    };
  },
};

const payrollProxy = {
  id:          "payroll-proxy",
  name:        "Curve Steepening (requires 2Y history)",
  category:    "macro",
  description: "Intended to fire when the 10Y–2Y curve steepens by more than 10bp. A steepening is a " +
               "CHANGE and needs 2Y history, which is not fetched, so ctx.deltas.t10y2y_d is null and this " +
               "playbook does not fire. It previously described curve steepening as a proxy for payroll " +
               "surprises; that link was never tested and has been removed.",
  invalidation: "Curve flattens again.",
  riskNotes:    "HIES has significant non-USD exposure.",
  requiredData: ["T10Y2Y history (not fetched)", "HIES price"],

  trigger(ctx) {
    return fin(ctx.deltas?.t10y2y_d) && ctx.deltas.t10y2y_d > 10;
  },

  template(ctx) {
    const p = plan(ctx, "HIES", 6, 8);
    return {
      ticker: "HIES", direction: "LONG", horizon: "2 months", confidence: 50, sizePct: 2,
      entry: p.entry, stop: p.stop, target: p.target, priceBasis: p.priceBasis,
      entryLogic:   `${p.entryText} Curve change +${ctx.deltas.t10y2y_d}bp.`,
      stopLogic:    p.stopText,
      targetLogic:  `${p.targetText} Reward/risk by construction ≈ ${p.rr}×.`,
      sizingRule:   `2% add-on. Current weight ${w(ctx,'HIES').toFixed(1)}%.`,
      rationale:    `10Y–2Y changed +${ctx.deltas.t10y2y_d}bp over the measured window.`,
      expectedDrivers: ["Curve steepening"],
      requiredDataFreshness: "T10Y2Y history; HIES price — no free feed",
    };
  },
};

const stagflationProxy = {
  id:          "stagflation-proxy",
  name:        "High Breakeven + Wide Credit",
  category:    "macro",
  description: "Fires when 10-year breakeven is above 2.4% AND HY OAS is above 3.5%. Two LEVELS; " +
               "this does not measure growth or inflation outcomes. The view is defensive (gold). " + HEURISTIC,
  invalidation: "Breakeven below 2.2% or HY OAS below 3.0%.",
  riskNotes:    "Gold can fall in liquidity-driven sell-offs.",
  requiredData: ["T10YIE", "BAMLH0A0HYM2", "SGLN price"],

  trigger(ctx) {
    return fin(ctx.rates.t10yie) && fin(ctx.rates.hy_spread) && ctx.rates.t10yie > 2.4 && ctx.rates.hy_spread > 3.5;
  },

  template(ctx) {
    const p = plan(ctx, "SGLN", 7, 14);
    return {
      ticker: "SGLN", direction: "LONG", horizon: "4 months", confidence: 58, sizePct: 4,
      entry: p.entry, stop: p.stop, target: p.target, priceBasis: p.priceBasis,
      entryLogic:   `${p.entryText} Trigger: breakeven ${f2(ctx.rates.t10yie)}% > 2.4% and HY OAS ${bp(ctx.rates.hy_spread)}bp > 350bp.`,
      stopLogic:    p.stopText,
      targetLogic:  `${p.targetText} Reward/risk by construction ≈ ${p.rr}×.`,
      sizingRule:   `4% allocation. Total SGLN below 25% (currently ${w(ctx,'SGLN').toFixed(1)}%).`,
      rationale:    `Breakeven ${f2(ctx.rates.t10yie)}% and HY OAS ${bp(ctx.rates.hy_spread)}bp are both above this app's thresholds. The combination is used as a crude stagflation-risk flag; it is not a growth measurement, and no historical-episode performance is claimed.`,
      expectedDrivers: ["High inflation compensation", "Wide credit spreads"],
      requiredDataFreshness: "T10YIE, BAMLH0A0HYM2 daily (FRED); SGLN price — no free feed",
    };
  },
};

const creditSpreadWidening = {
  id:          "credit-spread-widening",
  name:        "Credit Spread Widening",
  category:    "macro",
  description: "Fires when HY OAS is above 3.5% AND has widened by more than 15bp over the measured " +
               "FRED history window. The view is defensive (gold). This app makes no claim that credit " +
               "leads equities, or by how long — that relationship is not measured here. " + HEURISTIC,
  invalidation: "HY OAS back below 3.0%.",
  riskNotes:    "Spread moves can reverse quickly.",
  requiredData: ["BAMLH0A0HYM2 (level and history)", "SGLN price"],

  trigger(ctx) {
    return fin(ctx.rates.hy_spread) && fin(ctx.deltas?.hy_spread_d) && ctx.rates.hy_spread > 3.5 && ctx.deltas.hy_spread_d > 15;
  },

  template(ctx) {
    const p = plan(ctx, "SGLN", 5, 9);
    const win = ctx.deltas?.windows?.hy_spread;
    const winText = win ? `${win.from} → ${win.to}` : "window n/a";
    return {
      ticker: "SGLN", direction: "LONG", horizon: "2 months", confidence: 57, sizePct: 3,
      entry: p.entry, stop: p.stop, target: p.target, priceBasis: p.priceBasis,
      entryLogic:   `${p.entryText} Trigger: HY OAS ${bp(ctx.rates.hy_spread)}bp, +${ctx.deltas.hy_spread_d}bp over ${winText}.`,
      stopLogic:    p.stopText,
      targetLogic:  `${p.targetText} Reward/risk by construction ≈ ${p.rr}×.`,
      sizingRule:   `3% defensive add. Total SGLN below 25%. Current: ${w(ctx,'SGLN').toFixed(1)}%.`,
      rationale:    `HY OAS ${bp(ctx.rates.hy_spread)}bp after widening ${ctx.deltas.hy_spread_d}bp (${winText}, FRED). No lead-time relationship to equities is asserted.`,
      expectedDrivers: ["Credit spread widening"],
      requiredDataFreshness: "BAMLH0A0HYM2 daily (FRED); SGLN price — no free feed",
    };
  },
};

// ── Market Structure Playbooks (4) ────────────────────────────────────────────

const trendContinuation = {
  id:          "trend-continuation",
  name:        "Trend Continuation",
  category:    "structure",
  description: "Fires when the rates moving-average signal is LONG (short MA of DGS10 below long MA, " +
               "i.e. yields falling over the available FRED history) AND the momentum signal is positive. " +
               "MA windows are counted in observations of the fetched history, not months.",
  invalidation: "MA signal reverses.",
  riskNotes:    "Trend-following produces many small losses.",
  requiredData: ["DGS10 history", "AMD price"],

  trigger(ctx) {
    return ctx.signals.maSignal === "long" && ctx.signals.momentumSignal === "long";
  },

  template(ctx) {
    const p = plan(ctx, "AMD", 7, 15);
    const chg = ctx.watchlist.AMD?.chg;
    return {
      ticker: "AMD", direction: "LONG", horizon: "2 months", confidence: 55, sizePct: 3,
      entry: p.entry, stop: p.stop, target: p.target, priceBasis: p.priceBasis,
      entryLogic:   `${p.entryText} MA signal LONG and momentum positive.`,
      stopLogic:    p.stopText,
      targetLogic:  `${p.targetText} Reward/risk by construction ≈ ${p.rr}×.`,
      sizingRule:   `3% trend add. Current weight ${w(ctx,'AMD').toFixed(1)}%.`,
      rationale:    `Rates MA signal LONG (${ctx.signalsBasis || "history basis n/a"}) and AMD latest daily change ${fin(chg) ? `${chg >= 0 ? "+" : ""}${chg.toFixed(1)}%` : "n/a"}. Signal agreement is not evidence of a higher hit rate; none has been measured.`,
      expectedDrivers: ["Falling yields over the history window", "Positive latest daily change"],
      requiredDataFreshness: "DGS10 history (FRED); AMD daily close",
    };
  },
};

const meanReversionPlaybook = {
  id:          "mean-reversion",
  name:        "Mean Reversion",
  category:    "structure",
  description: "Fires when the current 10Y yield is ≥1.5 standard deviations from the mean of the " +
               "available FRED history window. The window is short (the snapshot fetches ~13 daily " +
               "observations), so this is a short-horizon z-score, not a 6-month one. Long-only: a " +
               "SHORT signal is blocked by the Shariah filter.",
  invalidation: "Yields keep extending in the same direction.",
  riskNotes:    "Reversion may not occur on any particular horizon.",
  requiredData: ["DGS10 history", "AMD price"],

  trigger(ctx) {
    return ctx.signals.reversionSignal !== "flat";
  },

  template(ctx) {
    const dir    = ctx.signals.reversionSignal;
    const isBull = dir === "long";
    const p      = plan(ctx, "AMD", 9, 18);
    return {
      ticker: "AMD", direction: isBull ? "LONG" : "SHORT", horizon: "3 months", confidence: 50, sizePct: 3,
      entry: p.entry, stop: p.stop, target: p.target, priceBasis: p.priceBasis,
      entryLogic:   `${p.entryText} Rates z-score signal ${dir.toUpperCase()}.`,
      stopLogic:    p.stopText,
      targetLogic:  `${p.targetText} Reward/risk by construction ≈ ${p.rr}×. No reversion timeline is claimed.`,
      sizingRule:   `3% allocation. Current weight ${w(ctx,'AMD').toFixed(1)}%.`,
      rationale:    `10Y yield ≥1.5σ from the mean of ${ctx.signalsBasis || "the available history"}. ${isBull ? "Yields high versus that window" : "Yields low versus that window"}; reversion is assumed, not forecast.`,
      expectedDrivers: ["Assumed reversion of yields toward the window mean"],
      requiredDataFreshness: "DGS10 history (FRED); AMD daily close",
    };
  },
};

const breakoutFailure = {
  id:          "breakout-failure",
  name:        "Credit Spread Reversal",
  category:    "structure",
  description: "Fires when HY OAS is above 4.0% but has narrowed by more than 10bp over the FRED " +
               "history window. HELD: its expression vehicle is HBKS, whose identity is unverified " +
               "(see CONTESTED_INSTRUMENTS). It will not fire until the instrument is verified.",
  invalidation: "HY OAS resumes widening above 4.0%.",
  riskNotes:    "Instrument unverified.",
  requiredData: ["BAMLH0A0HYM2 (level and history)"],

  trigger(ctx) {
    if (isContested("HBKS")) return false;
    return fin(ctx.rates.hy_spread) && fin(ctx.deltas?.hy_spread_d) && ctx.rates.hy_spread > 4.0 && ctx.deltas.hy_spread_d < -10;
  },

  template(ctx) {
    const p = plan(ctx, "HBKS", 5, 10);
    return {
      ticker: "HBKS", direction: "LONG", horizon: "3 months", confidence: 50, sizePct: 3,
      entry: p.entry, stop: p.stop, target: p.target, priceBasis: p.priceBasis,
      entryLogic:   `${p.entryText} HY OAS ${bp(ctx.rates.hy_spread)}bp, ${ctx.deltas.hy_spread_d}bp over the window.`,
      stopLogic:    p.stopText,
      targetLogic:  `${p.targetText} Reward/risk by construction ≈ ${p.rr}×.`,
      sizingRule:   `3% allocation. Current weight ${w(ctx,'HBKS').toFixed(1)}%.`,
      rationale:    `HY OAS ${bp(ctx.rates.hy_spread)}bp and narrowing. Expression vehicle pending instrument verification.`,
      expectedDrivers: ["Credit spread reversal"],
      requiredDataFreshness: "BAMLH0A0HYM2 daily (FRED)",
    };
  },
};

const correlationBreak = {
  id:          "correlation-break",
  name:        "Daily Divergence (AMD vs NVDA)",
  category:    "structure",
  description: "Fires when AMD's latest daily change trails NVDA's by more than 8 percentage points. " +
               "This is a one-day divergence in daily closes, not a measured correlation break; " +
               "convergence is assumed, not estimated. Long-only (buy the laggard).",
  invalidation: "Divergence widens further.",
  riskNotes:    "Divergences can persist when driven by stock-specific news.",
  requiredData: ["AMD daily change", "NVDA daily change"],

  trigger(ctx) {
    const amd = ctx.watchlist.AMD?.chg, nvda = ctx.watchlist.NVDA?.chg;
    if (!fin(amd) || !fin(nvda)) return false;   // missing ≠ 0% change
    return (amd - nvda) < -8;
  },

  template(ctx) {
    const amdChg  = ctx.watchlist.AMD.chg;
    const nvdaChg = ctx.watchlist.NVDA.chg;
    const gap     = amdChg - nvdaChg;
    const p       = plan(ctx, "AMD", 8, 12);
    return {
      ticker: "AMD", direction: "LONG", horizon: "1 month", confidence: 48, sizePct: 2,
      entry: p.entry, stop: p.stop, target: p.target, priceBasis: p.priceBasis,
      entryLogic:   `${p.entryText} AMD ${amdChg >= 0 ? "+" : ""}${amdChg.toFixed(1)}% vs NVDA ${nvdaChg >= 0 ? "+" : ""}${nvdaChg.toFixed(1)}% (daily closes ${ctx.watchlist.AMD.date || "n/a"} / ${ctx.watchlist.NVDA.date || "n/a"}).`,
      stopLogic:    p.stopText,
      targetLogic:  `${p.targetText} Reward/risk by construction ≈ ${p.rr}×.`,
      sizingRule:   `2% small position. Current weight ${w(ctx,'AMD').toFixed(1)}%.`,
      rationale:    `One-day return gap of ${Math.abs(gap).toFixed(1)}pp between AMD and NVDA. Convergence is assumed; no correlation or reversion speed has been measured, and no cause is asserted.`,
      expectedDrivers: ["Assumed convergence of a one-day divergence"],
      requiredDataFreshness: "AMD, NVDA daily closes",
    };
  },
};

// ── Portfolio-Aware Playbooks (2) ─────────────────────────────────────────────

const highUsdHedge = {
  id:          "high-usd-hedge",
  name:        "High USD Exposure",
  category:    "portfolio",
  description: "Fires when the portfolio's estimated USD exposure exceeds 55%. The estimate uses " +
               "hand-entered look-through currency weights (seeds CCY_EXP), which are assumptions. " +
               "SGLN is used as a diversifier; its USD sensitivity is not measured here.",
  invalidation: "Estimated USD exposure falls below 50%.",
  riskNotes:    "Look-through currency weights are assumptions, not fund-reported data.",
  requiredData: ["Portfolio snapshot", "CCY_EXP assumptions", "SGLN price"],

  trigger(ctx) {
    return ctx.portfolio.totalGBP > 0 && ctx.portfolio.usdPct > 55;
  },

  template(ctx) {
    const p = plan(ctx, "SGLN", 5, 8);
    return {
      ticker: "SGLN", direction: "LONG", horizon: "3 months", confidence: 52, sizePct: 2,
      entry: p.entry, stop: p.stop, target: p.target, priceBasis: p.priceBasis,
      entryLogic:   `${p.entryText} Estimated USD exposure ${ctx.portfolio.usdPct.toFixed(1)}% (>55%).`,
      stopLogic:    p.stopText,
      targetLogic:  `${p.targetText} Reward/risk by construction ≈ ${p.rr}×.`,
      sizingRule:   `2% add. Total SGLN after add: ${(w(ctx,'SGLN') + 2).toFixed(1)}%. Keep below 25%.`,
      rationale:    `Estimated USD exposure ${ctx.portfolio.usdPct.toFixed(1)}% (look-through weights are assumptions). HHI ${ctx.portfolio.hhi.toLocaleString()}. Diversification benefit is not quantified.`,
      expectedDrivers: ["Reduce estimated USD concentration"],
      requiredDataFreshness: "Portfolio snapshot; USD/GBP daily reference rate",
    };
  },
};

const concentrationHedge = {
  id:          "concentration-hedge",
  name:        "Concentration Hedge",
  category:    "portfolio",
  description: "Fires when portfolio HHI exceeds 2000. HELD: its expression vehicle is HBKS, whose " +
               "identity is unverified (see CONTESTED_INSTRUMENTS). The sukuk/duration description, " +
               "beta of 0.62 and income claims previously attached to it had no source and are removed.",
  invalidation: "HHI falls below 2000.",
  riskNotes:    "Instrument unverified.",
  requiredData: ["Portfolio HHI"],

  trigger(ctx) {
    if (isContested("HBKS")) return false;
    return ctx.portfolio.hhi > 2000;
  },

  template(ctx) {
    const p = plan(ctx, "HBKS", 5, 9);
    return {
      ticker: "HBKS", direction: "LONG", horizon: "6 months", confidence: 50, sizePct: 3,
      entry: p.entry, stop: p.stop, target: p.target, priceBasis: p.priceBasis,
      entryLogic:   `${p.entryText} Portfolio HHI ${ctx.portfolio.hhi.toLocaleString()} (>2000).`,
      stopLogic:    p.stopText,
      targetLogic:  `${p.targetText} Reward/risk by construction ≈ ${p.rr}×.`,
      sizingRule:   `3% allocation. Current weight ${w(ctx,'HBKS').toFixed(1)}%.`,
      rationale:    `HHI ${ctx.portfolio.hhi.toLocaleString()} is above 2000. Expression vehicle pending instrument verification.`,
      expectedDrivers: ["HHI reduction"],
      requiredDataFreshness: "Portfolio snapshot",
    };
  },
};

// ── Exit Playbooks (4) ──────────────────────────────────────────────────────

const exitTargetHit = {
  id:          "exit-target-hit",
  name:        "Target Price Reached",
  category:    "exit",
  description: "Fires when current watchlist price meets or exceeds the idea's target. Signal to close for profit.",
  trigger(_ctx) {
    // This playbook is evaluated differently — it scans open ideas, not rates.
    // For the standard trigger mechanism: always return false (handled by exitEngine).
    return false;
  },
  template(_ctx) { return {}; },
  invalidation: "Price retreats below entry — target was not sustainable.",
  riskNotes:    "Consider partial profit-taking at target rather than full close.",
  requiredData: ["watchlist prices"],
};

const exitStopHit = {
  id:          "exit-stop-hit",
  name:        "Stop Loss Triggered",
  category:    "exit",
  description: "Fires when current price falls to or below the idea's stop. Capital preservation signal.",
  trigger(_ctx) { return false; },
  template(_ctx) { return {}; },
  invalidation: "Price recovers above stop — false stop-out.",
  riskNotes:    "Do not move stop down to avoid loss — that is stop-loss hunting behavior.",
  requiredData: ["watchlist prices"],
};

const exitRegimeChange = {
  id:          "exit-regime-change",
  name:        "Macro Regime Change",
  category:    "exit",
  description: "Fires when the macro regime has shifted materially from the regime that generated the idea. Thesis invalidated by new macro context.",
  trigger(ctx) {
    // Regime deterioration invalidating LONG ideas: credit stress worsening,
    // rates rising further into restrictive territory, or curve inverting (recession).
    // Thresholds calibrated to current regime (DGS10 ~4.2%, HY ~3.2%, curve +0.5%).
    const creditStress     = ctx.rates.hy_spread > 3.8;  // HY widening materially beyond current
    const ratesRestrictive = ctx.rates.dgs10     > 4.8;  // rates risen >60bps from current
    const curveInverted    = ctx.rates.t10y2y    < -0.3; // firm inversion = recession signal
    return creditStress || ratesRestrictive || curveInverted;
  },
  template(ctx) {
    return {
      ticker:    "PORTFOLIO",
      direction: "LONG",
      rationale: `Macro regime has shifted materially. HY OAS: ${ctx.rates.hy_spread.toFixed(2)}%, DGS10: ${ctx.rates.dgs10.toFixed(2)}%, Curve: ${ctx.rates.t10y2y.toFixed(2)}%. Review all open ideas for thesis validity.`,
      confidence: 70,
      horizon: "Immediate",
    };
  },
  invalidation: "Regime returns to original conditions within 5 trading days.",
  riskNotes:    "Regime changes can be whipsaws — check multiple confirming signals.",
  requiredData: ["DGS10", "T10Y2Y", "BAMLH0A0HYM2"],
};

const exitTimeExpiry = {
  id:          "exit-time-expiry",
  name:        "Horizon Expiry",
  category:    "exit",
  description: "Fires when an idea has been open longer than its stated horizon without hitting target or stop. Time-decay of thesis validity.",
  trigger(_ctx) { return false; }, // handled by exitEngine per-idea date logic
  template(_ctx) { return {}; },
  invalidation: "Strong new catalyst refreshes the original thesis.",
  riskNotes:    "Hope is not a strategy — close time-expired positions even if not at target.",
  requiredData: ["openedAt", "horizon"],
};

// ── Export ────────────────────────────────────────────────────────────────────

const PLAYBOOKS = [
  hotCPI,
  softCPI,
  hawkishFed,
  dovishFed,
  payrollProxy,
  stagflationProxy,
  creditSpreadWidening,
  trendContinuation,
  meanReversionPlaybook,
  breakoutFailure,
  correlationBreak,
  highUsdHedge,
  concentrationHedge,
  exitTargetHit,
  exitStopHit,
  exitRegimeChange,
  exitTimeExpiry,
];

module.exports = { PLAYBOOKS };
