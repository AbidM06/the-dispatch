/**
 * server/engine/learningLayer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Deterministic educational annotations for each engine ticket.
 * No AI required — all content is pre-written per playbook ID.
 *
 * buildLearning(ticket) → {
 *   traderInterpretation:    string,  // price-action / technical read
 *   economicsInterpretation: string,  // macro driver explanation
 *   keyTerms:  [{ term, definition }],
 *   falsification:           string[],
 * }
 *
 * Optional enrichment (budget-gated) lives in ideaEngine.js, not here.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

// ── Key terms vocabulary ───────────────────────────────────────────────────────
const TERMS = {
  realYield: {
    term: "Real Yield (DFII10)",
    definition: "10-year Treasury yield adjusted for expected inflation (TIPS breakeven). Positive real yields represent the true cost of borrowing after inflation — high real yields compress growth stock P/E multiples by raising the discount rate on future earnings.",
  },
  breakeven: {
    term: "Breakeven Inflation (T10YIE)",
    definition: "The market's 10-year inflation expectation derived by subtracting TIPS yield from nominal 10Y yield. Above 2.5% signals inflation concerns; below 2.0% signals disinflation risk.",
  },
  hySpread: {
    term: "HY OAS (High-Yield Option-Adjusted Spread)",
    definition: "The yield premium investors demand to hold sub-investment-grade bonds over Treasuries. FRED publishes it in percent (3.50 = 350bp). A high LEVEL indicates more compensation for default and liquidity risk; WIDENING is a change over time and needs a prior observation to establish.",
  },
  yieldCurve: {
    term: "Yield Curve (T10Y2Y)",
    definition: "The spread between 10-year and 2-year Treasury yields. Positive = upward-sloping; negative = inverted (historically associated with later recessions, with long and variable lags). Steepener/flattener describe CHANGES: bear steepener = long end rising faster; bear flattener = short end rising faster; bull steepener = short end falling faster; bull flattener = long end falling faster.",
  },
  hhi: {
    term: "Herfindahl-Hirschman Index (HHI)",
    definition: "A portfolio concentration measure: HHI = Σ(weight_i²) × 10,000. Below 2,000 = diversified; 2,000–2,800 = concentrated; above 2,800 = highly concentrated. Higher HHI = less diversification.",
  },
  rMultiple: {
    term: "R-Multiple",
    definition: "Trade outcome expressed as a multiple of initial risk. If entry=$100, stop=$95, target=$115: risk=5, reward=15, R=3.0×. Expectancy = hitRate × avgWin_R + stopRate × avgLoss_R. Target ≥1.5R minimum.",
  },
  carry: {
    term: "Carry",
    definition: "The income earned from holding an asset: coupon for bonds, dividend for equities, interest rate differential for FX. Positive carry = asset pays more than it costs to hold.",
  },
  duration: {
    term: "Duration",
    definition: "A bond's price sensitivity to interest rate changes. Modified duration ≈ % price change per 1 percentage-point yield move. Long-duration bonds lose more value when yields rise.",
  },
  meanReversion: {
    term: "Mean Reversion",
    definition: "The tendency of some variables to return toward an average after large deviations. A |z-score| > 1.5 is this app's trigger for a reversion setup; reversion is an assumption, not a guarantee, and depends heavily on the window used.",
  },
  correlationBreak: {
    term: "Correlation Break",
    definition: "When two historically correlated instruments diverge sharply, suggesting either relative mispricing or a change in underlying fundamentals. Creates long-short pair trade opportunities.",
  },
  zscore: {
    term: "Z-Score",
    definition: "Statistical measure of how many standard deviations a data point is from the historical mean: z = (current − mean) / σ. Above +1.5 or below -1.5 is statistically significant (roughly 93% confidence interval).",
  },
  basisRisk: {
    term: "Basis Risk",
    definition: "The residual risk when a hedge does not perfectly offset the underlying position due to different maturities, currencies, or reference assets. SGLN vs AMD: negative-beta hedge has basis risk because SGLN tracks gold, not AMD's specific factors.",
  },
  momentum: {
    term: "Momentum",
    definition: "The tendency for recent price performance to continue. 1-day momentum: price continues in the same direction intraday/next day. Cross-sectional: outperforming stocks continue to outperform over 3–12 months.",
  },
  convexity: {
    term: "Convexity",
    definition: "The curvature in the price-yield relationship for bonds. Positive convexity means bond prices rise more for a given rate decline than they fall for an equivalent rate rise — favours holders when rates are volatile.",
  },
};

// ── Playbook-specific learning content ────────────────────────────────────────

const LEARNING_MAP = {
  "hot-cpi": {
    traderInterpretation: "CPI breakeven spike signals the market is pricing accelerating inflation. Traders buy gold (SGLN) as inflation typically erodes real bond yields and equities face multiple compression. This is a 'pricing power' macro trade.",
    economicsInterpretation: "A 10Y breakeven above 2.5% means the nominal–TIPS yield gap implies average CPI inflation of roughly that much over ten years, plus inflation-risk and liquidity premia. It is market pricing, not a CPI release, and says nothing about surprises versus consensus. Gold as an inflation hedge is an assumption of this playbook.",
    keyTerms: [TERMS.breakeven, TERMS.realYield, TERMS.basisRisk, TERMS.carry],
    falsification: [
      "Breakeven inflation drops below 2.2% on a series of soft CPI prints.",
      "Fed credibility restored — sharp hike cycle brings real yields to 3%+.",
      "Gold supply shock or crypto rotation drains SGLN safe-haven flows.",
    ],
    setupType: "Macro inflation hedge",
    macroLink: "T10YIE > 2.5% is a level of market-implied inflation compensation; the gold link is an assumption, not a measured relationship.",
    whatWouldInvalidate: "Breakeven inflation drops below 2.2% on consecutive soft CPI prints.",
    checklist: {
      preTrade: ["Confirm T10YIE > 2.5% (not stale data)", "Check current SGLN weight < 22%", "Verify no FOMC in next 48h"],
      postTrade: ["Monitor T10YIE daily", "Review after next CPI print", "Trail stop if gold rallies >5%"],
    },
  },
  "soft-cpi": {
    traderInterpretation: "Falling breakeven inflation combined with tight HY spreads is the ideal goldilocks setup for growth equities. Lower inflation → lower rates → higher growth P/E multiples. AMD is a high-beta beneficiary.",
    economicsInterpretation: "Breakeven inflation < 2.0% and HY OAS < 3.0% signal the Goldilocks environment: moderate growth with disinflation. This is historically the most supportive macro regime for semiconductor growth stocks — lower discount rates directly expand P/E multiples.",
    keyTerms: [TERMS.breakeven, TERMS.hySpread, TERMS.realYield, TERMS.rMultiple],
    falsification: [
      "CPI re-accelerates above 3% driven by energy or tariff pass-through.",
      "HY spreads widen above 3.5% indicating credit deterioration.",
      "AMD specific: MI450 hyperscaler cancellations or competitive share loss to NVIDIA.",
    ],
    setupType: "Goldilocks growth long",
    macroLink: "Disinflation (T10YIE < 2.0%) + contained credit (HY < 3.0%) = best macro for growth P/E expansion.",
    whatWouldInvalidate: "CPI re-accelerates above 3% or HY spreads widen above 3.5%.",
    checklist: {
      preTrade: ["Confirm T10YIE < 2.0% and HY OAS < 3.0%", "Check AMD weight < 16%", "Review AMD earnings date proximity"],
      postTrade: ["Monitor next CPI print", "Watch HY OAS for spread widening", "Review AMD Q1 earnings (Apr 22)"],
    },
  },
  "hawkish-fed": {
    traderInterpretation: "High nominal rates with a positive yield curve signal the Fed is behind the curve or deliberately restrictive. Gold benefits from inflation hedging demand and as the yield curve signals late-cycle risk.",
    economicsInterpretation: "DGS10 > 4.5% with T10Y2Y > 0.3% is a restrictive monetary policy signal. The Fed is keeping rates elevated to fight inflation, risking a hard landing. Gold (SGLN) acts as a safe-haven in both inflation shock and hard-landing scenarios.",
    keyTerms: [TERMS.yieldCurve, TERMS.realYield, TERMS.carry, TERMS.duration],
    falsification: [
      "10Y Treasury falls below 4.0% on recession fears driving rally.",
      "Yield curve inverts (T10Y2Y < 0) signalling hard landing — equity selloff may overwhelm gold.",
      "Dollar surges sharply, pressuring gold prices in USD terms.",
    ],
    setupType: "Restrictive regime safe-haven",
    macroLink: "DGS10 > 4.5% with positive curve signals prolonged restrictive stance — gold benefits from recession-risk premium.",
    whatWouldInvalidate: "DGS10 reverses below 4.0% on surprise dovish pivot.",
    checklist: {
      preTrade: ["Confirm DGS10 > 4.5% and T10Y2Y > 0.3%", "Check DXY trend (USD headwind for gold)", "Review SGLN weight < 22%"],
      postTrade: ["Monitor Fed speeches for dovish pivot signals", "Watch DGS10 for reversal below 4.2%", "Review after next FOMC"],
    },
  },
  "dovish-fed": {
    traderInterpretation: "Low nominal rates with compressed real yields directly unlocks P/E expansion for growth stocks. AMD's high beta to rates (1.82) means it benefits disproportionately from a rate-cut cycle.",
    economicsInterpretation: "DGS10 < 4.0% and DFII10 < 1.5% is an accommodative monetary policy environment. Lower real yields reduce the opportunity cost of holding non-yielding growth assets. AMD's AI-driven earnings growth story becomes more compelling when the discount rate falls.",
    keyTerms: [TERMS.realYield, TERMS.duration, TERMS.rMultiple, TERMS.momentum],
    falsification: [
      "Fed reverses course due to inflation resurgence — rates back above 4.5%.",
      "Recession deepens — even dovish Fed cannot prevent earnings multiple compression.",
      "AMD Q1 miss above 10% vs guide — stock-specific headwind overrides macro tailwind.",
    ],
    setupType: "Dovish pivot growth long",
    macroLink: "DGS10 < 4.0% + DFII10 < 1.5% = accommodative regime, mechanically expanding growth P/E multiples.",
    whatWouldInvalidate: "Fed reverses course — rates back above 4.5% on inflation resurgence.",
    checklist: {
      preTrade: ["Confirm DGS10 < 4.0% and DFII10 < 1.5%", "Check AMD total weight < 16%", "Review upcoming FOMC date"],
      postTrade: ["Monitor rate trajectory weekly", "Watch for inflation data surprises", "Review AMD earnings date"],
    },
  },
  "payroll-proxy": {
    traderInterpretation: "A steepening 10Y–2Y curve can reflect higher expected growth, lower expected policy rates, or a rising term premium — which one matters, and a slope change alone does not say. This playbook cannot fire until 2Y history is fetched.",
    economicsInterpretation: "Bull steepening (short end falling) and bear steepening (long end rising) have different causes and different implications for equities. Attributing a steepening to payroll data requires the data release, which this app does not ingest.",
    keyTerms: [TERMS.yieldCurve, TERMS.carry, TERMS.momentum, TERMS.realYield],
    falsification: [
      "Steepening caused by supply (Treasury issuance) rather than growth — bear steepener, negative for equities.",
      "Payrolls miss significantly — growth narrative reversed.",
      "HIES KRW exposure creates FX drag if Korean Won weakens.",
    ],
    setupType: "Growth resilience risk-on",
    macroLink: "Curve steepening (T10Y2Y change > +10bp) — requires 2Y history, not currently fetched. No link to payroll surprises is claimed.",
    whatWouldInvalidate: "Yield curve flattens again (< +5bps) or HY spreads widen.",
    checklist: {
      preTrade: ["Confirm T10Y2Y delta > +10bps", "Check HIES weight", "Review NFP date proximity"],
      postTrade: ["Monitor curve slope daily", "Watch for payroll revision", "Review EM FX (KRW exposure)"],
    },
  },
  "stagflation-proxy": {
    traderInterpretation: "High inflation expectations combined with rising credit spreads signals the worst macro environment for equities: stagflation. Gold is the classical stagflation hedge — it benefits from inflation while equity beta is negative.",
    economicsInterpretation: "Stagflation (simultaneous high inflation + slowing growth) is identified by breakeven inflation > 2.4% alongside widening HY OAS > 3.5%. The 1970s playbook: inflation-linked real assets (gold, commodities) outperform both equities and nominal bonds.",
    keyTerms: [TERMS.breakeven, TERMS.hySpread, TERMS.basisRisk, TERMS.carry],
    falsification: [
      "Inflation breaks sharply lower — stagflation narrative invalidated.",
      "Growth recovers — HY spreads compress below 2.5% removing the risk-off bid.",
      "Central bank credibility shock — extremely rapid rate hikes temporarily pressure gold.",
    ],
    setupType: "Stagflation hedge",
    macroLink: "T10YIE > 2.4% + HY OAS > 3.5% = simultaneous inflation + credit stress, the worst for equities.",
    whatWouldInvalidate: "Inflation breaks sharply lower or HY spreads compress below 2.5%.",
    checklist: {
      preTrade: ["Confirm both T10YIE > 2.4% and HY OAS > 3.5%", "Check SGLN weight < 22%", "Review oil price trend"],
      postTrade: ["Monitor both signals weekly", "Watch for Fed emergency measures", "Review after next CPI"],
    },
  },
  "credit-spread-widening": {
    traderInterpretation: "HY spread widening is an early-warning credit stress signal. Institutional positioning moves defensively — flows into gold (SGLN) are a natural de-risking response. This is the 'risk-off rotation' trade.",
    economicsInterpretation: "HY OAS > 3.5% with a 15bps+ widening is a material deterioration in credit conditions. Whether spreads lead equity drawdowns, and by how long, is not measured by this app. Rising default risk and tightening lending conditions pressure corporate earnings forecasts.",
    keyTerms: [TERMS.hySpread, TERMS.basisRisk, TERMS.duration, TERMS.rMultiple],
    falsification: [
      "HY spreads reverse below 3.0% — credit stress proves transitory.",
      "Risk-off proves equity-positive (Fed put activated) — gold underperforms.",
      "SGLN already at 25%+ portfolio weight — position size constraint.",
    ],
    setupType: "Credit stress defensive",
    macroLink: "HY OAS > 3.5% with > +15bps widening signals accelerating credit deterioration, leading equities by 2-4 weeks.",
    whatWouldInvalidate: "HY OAS reverses below 3.0% quickly or Fed intervenes with liquidity facilities.",
    checklist: {
      preTrade: ["Confirm HY OAS > 3.5% and delta > +15bps", "Check SGLN weight < 22%", "Review Fed meeting calendar"],
      postTrade: ["Monitor HY OAS daily for reversal", "Watch equity index correlation", "Set tighter stop given potential for quick reversal"],
    },
  },
  "trend-continuation": {
    traderInterpretation: "MA crossover + positive price momentum is the classic trend-following signal. When short-term moving average is below long-term (rates falling) and AMD shows positive intraday momentum, both macro and technical are aligned for a continuation trade.",
    economicsInterpretation: "Falling rates (short DGS10 MA < long MA) reduce the discount rate applied to future earnings. Combined with positive price momentum, this represents macro and market-structure alignment. Trend trades have the best risk-reward when macro and technical agree.",
    keyTerms: [TERMS.momentum, TERMS.realYield, TERMS.rMultiple, TERMS.meanReversion],
    falsification: [
      "Rate trend reverses — MA crossover shifts bearish (short MA exceeds long MA).",
      "AMD price momentum fails — stock reverses intraday below entry.",
      "Macro shock (FOMC hawkish surprise) overrides technical trend signal.",
    ],
    setupType: "Trend following",
    macroLink: "Falling rate MA crossover + positive price momentum = macro-technical alignment for growth equities.",
    whatWouldInvalidate: "Rate trend reverses (MA crossover shifts bearish) or AMD breaks below entry.",
    checklist: {
      preTrade: ["Confirm MA signal = long and momentum signal = long", "Check AMD weight", "Review news for counter-trend catalysts"],
      postTrade: ["Monitor MA signal daily", "Trail stop up after >8% gain", "Exit if momentum reverses"],
    },
  },
  "mean-reversion": {
    traderInterpretation: "A z-score above +1.5 signals rates are statistically extended above their recent average. Mean reversion traders fade this extreme — rates returning to mean benefits equity multiples (for LONG) or confirms continued rate pressure (for SHORT).",
    economicsInterpretation: "Z-score mean reversion strategy uses statistical extremes. DGS10 z-score > 1.5σ above 6-month mean implies rates are unusually elevated — markets often overshoot, then revert. Rate compression from extreme levels mechanically expands growth P/E multiples.",
    keyTerms: [TERMS.zscore, TERMS.meanReversion, TERMS.realYield, TERMS.convexity],
    falsification: [
      "Z-score extends to 2.5+ — regime change, not reversion. Trend trades outperform.",
      "New inflation regime established — historical mean itself shifts higher.",
      "Credit or geopolitical shock overrides statistical mean reversion dynamic.",
    ],
    setupType: "Statistical mean reversion",
    macroLink: "Rate z-score > 1.5 sigma signals statistical extreme — reversion to mean drives equity multiple expansion.",
    whatWouldInvalidate: "Z-score extends to 2.5+ indicating regime change rather than temporary deviation.",
    checklist: {
      preTrade: ["Confirm z-score > 1.5 or < -1.5", "Check if structural regime change possible", "Review AMD weight"],
      postTrade: ["Monitor z-score weekly for convergence", "Be patient — mean reversion can take months", "Review after 30 days if no reversion"],
    },
  },
  "breakout-failure": {
    traderInterpretation: "HY OAS above 4.0% and narrowing by more than 10bp over the measured window. HELD: the expression vehicle (HBKS) has an unverified identity, so this playbook does not fire.",
    economicsInterpretation: "Spread narrowing from a high level raises high-yield bond prices, all else equal. Whether a spike reflected forced selling or fundamentals cannot be determined from the spread alone.",
    keyTerms: [TERMS.hySpread, TERMS.duration, TERMS.convexity, TERMS.carry],
    falsification: [
      "Spread compression stalls above 3.5% — fundamental deterioration, not a failed breakout.",
      "Interest rate spike simultaneously offsets spread compression benefit.",
      "Expression vehicle unverified — see CONTESTED_INSTRUMENTS in playbooks.js.",
    ],
    setupType: "Credit reversal / failed breakout",
    macroLink: "HY OAS > 4.0% and narrowing (< -10bp over the window). No claim about the cause of the prior spike.",
    whatWouldInvalidate: "Spread compression stalls above 3.5% or a genuine credit event occurs.",
    checklist: {
      preTrade: ["Confirm HY OAS > 4.0% with delta < -10bps", "Check HBKS weight", "Review for corporate default news"],
      postTrade: ["Monitor HY OAS for re-test of highs", "Use wider stop for HBKS", "Review after 2 weeks for confirmation"],
    },
  },
  "correlation-break": {
    traderInterpretation: "AMD diverging from NVDA by >8% in a single day suggests idiosyncratic news or relative mispricing. Traders play the reversion — long the underperformer relative to the outperformer. This is a statistical arb / relative value trade.",
    economicsInterpretation: "AMD and NVDA are both AI-semiconductor names and are assumed to co-move; their correlation is not measured here. A one-day divergence may be news or noise, and convergence is an assumption.",
    keyTerms: [TERMS.correlationBreak, TERMS.momentum, TERMS.rMultiple, TERMS.basisRisk],
    falsification: [
      "Divergence is fundamental (AMD loses major customer, NVDA wins exclusive contract).",
      "Both stocks continue moving in the same direction — no reversion.",
      "Sector-wide selloff overrides individual stock relative value dynamic.",
    ],
    setupType: "Relative value / pair divergence",
    macroLink: "AMD/NVDA one-day divergence > 8pp. Correlation not measured; reversion assumed.",
    whatWouldInvalidate: "Divergence is driven by fundamental shift (AMD loses customer, NVDA exclusive contract).",
    checklist: {
      preTrade: ["Confirm AMD-NVDA gap > 8% today", "Check for company-specific news driving divergence", "Review AMD weight"],
      postTrade: ["Monitor convergence over 2-3 weeks", "Exit if divergence widens further", "Watch sector news for confirmation"],
    },
  },
  "high-usd-hedge": {
    traderInterpretation: "Estimated USD exposure above 55% (from hand-entered look-through weights). Gold is priced in USD, so adding SGLN does not reduce currency exposure in a simple sense; it is used here as a diversifier whose behaviour versus the rest of the book is not measured.",
    economicsInterpretation: "Concentration in USD assets exposes a GBP-reporting investor to USD/GBP moves. Gold's relationship with the dollar and with equities varies over time; no beta is asserted.",
    keyTerms: [TERMS.basisRisk, TERMS.hhi, TERMS.carry, TERMS.realYield],
    falsification: [
      "SGLN weight already at 25%+ — adding more creates gold concentration risk.",
      "USD safe-haven bid during risk-off overwhelms gold — both rise/fall together.",
      "Portfolio shifts to GBP-denominated holdings, reducing the USD concentration problem.",
    ],
    setupType: "Portfolio FX hedge",
    macroLink: "Estimated USD exposure > 55% (look-through weights are assumptions).",
    whatWouldInvalidate: "Portfolio USD exposure naturally reduces below 50% or SGLN weight already at 25%.",
    checklist: {
      preTrade: ["Confirm USD exposure > 55%", "Check SGLN weight < 22%", "Review GBP/USD trend"],
      postTrade: ["Monitor USD exposure after rebalancing", "Review quarterly", "Reduce if USD exposure drops naturally"],
    },
  },
  "concentration-hedge": {
    traderInterpretation: "HHI > 2000 means the portfolio is concentrated. Adding any new line reduces HHI mechanically. HELD: the proposed vehicle (HBKS) has an unverified identity, so this playbook does not fire.",
    economicsInterpretation: "HHI measures concentration by weight, not by risk. Real diversification depends on correlations, which are not measured here.",
    keyTerms: [TERMS.hhi, TERMS.duration, TERMS.carry, TERMS.basisRisk],
    falsification: [
      "Vehicle unverified — see CONTESTED_INSTRUMENTS in playbooks.js.",
      "Portfolio rebalancing toward equities is the desired direction — adding bonds contradicts objective.",
    ],
    setupType: "Portfolio diversification",
    macroLink: "HHI > 2000 signals concentration. No beta or income figure is asserted for the vehicle.",
    whatWouldInvalidate: "HHI naturally decreases through deposits or HBKS weight already exceeds 10%.",
    checklist: {
      preTrade: ["Confirm HHI > 2000", "Check HBKS weight < 8%", "Review rate environment for duration risk"],
      postTrade: ["Recalculate HHI after trade", "Monitor rate trajectory", "Review quarterly for rebalancing"],
    },
  },
};

// ── Default fallback for unrecognised playbook IDs ─────────────────────────────

const DEFAULT_LEARNING = {
  traderInterpretation: "Signal-based trade: combines macro data with portfolio context to identify a risk-adjusted opportunity aligned with current regime.",
  economicsInterpretation: "Macro-driven idea: the underlying economics connect interest rate dynamics, credit conditions, or portfolio structure to a specific instrument's expected price behaviour.",
  keyTerms: [TERMS.realYield, TERMS.hySpread],
  falsification: [
    "Signal reverses before entry — thesis invalidated by market action.",
    "Macro regime shifts materially from the conditions that triggered the idea.",
  ],
};

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Build deterministic learning annotations for an engine ticket.
 *
 * @param {{ playbook: string }} ticket  Engine ticket (needs `playbook` field)
 * @returns {{ traderInterpretation, economicsInterpretation, keyTerms, falsification }}
 */
function buildLearning(ticket) {
  const content = LEARNING_MAP[ticket.playbook] || DEFAULT_LEARNING;
  return {
    traderInterpretation:    content.traderInterpretation,
    economicsInterpretation: content.economicsInterpretation,
    keyTerms:                content.keyTerms.map(t => ({ term: t.term, definition: t.definition })),
    falsification:           content.falsification,
    setupType:               content.setupType || "General",
    macroLink:               content.macroLink || "",
    whatWouldInvalidate:     content.whatWouldInvalidate || content.falsification?.[0] || "",
    checklist:               content.checklist || { preTrade: [], postTrade: [] },
  };
}

module.exports = { buildLearning };
