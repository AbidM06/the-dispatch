/**
 * server/routes/research.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GET /api/research/report         — Goldman Sachs-style economics comment
 * POST /api/research/report/refresh — force regenerate with optional topic
 *
 * Cost: ~$0.015 per AI call. Cached 24h — runs once daily unless refreshed.
 * Falls back to deterministic narrative when LOW_COST_MODE=true or AI unavailable.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const { Router }  = require("express");
const cache       = require("../cache");
const anthropic   = require("../providers/anthropic");
const fred        = require("../providers/fred");

const router    = Router();
const TTL_24H   = 24 * 60 * 60 * 1000;
const VALID_TYPES = new Set(["macro", "fx", "rates", "thematic", "equity", "commodities"]);

/** Extract numeric value from FRED observation object or pass through numbers. */
function rateVal(obs, fallback = null) {
  if (typeof obs === "number") return obs;
  if (obs && Array.isArray(obs.observations) && obs.observations.length > 0) {
    return obs.observations[0].value;
  }
  return fallback;
}

/** Convert raw getAllRates() result to plain numeric rates object. */
function extractRates(r) {
  return {
    dgs10:     rateVal(r.dgs10, 4.2),
    dfii10:    rateVal(r.dfii10, 1.85),
    t10y_ie:   rateVal(r.t10yie, 2.38),
    hy_spread: rateVal(r.hy_spread, 3.2),
    t10y2y:    rateVal(r.t10y2y, 0.5),
  };
}

function cacheKey(type) {
  return `research:report:${VALID_TYPES.has(type) ? type : "macro"}`;
}

function now()     { return new Date().toISOString(); }
function envelope(data, source = "live", stale = false) {
  return { source, fetchedAt: now(), stale, data };
}

// ── FX Viewpoint fallback (BofA style) ───────────────────────────────────────
function buildFxFallback(rates = {}) {
  const { dgs10 = 4.21, dfii10 = 1.85, hy_spread = 3.17 } = rates;
  const isoDate = new Date().toISOString().slice(0, 10);
  return {
    reportType: "fx",
    title: "G10 FX Viewpoint: Rate Divergence and the Dollar Premium",
    subtitle: `USD supported by real yield differential of ${dfii10}% vs. peers; we assess the key FX pairs and trade barbell.`,
    date: isoDate,
    keyTakeaways: [
      `USD retains structural support from real yield differentials: US 10Y real yields at ${dfii10}% compare favourably to European and Japanese peers, keeping the broad dollar index bid. We stay constructive USD on a 3-month horizon but acknowledge positioning is stretched.`,
      `EUR/USD faces a dual headwind: ECB is further along its cutting cycle while the Fed holds at 4.25–4.50%. Rate differentials have widened by approximately 30bp in favour of the USD YTD. We target 1.04–1.06 in the near-term, with recoveries to be faded.`,
      `JPY remains trapped between BoJ normalisation rhetoric and structural carry demand. CFTC data shows leveraged funds maintain large JPY shorts. USD/JPY intervention risk rises above 158; we see the MoF threshold as elevated, keeping us short JPY on balance.`,
      `Commodity currencies (AUD, CAD, NOK) offer selective value as a hedge against energy and materials price volatility. Long AUD/NZD screens well given Australia's LNG export advantage; we favour this as a carry-efficient way to play commodity divergence.`,
    ],
    thesis: `The dominant driver of G10 FX is US real yield exceptionalism: with 10Y TIPS at ${dfii10}%, the US offers the highest risk-free real return among G10 economies, attracting capital flows and keeping the dollar supported. Rate differentials — not terms of trade — are the primary channel this quarter. This configuration favours selling EUR and JPY rallies while using commodity FX as a partial hedge.`,
    framework: `Rate differentials explain approximately 65% of G10 FX cross-sectional variation in the current quarter. The remainder is explained by terms-of-trade dynamics (commodity exporters vs importers) and speculative positioning. Intervention risk — notably in JPY and CHF — adds non-linearity in the tails.`,
    pairViews: [
      { pair: "EUR/USD", direction: "SHORT", type: "conviction", rationale: `ECB cutting cycle vs Fed on hold creates a 30–40bp rate differential headwind for EUR. Eurozone growth is disappointing relative to consensus; PMIs remain below 50 in manufacturing. Target 1.04–1.06, stop above 1.10.`, horizon: "3 months" },
      { pair: "USD/JPY", direction: "LONG", type: "conviction", rationale: `BoJ normalisation is too slow to offset USD carry advantage. Speculative JPY shorts elevated per CFTC. Intervention risk is non-linear above 158–160, making it a tail risk rather than base case.`, horizon: "near-term" },
      { pair: "AUD/NZD", direction: "LONG", type: "normalisation", rationale: `Australia's LNG export advantage over NZD gives AUD a terms-of-trade edge in commodity cycles. RBA is more hawkish than RBNZ given different output gaps. 1.10–1.12 target.`, horizon: "1-3 months" },
      { pair: "EUR/NOK", direction: "SHORT", type: "normalisation", rationale: `Norges Bank holds while ECB cuts — narrowing rate differential favours NOK. Norway's oil-linked fiscal buffer provides macro stability. We are long NOK vs EUR on carry and policy divergence.`, horizon: "medium-term" },
    ],
    cbReactionFunctions: [
      { bank: "Federal Reserve", stance: "Hawkish hold", rationale: `Inflation above 2% target with labour market still firm keeps the Fed on hold. First cut not expected before Q3 2026. Any upside CPI surprise could push dots higher — USD positive.` },
      { bank: "European Central Bank", stance: "Gradual easer", rationale: `ECB cutting at 25bp/quarter through mid-2026. Weak Eurozone growth gives room to ease but EUR/USD weakness imported inflation is a constraint. Dovish bias — EUR negative.` },
      { bank: "Bank of Japan", stance: "Slow normaliser", rationale: `BoJ raising rates gradually but behind the curve on inflation. Political pressure to support growth limits pace of hikes. JPY remains carry-funded — negative for JPY unless intervention materialises.` },
    ],
    tradeBarbell: {
      hedges: [
        "Long USD/JPY upside via 1-month calls — hedge against JPY carry unwind",
        "Short EUR/CHF — safe haven demand in risk-off; SNB less intervention-prone than before",
        "Long gold (SGLN) — USD debasement tail hedge distinct from rate carry",
      ],
      normalisationTrades: [
        "Long AUD/NZD — terms-of-trade divergence, RBA vs RBNZ policy gap",
        "Long EUR/NOK — Norges Bank hold vs ECB cuts, Norwegian macro stability",
        "Short USD/CAD on dips — BoC likely to pause rate cuts; energy export boost",
      ],
    },
    risks: [
      "Geopolitical escalation causing oil price spike — would benefit CAD/NOK, hurt EUR/JPY via terms of trade",
      "US inflation re-acceleration above 3.5% — forces Fed to hike; USD surges disorderly",
      "BoJ surprise rate hike or coordinated FX intervention — non-linear JPY appreciation, carry unwind",
    ],
    generatedAt: new Date().toISOString(),
    source: "seeded",
  };
}

