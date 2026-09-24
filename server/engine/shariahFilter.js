/**
 * server/engine/shariahFilter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Islamic Shariah compliance screening for The Dispatch idea engine.
 *
 * Based on: Alam et al. (2017) "The Islamic Shariah Principles for Investment
 * in Stock Market", QRFM 9(2):132-146, and major Islamic index methodologies
 * (DJIM, FTSE Shariah, S&P 500 Shariah, Securities Commission Malaysia SAC).
 *
 * Core principles applied:
 *   1. Business activity screening — haram sectors are prohibited
 *   2. Financial ratio screening — debt/assets ≤ 33%, interest income ≤ 5%
 *   3. Transaction screening — no short-selling, no derivatives, no margin
 *   4. Common stock only — preferred stock has riba characteristics
 *
 * Prohibited sectors (hard block):
 *   - Riba (interest): conventional banks, insurance, finance companies
 *   - Khamr (intoxicants): alcohol producers, distributors
 *   - Maysir/Qimar (gambling): casinos, betting companies
 *   - Lahm al-Khinzir (pork): pork processors, distributors
 *   - Pornography / adult entertainment
 *   - Tobacco
 *   - Conventional weapons manufacturers (selling arms to aggressors)
 *
 * Mixed companies (SAC 2012 benchmarks):
 *   - 5% benchmark: conventional banking/insurance, gambling, alcohol, tobacco,
 *     pork, pornography as proportion of revenue must be < 5%
 *   - 20% benchmark: hotel/resort, stockbroking mixed activities < 20%
 *   - Debt to asset ratio ≤ 33% (DJIM standard)
 *
 * Implementation: a hand-curated allowlist. The original comment said it was
 * "cross-referenced against DJIM, FTSE Shariah, and S&P 500 Shariah indices.
 * Screened as of 2025." No per-ticker screening date, index-membership record
 * or ratio figures are stored, so this app cannot show that any entry is
 * CURRENTLY screened — index constituents and company ratios change. Every
 * status carries SCREENING_BASIS saying so. No new compliance claims are made
 * here; this is a record of the owner's list and its limits.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

// ── Curated Shariah universe (owner's list) ───────────────────────────────────
// Entries were described as passing the sector, debt/assets ≤ 33% and interest
// income ≤ 5% screens at an unrecorded date. Re-verify against current index
// membership or a screening provider before relying on any entry.

const SCREENING_BASIS = Object.freeze({
  kind:     "unverified",
  asOf:     null,
  source:   "Hand-curated list; original catalogue comment says 'Screened as of 2025'.",
  note:     "Screening date and evidence are not stored. Index membership and financial ratios change; this status is the owner's list, not a current screening result.",
});

// Tickers whose identity itself is unverified (see playbooks CONTESTED_INSTRUMENTS).
const IDENTITY_UNVERIFIED = new Set(["HBKS"]);

const SHARIAH_UNIVERSE = new Map([
  // ── Semiconductors & Hardware (core universe) ─────────────────────────────
  ["AMD",    { name: "Advanced Micro Devices",   sector: "Semiconductors",      index: "DJIM,S&P Shariah" }],
  ["NVDA",   { name: "NVIDIA",                   sector: "Semiconductors",      index: "DJIM,FTSE,S&P Shariah" }],
  ["MSFT",   { name: "Microsoft",                sector: "Technology",          index: "DJIM,FTSE,S&P Shariah" }],
  ["TSLA",   { name: "Tesla",                    sector: "EV / Clean Energy",   index: "DJIM,S&P Shariah" }],
  ["MU",     { name: "Micron Technology",        sector: "Semiconductors",      index: "DJIM,S&P Shariah" }],
  ["AMAT",   { name: "Applied Materials",        sector: "Semiconductor Equip", index: "DJIM,S&P Shariah" }],
  ["LRCX",   { name: "Lam Research",             sector: "Semiconductor Equip", index: "DJIM,S&P Shariah" }],

  // ── Expanded tech universe ────────────────────────────────────────────────
  ["AAPL",   { name: "Apple",                    sector: "Technology",          index: "DJIM,FTSE,S&P Shariah" }],
  ["GOOG",   { name: "Alphabet (Google)",        sector: "Technology",          index: "DJIM,S&P Shariah" }],
  ["GOOGL",  { name: "Alphabet (Google)",        sector: "Technology",          index: "DJIM,S&P Shariah" }],
  ["AMZN",   { name: "Amazon",                   sector: "E-commerce / Cloud",  index: "DJIM,S&P Shariah" }],
  ["META",   { name: "Meta Platforms",           sector: "Social Technology",   index: "DJIM,S&P Shariah" }],
  ["QCOM",   { name: "Qualcomm",                 sector: "Semiconductors",      index: "DJIM,FTSE,S&P Shariah" }],
  ["INTC",   { name: "Intel",                    sector: "Semiconductors",      index: "DJIM,S&P Shariah" }],
  ["AVGO",   { name: "Broadcom",                 sector: "Semiconductors",      index: "DJIM,S&P Shariah" }],
  ["TSM",    { name: "TSMC (ADR)",               sector: "Semiconductors",      index: "DJIM,FTSE Shariah" }],
  ["ORCL",   { name: "Oracle",                   sector: "Cloud / Enterprise",  index: "DJIM,S&P Shariah" }],
  ["CRM",    { name: "Salesforce",               sector: "Cloud Software",      index: "DJIM,S&P Shariah" }],
  ["ADBE",   { name: "Adobe",                    sector: "Software",            index: "DJIM,S&P Shariah" }],
  ["SNOW",   { name: "Snowflake",                sector: "Cloud Data",          index: "DJIM" }],
  ["NOW",    { name: "ServiceNow",               sector: "Enterprise SaaS",     index: "DJIM,S&P Shariah" }],
  ["PANW",   { name: "Palo Alto Networks",       sector: "Cybersecurity",       index: "DJIM,S&P Shariah" }],
  ["CRWD",   { name: "CrowdStrike",              sector: "Cybersecurity",       index: "DJIM" }],

  // ── Clean energy & industrials ────────────────────────────────────────────
  ["ENPH",   { name: "Enphase Energy",           sector: "Solar / Clean Energy",index: "DJIM" }],
  ["FSLR",   { name: "First Solar",              sector: "Solar Energy",        index: "DJIM" }],
  ["NEE",    { name: "NextEra Energy",           sector: "Renewables",          index: "DJIM,S&P Shariah",
               note: "Regulated utility; debt-heavy — monitor debt/assets ratio" }],

  // ── Healthcare & biotech (non-alcohol, non-gambling) ─────────────────────
  ["JNJ",    { name: "Johnson & Johnson",        sector: "Healthcare",          index: "DJIM,S&P Shariah",
               note: "Diversified healthcare; passes screens" }],
  ["ABBV",   { name: "AbbVie",                   sector: "Pharmaceuticals",     index: "DJIM,S&P Shariah",
               note: "Check debt ratio annually" }],

  // ── LSE Islamic ETFs (explicitly Shariah-screened by iShares) ────────────
  ["SGLN",   { name: "iShares Physical Gold ETC", sector: "Commodities / Gold", index: "iShares Shariah",
               note: "Physical gold — spot trade permissible; no forward/futures" }],
  ["HIES",   { name: "iShares MSCI EM Islamic UCITS ETF",  sector: "EM Equities", index: "iShares Shariah" }],
  ["HIJS",   { name: "iShares MSCI Japan Islamic UCITS ETF", sector: "Japan Equities", index: "iShares Shariah" }],
  ["HIUS",   { name: "iShares MSCI USA Islamic UCITS ETF", sector: "US Equities", index: "iShares Shariah" }],
  ["HBKS",   { name: "iShares MSCI UK Islamic UCITS ETF", sector: "UK Equities", index: "iShares Shariah" }],
]);

// ── Hard-blocked haram tickers ────────────────────────────────────────────────
// Included here so the engine can explicitly flag them with reasons.

const HARAM_TICKERS = new Map([
  // Conventional banking (riba — interest-based financial services)
  ["JPM",   "Conventional bank (riba/interest income is core business)"],
  ["BAC",   "Conventional bank (riba/interest income is core business)"],
  ["WFC",   "Conventional bank (riba/interest income is core business)"],
  ["C",     "Conventional bank (riba/interest income is core business)"],
  ["GS",    "Investment bank with significant interest-based activities (riba)"],
  ["MS",    "Investment bank with significant interest-based activities (riba)"],
  ["USB",   "Conventional bank (riba)"],
  ["PNC",   "Conventional bank (riba)"],
  // Insurance (conventional — uncertainty/gharar + riba)
  ["ALL",   "Conventional insurance (gharar + riba elements)"],
  ["TRV",   "Conventional insurance (gharar + riba)"],
  ["MET",   "Conventional insurance/financial services (riba + gharar)"],
  ["PRU",   "Conventional insurance (gharar + riba)"],
  // Alcohol (khamr — strictly prohibited)
  ["BUD",   "Alcohol producer (khamr — strictly prohibited)"],
  ["STZ",   "Alcohol producer — Constellation Brands (khamr)"],
  ["TAP",   "Alcohol producer — Molson Coors (khamr)"],
  ["SAM",   "Alcohol producer — Boston Beer (khamr)"],
  ["DEO",   "Alcohol conglomerate — Diageo (khamr)"],
  // Tobacco (prohibited — harmful, intoxicant category)
  ["PM",    "Tobacco — Philip Morris (prohibited: harmful/intoxicant)"],
  ["MO",    "Tobacco — Altria (prohibited: harmful/intoxicant)"],
  ["BTI",   "Tobacco — BAT (prohibited: harmful/intoxicant)"],
  // Gambling (maysir/qimar)
  ["MGM",   "Casino/gambling operator (maysir — strictly prohibited)"],
  ["CZR",   "Casino/gambling operator (maysir)"],
  ["PENN",  "Sports betting/gambling (maysir)"],
  ["WYNN",  "Casino operator (maysir)"],
  ["LVS",   "Casino operator (maysir)"],
  // Major weapons/defence manufacturers
  ["LMT",   "Primary weapons manufacturer — Lockheed Martin (weapons to aggressors)"],
  ["RTX",   "Defence/weapons conglomerate — Raytheon (weapons)"],
  ["NOC",   "Defence/weapons — Northrop Grumman (weapons)"],
  ["GD",    "Defence/weapons — General Dynamics (weapons)"],
]);

// ── Transaction-level prohibitions ────────────────────────────────────────────

const PROHIBITED_TRANSACTIONS = {
  shortSelling: {
    prohibited: true,
    reason: "Short-selling violates shariah — selling what you do not own (gharar). " +
            "Chapra (1985) and Islamic Fiqh Academy of Mecca prohibit all forms of " +
            "forward/short sales involving goods not owned by the seller.",
  },
  derivatives: {
    prohibited: true,
    reason: "Options and futures involve gharar (uncertainty) and often riba. " +
            "Islamic Fiqh Academy: forward contracts with deferred payment and delivery are invalid.",
  },
  marginTrading: {
    prohibited: true,
    reason: "Margin trading uses interest-bearing borrowed capital (riba).",
  },
  preferredStock: {
    prohibited: true,
    reason: "Preferred stock has a fixed dividend resembling interest (riba). " +
            "Only common stock is permissible — shareholders must share in profit AND loss.",
  },
};

// ── Key financial thresholds (SAC Malaysia 2012 + DJIM standard) ──────────────

const SCREENING_THRESHOLDS = {
  haramRevenueMax:  0.05,   // 5%  — conventional banking, gambling, alcohol, tobacco, pork
  mixedRevenueMax:  0.20,   // 20% — hotels, stockbroking mixed activities
  debtToAssetsMax:  0.33,   // 33% — DJIM/FTSE Shariah standard
  interestIncomeMax: 0.05,  // 5%  — interest income as % of gross revenue
  liquidAssetsMin:  0.51,   // >51% non-liquid assets (Shafi/Hanbali school)
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check whether a ticker is in the Shariah-compliant universe.
 * @param {string} ticker
 * @returns {boolean}
 */
