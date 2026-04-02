/**
 * server/engine/playbooks.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 13 deterministic trade playbooks for the Idea Engine.
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
 *   deltas:    { dgs10_d, dfii10_d, t10yie_d, hy_spread_d }   Δbps vs prior month
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
  return ctx.portfolio.weights[ticker] ?? 0;
}

function priceFmt(ctx, ticker, fallback) {
  return ctx.watchlist[ticker]?.price ?? fallback;
}

// ── Macro Playbooks (7) ───────────────────────────────────────────────────────

const hotCPI = {
  id:          "hot-cpi",
  name:        "Hot CPI / Inflation Spike",
  category:    "macro",
  description: "Fires when 10-year breakeven inflation (T10YIE) exceeds 2.5%, signalling " +
               "above-consensus inflation expectations. Gold (SGLN) is the primary beneficiary " +
               "as it preserves real purchasing power when inflation erodes fixed-income returns. " +
               "Strategy: add inflation hedge before CPI print confirms the move.",
  invalidation: "T10YIE drops below 2.2% on weaker-than-expected CPI; Fed signals aggressive hikes; gold supply shock.",
  riskNotes:    "Gold is already held (SGLN). Avoid over-concentration above 25% weight.",
  requiredData: ["T10YIE", "BAMLH0A0HYM2"],

  trigger(ctx) {
    return ctx.rates.t10yie > 2.5;
  },

  template(ctx) {
    const entry  = priceFmt(ctx, "SGLN", 74.00);
    const stop   = +(entry * 0.95).toFixed(2);
    const target = +(entry * 1.11).toFixed(2);
    return {
      ticker:       "SGLN",
      direction:    "LONG",
      horizon:      "3 months",
      confidence:   72,
      sizePct:      3,
      entry, stop, target,
      entryLogic:   `Enter near current price £${entry} — inflation breakeven above 2.5% supports gold bid. Use limit at £${entry} or market on next open.`,
      stopLogic:    `Stop at £${stop} (5% below entry). Gold breaks down if real rates spike sharply on surprise Fed hike.`,
      targetLogic:  `Target £${target} (R≈${((target-entry)/(entry-stop)).toFixed(1)}×). Inflation regime typically sustains gold above prior resistance.`,
      sizingRule:   `3% portfolio allocation. Total SGLN (current ${w(ctx,'SGLN').toFixed(1)}% + new 3%) must stay below 25%.`,
      rationale:    `Breakeven inflation at ${ctx.rates.t10yie.toFixed(2)}% (above 2.5% threshold) confirms market pricing above-consensus inflation. SGLN (negative beta −0.08) provides inflation hedge with no equity correlation drag. ${ctx.regime} regime supports defensive positioning.`,
      expectedDrivers: ["Breakeven inflation >2.5%", "Real yield erosion", "Safe-haven demand"],
      requiredDataFreshness: "T10YIE < 24h; SGLN price < 30min",
    };
  },
};

const softCPI = {
  id:          "soft-cpi",
  name:        "Soft CPI / Disinflation",
  category:    "macro",
  description: "Fires when breakeven inflation falls below 2.0% AND HY spreads are contained " +
               "below 3.0%, signalling a benign inflation outlook. This is the ideal macro " +
               "backdrop for high-growth, rate-sensitive names like AMD — the Fed gains " +
               "room to cut, compressing the real yield discount rate and expanding P/E multiples.",
  invalidation: "CPI re-accelerates above 3.5%; tariff pass-through adds 50bps+ to breakeven; FOMC turns hawkish.",
  riskNotes:    "AMD has high beta (1.82). Position sizing critical — use 4% max if AMD already at target weight.",
  requiredData: ["T10YIE", "BAMLH0A0HYM2", "DFII10"],

  trigger(ctx) {
    return ctx.rates.t10yie < 2.0 && ctx.rates.hy_spread < 3.0;
  },

  template(ctx) {
    const entry  = priceFmt(ctx, "AMD", 192.00);
    const stop   = +(entry * 0.91).toFixed(2);
    const target = +(entry * 1.20).toFixed(2);
    return {
      ticker:       "AMD",
      direction:    "LONG",
      horizon:      "3 months",
      confidence:   70,
      sizePct:      4,
      entry, stop, target,
      entryLogic:   `Enter AMD near £${entry} on confirmed disinflation signal — breakeven <2.0% & HY OAS <3.0%. Prefer limit entry on 1–2% intraday pullback.`,
      stopLogic:    `Stop at $${stop} (9% below entry). Macro thesis breaks if inflation re-accelerates or credit spreads widen sharply.`,
      targetLogic:  `Target $${target} (R≈${((target-entry)/(entry-stop)).toFixed(1)}×). Multiple expansion potential if real yields compress toward 1.0–1.2%.`,
      sizingRule:   `4% allocation. AMD is high-beta (1.82) — size conservatively. Total AMD (current ${w(ctx,'AMD').toFixed(1)}% + 4%) should not exceed 20%.`,
      rationale:    `Soft inflation (T10YIE ${ctx.rates.t10yie.toFixed(2)}%) + contained credit (HY OAS ${ctx.rates.hy_spread.toFixed(2)}%) = ideal conditions for AMD re-rating. Disinflation unlocks Fed optionality for H2 cuts, mechanically expanding growth multiples. Q1 earnings Apr 22 is the near-term catalyst.`,
      expectedDrivers: ["Disinflation + Fed easing optionality", "AMD Q1 earnings catalyst", "Growth multiple expansion"],
      requiredDataFreshness: "T10YIE < 24h; BAMLH0A0HYM2 < 24h; AMD price < 30min",
    };
  },
};

const hawkishFed = {
  id:          "hawkish-fed",
  name:        "Hawkish Fed / Rates Restrictive",
  category:    "macro",
  description: "Fires when the 10-year Treasury yield exceeds 4.5% and the yield curve " +
               "is not inverted (still positively sloped), indicating the Fed is in an " +
               "actively restrictive stance. In this environment, fixed-income proxies and " +
               "gold outperform equities as the cost of capital rises. SGLN benefits from " +
               "flight-to-quality demand and as a rates-restrictive inflation hedge.",
  invalidation: "DGS10 reverses below 4.2% on surprise dovish pivot; risk appetite returns; HY spreads tighten sharply.",
  riskNotes:    "Gold can sell off on USD strength. Monitor DXY — rising dollar headwind for gold even in hawkish regime.",
  requiredData: ["DGS10", "T10Y2Y"],

  trigger(ctx) {
    return ctx.rates.dgs10 > 4.5 && ctx.rates.t10y2y > 0.3;
  },

  template(ctx) {
    const entry  = priceFmt(ctx, "SGLN", 74.00);
    const stop   = +(entry * 0.94).toFixed(2);
    const target = +(entry * 1.10).toFixed(2);
    return {
      ticker:       "SGLN",
      direction:    "LONG",
      horizon:      "2 months",
      confidence:   65,
      sizePct:      3,
      entry, stop, target,
      entryLogic:   `Enter SGLN at market — 10Y Treasury at ${ctx.rates.dgs10.toFixed(2)}% (above 4.5%) confirms restrictive stance. Gold is historically the best hedge in prolonged high-rate environments.`,
      stopLogic:    `Stop at £${stop} (6% below entry). Exit if DGS10 falls below 4.0% on dovish surprise.`,
      targetLogic:  `Target £${target} (~R${((target-entry)/(entry-stop)).toFixed(1)}×). Gold re-rates higher as restrictive policy increases recession risk premium.`,
      sizingRule:   `3% allocation. Complement existing SGLN (${w(ctx,'SGLN').toFixed(1)}%). Keep total below 25%.`,
      rationale:    `10Y Treasury at ${ctx.rates.dgs10.toFixed(2)}% with a positively sloped curve (T10Y2Y ${ctx.rates.t10y2y.toFixed(2)}%) signals the Fed is in a sustained restrictive regime. Historical precedent: gold outperforms equities in the 12 months following peak-restrictive rate cycles. SGLN's negative equity beta (−0.08) reduces portfolio volatility.`,
      expectedDrivers: ["Prolonged restrictive Fed stance", "Recession risk premium", "Flight-to-safety bid"],
      requiredDataFreshness: "DGS10 < 24h; T10Y2Y < 24h",
    };
  },
};

const dovishFed = {
  id:          "dovish-fed",
  name:        "Dovish Fed / Rate Cut Cycle",
  category:    "macro",
  description: "Fires when the 10-year yield drops below 4.0% AND real yields (DFII10) " +
               "are below 1.5%, indicating the market is pricing Fed rate cuts. This is the " +
               "classic risk-on pivot playbook — falling discount rates mechanically expand " +
               "P/E multiples for high-growth names. AMD with its 1.82 beta is the highest " +
               "leverage play in the portfolio for a dovish pivot.",
  invalidation: "DGS10 rebounds above 4.3% on sticky inflation; FOMC dot plot moves hawkish; AMD earnings miss.",
  riskNotes:    "AMD is high-beta — a 10% rate cut rally can reverse 15–20% on any bad headline. Use defined stop.",
  requiredData: ["DGS10", "DFII10"],

  trigger(ctx) {
    return ctx.rates.dgs10 < 4.0 && ctx.rates.dfii10 < 1.5;
  },

  template(ctx) {
    const entry  = priceFmt(ctx, "AMD", 192.00);
    const stop   = +(entry * 0.90).toFixed(2);
    const target = +(entry * 1.25).toFixed(2);
    return {
      ticker:       "AMD",
      direction:    "LONG",
      horizon:      "6 months",
      confidence:   75,
      sizePct:      5,
      entry, stop, target,
      entryLogic:   `Enter AMD as dovish pivot confirms — DGS10 at ${ctx.rates.dgs10.toFixed(2)}% below 4.0% threshold. Real yields at ${ctx.rates.dfii10.toFixed(2)}% compressing = multiple expansion setup.`,
      stopLogic:    `Stop at $${stop} (10% below entry). Dovish thesis invalidated if yields rapidly reverse.`,
      targetLogic:  `Target $${target} (R≈${((target-entry)/(entry-stop)).toFixed(1)}×). Each 25bps cut historically adds 8–12% to AMD's fair value via discount rate.`,
      sizingRule:   `5% allocation reflects high conviction in dovish pivot. AMD high-beta (1.82) — still use defined stop. Max total AMD: 20%.`,
      rationale:    `Dovish conditions confirmed: DGS10 ${ctx.rates.dgs10.toFixed(2)}% and DFII10 ${ctx.rates.dfii10.toFixed(2)}%. Fed rate cuts are the most powerful near-term catalyst for AMD's P/E re-rating. MI450 GPU ramp + Q1 Apr 22 earnings provide company-specific upside. Portfolio alpha trade.`,
      expectedDrivers: ["Rate cut cycle compresses discount rate", "AMD P/E multiple expansion", "AI capex re-acceleration"],
      requiredDataFreshness: "DGS10 < 24h; DFII10 < 24h; AMD price < 30min",
    };
  },
};

const payrollProxy = {
  id:          "payroll-proxy",
  name:        "Payroll Surprise / Growth Resilience",
  category:    "macro",
  description: "Uses yield curve steepening (T10Y2Y rising >+10bps) as a proxy for " +
               "growth-positive payroll surprises — the curve steepens when the market " +
               "prices stronger growth and less likelihood of near-term Fed cuts. " +
               "In this environment, broad equity exposure via diversified ETFs outperforms " +
               "single-stock. HIES (global equity) benefits from risk appetite returning.",
  invalidation: "Yield curve flattens again (<+5bps); HY spreads widen; risk-off resumes.",
  riskNotes:    "HIES has significant EM/Korea exposure — strong USD can negate the global growth thesis.",
  requiredData: ["T10Y2Y"],

  trigger(ctx) {
    return ctx.deltas.dgs10_d !== undefined && ctx.deltas.t10y2y_d > 10;
  },

  template(ctx) {
    const entry  = priceFmt(ctx, "HIES", 15.74);
    const stop   = +(entry * 0.94).toFixed(2);
    const target = +(entry * 1.08).toFixed(2);
    return {
      ticker:       "HIES",
      direction:    "LONG",
      horizon:      "2 months",
      confidence:   58,
      sizePct:      2,
      entry, stop, target,
      entryLogic:   `Enter HIES as curve steepens — growth resilience signal. Yield curve delta: +${ctx.deltas.t10y2y_d ?? "N/A"}bps.`,
      stopLogic:    `Stop at £${stop} (6% below entry). Thesis breaks if curve re-flattens or EM sells off.`,
      targetLogic:  `Target £${target} (R≈${((target-entry)/(entry-stop)).toFixed(1)}×). Growth-positive regime supports global equity exposure.`,
      sizingRule:   `2% small add-on. HIES beta is 1.15 vs portfolio. Current weight ${w(ctx,'HIES').toFixed(1)}%.`,
      rationale:    `Yield curve steepening (T10Y2Y at ${ctx.rates.t10y2y.toFixed(2)}%, +${ctx.deltas.t10y2y_d ?? 'N/A'}bps) signals market pricing growth resilience. Strong labour market historically supports global equity risk appetite. HIES (global equity ETF) provides diversified exposure without single-stock risk.`,
      expectedDrivers: ["Curve steepening = growth optimism", "Risk-on rotation into equities", "EM outperformance"],
      requiredDataFreshness: "T10Y2Y < 24h; HIES price < 30min",
    };
  },
};

const stagflationProxy = {
  id:          "stagflation-proxy",
  name:        "Stagflation / Oil Shock Proxy",
  category:    "macro",
  description: "Fires when both breakeven inflation is elevated (T10YIE >2.4%) AND " +
               "credit spreads are wide (HY OAS >3.5%), creating the toxic stagflation " +
               "combination: high inflation + slowing growth. Gold (SGLN) is the textbook " +
               "stagflation hedge — it benefits from inflation while credit stress signals " +
               "a growth slowdown. This is the worst macro backdrop for equities.",
  invalidation: "Oil prices collapse; inflation resolves quickly below 2.5%; HY spreads tighten to <2.5%.",
  riskNotes:    "Gold can be liquidated in a liquidity crisis (2008 scenario). Monitor cross-asset correlations.",
  requiredData: ["T10YIE", "BAMLH0A0HYM2"],

  trigger(ctx) {
    return ctx.rates.t10yie > 2.4 && ctx.rates.hy_spread > 3.5;
  },

  template(ctx) {
    const entry  = priceFmt(ctx, "SGLN", 74.00);
    const stop   = +(entry * 0.93).toFixed(2);
    const target = +(entry * 1.14).toFixed(2);
    return {
      ticker:       "SGLN",
      direction:    "LONG",
      horizon:      "4 months",
      confidence:   68,
      sizePct:      4,
      entry, stop, target,
      entryLogic:   `Enter SGLN — stagflation proxy trigger: T10YIE ${ctx.rates.t10yie.toFixed(2)}% + HY OAS ${ctx.rates.hy_spread.toFixed(2)}%. Market pricing simultaneous inflation + credit stress.`,
      stopLogic:    `Stop at £${stop} (7% below). Exit if either inflation normalises (<2.0%) or spreads tighten sharply.`,
      targetLogic:  `Target £${target} (R≈${((target-entry)/(entry-stop)).toFixed(1)}×). Stagflation historically sustains gold premium for 3–6 months.`,
      sizingRule:   `4% allocation. Stagflation is the highest-conviction gold scenario. Total SGLN should not exceed 25% (currently ${w(ctx,'SGLN').toFixed(1)}%).`,
      rationale:    `Stagflation signal confirmed: inflation breakeven ${ctx.rates.t10yie.toFixed(2)}% AND HY OAS ${ctx.rates.hy_spread.toFixed(2)}%. This toxic combination — high inflation with slowing growth — historically produced gold's strongest outperformance periods (1974–1975, 1980, 2022). SGLN's low equity beta (−0.08) makes it an ideal portfolio shock absorber.`,
      expectedDrivers: ["High inflation + slow growth = gold bid", "Credit stress reduces equity appetite", "Safe-haven premium"],
      requiredDataFreshness: "T10YIE < 24h; BAMLH0A0HYM2 < 24h",
    };
  },
};

const creditSpreadWidening = {
  id:          "credit-spread-widening",
  name:        "Credit Spread Widening",
  category:    "macro",
  description: "Fires when HY OAS exceeds 3.5% AND has widened >+15bps recently, " +
               "signalling an accelerating risk-off move in credit markets. Credit spread " +
               "widening historically leads equity drawdowns by 2–4 weeks — this playbook " +
               "positions defensively ahead of potential equity weakness by adding gold.",
  invalidation: "HY OAS reverses below 3.0% quickly; Fed intervenes with emergency rate cut or liquidity facilities.",
  riskNotes:    "Credit spread widening can be short-lived (flash selloff). Use a tighter stop to avoid being caught in a reversal.",
  requiredData: ["BAMLH0A0HYM2"],

  trigger(ctx) {
    return ctx.rates.hy_spread > 3.5 && ctx.deltas.hy_spread_d > 15;
  },

  template(ctx) {
    const entry  = priceFmt(ctx, "SGLN", 74.00);
    const stop   = +(entry * 0.95).toFixed(2);
    const target = +(entry * 1.09).toFixed(2);
    return {
      ticker:       "SGLN",
      direction:    "LONG",
      horizon:      "2 months",
      confidence:   67,
      sizePct:      3,
      entry, stop, target,
      entryLogic:   `Enter SGLN on accelerating credit stress — HY OAS at ${ctx.rates.hy_spread.toFixed(2)}% (+${ctx.deltas.hy_spread_d}bps). Credit leads equity by 2–4 weeks historically.`,
      stopLogic:    `Stop at £${stop} (5% below). Tight stop reflects potential for quick reversal if credit normalises.`,
      targetLogic:  `Target £${target} (R≈${((target-entry)/(entry-stop)).toFixed(1)}×). Exit when HY OAS stabilises or narrows below 3.2%.`,
      sizingRule:   `3% defensive add. Do not exceed 25% total SGLN. Current: ${w(ctx,'SGLN').toFixed(1)}%.`,
      rationale:    `HY OAS at ${ctx.rates.hy_spread.toFixed(2)}% with ${ctx.deltas.hy_spread_d}bps recent widening — credit markets leading risk-off signal. Equity markets typically reprice 2–4 weeks after credit stress of this magnitude. SGLN provides lead-time defensive positioning without equity beta.`,
      expectedDrivers: ["Credit leading equity drawdown", "Risk-off rotation to safety", "Spread normalisation premium"],
      requiredDataFreshness: "BAMLH0A0HYM2 < 24h",
    };
  },
};

// ── Market Structure Playbooks (4) ────────────────────────────────────────────

const trendContinuation = {
  id:          "trend-continuation",
  name:        "Trend Continuation",
  category:    "structure",
  description: "Fires when both the moving average signal is bullish (short MA below " +
               "long MA — rates falling) AND momentum is positive, confirming a regime " +
               "where equities trend higher. The trend continuation strategy adds to the " +
               "highest-beta holding (AMD) to maximise participation in an established uptrend.",
  invalidation: "Moving average signal reverses (rates start rising); AMD price breaks below 50-day MA equivalent.",
  riskNotes:    "Trend-following has positive skew but can have many small losses. Use tight stops.",
  requiredData: ["DGS10 (history)", "AMD price"],

  trigger(ctx) {
    return ctx.signals.maSignal === "long" && ctx.signals.momentumSignal === "long";
  },

  template(ctx) {
    const entry  = priceFmt(ctx, "AMD", 192.00);
    const stop   = +(entry * 0.93).toFixed(2);
    const target = +(entry * 1.15).toFixed(2);
    return {
      ticker:       "AMD",
      direction:    "LONG",
      horizon:      "2 months",
      confidence:   60,
      sizePct:      3,
      entry, stop, target,
      entryLogic:   `Enter AMD with trend confirmation — MA signal LONG and momentum positive. Enter on next-day open or on minor pullback to ${(entry * 0.99).toFixed(2)}.`,
      stopLogic:    `Stop at $${stop} (7% below). Trend invalidated on close below this level.`,
      targetLogic:  `Target $${target} (R≈${((target-entry)/(entry-stop)).toFixed(1)}×). Trail stop up once AMD gains >8%.`,
      sizingRule:   `3% trend add. AMD beta 1.82 — trend strategies prefer smaller sizing, higher frequency. Current weight ${w(ctx,'AMD').toFixed(1)}%.`,
      rationale:    `Both MA (rates declining = equity tailwind) and momentum (AMD +${(ctx.watchlist.AMD?.chg ?? 0).toFixed(1)}% today) signals are aligned bullish. Trend continuation is the highest probability strategy when multiple timeframe signals agree. ${ctx.regime}.`,
      expectedDrivers: ["Rates trend declining", "Positive price momentum", "AI sector rotation"],
      requiredDataFreshness: "DGS10 history < 24h; AMD price < 30min",
    };
  },
};

const meanReversionPlaybook = {
  id:          "mean-reversion",
  name:        "Mean Reversion",
  category:    "structure",
  description: "Fires when the mean reversion signal is non-flat, indicating rates have " +
               "deviated significantly from their 6-month mean (z-score ≥1.5). Rates " +
               "mean-reversion tends to drive equity multiple expansion (when rates are " +
               "abnormally high) or contraction (when abnormally low). The playbook acts " +
               "in the direction of the expected reversion.",
  invalidation: "Rates continue trending further away from mean; structural regime change confirmed by Fed statement.",
  riskNotes:    "Mean reversion can take months to materialise. Sizing must account for the waiting time and potential drawdown.",
  requiredData: ["DGS10 (history)", "AMD price"],

  trigger(ctx) {
    return ctx.signals.reversionSignal !== "flat";
  },

  template(ctx) {
    const dir    = ctx.signals.reversionSignal; // "long" or "short"
    const entry  = priceFmt(ctx, "AMD", 192.00);
    const isBull = dir === "long";
    const stop   = isBull ? +(entry * 0.91).toFixed(2) : +(entry * 1.09).toFixed(2);
    const target = isBull ? +(entry * 1.18).toFixed(2) : +(entry * 0.84).toFixed(2);
    return {
      ticker:       "AMD",
      direction:    isBull ? "LONG" : "SHORT",
      horizon:      "3 months",
      confidence:   55,
      sizePct:      3,
      entry, stop, target,
      entryLogic:   `Mean reversion ${dir.toUpperCase()} signal — rates z-score suggests ${isBull ? "rates are elevated vs history → compression trade" : "rates are suppressed vs history → expansion trade"}.`,
      stopLogic:    `Stop at $${stop}. Mean reversion thesis is broken if rates keep extending in the same direction.`,
      targetLogic:  `Target $${target} (R≈${(Math.abs(target-entry)/Math.abs(entry-stop)).toFixed(1)}×). Mean reversion to the 6-month average historically occurs within 60–90 days.`,
      sizingRule:   `3% allocation — mean reversion is moderate-conviction. AMD beta 1.82. Current weight ${w(ctx,'AMD').toFixed(1)}%.`,
      rationale:    `Rate z-score outside ±1.5 standard deviations from 6-month mean. ${isBull ? "Rates are elevated → likely to compress → AMD multiple expansion" : "Rates are suppressed → likely to rise → AMD multiple pressure"}. Mean reversion signal generated by quantitative analysis of RATES_HISTORY_SEED.`,
      expectedDrivers: isBull
        ? ["Rate z-score compression", "AMD multiple expansion", "Regression to mean"]
        : ["Rate z-score expansion", "AMD multiple compression", "Risk premium widening"],
      requiredDataFreshness: "DGS10 history < 24h; AMD price < 30min",
    };
  },
};

const breakoutFailure = {
  id:          "breakout-failure",
  name:        "Breakout Failure / Credit Reversal",
  category:    "structure",
  description: "Fires when HY spreads spiked above 4.0% but are now reverting " +
               "(recent delta < −10bps), indicating a 'breakout failure' in credit stress. " +
               "When credit spreads fail to sustain above key levels, it often marks the " +
               "short-term bottom in risk assets. Duration/sukuk (HBKS) benefits from the " +
               "flight-to-quality unwind as credit normalises.",
  invalidation: "HY OAS resumes widening above 4.0%; fundamental credit event (default) causes structural spread elevation.",
  riskNotes:    "Breakout failures can re-test — give HBKS a wider stop to avoid being stopped by the re-test before reversal.",
  requiredData: ["BAMLH0A0HYM2"],

  trigger(ctx) {
    return ctx.rates.hy_spread > 4.0 && ctx.deltas.hy_spread_d < -10;
  },

  template(ctx) {
    const entry  = priceFmt(ctx, "HBKS", 8.65);
    const stop   = +(entry * 0.95).toFixed(2);
    const target = +(entry * 1.10).toFixed(2);
    return {
      ticker:       "HBKS",
      direction:    "LONG",
      horizon:      "3 months",
      confidence:   62,
      sizePct:      3,
      entry, stop, target,
      entryLogic:   `Enter HBKS as credit breakout fails — HY OAS at ${ctx.rates.hy_spread.toFixed(2)}% but reverting (${ctx.deltas.hy_spread_d}bps). Duration benefits from flight-to-quality unwind.`,
      stopLogic:    `Stop at £${stop} (5% below). Wider stop needed to handle re-test of credit spike.`,
      targetLogic:  `Target £${target} (R≈${((target-entry)/(entry-stop)).toFixed(1)}×). HBKS rebounds as credit normalises and duration is re-valued.`,
      sizingRule:   `3% allocation. HBKS beta is 0.62 — modest equity sensitivity. Current weight ${w(ctx,'HBKS').toFixed(1)}%.`,
      rationale:    `Credit breakout failure: HY OAS hit ${ctx.rates.hy_spread.toFixed(2)}% but has reversed ${Math.abs(ctx.deltas.hy_spread_d)}bps. Failed breakouts in credit often mark local cycle highs in stress. HBKS (sukuk/duration ETF) benefits from normalising rate expectations and credit recovery.`,
      expectedDrivers: ["Credit spread reversal", "Duration re-rating", "Risk-off unwind"],
      requiredDataFreshness: "BAMLH0A0HYM2 < 24h; HBKS price < 30min",
    };
  },
};

const correlationBreak = {
  id:          "correlation-break",
  name:        "Correlation Break (AMD vs NVDA)",
  category:    "structure",
  description: "Fires when AMD and NVDA have diverged significantly in 1-day performance " +
               "(gap >8%), indicating a stock-specific vs sector event. If NVDA outperforms " +
               "AMD by >8%, this is an AMD-specific negative catalyst or a relative value " +
               "opportunity to buy the laggard. If AMD outperforms NVDA by >8%, something " +
               "AMD-specific (MI450 order?) is driving the stock.",
  invalidation: "Both names continue moving in the same direction after the divergence; sector-wide event.",
  riskNotes:    "Correlation breaks can widen before reverting. This is a higher-risk, shorter-horizon playbook.",
  requiredData: ["AMD price (chg%)", "NVDA price (chg%)"],

  trigger(ctx) {
    const amdChg  = ctx.watchlist.AMD?.chg  ?? 0;
    const nvdaChg = ctx.watchlist.NVDA?.chg ?? 0;
    return Math.abs(amdChg - nvdaChg) > 8;
  },

  template(ctx) {
    const amdChg  = ctx.watchlist.AMD?.chg  ?? 0;
    const nvdaChg = ctx.watchlist.NVDA?.chg ?? 0;
    const gap     = amdChg - nvdaChg;
    const isBull  = gap > 0; // AMD is outperforming NVDA
    const dir     = isBull ? "LONG" : "LONG"; // We LONG the laggard AMD on relative value
    const entry   = priceFmt(ctx, "AMD", 192.00);
    const stop    = +(entry * 0.92).toFixed(2);
    const target  = +(entry * 1.12).toFixed(2);
    return {
      ticker:       "AMD",
      direction:    "LONG",
      horizon:      "1 month",
      confidence:   52,
      sizePct:      2,
      entry, stop, target,
      entryLogic:   `Correlation break: AMD ${amdChg >= 0 ? '+' : ''}${amdChg.toFixed(1)}% vs NVDA ${nvdaChg >= 0 ? '+' : ''}${nvdaChg.toFixed(1)}% — gap of ${Math.abs(gap).toFixed(1)}%. ${isBull ? "AMD stock-specific catalyst." : "Relative value: AMD lagging NVDA — buy the laggard for convergence."}`,
      stopLogic:    `Stop at $${stop} (8% below). Correlation breaks can extend — use wider stop.`,
      targetLogic:  `Target $${target} (R≈${((target-entry)/(entry-stop)).toFixed(1)}×). Sector correlation historically recovers within 2–3 weeks.`,
      sizingRule:   `2% small position — correlation breaks have lower conviction. AMD beta 1.82. Current weight ${w(ctx,'AMD').toFixed(1)}%.`,
      rationale:    `AMD/NVDA 1-day return divergence of ${Math.abs(gap).toFixed(1)}% exceeds 8% threshold. In AI semiconductor sector, high inter-stock correlation means extreme short-term divergences are typically mean-reverting. ${isBull ? "AMD outperformance may be driven by company-specific news (MI450 order, analyst upgrade)." : "AMD underperformance vs NVDA suggests stock-specific drag — relative value opportunity for AMD catch-up."}`,
      expectedDrivers: ["Correlation reversion", isBull ? "AMD-specific catalyst momentum" : "AMD relative value vs NVDA", "Sector rotation"],
      requiredDataFreshness: "AMD price < 30min; NVDA price < 30min",
    };
  },
};

// ── Portfolio-Aware Playbooks (2) ─────────────────────────────────────────────

const highUsdHedge = {
  id:          "high-usd-hedge",
  name:        "High USD Exposure Hedge",
  category:    "portfolio",
  description: "Fires when the portfolio's total USD-denominated exposure exceeds 55%, " +
               "meaning the GBP value of the portfolio is heavily dependent on the USD/GBP " +
               "rate. SGLN (gold, priced in USD via GBP hedge) provides partial currency " +
               "diversification. This is a portfolio construction overlay, not a directional " +
               "macro call.",
  invalidation: "Portfolio USD exposure naturally reduces through existing position changes; GBP weakens significantly (reduces the urgency of hedging).",
  riskNotes:    "SGLN itself is USD-denominated but inversely correlated to USD (gold/dollar relationship). Consult CCY_EXP for exact exposure math.",
  requiredData: ["Portfolio FX exposure data"],

  trigger(ctx) {
    return ctx.portfolio.usdPct > 55;
  },

  template(ctx) {
    const entry  = priceFmt(ctx, "SGLN", 74.00);
    const stop   = +(entry * 0.95).toFixed(2);
    const target = +(entry * 1.08).toFixed(2);
    return {
      ticker:       "SGLN",
      direction:    "LONG",
      horizon:      "3 months",
      confidence:   60,
      sizePct:      2,
      entry, stop, target,
      entryLogic:   `Portfolio USD exposure at ${ctx.portfolio.usdPct.toFixed(1)}% (>55% threshold). Add SGLN to partially offset USD concentration risk.`,
      stopLogic:    `Stop at £${stop} (5% below). Review if USD exposure drops below 50% naturally.`,
      targetLogic:  `Target £${target} (R≈${((target-entry)/(entry-stop)).toFixed(1)}×). This is a hedge — expect muted upside vs downside protection.`,
      sizingRule:   `2% small hedge add. Total SGLN after add: ${(w(ctx,'SGLN') + 2).toFixed(1)}%. Keep below 25%.`,
      rationale:    `Portfolio USD exposure at ${ctx.portfolio.usdPct.toFixed(1)}% is above the 55% diversification threshold. AMD (100% USD) + HIES (25% USD) + HIUS (100% USD) = high GBP sensitivity to USD/GBP moves. Adding SGLN provides partial hedge as gold inversely correlates to broad USD strength. HHI: ${ctx.portfolio.hhi.toLocaleString()}.`,
      expectedDrivers: ["USD/GBP diversification", "Portfolio HHI reduction", "Gold-dollar inverse correlation"],
      requiredDataFreshness: "Portfolio data < 1h; FX_SEED usdgbp",
    };
  },
};

const concentrationHedge = {
  id:          "concentration-hedge",
  name:        "Concentration Hedge",
  category:    "portfolio",
  description: "Fires when the portfolio's Herfindahl-Hirschman Index (HHI) exceeds 2000, " +
               "indicating excessive concentration. HHI of 2000+ means the top position is " +
               "disproportionately large relative to a diversified portfolio. Adding a low-" +
               "correlated position (HBKS sukuk) reduces HHI and provides income ballast " +
               "against the dominant equity positions.",
  invalidation: "HHI naturally decreases as portfolio grows via deposits; HBKS liquidity worsens; interest rate regime changes duration attractiveness.",
  riskNotes:    "HBKS is a halal sukuk ETF with moderate liquidity on T212. Not suitable for large positions.",
  requiredData: ["Portfolio HHI data"],

  trigger(ctx) {
    return ctx.portfolio.hhi > 2000;
  },

  template(ctx) {
    const entry  = priceFmt(ctx, "HBKS", 8.65);
    const stop   = +(entry * 0.95).toFixed(2);
    const target = +(entry * 1.09).toFixed(2);
    return {
      ticker:       "HBKS",
      direction:    "LONG",
      horizon:      "6 months",
      confidence:   62,
      sizePct:      3,
      entry, stop, target,
      entryLogic:   `Portfolio HHI at ${ctx.portfolio.hhi.toLocaleString()} (>2000 concentration warning). HBKS adds low-beta income to diversify.`,
      stopLogic:    `Stop at £${stop} (5% below entry). Duration risk — exit if 10Y yields rise sharply above 5%.`,
      targetLogic:  `Target £${target} (R≈${((target-entry)/(entry-stop)).toFixed(1)}×). Sukuk income + modest capital appreciation in a flat-to-declining rate environment.`,
      sizingRule:   `3% allocation. HBKS adds diversification — low beta (0.62), income, halal-compliant. Current weight ${w(ctx,'HBKS').toFixed(1)}%.`,
      rationale:    `HHI of ${ctx.portfolio.hhi.toLocaleString()} indicates portfolio concentration above optimal diversification levels. HBKS (sukuk ETF, beta 0.62) is the least correlated asset to existing holdings. Adding 3% reduces HHI by ~${Math.round(3 * 30)} points (estimated) and provides steady income alongside AMD growth exposure. Halal-compliant.`,
      expectedDrivers: ["HHI reduction via diversification", "Sukuk income contribution", "Low-beta ballast vs equity volatility"],
      requiredDataFreshness: "Portfolio HHI < 1h; HBKS price < 30min",
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
    // Regime shift: HY spread compression or rates move counter to original thesis
    const hySpreadsCompressed  = ctx.rates.hy_spread < 2.8;
    const ratesDroppedSharply  = ctx.rates.dgs10 < 3.8;
    const curveInverted        = ctx.rates.t10y2y < -0.1;
    return hySpreadsCompressed || ratesDroppedSharply || curveInverted;
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
