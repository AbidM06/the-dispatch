/**
 * server/routes/macro.js
 * S&T Sales intelligence endpoints.
 *
 * GET /api/macro/view     — global macro view (AI + deterministic fallback)
 * GET /api/macro/clients  — institutional client impact analysis (AI + fallback)
 */
"use strict";

const { Router }  = require("express");
const cache       = require("../cache");
const anthropic   = require("../providers/anthropic");
const fred        = require("../providers/fred");

const router = Router();

const TTL_MACRO_MS   = 4 * 60 * 60 * 1000;  // 4 hours — macro views don't need constant refresh
const TTL_CLIENT_MS  = 4 * 60 * 60 * 1000;

function now() { return new Date().toISOString(); }

/**
 * Extract numeric rate value from a FRED observation object.
 * getAllRates() returns { field: { seriesId, observations: [{date, value}], source } }.
 * We need the latest observation's value (a number), not the whole object.
 */
function rateVal(obs, fallback = null) {
  if (typeof obs === "number") return obs;
  if (obs && Array.isArray(obs.observations) && obs.observations.length > 0) {
    return obs.observations[0].value;
  }
  return fallback;
}
function envelope(data, source = "live", stale = false) {
  return { source, fetchedAt: now(), stale, data };
}

// ── Deterministic cross-asset matrix from FRED rates ──────────────────────────
// Used as fallback when AI unavailable. Scores -2 (very bearish) to +2 (very bullish).
function buildCrossAssetMatrix(rates = {}) {
  const { dgs10 = 4.2, dfii10 = 1.85, t10y2y = 0.5, hy_spread = 3.2, t10y_ie = 2.38 } = rates;

  function score(val, [ vbear, bear, neutral, bull, vbull ]) {
    if (val <= vbear)  return -2;
    if (val <= bear)   return -1;
    if (val <= neutral) return 0;
    if (val <= bull)   return 1;
    return 2;
  }

  // Real yield thresholds: very high real yields = duration pain
  const realYieldScore = -score(dfii10, [0.5, 1.0, 1.5, 2.0, 2.5]);

  // HY spread: wider = risk-off. Invert so higher spread = lower score
  const creditScore = -score(hy_spread, [2.0, 2.5, 3.0, 4.0, 5.0]);

  // Curve: steeper = better for growth outlook. Flat/inverted = bad
  const curveScore = score(t10y2y, [-0.5, 0, 0.3, 0.7, 1.2]);

  // Breakeven inflation: higher = good for TIPS, bad for nominal long
  const beiScore = score(t10y_ie, [1.5, 2.0, 2.3, 2.6, 3.0]);

  function label(s) {
    return s >= 1 ? "BULLISH" : s <= -1 ? "BEARISH" : "NEUTRAL";
  }
  function rationale(s, asset, context) {
    return context;
  }

  return [
    {
      asset: "US Treasuries (Long Duration)",
      signal: label(realYieldScore),
      score: realYieldScore,
      rationale: `Real yield at ${dfii10}% — ${dfii10 > 1.8 ? "high real rates compress duration; long bonds face headwinds" : dfii10 > 1.2 ? "real rates normalising but still manageable for duration" : "low real yields supportive of duration and long bonds"}.`,
    },
    {
      asset: "TIPS / Inflation-Linked",
      signal: label(beiScore),
      score: beiScore,
      rationale: `10Y breakeven at ${t10y_ie}% — ${t10y_ie > 2.4 ? "elevated inflation expectations support TIPS over nominals" : t10y_ie > 2.0 ? "breakevens near target; TIPS fairly valued vs nominals" : "low inflation expectations reduce TIPS premium"}.`,
    },
    {
      asset: "IG Credit",
      signal: label(Math.round((creditScore + curveScore) / 2)),
      score: Math.round((creditScore + curveScore) / 2),
      rationale: `HY OAS at ${hy_spread}% — ${hy_spread > 4.0 ? "spreads wide, IG credit under stress; prefer shorter duration" : hy_spread > 3.0 ? "spreads slightly elevated; selective IG still offers carry vs Treasuries" : "tight spreads reduce risk premium; limited upside in IG"}.`,
    },
    {
      asset: "HY Credit",
      signal: label(creditScore),
      score: creditScore,
      rationale: `HY OAS ${hy_spread}% — ${hy_spread > 4.5 ? "distressed territory; default risk rising" : hy_spread > 3.5 ? "spreads widening; risk/reward deteriorating for HY" : hy_spread > 3.0 ? "spreads ticking up — watch for momentum; defensive credit sectors preferred" : "benign credit environment; carry trade intact"}.`,
    },
    {
      asset: "US Equities — Growth / Tech",
      signal: label(realYieldScore + (creditScore > 0 ? 1 : 0) - 1),
      score: Math.max(-2, Math.min(2, realYieldScore + (creditScore > 0 ? 1 : 0) - 1)),
      rationale: `Real yield at ${dfii10}% pressures long-duration equities (growth/tech). ${dfii10 > 1.8 ? "Expensive multiples hard to sustain; earnings quality paramount." : "Supportive for growth but watch rate sensitivity."}.`,
    },
    {
      asset: "US Equities — Value / Cyclical",
      signal: label(curveScore + 1),
      score: Math.max(-2, Math.min(2, curveScore + 1)),
      rationale: `Yield curve at +${t10y2y}% — ${t10y2y > 0.5 ? "mild steepener supports banks and cyclicals; financials, energy, industrials in focus" : t10y2y > 0 ? "flat curve limits bank margin expansion; value vs growth rotation cautious" : "inverted curve pressures cyclicals and raises recession risk"}.`,
    },
    {
      asset: "EM Equities",
      signal: label(creditScore - 1),
      score: Math.max(-2, Math.min(2, creditScore - 1)),
      rationale: `USD rates at ${dgs10}% — ${dgs10 > 4.5 ? "high US rates drive EM capital outflows; EM FX under pressure" : dgs10 > 4.0 ? "elevated US yields keep EM under moderate pressure; selective opportunity in carry" : "declining US yields support EM; local currency bonds attractive"}.`,
    },
    {
      asset: "USD (DXY)",
      signal: label(-realYieldScore),
      score: Math.max(-2, Math.min(2, -realYieldScore)),
      rationale: `Real yield differential at ${dfii10}% — ${dfii10 > 1.8 ? "high US real rates vs peers support USD strength; watch positioning" : dfii10 > 1.0 ? "moderate real yield advantage; USD supported but not stretched" : "low real yields reduce USD carry advantage"}.`,
    },
    {
      asset: "Gold",
      signal: label(Math.round((beiScore - realYieldScore) / 2) + (creditScore < 0 ? 1 : 0)),
      score: Math.max(-2, Math.min(2, Math.round((beiScore - realYieldScore) / 2) + (creditScore < 0 ? 1 : 0))),
      rationale: `Real yield ${dfii10}% vs breakeven ${t10y_ie}% — ${dfii10 > 2.0 ? "high real yields a headwind for gold; needs geopolitical bid to outperform" : "moderate real yield + elevated breakevens support gold as inflation hedge; risk-off adds safe-haven bid"}.`,
    },
    {
      asset: "Commodities",
      signal: label(Math.round((beiScore + curveScore) / 2)),
      score: Math.max(-2, Math.min(2, Math.round((beiScore + curveScore) / 2))),
      rationale: `Inflation breakeven ${t10y_ie}%, curve +${t10y2y}% — ${t10y_ie > 2.4 ? "elevated inflation expectations support commodity complex; energy and metals sensitive to demand outlook" : "neutral commodity backdrop; geopolitical supply risk key swing factor"}.`,
    },
  ];
}