function isShariahCompliant(ticker) {
  const t = String(ticker).toUpperCase();
  return SHARIAH_UNIVERSE.has(t);
}

/**
 * Return detailed Shariah status for a ticker.
 * @param {string} ticker
 * @returns {{ compliant: boolean, status: string, reason?: string, note?: string, index?: string }}
 */
function getShariahStatus(ticker) {
  const t = String(ticker).toUpperCase();

  if (SHARIAH_UNIVERSE.has(t)) {
    const info = SHARIAH_UNIVERSE.get(t);
    return {
      compliant: true,
      status:    "HALAL",
      name:      info.name,
      sector:    info.sector,
      index:     info.index,
      note:      info.note || null,
      screening: SCREENING_BASIS,
      ...(IDENTITY_UNVERIFIED.has(t) ? { identityVerified: false,
          identityNote: "Instrument identity unverified: verify fund name and asset class by ISIN against the issuer factsheet." } : {}),
    };
  }

  if (HARAM_TICKERS.has(t)) {
    return {
      compliant: false,
      status:    "HARAM",
      reason:    HARAM_TICKERS.get(t),
    };
  }

  // Unknown — not screened
  return {
    compliant: false,
    status:    "UNSCREENED",
    reason:    `${t} has not been screened against Shariah criteria. ` +
               "Invest only in pre-screened halal instruments.",
  };
}