// ── Rates & Carry fallback (MS G10 FX style) ─────────────────────────────────
function buildRatesFallback(rates = {}) {
  const { dgs10 = 4.21, dfii10 = 1.85, t10y2y = 0.51 } = rates;
  const isoDate = new Date().toISOString().slice(0, 10);
  return {
    reportType: "rates",
    title: "Rates & Carry: Why Is the Carry Trade Winning Despite Rate Convergence?",
    subtitle: `JGB yields rising yet JPY weak; real yields elevated yet equities bid — we resolve the key contradictions in G10 rates markets.`,
    date: isoDate,
    keyTakeaways: [
      `Higher JGB yields have not translated into JPY strength — the dominant pattern is 'weaker JPY = rising JGB yields', reflecting higher inflation expectations rather than capital repatriation. Speculative JPY shorts remain elevated per CFTC data.`,
      `US 10Y real yields at ${dfii10}% are the highest sustained level since 2007–2008, yet equity multiples remain elevated. The resolution: carry demand and AI capex narrative are offsetting the discount rate headwind. This compression cannot persist indefinitely.`,
      `The yield curve at +${t10y2y}% (10Y–2Y) signals a mild steepener consistent with soft-landing, but the combination of elevated real yields and HY spread widening introduces a credible recession path in H2 2026. We are watching the cross-asset divergence closely.`,
      `Domestic Japanese investors are not repatriating to JGBs despite improving relative yields. Life insurers are increasing outward direct investment; investment trusts continue exporting capital. Repatriation risk is overstated — constraints vary by investor type.`,
      `The expected return on JPY carry trades has deteriorated as MoF intervention speculation mounts. Three catalysts could unwind: (1) rising geopolitical risk, (2) weakening US economy, (3) reduced Japan fiscal expansion concerns.`,
    ],
    executiveSummary: `G10 rates markets are defined by a key tension: US real yields at ${dfii10}% are restrictive by any historical measure, yet risk assets remain resilient. The resolution is carry: with FX volatility suppressed, investors continue to fund in low-rate currencies (JPY, CHF) and deploy into high-real-yield assets (USD, EM carry). This dynamic is self-reinforcing until a volatility catalyst disrupts it. We identify three scenarios for an unwind and assign rough probability weights.`,
    thePuzzle: `JPY should strengthen as BoJ hikes and US-Japan rate differentials narrow — but it has not. USD/JPY is rising alongside JGB yields, which is the opposite of the conventional capital-flow model. The resolution: domestic Japanese investors are not repatriating, while foreign speculative accounts are driving JPY short positioning. Rising JGB yields reflect inflation expectations — not rate convergence — which is dollar-positive not dollar-negative.`,
    flowAnalysis: `CFTC data shows leveraged funds hold elevated JPY short positions, consistent with carry trade activity during London and New York afternoon hours. Domestic Japanese investor flows are mixed: investment trusts continue capital export (NISA-driven household equity demand); life insurers are reducing bond exposure in favour of outward direct investment; only pension funds show modest JGB reallocation. Net: repatriation flow is marginal — speculative carry is the dominant driver. This creates a non-linear unwind risk.`,
    clientConversations: `In our conversations with clients, the dominant themes are fiscal dominance risk, carry sustainability, and whether BoJ is behind the curve. Clients note that rising JGB yields alongside JPY weakness aligns with 'fiscal dominance' narratives they have been tracking since the UK gilt crisis of 2022. They are watching Japan's bond market for signs of a Truss-style confidence shock.`,
    catalysts: [
      { catalyst: "Rising geopolitical risk (Middle East, Taiwan)", impact: "POSITIVE", detail: "Risk-off reduces carry demand, triggers JPY short covering. USD/JPY could fall toward 145 (rough fair value) in an acute scenario." },
      { catalyst: "US recession signals (NFP < 100k, ISM < 48)", impact: "POSITIVE", detail: "Weakening US economy reduces USD rate advantage, encourages Fed dovish pivot — both negative for USD/JPY carry." },
      { catalyst: "Japan fiscal tightening (Takaichi administration pivot)", impact: "POSITIVE", detail: "Reduced fiscal expansion concerns lower JGB term premium and strengthen JPY through the inflation expectations channel." },
      { catalyst: "US CPI re-acceleration above 3.5%", impact: "NEGATIVE", detail: "Forces Fed to stay hawkish longer, widens US-Japan rate differential — extends carry trade and keeps JPY weak." },
    ],
    levelTargets: [
      { pair: "USD/JPY", target: "145–150 (tail risk), 158–162 (base range)", rationale: "Fair value around 145 on real rate parity; current level reflects carry premium + fiscal risk premium. 145 is plausible in multi-catalyst unwind scenario." },
      { pair: "10Y UST Yield", target: `${dgs10}% base; 4.6–4.8% hawkish; 3.8–4.0% soft-landing`, rationale: `Real yield at ${dfii10}% with breakeven inflation at 2.4% implies nominal 4.25% is appropriate at current inflation. Downside requires clear disinflation trend.` },
      { pair: "EUR/USD", target: "1.04–1.08 (3-month range)", rationale: "Rate differential headwind from ECB cuts keeps EUR offered vs USD. Political risk premium in Eurozone limits recovery potential." },
    ],
    generatedAt: new Date().toISOString(),
    source: "seeded",
  };
}