// ── Deterministic client impact fallback ──────────────────────────────────────
function buildClientFallback(rates = {}, regime = "") {
  const { dfii10 = 1.85, hy_spread = 3.2, t10y2y = 0.5, dgs10 = 4.2, t10y_ie = 2.38 } = rates;
  const riskOff = hy_spread > 3.5;
  const yieldHigh = dgs10 > 4.5;
  const realYieldHigh = dfii10 > 1.8;

  return [
    {
      type: "Pension Fund",
      icon: "🏛️",
      urgency: realYieldHigh ? "HIGH" : "MEDIUM",
      primaryConcern: realYieldHigh
        ? `Rising real yields (${dfii10}%) are improving funding ratios but marking down long-duration bond portfolios — LDI hedges are underwater.`
        : `Funded status management in a volatile rate environment — balancing liability hedging with return-seeking allocations.`,
      portfolioImpact: `Long-duration bonds down as real yields rise to ${dfii10}%. Equity allocation performing ${riskOff ? "poorly in risk-off" : "reasonably"}, creating mixed signals for de-risking triggers. LDI overlay cost has increased.`,
      theyAreAsking: [
        "Should we be adding to our rate hedge given where real yields are?",
        "How does the current spread environment affect our credit allocation?",
        "Are there any solutions to lock in current yields on the liability side?",
      ],
      talkingPoint: `With real yields at ${dfii10}% — the highest since 2007-era — many pension schemes are seeing funding ratios improve but mark-to-market losses on legacy bond positions. The opportunity is to discuss liability immunisation using interest rate swaps or long-dated gilts/Treasuries at these yields before the next leg of rate cuts.`,
      productOpportunity: `Long-dated interest rate swaps or inflation-linked bonds to lock in real yields for liability matching.`,
    },
    {
      type: "Hedge Fund (Global Macro)",
      icon: "⚡",
      urgency: "HIGH",
      primaryConcern: `Positioning crowding in rates shorts and USD longs — risk of violent unwind if Fed pivots or geopolitical risk premium collapses suddenly.`,
      portfolioImpact: `Rates short (paid fixed) positions profitable with 10Y at ${dgs10}%. USD longs working with real yield support. HY spread widening to ${hy_spread}% creating credit short opportunities. Macro vol elevated.`,
      theyAreAsking: [
        "What's your desk's view on when the Fed pivots and how sharp the move will be?",
        "Are you seeing any systematic unwind in rate shorts that could squeeze the trade?",
        "What's the cleanest expression of a hard landing / soft landing bet right now?",
      ],
      talkingPoint: `The macro setup is clear: real yields at ${dfii10}% with HY spreads at ${hy_spread}% is a risk-off configuration that historically precedes either a Fed pivot or credit stress. The key question is timing — we're watching the ${t10y2y > 0 ? "mild steepening" : "flat"} curve for signals that the market is pricing a growth slowdown. Our desk is positioned for rates vol given the asymmetric payoff.`,
      productOpportunity: `Rates vol strategies (receiver swaptions or rate cap/floor structures) to express central bank pivot uncertainty.`,
    },
    {
      type: "Asset Manager (Long-Only)",
      icon: "📊",
      urgency: riskOff ? "HIGH" : "MEDIUM",
      primaryConcern: `Benchmark underperformance risk as HY spreads widen to ${hy_spread}% and growth equity multiples compress — active managers under pressure to justify fees.`,
      portfolioImpact: `Credit allocation dragging on returns with HY OAS at ${hy_spread}%. Rate-sensitive sectors (utilities, REITs) underperforming. Value vs growth rotation ongoing. ${realYieldHigh ? "High real yields structurally challenging for long-duration equity multiples." : "Real yields moderate — growth equities holding up."}`,
      theyAreAsking: [
        "What sectors are positioned to outperform in a higher-for-longer environment?",
        "How are your flows looking — are other managers reducing risk here?",
        "Is there a case for rotating from growth into value/cyclicals at current spreads?",
      ],
      talkingPoint: `With HY spreads at ${hy_spread}% and real yields at ${dfii10}%, the market is telling you to be selective. The case for value over growth strengthens in this environment — financials benefit from a ${t10y2y > 0 ? "positive yield curve" : "flat curve recovery"}, and energy names provide inflation linkage. We'd be showing you ideas in dividend-paying cyclicals with strong balance sheets that are less sensitive to duration.`,
      productOpportunity: `Sector rotation strategies — long value/cyclicals vs short growth/high-duration equities via basket swaps or ETF overlays.`,
    },
    {
      type: "Insurance Company",
      icon: "🛡️",
      urgency: "MEDIUM",
      primaryConcern: `Reinvestment rate opportunity is improving but legacy portfolio mark-to-market losses and Solvency II / NAIC capital constraints limit ability to realise gains.`,
      portfolioImpact: `New money yields at ${dgs10}% are attractive for reinvestment. Existing long-duration bond book marked down. IG credit allocations at ${hy_spread > 3 ? "elevated" : "normal"} spread levels. Real yield at ${dfii10}% improves ALM economics for new business.`,
      theyAreAsking: [
        "What's the optimal duration to reinvest at in the current environment?",
        "Are IG spreads wide enough to add credit vs Treasuries for new money allocation?",
        "How should we think about our Solvency II SCR with rates at this level?",
      ],
      talkingPoint: `For insurers, ${dgs10}% on 10Y Treasuries is compelling for new liability matching — the question is duration and quality. We're seeing appetite for 7-10Y IG credit at ${hy_spread > 3 ? "spreads that offer 150bps+ over Treasuries" : "current spread levels"}, which provides carry while staying within Solvency II credit quality constraints. Happy to model the impact on your SCR.`,
      productOpportunity: `7-10Y IG credit or structured credit (CLO AAA tranches) offering enhanced yield within regulatory capital constraints.`,
    },
    {
      type: "Private Bank / Wealth Manager",
      icon: "💎",
      urgency: riskOff ? "HIGH" : "MEDIUM",
      primaryConcern: `HNW client portfolios showing volatility with multi-asset drawdown — clients asking about capital preservation and whether to rotate into cash/short-term bonds at ${dgs10}% yield.`,
      portfolioImpact: `International clients exposed to USD/GBP FX moves (current context: GBP/USD and USD rates divergence). Equity holdings under pressure. Alternative allocations (PE, real estate) facing valuation pressure from higher rates. Cash and short-term bonds now attractive at ${dgs10}%.`,
      theyAreAsking: [
        "Should we be moving into cash and T-bills given 5%+ short rates?",
        "How are our alternative allocations affected by higher discount rates?",
        "What's the FX exposure on our US holdings — should we hedge?",
      ],
      talkingPoint: `For HNW clients, the message is nuanced: yes, cash and T-bills at ${dgs10}% are the most attractive they've been in 15 years, but sitting in cash means missing a potential rate rally when the Fed cuts. The sweet spot is laddering into 2-5Y Treasuries or IG credit — capturing carry while maintaining flexibility. On FX, with GBP/USD at current levels, USD-denominated assets for UK-based clients have an extra FX headwind worth addressing.`,
      productOpportunity: `Treasury ladder strategies (2-5Y) or principal-protected structured notes with rates participation — capital preservation with upside optionality.`,
    },
    {
      type: "Mutual Fund",
      icon: "🌊",
      urgency: "MEDIUM",
      primaryConcern: `Retail investor redemption pressure as market volatility rises — fund managers forced to hold cash buffers that drag on performance vs benchmark.`,
      portfolioImpact: `${riskOff ? "Risk-off environment triggering retail redemptions" : "Flows broadly stable but rotation away from growth funds"}. Equity funds seeing rotation toward dividend/income strategies. Bond fund managers face duration dilemma with ${dgs10}% yields. Liquidity management paramount.`,
      theyAreAsking: [
        "Are you seeing unusual sector flow patterns that could move markets?",
        "What's the retail investor sentiment on equities right now?",
        "How are other fund managers positioning for the next FOMC meeting?",
      ],
      talkingPoint: `Retail flows are a contrarian signal worth watching — ${riskOff ? "current redemption pressure often marks bottoms in risk assets, particularly in high-quality IG credit where technicals can overshoot fundamentals" : "steady inflows into income strategies suggest the duration trade is broadening to retail, which historically precedes a rates rally"}. For fund managers needing liquidity, we can show short-dated IG credit that offers yield without duration risk.`,
      productOpportunity: `Short-duration IG credit funds or income-focused equity strategies with high dividend yield and low rate sensitivity.`,
    },
  ];
}

