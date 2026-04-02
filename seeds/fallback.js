/**
 * seeds/fallback.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Canonical seed values used when live data sources are unavailable.
 * Sourced from: Trading 212 Freestyle export Mar 13 2026, FRED (Mar 11–12 2026).
 * Any time this data is served, the API envelope will include:
 *   { stale: true, source: "seeded", fetchedAt: SEED_DATE }
 * ─────────────────────────────────────────────────────────────────────────────
 */

const SEED_DATE = "2026-03-13T19:22:48.685Z"; // seed reference timestamp — T212 export Mar 13 2026

// ── FRED macro rates (Mar 5–6 2026) ──────────────────────────────────────────
const RATES_SEED = {
  dgs10:      { value: 4.21, seriesId: "DGS10",          date: "2026-03-11", source: "FRED" },
  dfii10:     { value: 1.85, seriesId: "DFII10",         date: "2026-03-11", source: "FRED" },
  t10yie:     { value: 2.38, seriesId: "T10YIE",         date: "2026-03-12", source: "FRED" },
  hy_spread:  { value: 3.17, seriesId: "BAMLH0A0HYM2",   date: "2026-03-12", source: "FRED" },
  t10y2y:     { value: 0.51, seriesId: "T10Y2Y",         date: "2026-03-12", source: "FRED" },
};

// ── FX rate ───────────────────────────────────────────────────────────────────
const FX_SEED = {
  usdgbp: { value: 0.7558, pair: "USD/GBP", date: "2026-03-13", source: "Market" },
};

// ── US watchlist (Alpha Vantage Mar 6 2026 close) ────────────────────────────
const WATCHLIST_SEED = [
  { sym: "AMD",  price: 192.82, chg: -4.03, note: "Direct position",   source: "Market",       date: "2026-03-13" },
  { sym: "NVDA", price: 177.82, chg: -3.01, note: "AI peer",           source: "Alpha Vantage", date: "2026-03-06" },
  { sym: "MSFT", price: 408.96, chg: -0.42, note: "HIUS top hold",     source: "Alpha Vantage", date: "2026-03-06" },
  { sym: "TSLA", price: 396.73, chg: -2.17, note: "HIUS top hold",     source: "Alpha Vantage", date: "2026-03-06" },
  { sym: "MU",   price: 370.30, chg: -6.74, note: "HIES semi peer",    source: "Alpha Vantage", date: "2026-03-06" },
  { sym: "AMAT", price: 324.74, chg: -6.29, note: "HIES/HIJS semi",    source: "Alpha Vantage", date: "2026-03-06" },
  { sym: "LRCX", price: 199.33, chg: -7.15, note: "Semicon equipment", source: "Alpha Vantage", date: "2026-03-06" },
];

// ── International watchlist ───────────────────────────────────────────────────
const INTL_SEED = [
  { sym: "005930.KS", name: "Samsung Elec",   price: "KRW 56,400",  chg: "+0.5%", note: "HIES 16.4%", source: "Manual", date: "2026-03-06" },
  { sym: "000660.KS", name: "SK Hynix",       price: "KRW 214,000", chg: "+1.2%", note: "HIES 15.0%", source: "Manual", date: "2026-03-06" },
  { sym: "8035.T",    name: "Tokyo Electron", price: "JPY 18,200",  chg: "-1.8%", note: "HIJS 6.0%",  source: "Manual", date: "2026-03-06" },
];

// ── Portfolio positions (personal cost-basis data) ────────────────────────────
// Shares and cost basis updated from Trading 212 — Mar 9 2026.
// costUSD / costGBP is the average purchase price per share (not total).
const POSITIONS_SEED = [
  { ticker: "AMD",  shares: 0.95439887,  costUSD: 216.70, currency: "USD" },  // partial sale Mar 13; ~0.815sh sold; cost at FX 0.7558
  { ticker: "HIES", shares: 17.53416265, costGBP: 14.436, currency: "GBP" },  // partial sale Mar 13
  { ticker: "HIUS", shares: 8.0835436,   costGBP: 27.497, currency: "GBP" },
  { ticker: "HIJS", shares: 10.94098499, costGBP: 17.355, currency: "GBP" },  // partial sale Mar 13
  { ticker: "SGLN", shares: 2.96954096,  costGBP: 71.529, currency: "GBP" },
  { ticker: "HBKS", shares: 6.41731723,  costGBP: 8.683,  currency: "GBP" },
];