// ── Thematic Analysis fallback (MS Thematic Lens style) ──────────────────────
function buildThematicFallback(rates = {}) {
  const { dgs10 = 4.21, dfii10 = 1.85, hy_spread = 3.17 } = rates;
  const isoDate = new Date().toISOString().slice(0, 10);
  return {
    reportType: "thematic",
    title: "The World Through a Thematic Lens: Predictions, Debates and Structural Change",
    subtitle: "AI diffusion, energy transition, multipolar geopolitics and demographic shifts — the four forces reshaping markets in 2026 and beyond.",
    date: isoDate,
    keyThemes: [
      { theme: "AI / Tech Diffusion", description: "Frontier AI capabilities are advancing non-linearly while adoption lags. The gap between AI capability and real-world deployment is widening, creating a 'narrow funnel' problem. By H2 2026, evidence of genuine productivity gains will begin to emerge in white-collar services.", stockImplication: "AI enablers (semiconductors, data centres) remain the highest-conviction trade. AMD and NVDA are direct beneficiaries of compute demand exceeding supply — a condition we expect to persist through 2027." },
      { theme: "Future of Energy", description: "Energy security has replaced energy transition as the dominant policy frame. AI data centre power demand is colliding with grid infrastructure limits. Politics of energy — local resistance to data centres, off-grid power strategies — is becoming a key investment risk.", stockImplication: "Nuclear renaissance and grid growth companies benefit. Energy exporters (Norway, Australia) gain strategic importance. Oil majors benefit from higher-for-longer energy prices." },
      { theme: "Multipolar World", description: "The US-China technology and supply chain decoupling is accelerating. Rare earths, critical minerals, and enriched uranium are geopolitical leverage points. Latin America and Southeast Asia are the swing regions in competing supply chains.", stockImplication: "Defence and critical minerals stocks outperform. Supply chain diversification creates EM differentiation — prefer commodity exporters with rule-of-law over pure manufacturing hubs." },
      { theme: "Societal Shifts", description: "AI-driven labour disruption is intersecting with demographic ageing and K-economy dynamics. Re-skilling policy intervention is becoming a political necessity across all major economies. Consumer preferences are bifurcating between value and premium.", stockImplication: "Healthcare innovation (GLP-1s, longevity tech) and education/re-skilling platforms are structural growth areas. Traditional employment-intensive businesses face structural margin pressure." },
    ],
    predictions: [
      { n: 1, prediction: "Frontier US LLMs will demonstrate a step-change in reasoning capability by H1 2026, widening the US-China AI gap. This will accelerate compute demand and stretch data centre supply chains further.", keyTheme: "AI / Tech Diffusion", investingImplication: "Long AI infrastructure (AMD, NVDA). Short AI 'picks and shovels' later in the year as capex digestion begins." },
      { n: 2, prediction: "Compute demand will systematically exceed supply through 2026, driven by proliferation of AI use cases beyond text. Video generation, robotics, and deep research are exponentially more compute-intensive.", keyTheme: "AI / Tech Diffusion", investingImplication: "Data centre power and cooling companies outperform. AMD's GPU roadmap becomes critical — any execution gap is a negative catalyst." },
      { n: 3, prediction: "Energy politics will dominate data centre planning. Local backlash against grid load will force 20%+ of new AI projects toward off-grid power solutions. This creates a structural tailwind for nuclear and distributed energy.", keyTheme: "Future of Energy", investingImplication: "Long nuclear utilities and SMR developers. Long SGLN (gold) as energy inflation hedge." },
      { n: 4, prediction: "The Trump administration will take steps to eliminate US dependency on China for critical minerals, including rare earths and enriched uranium. Executive orders will accelerate domestic production and allied-nation sourcing.", keyTheme: "Multipolar World", investingImplication: "Long critical minerals and domestic mining equities. EM differentiation: prefer Chile, Australia, Canada over China-adjacent EM." },
      { n: 5, prediction: "A broad re-skilling initiative will emerge in Europe and the US, partly government-funded. Corporate investment in workforce transition will become a measurable balance sheet item for S&P 500 companies by Q4 2026.", keyTheme: "Societal Shifts", investingImplication: "Ed-tech and corporate training platforms see re-rating. Traditional staffing agencies face secular decline." },
      { n: 6, prediction: `With real yields at ${dfii10}%, domestic capital markets in Latin America will outperform as rates globally peak. Argentina, Chile, and Mexico lead the regional recovery as policy credibility improves.`, keyTheme: "Multipolar World", investingImplication: "EM allocation toward LatAm. Prefer commodity exporters and financial sector plays in countries with improving macro fundamentals." },
      { n: 7, prediction: "GLP-1 drugs will extend beyond obesity into longevity protocols by H2 2026. This creates a 'diabesity dividend' — reduced healthcare utilisation costs of $50–100bn/year in OECD economies within 5 years.", keyTheme: "Societal Shifts", investingImplication: "Long pharmaceutical innovators. Short traditional healthcare utilisation plays (hospitals, device companies focused on obesity complications)." },
      { n: 8, prediction: "China will grow its share of global technology manufacturing despite US decoupling efforts, leveraging multiyear supply chain investments and a vast talent pool. The US re-shoring narrative will take 3–5 years to produce material domestic capacity.", keyTheme: "Multipolar World", investingImplication: "Short-term: China technology manufacturers benefit from market share gains. Long-term: US re-shoring creates domestic manufacturing opportunities." },
    ],
    debates: [
      {
        title: "Will AI drive deflation or inflation?",
        bull: "AI dramatically reduces the cost of knowledge work — legal, accounting, research, coding — creating a broad deflationary force across services. Productivity gains could suppress core services inflation by 0.5–1.0pp annually within 5 years, allowing central banks to cut rates earlier and more aggressively.",
        bear: "AI capex is massively inflationary in the near term: data centres, power infrastructure, and skilled labour are all in shortage. Energy prices rise as AI load grows. Training runs and inference at scale consume enormous resources, offsetting any deflationary productivity benefit for a decade.",
        ourView: "We believe the near-term effect is inflationary (capex, energy, labour) but the 3-5 year horizon is disinflationary as productivity gains compound. The transition period — 2025–2027 — is characterised by cost pressures. Position accordingly: long energy and infrastructure now, rotate to beneficiaries of deflation later.",
      },
      {
        title: "Is the AI adoption cycle a 'narrow funnel' or broad productivity wave?",
        bull: "AI adoption is broader than the market appreciates. Every white-collar firm is deploying AI tools; the productivity gains are real but show up in aggregate statistics with a lag. By H2 2026, AI's contribution to US labour productivity growth will be measurable at 0.3–0.5pp annually.",
        bear: "AI adoption is concentrated in a narrow set of tech-forward early adopters. Most firms are in 'pilot purgatory' — using AI for marketing copy but not core processes. The productivity wave is 5–10 years away; current valuations price in an adoption speed that will not materialise by 2027.",
        ourView: "We see a barbell: a narrow set of AI-native early adopters (finance, law, coding) capturing near-term productivity gains, while the broad economy takes longer to restructure around AI tools. This means AI enabler equities (AMD, NVDA, MSFT) remain well-supported even if aggregate productivity statistics disappoint.",
      },
      {
        title: `Are HY credit spreads at ${hy_spread}% cheap or rich given the credit cycle?`,
        bull: `HY OAS at ${hy_spread}% reflects a well-functioning credit market with low defaults (currently ~3.5%) and strong corporate balance sheets. M&A activity and strong earnings revision trends support credit quality. Spreads will tighten toward 2.5–3.0% as the soft-landing confirms.`,
        bear: `HY at ${hy_spread}% is dangerously tight given the wall of maturities in 2025–2027 and elevated refinancing costs. Sub-investment-grade issuers face interest coverage ratio deterioration as cheap pandemic-era debt rolls at 300–400bp higher coupons. Default rates will rise to 5–6% by end-2026, and spreads will reprice to 500bp+.`,
        ourView: "We are cautious on HY at current levels. The spread does not adequately compensate for late-cycle credit risk, particularly in the CCC/single-B segment. We prefer short-duration IG credit as a better risk-adjusted carry trade, and use SGLN (gold) as a portfolio hedge against credit stress.",
      },
    ],
    portfolioLinks: [
      { ticker: "AMD", theme: "AI / Tech Diffusion", rationale: "Direct beneficiary of AI compute demand — GPU and AI accelerator product lines compete with NVDA. Execution on MI300/MI400 roadmap is the critical catalyst; any market share gain from NVDA is a significant upside." },
      { ticker: "NVDA", theme: "AI / Tech Diffusion", rationale: "Dominant AI chip supplier; compute demand exceeding supply plays directly into NVDA's pricing power. Part of our watchlist — a key benchmark for the AI capex cycle health." },
      { ticker: "SGLN", theme: "Future of Energy", rationale: "Gold is the hedge against both AI-driven energy inflation and geopolitical risk in the multipolar world. Energy price volatility and USD debasement risk support gold as a structural portfolio component." },
      { ticker: "HIES", theme: "Multipolar World", rationale: "Islamic equity fund providing diversified EM and global equity exposure across the multipolar world theme. Shariah compliance means no exposure to leveraged financial risk or weapon manufacturers." },
      { ticker: "HIJS", theme: "Societal Shifts", rationale: "Japan-focused equity exposure captures the Societal Shifts theme: Japan's aging population, BoJ normalisation, and corporate governance reform are long-duration structural changes in a Shariah-compliant wrapper." },
      { ticker: "HBKS", theme: "AI / Tech Diffusion", rationale: "Global Sukuk (Islamic bond) fund provides duration exposure that benefits if AI-driven deflation eventually allows central banks to cut rates meaningfully in 2027+." },
    ],
    generatedAt: new Date().toISOString(),
    source: "seeded",
  };
}