// ── Deterministic macro view fallback ────────────────────────────────────────
function buildMacroViewFallback(rates = {}) {
  const { dgs10 = 4.2, dfii10 = 1.85, t10y2y = 0.5, hy_spread = 3.2, t10y_ie = 2.38 } = rates;
  const matrix = buildCrossAssetMatrix(rates);

  return {
    headline:    `Real yields at ${dfii10}% and HY spreads widening to ${hy_spread}% signal a risk-off macro environment — higher-for-longer rates are the dominant regime.`,
    regimeLabel: t10y2y > 0 ? "Bear Steepener / Risk-Off" : "Bear Flattener / Risk-Off",
    scenarios: {
      base: {
        probability: 60,
        title: "Higher For Longer",
        narrative:   `Fed holds rates at 4.25-4.50% through mid-year as inflation remains sticky above 2.5%. Growth slows but avoids recession; risk assets range-bound with elevated volatility.`,
        keyAssets:   "Short-duration credit, value equities, USD, TIPS",
      },
      bull: {
        probability: 20,
        title: "Soft Landing / Rate Cuts",
        narrative:   `Inflation falls faster than expected, enabling Fed to cut 75bps by year-end. Credit spreads tighten sharply, equities rally led by growth/tech, USD weakens.`,
        keyAssets:   "Long duration Treasuries, growth equities, EM assets, gold",
      },
      bear: {
        probability: 20,
        title: "Credit Crunch / Hard Landing",
        narrative:   `HY spreads blow out through 500bps as credit conditions tighten. Corporate earnings disappoint; recession probability spikes. Fed forced to cut but equities still sell off.`,
        keyAssets:   "Treasuries (safe haven), gold, defensive equities, short HY credit",
      },
    },
    crossAsset:  matrix,
    centralBank: {
      fed: `Fed on hold at 4.25-4.50% with bias to keep rates elevated while inflation above target. Dot plot likely shows fewer cuts than market pricing; watch for any pivot in forward guidance at upcoming FOMC.`,
      boe: `Bank of England facing stagflationary mix — high wage growth vs. slowing activity. Rate path uncertain; GBP sensitive to any dovish pivot.`,
      ecb: `ECB in gradual cutting cycle; eurozone growth weak. Divergence from Fed policy creating EUR/USD downside pressure.`,
    },
    catalysts: [
      {
        event:  "US CPI Release",
        date:   "2026-04-10",
        impact: "A hot print (>3%) would force the market to price out any 2026 Fed cuts, pushing real yields higher and compressing equity multiples — sell growth, buy USD.",
      },
      {
        event:  "FOMC Meeting",
        date:   "2026-05-07",
        impact: "Dot plot and press conference key — any hint of cuts in H2 2026 could spark a sharp rally in duration and risk assets; hold language extends the current bear-flattener regime.",
      },
      {
        event:  "Non-Farm Payrolls",
        date:   "2026-04-04",
        impact: "A weak jobs number (<100k) would shift the Fed reaction function toward cuts, rally bonds and EM — the cleanest long signal in the current regime.",
      },
    ],
    morningNote: `Real yields at ${dfii10}% and HY OAS at ${hy_spread}% paint a clear picture: the market is in a risk-off, higher-for-longer regime that favours quality over duration and value over growth. With the yield curve at +${t10y2y}% and breakevens at ${t10y_ie}%, there is no imminent recession signal but there is meaningful compression in risk premium. Key event this week: watch for any Fed speak that signals shifting tolerance on inflation. Our top trade implication: long USD vs. EM FX baskets and reduce HY allocation toward IG quality.`,
    fetchedAt:   new Date().toISOString(),
    source:      "seeded",
  };
}