/**
 * Check whether a transaction type is Shariah-permissible.
 * @param {"shortSelling"|"derivatives"|"marginTrading"|"preferredStock"} txType
 * @returns {{ permitted: boolean, reason?: string }}
 */
function isTransactionPermitted(txType) {
  const rule = PROHIBITED_TRANSACTIONS[txType];
  if (!rule) return { permitted: true };
  return { permitted: !rule.prohibited, reason: rule.reason };
}

/**
 * Get all pre-screened Shariah-compliant tickers.
 * @returns {string[]}
 */
function getUniverse() {
  return Array.from(SHARIAH_UNIVERSE.keys());
}

/**
 * Get universe with metadata (for /api/ideas/universe endpoint).
 * @returns {Array<{ ticker, name, sector, index, note? }>}
 */
function getUniverseDetailed() {
  return Array.from(SHARIAH_UNIVERSE.entries()).map(([ticker, info]) => ({
    ticker,
    ...info,
  }));
}

/**
 * Filter an array of tickers to only those that are Shariah-compliant.
 * @param {string[]} tickers
 * @returns {string[]}
 */
function filterCompliant(tickers) {
  return tickers.filter(t => isShariahCompliant(t));
}

module.exports = {
  SCREENING_BASIS,
  SHARIAH_UNIVERSE,
  HARAM_TICKERS,
  PROHIBITED_TRANSACTIONS,
  SCREENING_THRESHOLDS,
  isShariahCompliant,
  getShariahStatus,
  isTransactionPermitted,
  getUniverse,
  getUniverseDetailed,
  filterCompliant,
};