// Current live prices (seeded — refreshed from Alpha Vantage / manual in production)
// `price` is the native-currency price used in valuation (USD for AMD, GBP for ETFs)
const PRICES_SEED = {
  AMD:  { price: 192.82, chg: 0, source: "Market",       date: "2026-03-13" },  // $192.82 USD (~$200.93 Mar 9, -4.0%)
  HIES: { price: 15.738, chg: 0, source: "Trading 212", date: "2026-03-13" },  // £15.774→15.738, -0.2%
  HIUS: { price: 27.135, chg: 0, source: "Trading 212", date: "2026-03-13" },  // £26.940→27.135, +0.7%
  HIJS: { price: 18.362, chg: 0, source: "Trading 212", date: "2026-03-13" },  // £18.125→18.362, +1.3%
  SGLN: { price: 74.001, chg: 0, source: "Trading 212", date: "2026-03-13" },  // £73.93→74.00, +0.1%
  HBKS: { price: 8.639,  chg: 0, source: "Trading 212", date: "2026-03-13" },  // £8.564→8.639, +0.9%
};

// ── Historical chart series (6-month, monthly) ────────────────────────────────
const RATES_HISTORY_SEED = [
  { m: "Sep 25", y10: 3.65, real: 1.42, bei: 2.23 },
  { m: "Oct 25", y10: 3.95, real: 1.58, bei: 2.37 },
  { m: "Nov 25", y10: 4.02, real: 1.65, bei: 2.37 },
  { m: "Dec 25", y10: 4.28, real: 1.79, bei: 2.49 },
  { m: "Jan 26", y10: 4.45, real: 1.91, bei: 2.54 },
  { m: "Feb 26", y10: 4.21, real: 1.75, bei: 2.46 },
  { m: "Mar 26", y10: 4.21, real: 1.85, bei: 2.38 },
];

const HY_HISTORY_SEED = [
  { m: "Sep 25", oas: 2.78 },
  { m: "Oct 25", oas: 2.92 },
  { m: "Nov 25", oas: 2.85 },
  { m: "Dec 25", oas: 2.71 },
  { m: "Jan 26", oas: 2.88 },
  { m: "Feb 26", oas: 3.12 },
  { m: "Mar 26", oas: 3.17 },
];

const RSI_HISTORY_SEED = [
  { d: "Feb 03", rsi: 55.5 },
  { d: "Feb 05", rsi: 32.5 },
  { d: "Feb 11", rsi: 44.2 },
  { d: "Feb 18", rsi: 38.7 },
  { d: "Feb 24", rsi: 49.1 },
  { d: "Mar 03", rsi: 37.5 },
  { d: "Mar 04", rsi: 45.2 },
  { d: "Mar 05", rsi: 43.8 },
  { d: "Mar 06", rsi: 40.3 },
  { d: "Mar 09", rsi: 52.1 },
];