// ── Equity Views fallback (GS US Equity style) ───────────────────────────────
function buildEquityFallback(rates = {}) {
  const { dgs10 = 4.21, dfii10 = 1.85 } = rates;
  const isoDate = new Date().toISOString().slice(0, 10);
  return {
    reportType: "equity",
    title: "US Equity Views: AI Adoption and Economic Resilience Should Support Solid EPS Growth in 2026–2027",
    subtitle: "We forecast S&P 500 EPS of $305 in 2026 (+12% YoY) and $336 in 2027 (+10%); AI productivity begins to show up in margins from H2 2026.",
    date: isoDate,
    keyTakeaways: [
      `We forecast S&P 500 EPS growth of +12% year/year in 2026 (to $305) and +10% in 2027 (to $336). Our estimates combine 7% revenue growth with 70bp of profit margin expansion, incorporating GS macro forecasts for solid US GDP growth and weaker USD.`,
      `We expect AI-driven productivity gains to lift S&P 500 EPS by +0.4% in 2026 and +1.5% in 2027. AI adoption remains early — large companies report more progress than smaller firms — but the earnings impact will build as adoption broadens and the share of potential productivity gains realised grows.`,
      `The mega-cap 7 (NVDA, AAPL, MSFT, GOOGL, AMZN, AVGO, META) account for approximately 36% of S&P 500 market cap and 26% of earnings. Their above-average sales growth and profit margins provide a mechanical tailwind to aggregate S&P 500 margins, with NVDA's projected 50% sales growth alone boosting index margins by ~30bp.`,
      `Profit margins are the key source of difference between our forecast and bottom-up consensus. Consensus shows median stock margin expansion of 89bp in 2026, which we view as too optimistic. Easing tariff pressures and continued productivity growth support expansion, but corporate surveys flag concern about input costs passing through to pricing.`,
    ],
    epsOutlook: {
      year2026: { epsGrowth: "+12% YoY", epsLevel: "$305", revenueGrowth: "+7%", marginExpansion: "+70bp to ~12.8%" },
      year2027: { epsGrowth: "+10% YoY", epsLevel: "$336", revenueGrowth: "+6%", marginExpansion: "+60bp to ~13.4%" },
      narrative: `Our 2026 EPS forecast is in line with the median top-down strategist estimate but below bottom-up analyst consensus (historical pattern is for eventual downward revision of 1-2pp). The key drivers are: (1) healthy nominal revenue growth supported by solid US GDP (~2.5%) and a modestly weaker USD; (2) continued earnings strength from the mega-cap technology complex; (3) early-stage AI productivity benefits. Downside risks to our forecast include re-acceleration of tariffs, a sharper-than-expected labour market cooling, and earnings disappointment in rate-sensitive sectors given 10Y yields at ${dgs10}%.`,
    },
    megaCapContribution: {
      marketCapShare: "~36%",
      earningsShare: "~26%",
      epsGrowthContribution2026: "~46% of index EPS growth",
      names: ["NVDA", "AAPL", "MSFT", "GOOGL", "AMZN", "AVGO", "META"],
      narrative: `The mega-cap 7's contribution to index EPS growth is declining from 50% in 2025 to 46% in 2026, as earnings growth for the S&P 493 accelerates from +7% to +9%. This broadening is a positive signal for equity market health — a narrow mega-cap rally is more vulnerable to sentiment shifts. NVDA remains the dominant incremental driver; our AI infrastructure demand forecast implies continued exceptional growth.`,
    },
    aiProductivityLift: {
      eps2026: "+0.4% EPS boost",
      eps2027: "+1.5% EPS boost",
      adoptionStatus: `AI adoption is early but accelerating. In Q3 2025 earnings calls, large-cap companies report meaningful AI integration in software development, customer service, and legal/compliance functions. Small-cap companies are 12-18 months behind large-cap peers in adoption pace. The productivity gains are real but show in aggregate statistics with a lag.`,
      mechanism: `AI boosts EPS through two channels: (1) labour productivity gains — fewer headcount needed for equivalent output, expanding operating margins; (2) revenue enablement — AI-powered products command price premiums and expand addressable markets. We model the labour productivity channel as the larger near-term driver, with revenue enablement accelerating in 2027-2028.`,
    },
    sectorViews: [
      { sector: "Technology / AI Infrastructure", stance: "Overweight", rationale: `AI capex cycle remains in early innings; hyperscaler capex budgets still growing 20%+ YoY. Semiconductor and cloud infrastructure are structural beneficiaries.`, keyRisk: "Capex digestion cycle beginning in H2 2026 could create temporary headwinds." },
      { sector: "Financials", stance: "Overweight", rationale: `Yield curve steepener (10Y at ${dgs10}%) supports net interest income. Loan growth expected to recover as rate uncertainty resolves.`, keyRisk: "Commercial real estate credit quality deterioration remains a watch." },
      { sector: "Healthcare", stance: "Neutral", rationale: `GLP-1 tailwinds to pharmaceutical innovators; headwinds for device and utilisation-sensitive businesses. Mixed sector.`, keyRisk: "Drug pricing legislation risk is an overhang for large-cap pharma." },
      { sector: "Utilities / REITs", stance: "Underweight", rationale: `Rate-sensitive sectors under pressure with 10Y at ${dgs10}%; limited growth catalysts.`, keyRisk: "Data centre power demand creates a narrow positive sub-sector within utilities." },
      { sector: "Consumer Discretionary", stance: "Neutral", rationale: `Labour market resilience supports consumer spending; however, lower-income consumer stress is emerging. Stock-picking environment.`, keyRisk: "Tariff cost pass-through uncertainty limits visibility on margins." },
    ],
    amdImplications: {
      currentEps: "~$3.00 (FY2025 non-GAAP estimate)",
      epsGrowthForecast: "+15-20% in 2026 if AI accelerator revenue scales as expected",
      aiRevenue: "~25-30% of total revenue from AI data centre GPU/accelerator products (MI300 series)",
      keyRisk: `NVDA retains dominant market share in AI training (H100/H200/B100); AMD's MI300/MI400 faces an ecosystem disadvantage (CUDA moat). China export control restrictions limit the addressable market for high-performance AI chips. Any guidance cut on AI accelerator demand is a significant negative catalyst.`,
      keyOpportunity: `Hyperscalers are actively diversifying AI chip suppliers to reduce NVDA dependence — AMD is the primary alternative. MI300X has shown strong performance benchmarks for inference workloads. A 1-2pp market share gain in AI accelerators from NVDA would be transformative for AMD's revenue trajectory and could drive meaningful EPS upgrades.`,
      valuation: `AMD trades at approximately 25-35x forward earnings (vs NVDA at 35-50x), reflecting a valuation discount for AMD's smaller AI market share and execution risk. The discount narrows if MI300/MI400 adoption scales faster than expected. Real yield headwind at ${dfii10}% compresses growth stock multiples across the board.`,
    },
    consensusComparison: {
      vsBottomUp: "GS forecast is 1-2pp below bottom-up analyst consensus for 2026 EPS, consistent with historical pattern of over-optimism in bottom-up estimates",
      vsTopDown: "In line with median top-down strategist consensus",
      keyDifference: `The key divergence vs bottom-up consensus is profit margin assumptions: consensus assumes 89bp median stock margin expansion, which we view as too optimistic given tariff uncertainty and input cost pressures. Our top-down approach applies a haircut to bottom-up margin estimates based on historical over-optimism.`,
    },
    generatedAt: new Date().toISOString(),
    source: "seeded",
  };
}