// ── GET /api/macro/view ───────────────────────────────────────────────────────
router.get("/view", async (req, res) => {
  const force = req.query.refresh === "true";
  const cacheKey = "macro:view";

  if (!force) {
    const cached = cache.getWithMeta(cacheKey);
    if (cached && !cached.stale) {
      return res.json(envelope(cached.value, "cache", false));
    }
  }

  // Build rates context from FRED for the AI prompt
  let rates = {};
  let ratesStr = "";
  try {
    const r = await fred.getAllRates();
    rates = {
      dgs10:     rateVal(r.dgs10, 4.2),
      dfii10:    rateVal(r.dfii10, 1.85),
      t10y_ie:   rateVal(r.t10yie, 2.38),
      hy_spread: rateVal(r.hy_spread, 3.2),
      t10y2y:    rateVal(r.t10y2y, 0.5),
    };
    ratesStr = `10Y nominal: ${rates.dgs10}%, real yield: ${rates.dfii10}%, breakeven inflation: ${rates.t10y_ie}%, HY OAS: ${rates.hy_spread}%, yield curve (10Y-2Y): ${rates.t10y2y}%`;
  } catch (_) {
    ratesStr = "latest FRED data unavailable — use web search for current rates";
  }

  // Try AI first, fall back to deterministic
  let viewData;
  let source = "live";
  try {
    const lowCost = process.env.LOW_COST_MODE === "true";
    if (lowCost) throw new Error("LOW_COST_MODE");
    viewData = await anthropic.fetchMacroView(ratesStr);
    viewData.crossAsset = viewData.crossAsset && viewData.crossAsset.length > 0
      ? viewData.crossAsset
      : buildCrossAssetMatrix(rates);
  } catch (err) {
    console.warn("[macro/view] AI unavailable, using deterministic fallback:", err.message);
    viewData = buildMacroViewFallback(rates);
    source   = "seeded";
  }

  cache.set(cacheKey, viewData, TTL_MACRO_MS);
  res.json(envelope(viewData, source, false));
});