// ── Default risk scores (AI-authored, as of seed date) ────────────────────────
const RISKS_SEED = [
  {
    id: 1, title: "US/Israel-Iran War Escalation", level: "HIGH", score: 88,
    detail: "Active military conflict between Israel and Iran with US involvement. Oil supply disruption risk elevated; Strait of Hormuz passage threatened. Stagflationary shock possible — HIES (Gulf exposure via Al Rajhi), SGLN (gold hedge active), AMD supply chain risk.",
    affects: "HIES, SGLN, AMD, HIUS",
    date: "2026-03-09",
  },
  {
    id: 2, title: "US Tariff Escalation (25% Canada/Mexico)", level: "HIGH", score: 82,
    detail: "25% tariffs on Canadian and Mexican imports enacted. Supply chain repricing across semiconductors and consumer goods. Inflation re-acceleration risk — Fed rate cut timeline pushed back.",
    affects: "HIUS, AMD, HIES",
    date: "2026-03-09",
  },
  {
    id: 3, title: "AMD ASIC Competitive Threat", level: "HIGH", score: 75,
    detail: "Custom AI chips from hyperscalers displacing merchant silicon. AMD Q1 2026 guide $9.8B disappointed vs $10.3B Q4 beat. MI450 demand key proving ground.",
    affects: "AMD only",
    date: "2026-03-09",
  },
  {
    id: 4, title: "Rising Real Yields (1.85%)", level: "MEDIUM", score: 65,
    detail: "Real yield at 1.85% (TIPS 10Y, Mar 11). Up +7bps since Mar 9; bear flattener regime. Elevated real rates compress growth stock multiples. AMD valuation and HIJS Japan growth names most exposed.",
    affects: "AMD, HIUS, HIJS",
    date: "2026-03-11",
  },
  {
    id: 5, title: "EM Currency / Dollar Stress", level: "MEDIUM", score: 55,
    detail: "USD DXY elevated. EM currencies under pressure — Korean Won weakness reduces HIES NAV in GBP terms. Samsung/SK Hynix reporting in KRW creates FX drag.",
    affects: "HIES",
    date: "2026-03-09",
  },
  {
    id: 6, title: "Credit Spread Widening", level: "MEDIUM", score: 60,
    detail: "HY OAS at 3.17% (Mar 12) — up +17bps in 6 days, risk-off signal accelerating. Combined with bear flattener in rates and tariff uncertainty, broad equity de-rating risk is rising.",
    affects: "All positions",
    date: "2026-03-12",
  },
  {
    id: 7, title: "Japan Yield Curve Control Exit", level: "LOW", score: 32,
    detail: "BoJ normalisation continues. JGB 10Y above 1.5%. Rising Japanese rates reduce relative attractiveness of HIJS holdings.",
    affects: "HIJS",
    date: "2026-03-09",
  },
];

// ── Default economic analysis (AI-authored, as of seed date) ──────────────────
const ECON_SEED = [
  {
    id: 1, label: "MACRO THEME",
    color: "#c8392b", bg: "rgba(200,57,43,.08)", border: "rgba(200,57,43,.2)",
    date: "2026-03-09",
    title: "The Iran Shock: Oil, Inflation & Stagflation Risk",
    body: "US-Israel military operations against Iran have materially re-rated geopolitical risk premia. The primary transmission mechanism is oil: Brent surged above $90 on Strait of Hormuz fears. For your portfolio, SGLN is the natural beneficiary. HIES faces a paradox: Gulf bank holdings benefit from oil windfalls, but EM risk-off weighs on Korean tech. The stagflationary combination — higher oil, tariffs, slower growth — is the most hostile macro backdrop since 2022.",
  },
  {
    id: 2, label: "RATES ANALYSIS",
    color: "#1a3a5c", bg: "rgba(26,58,92,.15)", border: "rgba(88,166,255,.2)",
    date: "2026-03-09",
    title: "Yield Curve & Rates: Bear Steepener in Progress",
    body: "10Y Treasury at 4.13% (Mar 5), real yield 1.82%, breakeven 2.35%. The bear steepener thesis is playing out — long-end rates rising faster than the front end (10Y-2Y +59bps). The Fed faces a policy bind: tariff inflation argues against cuts, but softening growth argues for easing. Elevated real yields of 1.82% mechanically compress AMD's P/E multiple.",
  },
  {
    id: 3, label: "EQUITY DEEP DIVE",
    color: "#2c6e49", bg: "rgba(44,110,73,.08)", border: "rgba(63,185,80,.2)",
    date: "2026-03-09",
    title: "AMD: Navigating the AI Bifurcation",
    body: "AMD at ~$192.82 (Mar 13, -4.0% from Mar 9). Position reduced to 0.954 shares (partial sale ~0.815sh executed); cost basis £156.31 (~$217/sh avg) — unrealised -£17.63 (-11.3%). Real yield at 1.85% and HY spreads widening to 3.17% create dual headwinds on valuation. Q1 guide $9.8B ±$300M remains the key uncertainty. FOMC Mar 19 in 6 days — any dovish signal could catalyse a relief rally. Earnings Apr 22.",
  },
];