// ── Deterministic fallback report (when AI unavailable) ───────────────────────
function buildFallbackReport(rates = {}) {
  const { dgs10 = 4.21, dfii10 = 1.85, hy_spread = 3.17, t10y_ie = 2.38, t10y2y = 0.51 } = rates;
  const isoDate = new Date().toISOString().slice(0, 10);

  return {
    title:    "Global Macro Outlook: Higher-For-Longer Rates and Credit Stress",
    subtitle: `Real yields at ${dfii10}% and HY spreads at ${hy_spread}% signal persistent tightening — we assess the macro transmission and policy implications.`,
    date:     isoDate,
    abstract: [
      `Global financial conditions remain restrictive with US 10-year real yields at ${dfii10}%, the highest sustained level since 2007–2008. We estimate this configuration reduces global growth by approximately 0.3–0.5pp relative to a neutral rate environment, with the drag concentrated in rate-sensitive sectors.`,
      `HY credit spreads at ${hy_spread}% OAS have widened materially from cycle lows, signalling deteriorating risk appetite in leveraged credit markets. We see incremental downside growth risks if spreads widen further toward 450–500bp, which historically has been associated with a credit crunch transmission to real economic activity.`,
      `Breakeven inflation at ${t10y_ie}% remains above the Fed's 2% target, keeping the Fed on hold and deferring any dovish pivot. We anticipate the FOMC will hold rates at 4.25–4.50% through mid-year, with cuts contingent on sustained CPI deceleration toward 2.3–2.5%.`,
      `The yield curve at +${t10y2y}% (10Y–2Y) signals a mild steepening consistent with a soft-landing base case, though the combination of elevated real yields and widening HY spreads introduces meaningful recession risk in the back half of 2026. Central banks have limited room to ease pre-emptively given above-target inflation.`,
    ],
    mainChannel: `The primary transmission mechanism from elevated rates to the real economy operates via three channels: (1) household mortgage and consumer credit costs, which remain elevated following the 2022–2023 hiking cycle; (2) corporate refinancing risk, particularly for sub-investment-grade issuers facing wall of maturities in 2025–2027; and (3) financial conditions tightening, where HY OAS at ${hy_spread}% implies an incremental drag of approximately 0.2pp on investment spending if sustained. Our rules of thumb suggest each 100bp increase in real yields reduces global growth by 0.15–0.25pp over a 12–18 month horizon, consistent with the current configuration.`,
    scenarios: {
      baseline: {
        label:      "Baseline — Soft Landing",
        anchor:     `10Y at ${dgs10}%, HY OAS stable at ${hy_spread}%`,
        gdpImpact:  "-0.2pp to 2026 global GDP growth vs. neutral",
        cpiImpact:  "+0.0pp (rates suppressing demand-pull inflation)",
        narrative:  `Under our baseline, the Fed holds rates at 4.25–4.50% through Q2 2026 before executing 50bp of cuts in H2 2026 as inflation decelerates toward 2.4%. Real yields gradually compress to 1.5–1.6% by year-end, providing modest relief to rate-sensitive sectors. HY spreads stabilise or tighten modestly as credit fundamentals hold and default rates stay below 4%.`,
      },
      stress: {
        label:      "Stress — Credit Crunch",
        anchor:     `HY OAS widens to 500bp+, 10Y rises to 4.8%`,
        gdpImpact:  "-0.6pp to 2026 global GDP growth",
        cpiImpact:  "+0.1pp (supply disruption offset by demand weakness)",
        narrative:  `The stress scenario materialises if HY defaults accelerate — driven by a combination of refinancing pressure and earnings disappointments — pushing OAS above 500bp. Financial conditions tighten significantly (we estimate a 60–80bp FCI move), reducing credit availability and business investment. The Fed would be forced to cut more aggressively (100–150bp in H2 2026) but at the cost of above-target inflation persistence.`,
      },
    },
    secondaryRisks: [
      {
        channel:     "Geopolitical risk premium",
        magnitude:   "15–20bp FCI tightening on escalation",
        growthImpact: "-0.1 to -0.2pp if sustained 6 months",
        narrative:   `Geopolitical developments — particularly Middle East tensions affecting oil supply — add a risk premium to financial conditions that is distinct from the rate channel. Historically, a 10% oil supply shock has added approximately 0.2pp to headline inflation and reduced global growth by 0.1pp over 12 months; effects are larger for European and EM oil importers.`,
      },
      {
        channel:     "USD strength and EM capital outflows",
        magnitude:   "DXY elevated; EM FX under pressure",
        growthImpact: "-0.2pp EM growth if USD remains strong",
        narrative:   `Elevated US real yields attract capital flows from EM economies, pressuring EM currencies and forcing EM central banks to maintain tighter policies than domestic conditions warrant. We see incremental downside risks to EM growth, particularly for economies with high USD-denominated debt: Turkey, Brazil, Indonesia, and South Africa are most exposed.`,
      },
      {
        channel:     "Inflation expectations de-anchoring",
        magnitude:   "Breakeven inflation at " + t10y_ie + "%",
        growthImpact: "+0.1pp CPI if breakevens rise 20bp further",
        narrative:   `Breakeven inflation at ${t10y_ie}% is above the Fed's 2% target but below the 2.7–3.0% levels that would signal genuine de-anchoring. Historically, a 10% increase in oil prices adds approximately 4bp to long-run inflation expectations; this relationship is amplified when current inflation is already elevated, as it is now.`,
      },
    ],
    policyImplications: {
      fed:     `The Federal Reserve faces a classic higher-for-longer dilemma: inflation remains above target at ~2.8% YoY while the labour market shows early signs of softening. Under our baseline, we expect the FOMC to hold at 4.25–4.50% through H1 2026, with the first 25bp cut in Q3 2026. Hawkish risk: if CPI re-accelerates above 3.0% or oil spikes, the dot plot would shift toward zero 2026 cuts.`,
      boe:     `The Bank of England faces a more challenging dual mandate balance: UK wage growth remains above 5% while economic activity is stagnating. We recently delayed our forecast for the next BOE cut to Q2 2026; risks are skewed toward a further delay if US rate resilience keeps sterling under pressure.`,
      ecb:     `The ECB is further along its cutting cycle, having reduced rates 100bp since June 2024. Eurozone growth weakness supports further easing; however, EUR/USD weakness imported from USD strength could stoke imported inflation, creating a hawkish constraint. We see the ECB cutting 25bp per quarter through mid-2026.`,
      overall: `DM central banks are collectively in a "pause and assess" mode: the Fed on hold, BOE cautious, ECB gradual easer. This configuration is consistent with a higher-for-longer global rate environment that keeps financial conditions restrictive relative to pre-2022 norms.`,
    },
    marketImplications: {
      rates:   `The current rate configuration favours the 2–5Y part of the Treasury curve, where real yields are most attractive and duration risk is limited. The long end (10–30Y) faces pressure from fiscal supply concerns and term premium re-pricing; we see the 10Y range as 4.0–4.5% in the baseline.`,
      equities: `Equity valuations remain stretched on a real yield basis: the S&P 500 earnings yield of ~5% provides only a modest premium over 10Y Treasuries at ${dgs10}%, versus a historical 200–300bp equity risk premium. Rate-sensitive growth equities are most exposed; we prefer value, financials (yield curve steepener), and dividend-paying defensives.`,
      credit:  `We prefer IG over HY at current spread levels. HY OAS at ${hy_spread}% is not yet compensation for late-cycle default risk; the crossover point historically is 350–400bp for IG-equivalent risk. Short-duration IG credit (3–5Y) offers the best risk-adjusted carry in fixed income.`,
      fx:      `USD remains supported by real yield differentials relative to EUR and JPY. EUR/USD has limited upside while the Fed holds and the ECB cuts; our baseline range is 1.04–1.09. EM FX faces headwinds from USD strength and risk-off dynamics — prefer commodity exporters (BRL, CLP) over rate-sensitive importers (TRY, IDR).`,
      topTrade: `Long 2–5Y US Treasuries (real yield pick-up + Fed cut optionality) versus short HY credit (spread widening + default risk) — a barbell that performs in both soft-landing and stress scenarios.`,
    },
    keyMetrics: [
      { label: "10Y Nominal Yield",      current: dgs10 + "%",    baseline: "4.0–4.5%",  stress: "4.5–5.0%" },
      { label: "10Y Real Yield (TIPS)",  current: dfii10 + "%",   baseline: "1.5–1.8%",  stress: "2.0–2.3%" },
      { label: "HY OAS",                 current: hy_spread + "%", baseline: "3.0–3.5%", stress: "4.5–5.5%" },
      { label: "Breakeven Inflation",    current: t10y_ie + "%",  baseline: "2.2–2.4%",  stress: "2.5–2.8%" },
      { label: "Yield Curve (10Y–2Y)",   current: "+" + t10y2y + "%", baseline: "+0.5–1.0%", stress: "-0.2–0.0%" },
    ],
    conclusion: `The global macro backdrop in early 2026 is characterised by a tension between persistent inflation (keeping central banks on hold) and rising credit stress (HY spreads, EM pressure). Under our baseline soft-landing scenario, this tension resolves gradually as inflation decelerates and the Fed executes modest cuts in H2 2026. The risks are skewed to the downside: a credit event or geopolitical escalation could trigger a disorderly tightening of financial conditions that the current rate structure — with limited policy space — would struggle to absorb. We watch HY OAS, breakeven inflation, and Q1 2026 earnings guidance as the three primary stress indicators.`,
    generatedAt: new Date().toISOString(),
    source: "seeded",
  };
}