// ── GET /api/macro/clients ────────────────────────────────────────────────────
router.get("/clients", async (req, res) => {
  const force = req.query.refresh === "true";
  const cacheKey = "macro:clients";

  if (!force) {
    const cached = cache.getWithMeta(cacheKey);
    if (cached && !cached.stale) {
      return res.json(envelope(cached.value, "cache", false));
    }
  }

  let rates = {};
  let ratesStr = "";
  let regime = "";
  try {
    const r = await fred.getAllRates();
    rates = {
      dgs10:     rateVal(r.dgs10, 4.2),
      dfii10:    rateVal(r.dfii10, 1.85),
      t10y_ie:   rateVal(r.t10yie, 2.38),
      hy_spread: rateVal(r.hy_spread, 3.2),
      t10y2y:    rateVal(r.t10y2y, 0.5),
    };
    ratesStr = `10Y nominal: ${rates.dgs10}%, real yield: ${rates.dfii10}%, breakeven inflation: ${rates.t10y_ie}%, HY OAS: ${rates.hy_spread}%, yield curve: ${rates.t10y2y}%`;
    regime   = rates.hy_spread > 3.5 ? "Bear Flattener / Risk-Off" : rates.t10y2y > 0.5 ? "Bear Steepener" : "Uncertain";
  } catch (_) {}

  let clients;
  let source = "live";
  try {
    const lowCost = process.env.LOW_COST_MODE === "true";
    if (lowCost) throw new Error("LOW_COST_MODE");
    clients = await anthropic.fetchClientImpact(ratesStr, regime);
  } catch (err) {
    console.warn("[macro/clients] AI unavailable, using deterministic fallback:", err.message);
    clients = buildClientFallback(rates, regime);
    source  = "seeded";
  }

  cache.set(cacheKey, clients, TTL_CLIENT_MS);
  res.json(envelope(clients, source, false));
});

module.exports = router;