// ── Events (AI-authored, seeded for demo) ────────────────────────────────────
const EVENTS_SEED = [
  { headline: "FOMC rate decision due 19 Mar — hold at 4.25–4.50% widely expected", impact: "NEUTRAL", ticker: "MACRO", date: "2026-03-19", detail: "Dot plot expected to signal one cut in 2026 H2; tariff-driven inflation cited as key upside risk. Decision scheduled 19 Mar." },
  { headline: "AMD guides Q1 2026 revenue $9.8B ± $300M", impact: "BEARISH", ticker: "AMD",  date: "2026-01-28", detail: "Missed elevated buy-side expectations of $10.2B; stock fell 17% post-earnings on the Q4 2025 results call." },
  { headline: "US extends tariffs to Canadian steel/aluminium", impact: "BEARISH", ticker: "HIUS", date: "2026-02-01", detail: "Broad tariff escalation adds 60–80bps to corporate cost inflation expectations across supply chains." },
  { headline: "Meta confirms $6GW AMD MI450 GPU order", impact: "BULLISH", ticker: "AMD",  date: "2026-02-18", detail: "Largest single GPU procurement in history; validates MI450 product roadmap vs NVIDIA Blackwell." },
  { headline: "Iran closes Strait of Hormuz to tankers (24h)", impact: "BEARISH", ticker: "MACRO", date: "2026-03-07", detail: "Brief closure sent Brent +8% intraday; SGLN +2.1% on safe-haven demand. Reopened within 24 hours." },
];

// ── Analytics constants ───────────────────────────────────────────────────────
const BETAS = { AMD: 1.82, HIES: 1.15, HIUS: 1.05, HIJS: 0.88, SGLN: -0.08, HBKS: 0.62 };

const CCY_EXP = {
  AMD:  { USD: 100, JPY: 0,   KRW: 0,  GBP: 0,  Other: 0  },
  HIES: { USD: 25,  JPY: 0,   KRW: 46, GBP: 0,  Other: 29 },
  HIUS: { USD: 100, JPY: 0,   KRW: 0,  GBP: 0,  Other: 0  },
  HIJS: { USD: 0,   JPY: 100, KRW: 0,  GBP: 0,  Other: 0  },
  SGLN: { USD: 100, JPY: 0,   KRW: 0,  GBP: 0,  Other: 0  },
  HBKS: { USD: 40,  JPY: 0,   KRW: 0,  GBP: 30, Other: 30 },
};