// ── Commodities fallback (GS Oil Comment style) ───────────────────────────────
function buildCommoditiesFallback(rates = {}) {
  const { dgs10 = 4.21, dfii10 = 1.85 } = rates;
  const isoDate = new Date().toISOString().slice(0, 10);
  return {
    reportType: "commodities",
    title: "Oil Comment: Mounting Upside Risks to Prices From Hormuz Disruption",
    subtitle: "Persian Gulf oil flows are down ~90% of normal levels; we identify four reasons why upside price risks are growing faster than the market has priced.",
    commodity_focus: "Oil",
    conviction: "HIGH",
    date: isoDate,
    keyTakeaways: [
      "Estimated oil flows through the Strait of Hormuz are down to approximately 2mb/d, around 10% of normal 20mb/d — well below our baseline assumption of 15% normalisation. The supply shock now stands at 17mb/d, 17 times larger than the peak April 2022 hit to Russian production.",
      "Alternative redirection via pipelines and ports at Yanbu and Fujairah is running at only 0.9mb/d against a theoretical maximum of 3.6mb/d — physical infrastructure constraints limit the bypass option in the near term, extending the duration of the supply shock.",
      "We now think oil prices would likely exceed $100/bbl next week if no resolution emerges. If SoH flows remain depressed through March, Brent could exceed the 2008 and 2022 peaks, as inventory depletion forces demand destruction at higher inventory levels than simple models suggest.",
      "Three paths to normalisation exist: (a) geopolitical de-escalation, (b) US naval protection for tankers, (c) Iran granting safe passage to vessels of specific nationalities. Until one materialises, physical market tightness accelerates."
    ],
    supply_demand: {
      supply_narrative: "Strait of Hormuz flows have collapsed to approximately 10% of normal (2mb/d vs 20mb/d normal). Pipeline redirection to Yanbu (Red Sea) and Fujairah (Gulf of Oman) is constrained by infrastructure, running at 0.9mb/d vs theoretical capacity of 3.6mb/d. This creates a net daily supply shortfall of approximately 17mb/d — the largest supply disruption since the 1973 Arab Oil Embargo in absolute terms. Insurance costs for tankers have surged, adding approximately $2–4/bbl to shipping costs for cargoes that do pass.",
      demand_narrative: "Global oil demand remains approximately 103mb/d, with Asian importers (China, India, Japan, South Korea) most exposed as approximately 60% of their crude imports transit the Strait. Near-term demand destruction is limited — consumers are hoarding, not reducing consumption, which creates a 'front-loaded inventory draw' dynamic that is likely pulling prices above equilibrium clearing levels. European and US refiners face tighter product supply rather than crude supply directly.",
      balance: "The physical market is in a deficit of approximately 2–4mb/d in the current disruption scenario, against a pre-disruption balance that was roughly flat. OECD commercial inventories are being drawn at an estimated 1.5–2mb/d faster than seasonal normal, which at this pace exhausts the inventory buffer in 8–12 weeks."
    },
    price_targets: [
      { commodity: "Brent Crude", current: "$85/bbl", dispatch_base: "$95/bbl", dispatch_bull: "$115/bbl", dispatch_bear: "$75/bbl", rationale: "Base assumes partial Hormuz normalisation within 3–4 weeks; bull assumes sustained closure through Q2." },
      { commodity: "WTI Crude",  current: "$81/bbl", dispatch_base: "$91/bbl", dispatch_bull: "$111/bbl", dispatch_bear: "$71/bbl", rationale: "WTI-Brent spread widens as US shale output partially offsets global shortfall." },
      { commodity: "Gold",       current: "$2,650/oz", dispatch_base: "$2,750/oz", dispatch_bull: "$3,100/oz", dispatch_bear: "$2,400/oz", rationale: "Gold benefits from risk premium and inflation expectations re-anchoring upward." }
    ],
    scenarios: {
      bear:  { label: "Bear",        probability: "20%", trigger: "Rapid geopolitical de-escalation — ceasefire within 2 weeks, Hormuz flows normalise to 15mb/d", price_outcome: "Brent falls to $70–75/bbl on demand destruction reversal and inventory rebuild", narrative: "A rapid diplomatic resolution — likely mediated by Oman or Qatar — restores tanker confidence and flows normalise within 2 weeks. OPEC+ does not cut to defend price. Demand destruction that occurred during the spike reverses, pushing prices back toward pre-disruption levels of $75–80/bbl. This scenario requires active US diplomatic engagement and a specific Iranian concession." },
      base:  { label: "Base",        probability: "55%", trigger: "Partial normalisation over 4–6 weeks, Hormuz flows recover to 10–12mb/d", price_outcome: "Brent stabilises at $90–100/bbl through Q2-26", narrative: "Flows gradually recover as physical risk premium persists but US naval escorts restore partial tanker confidence. OPEC+ holds current production. Inventory draws slow from 2mb/d to 0.5mb/d by Q2. Demand destruction in price-sensitive Asian markets partly offsets supply shortfall. Brent settles into a $90–100/bbl range — higher than the pre-crisis baseline but below the spike levels." },
      bull:  { label: "Bull / Stress", probability: "25%", trigger: "Sustained Hormuz closure through Q2, escalation to refinery infrastructure", price_outcome: "Brent exceeds $115/bbl, refinery margins widen sharply", narrative: "The disruption extends beyond 6 weeks with Iranian strikes on Saudi and UAE energy infrastructure, extending the supply shock. OECD inventories breach critical lows, triggering IEA emergency reserve releases (insufficient to fully offset the shortfall). Oil prices breach 2008 highs as demand destruction is required at higher inventory levels than conventional models assume — the non-linearity the market is currently underpricing." }
    },
    scenario_chart: [
      { period: "NOW",   bear: null, base: null, bull: null, actual: 85 },
      { period: "Q2-26", bear: 72,  base: 95,   bull: 115,  actual: null },
      { period: "Q3-26", bear: 70,  base: 90,   bull: 108,  actual: null },
      { period: "Q4-26", bear: 75,  base: 85,   bull: 100,  actual: null },
      { period: "Q1-27", bear: 78,  base: 82,   bull: 92,   actual: null }
    ],
    scenario_chart_label: "Brent Crude ($/bbl)",
    dispatch_angle: {
      headline: "Hormuz closure may permanently accelerate Gulf sovereign wealth pivot to renewables",
      mechanism: "Gulf states (Saudi, UAE, Kuwait) have been slow to diversify their fiscal base from oil precisely because oil revenues feel permanent. A sustained Hormuz closure forces two simultaneous realisations: (1) their own oil export revenues are disrupted, squeezing sovereign budgets; (2) the disruption dramatically accelerates energy security investment globally, particularly in renewable energy and nuclear, which structurally reduces the long-run demand ceiling for Gulf crude. This is the moment where the geopolitical risk premium in oil and the long-run demand destruction premium merge — an event that historically catalyses Gulf sovereign diversification into non-oil assets at a pace that surprises markets.",
      winners: [
        "Saudi Aramco's downstream / chemicals division: if upstream export revenue is disrupted, downstream refining and petrochemicals in Asia become more valuable as a supply chain hedge",
        "US shale producers (Pioneer, Diamondback, EOG): the only major oil production basin entirely outside the disruption zone benefits from price spike and accelerated long-term contract demand",
        "Renewable energy developers and nuclear builders (Constellation, Cameco, Vestas): geopolitical proof-of-concept for energy security investment triggers acceleration of government capital allocation",
        "Gold (SGLN): dual beneficiary — inflation expectations re-anchor upward AND geopolitical risk premium re-prices from 'tail risk' to 'structural premium'"
      ],
      losers: [
        "Asian oil refiners (South Korea, Japan, India): lack alternative crude routes at equivalent landed cost; refinery margins squeezed by product demand strength meeting crude supply constraint",
        "Airline sector globally: jet fuel accounts for 20–30% of operating costs; pass-through to ticket prices is limited by demand elasticity, compressing margins",
        "EM oil importers with weak FX reserves (Egypt, Pakistan, Bangladesh): combination of higher oil import bill and USD strength creates acute balance of payments pressure"
      ],
      trade_expression: "Long Brent crude Dec-26 calls (strike $100) vs short Asian refiner equities — captures the production disruption premium while expressing the refinery margin compression from product-cost divergence"
    },
    client_impact: [
      { type: "Pension / Insurance", relevance: "HIGH", positioning_change: "Review commodity overlay allocation — the case for 5–8% real assets allocation as inflation hedge has strengthened materially; energy infrastructure and commodities should be evaluated for rebalancing.", risk: "Higher energy costs feed through to inflation expectations, compressing real bond returns and increasing liability present values for insurance.", opportunity: "Long-dated oil infrastructure assets (pipelines, LNG terminals outside the disruption zone) offer inflation-linked cashflows at attractive entry points during market dislocation." },
      { type: "Hedge Fund / Macro PM", relevance: "HIGH", positioning_change: "Event-driven long in crude via futures/options; pair trade long US energy producers vs short Asian oil importers captures the geographic asymmetry of the supply shock.", risk: "Rapid diplomatic resolution is the primary tail risk — options premium decay rapidly in a de-escalation scenario; size positions with defined risk.", opportunity: "The Dispatch Angle trade: long gold + long US shale equities + short global airline sector captures three legs of the second-order cascade simultaneously." },
      { type: "Sovereign Wealth / Endowment", relevance: "MEDIUM", positioning_change: "For Gulf SWFs, the paradox: oil revenues are disrupted short-term but the long-run demand ceiling for oil is lower post-crisis — accelerate portfolio diversification toward non-correlated alternatives.", risk: "Hydrocarbon-heavy SWFs (Kuwait, Qatar) face direct revenue disruption if the closure extends beyond 6 weeks; fiscal buffer drawdown risk.", opportunity: "Technology and renewable energy equity baskets globally — the crisis provides political cover for accelerated capital reallocation that the SWF mandate has been slow to execute." },
      { type: "Long-Only Asset Manager", relevance: "MEDIUM", positioning_change: "Overweight energy sector within global equity mandates; underweight aviation, consumer discretionary (high fuel cost pass-through sensitivity), and EM exporters to Gulf (reduced remittance income).", risk: "Benchmark energy weightings (typically 4–6% in global indices) are insufficient to hedge inflation pass-through to portfolio companies; underweight energy exposes the fund to tracking error in a sustained oil spike.", opportunity: "Integrated oil majors with non-Middle Eastern production (BP, Shell, TotalEnergies, ExxonMobil) benefit from price spike with manageable supply disruption exposure." }
    ],
    macro_linkages: "A $20/bbl increase in Brent adds approximately 0.4–0.5pp to headline CPI in oil-importing economies (US: ~0.25pp, Europe: ~0.5pp, Japan: ~0.7pp) via energy components and transport cost pass-through. This is likely to delay Fed and ECB rate cuts by one additional meeting. Currency markets will see USD strengthen vs energy-importing EM currencies (INR, KRW, TRY) and petrocurrency outperformance (CAD, NOK, BRL). Global equity earnings face a 1–3pp headwind from higher input and transport costs, concentrated in consumer discretionary and industrials.",
    key_watchpoints: [
      "Weekly EIA US crude inventory report — any draw above 3mb/week confirms demand destruction has not yet offset supply disruption",
      "OPEC+ emergency meeting or quota communication — production increase would partially offset Hormuz shortfall and cap price upside",
      "Strait of Hormuz vessel count (tracked via Bloomberg/Kpler) — the primary real-time indicator of whether flows are normalising"
    ],
    generatedAt: new Date().toISOString(),
    source: "seeded",
  };
}

