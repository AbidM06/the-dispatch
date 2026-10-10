/**
 * seeds/fallback.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Canonical seed values used when live data sources are unavailable.
 * Generic market seed values only. Contains NO personal holdings, share counts or cost
 * basis — those live in gitignored data/ files and the private repo (D-22).
 * Any time this data is served, the API envelope will include:
 *   { stale: true, source: "seeded", fetchedAt: SEED_DATE }
 * ─────────────────────────────────────────────────────────────────────────────
 */

const SEED_DATE = "2026-03-13T19:22:48.685Z"; // seed reference timestamp

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
  { sym: "AMD",  price: 192.82, chg: -4.03, note: "US watchlist",      source: "Market",       date: "2026-03-13" },
  { sym: "NVDA", price: 177.82, chg: -3.01, note: "AI peer",           source: "Alpha Vantage", date: "2026-03-06" },
  { sym: "MSFT", price: 408.96, chg: -0.42, note: "US large-cap",       source: "Alpha Vantage", date: "2026-03-06" },
  { sym: "TSLA", price: 396.73, chg: -2.17, note: "US large-cap",       source: "Alpha Vantage", date: "2026-03-06" },
  { sym: "MU",   price: 370.30, chg: -6.74, note: "Semis",              source: "Alpha Vantage", date: "2026-03-06" },
  { sym: "AMAT", price: 324.74, chg: -6.29, note: "Semis",              source: "Alpha Vantage", date: "2026-03-06" },
  { sym: "LRCX", price: 199.33, chg: -7.15, note: "Semicon equipment", source: "Alpha Vantage", date: "2026-03-06" },
];

// ── International watchlist ───────────────────────────────────────────────────
const INTL_SEED = [
  { sym: "005930.KS", name: "Samsung Elec",   price: "KRW 56,400",  chg: "+0.5%", note: "Korea", source: "Manual", date: "2026-03-06" },
  { sym: "000660.KS", name: "SK Hynix",       price: "KRW 214,000", chg: "+1.2%", note: "Korea", source: "Manual", date: "2026-03-06" },
  { sym: "8035.T",    name: "Tokyo Electron", price: "JPY 18,200",  chg: "-1.8%", note: "Japan", source: "Manual", date: "2026-03-06" },
];

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

const EARNINGS_CAL = [
  { date: "22 Apr", ticker: "AMD",     importance: "HIGH", event: "Q1 2026 Earnings",  est: "EPS $1.57E | Rev $9.8BE",  note: "First print after guide cut; MI300X/MI450 GPU demand key" },
  { date: "23 Apr", ticker: "MSFT",    importance: "HIGH", event: "Q3 FY26 Earnings",  est: "EPS $3.22E | Azure +22%E", note: "Azure growth is a data-centre demand proxy" },
  { date: "30 Apr", ticker: "META",    importance: "MED",  event: "Q1 2026 Earnings",  est: "EPS $5.67E",               note: "AMD $6GW MI450 customer; capex commentary will move AMD" },
  { date: "28 May", ticker: "NVDA",    importance: "HIGH", event: "Q1 FY27 Earnings",  est: "EPS $0.93E | Rev $43BE",   note: "AI peer; Blackwell ramp sets competitive bar for AMD MI500" },
];

const MACRO_CAL = [
  { date: "19 Mar", ticker: "FOMC", importance: "HIGH", event: "Fed Rate Decision",   est: "Hold — 4.25–4.50%", note: "Updated dot plot & SEP; hawkish hold expected" },
  { date: "19 Mar", ticker: "BoJ",  importance: "MED",  event: "BoJ Policy Decision", est: "Hold — 0.50%",      note: "JGB 10Y above 1.5%; normalisation path matters for Japan equities" },
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
  RATES_HISTORY_SEED,
  HY_HISTORY_SEED,
  RSI_HISTORY_SEED,
  EARNINGS_CAL,
  MACRO_CAL,
};