const SCENARIOS = [
  {
    id: "bear", label: "BEAR", prob: 25,
    name: "Iran Escalation + Tariff Shock",
    desc: "Brent >$100, HY spreads +200bps, stagflationary environment. Fed unable to cut. Gold surges as safe-haven.",
    shocks: { AMD: -0.25, HIES: -0.18, HIUS: -0.20, HIJS: -0.15, SGLN: +0.12, HBKS: -0.05 },
    color: "#c0392b", bg: "rgba(192,57,43,.06)", border: "rgba(192,57,43,.25)",
  },
  {
    id: "base", label: "BASE", prob: 50,
    name: "Managed De-escalation",
    desc: "Iran conflict contained, tariff negotiations restart, Fed cuts once in H2 2026. AI semiconductor demand re-accelerates.",
    shocks: { AMD: +0.08, HIES: +0.05, HIUS: +0.06, HIJS: +0.04, SGLN: -0.04, HBKS: +0.02 },
    color: "#c8972a", bg: "rgba(200,151,42,.06)", border: "rgba(200,151,42,.25)",
  },
  {
    id: "bull", label: "BULL", prob: 25,
    name: "Fed Pivot + AI Capex Boom",
    desc: "Geopolitical ceasefire, tariffs rolled back, Fed cuts 3×, AMD beats Q1 guide. Risk-on rotation into semiconductors.",
    shocks: { AMD: +0.35, HIES: +0.20, HIUS: +0.22, HIJS: +0.18, SGLN: -0.05, HBKS: +0.04 },
    color: "#1a7a4a", bg: "rgba(26,122,74,.06)", border: "rgba(26,122,74,.25)",
  },
];

const EARNINGS_CAL = [
  { date: "22 Apr", ticker: "AMD",     importance: "HIGH", event: "Q1 2026 Earnings",  est: "EPS $1.57E | Rev $9.8BE",  note: "First print after guide cut; MI300X/MI450 GPU demand key" },
  { date: "23 Apr", ticker: "MSFT",    importance: "HIGH", event: "Q3 FY26 Earnings",  est: "EPS $3.22E | Azure +22%E", note: "HIUS 7.5% top holding; Azure growth is AMD data-centre proxy" },
  { date: "30 Apr", ticker: "META",    importance: "MED",  event: "Q1 2026 Earnings",  est: "EPS $5.67E",               note: "AMD $6GW MI450 customer; capex commentary will move AMD" },
  { date: "28 May", ticker: "NVDA",    importance: "HIGH", event: "Q1 FY27 Earnings",  est: "EPS $0.93E | Rev $43BE",   note: "AI peer; Blackwell ramp sets competitive bar for AMD MI500" },
  { date: "Apr TBC", ticker: "HIES",   importance: "MED",  event: "Fund Factsheet",    est: "Monthly NAV update",       note: "Samsung Elec (16.4%) Q1 results in April — primary HIES driver" },
];

const MACRO_CAL = [
  { date: "19 Mar", ticker: "FOMC", importance: "HIGH", event: "Fed Rate Decision",   est: "Hold — 4.25–4.50%", note: "Updated dot plot & SEP; hawkish hold expected" },
  { date: "19 Mar", ticker: "BoJ",  importance: "MED",  event: "BoJ Policy Decision", est: "Hold — 0.50%",      note: "JGB 10Y above 1.5%; normalisation path key for HIJS NAV" },
  { date: "04 Apr", ticker: "NFP",  importance: "HIGH", event: "US Payrolls (Mar)",   est: "+185K",             note: "Labour market resilience determines Fed optionality" },
  { date: "10 Apr", ticker: "CPI",  importance: "HIGH", event: "US CPI (Mar)",        est: "3.1% YoY",          note: "First full month of tariff pass-through; most important print" },
  { date: "17 Apr", ticker: "ECB",  importance: "MED",  event: "ECB Rate Decision",   est: "-25bps → 2.25%",   note: "EU–US policy divergence widens; EUR/USD vol elevated" },
  { date: "07 May", ticker: "FOMC", importance: "HIGH", event: "Fed Rate Decision",   est: "Hold — 4.25–4.50%", note: "June cut depends entirely on the Apr 10 CPI print" },
];

module.exports = {
  SEED_DATE,
  RATES_SEED,
  FX_SEED,
  WATCHLIST_SEED,
  INTL_SEED,
  POSITIONS_SEED,
  PRICES_SEED,
  RATES_HISTORY_SEED,
  HY_HISTORY_SEED,
  RSI_HISTORY_SEED,
  RISKS_SEED,
  ECON_SEED,
  EVENTS_SEED,
  BETAS,
  CCY_EXP,
  SCENARIOS,
  EARNINGS_CAL,
  MACRO_CAL,
};