function buildFallbackForType(type, rates) {
  if (type === "fx")          return buildFxFallback(rates);
  if (type === "rates")       return buildRatesFallback(rates);
  if (type === "thematic")    return buildThematicFallback(rates);
  if (type === "equity")      return buildEquityFallback(rates);
  if (type === "commodities") return buildCommoditiesFallback(rates);
  return buildFallbackReport(rates);
}

// ── GET /api/research/report ──────────────────────────────────────────────────
router.get("/report", async (req, res) => {
  const type   = VALID_TYPES.has(req.query.type) ? req.query.type : "macro";
  const key    = cacheKey(type);
  const cached = cache.getWithMeta(key);
  if (cached && !cached.stale) {
    return res.json(envelope(cached.value, "cache", false));
  }

  // Build rates context for AI prompt
  let rates = {};
  let ratesStr = "";
  try {
    const r = await fred.getAllRates();
    rates    = extractRates(r);
    ratesStr = `10Y: ${rates.dgs10}%, real yield: ${rates.dfii10}%, HY OAS: ${rates.hy_spread}%, BEI: ${rates.t10y_ie}%, curve: ${rates.t10y2y}%`;
  } catch (_) {}

  let report;
  let source = "live";
  try {
    if (process.env.LOW_COST_MODE === "true") throw new Error("LOW_COST_MODE");
    report = await anthropic.fetchResearchReport(ratesStr, "", type);
  } catch (err) {
    console.warn(`[research:${type}] AI unavailable, using deterministic fallback:`, err.message);
    report = buildFallbackForType(type, rates);
    source = "seeded";
  }

  cache.set(key, report, TTL_24H);
  res.json(envelope(report, source, false));
});

// ── POST /api/research/report/refresh ────────────────────────────────────────
router.post("/report/refresh", async (req, res) => {
  const { topic, type: bodyType } = req.body || {};
  const type   = VALID_TYPES.has(bodyType || req.query.type) ? (bodyType || req.query.type) : "macro";
  const key    = cacheKey(type);

  let rates = {};
  let ratesStr = "";
  try {
    const r = await fred.getAllRates();
    rates    = extractRates(r);
    ratesStr = `10Y: ${rates.dgs10}%, real yield: ${rates.dfii10}%, HY OAS: ${rates.hy_spread}%, BEI: ${rates.t10y_ie}%`;
  } catch (_) {}

  let report;
  let source = "live";
  try {
    if (process.env.LOW_COST_MODE === "true") throw new Error("LOW_COST_MODE");
    report = await anthropic.fetchResearchReport(ratesStr, topic || "", type);
  } catch (err) {
    console.warn(`[research:${type}] AI unavailable, using deterministic fallback:`, err.message);
    report = buildFallbackForType(type, rates);
    source = "seeded";
  }

  cache.set(key, report, TTL_24H);
  res.json(envelope(report, source, false));
});

module.exports = router;
