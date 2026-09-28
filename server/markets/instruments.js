/**
 * server/markets/instruments.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The Markets panel universe. Every instrument lists a primary free source and
 * optional fallbacks, tried in order. All sources here are free:
 *
 *   yahoo      — Yahoo Finance chart API (unofficial, no key). Exchange print
 *                time comes back with every quote, so delay is measured, not
 *                assumed (futures ≈10 min, LSE ≈15 min, FX/crypto real-time).
 *   fred       — St. Louis Fed (FRED_API_KEY). Daily/monthly series with the
 *                publication timestamp (`last_updated`).
 *   finnhub    — Finnhub /quote (FINNHUB_API_KEY), US stocks only.
 *   frankfurter— ECB reference rates (no key), once per business day ~16:00 CET.
 *   polymarket — Polymarket public Gamma/CLOB APIs (no key).
 *
 * kind:   "price" (candles), "macro" (area), "prob" (area, 0–100%)
 * format: number formatting hint for the UI
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const GROUPS = [
  { id: "fx",          label: "FX" },
  { id: "rates",       label: "Rates & Credit" },
  { id: "equities",    label: "Equities" },
  { id: "commodities", label: "Commodities" },
  { id: "crypto",      label: "Crypto" },
  { id: "macro",       label: "Macro" },
  { id: "predictions", label: "Prediction Markets" },
];

const y  = (symbol) => ({ provider: "yahoo", symbol });
const fr = (series, opts = {}) => ({ provider: "fred", series, ...opts });

const INSTRUMENTS = [
  // ── FX ──────────────────────────────────────────────────────────────────────
  { id: "GBPUSD", label: "GBP/USD", group: "fx", kind: "price", decimals: 4, sources: [y("GBPUSD=X"), { provider: "frankfurter", base: "GBP", quote: "USD" }] },
  { id: "EURUSD", label: "EUR/USD", group: "fx", kind: "price", decimals: 4, sources: [y("EURUSD=X"), { provider: "frankfurter", base: "EUR", quote: "USD" }] },
  { id: "USDJPY", label: "USD/JPY", group: "fx", kind: "price", decimals: 2, sources: [y("USDJPY=X"), { provider: "frankfurter", base: "USD", quote: "JPY" }] },
  { id: "EURGBP", label: "EUR/GBP", group: "fx", kind: "price", decimals: 4, sources: [y("EURGBP=X"), { provider: "frankfurter", base: "EUR", quote: "GBP" }] },
  { id: "DXY",    label: "US Dollar Index", group: "fx", kind: "price", decimals: 2, sources: [y("DX-Y.NYB")] },

  // ── Rates & Credit ──────────────────────────────────────────────────────────
  { id: "US10Y",  label: "US 10Y yield",        group: "rates", kind: "macro", unit: "%",  decimals: 3, sources: [y("^TNX"), fr("DGS10")] },
  { id: "US30Y",  label: "US 30Y yield",        group: "rates", kind: "macro", unit: "%",  decimals: 3, sources: [y("^TYX"), fr("DGS30")] },
  { id: "REAL10", label: "US 10Y real yield",   group: "rates", kind: "macro", unit: "%",  decimals: 2, sources: [fr("DFII10")] },
  { id: "BEI10",  label: "10Y breakeven",       group: "rates", kind: "macro", unit: "%",  decimals: 2, sources: [fr("T10YIE")] },
  { id: "T10Y2Y", label: "2s10s curve",         group: "rates", kind: "macro", unit: "%",  decimals: 2, sources: [fr("T10Y2Y")] },
  { id: "HYOAS",  label: "US HY spread (OAS)",  group: "rates", kind: "macro", unit: "%",  decimals: 2, sources: [fr("BAMLH0A0HYM2")] },
  { id: "IGOAS",  label: "US IG spread (OAS)",  group: "rates", kind: "macro", unit: "%",  decimals: 2, sources: [fr("BAMLC0A0CM")] },
  { id: "HYG",    label: "HYG · High-yield ETF", group: "rates", kind: "price", decimals: 2, sources: [y("HYG"), { provider: "finnhub", symbol: "HYG" }] },
  { id: "LQD",    label: "LQD · IG credit ETF",  group: "rates", kind: "price", decimals: 2, sources: [y("LQD"), { provider: "finnhub", symbol: "LQD" }] },

  // ── Equities ────────────────────────────────────────────────────────────────
  { id: "SPX",    label: "S&P 500",            group: "equities", kind: "price", decimals: 2, sources: [y("^GSPC")] },
  { id: "UKX",    label: "FTSE 100",           group: "equities", kind: "price", decimals: 2, sources: [y("^FTSE")] },
  { id: "ES",     label: "E-mini S&P futures", group: "equities", kind: "price", decimals: 2, sources: [y("ES=F")] },
  { id: "NQ",     label: "E-mini Nasdaq futures", group: "equities", kind: "price", decimals: 2, sources: [y("NQ=F")] },
  ...["AMD", "NVDA", "MSFT", "TSLA", "MU", "AMAT", "LRCX"].map(s => ({
    id: s, label: s, group: "equities", kind: "price", decimals: 2, sources: [y(s), { provider: "finnhub", symbol: s }],
  })),
  { id: "HIES",   label: "HIES · MSCI EM Islamic",  group: "equities", kind: "price", decimals: 3, sources: [y("HIES.L")] },
  { id: "HIUS",   label: "HIUS · MSCI USA Islamic", group: "equities", kind: "price", decimals: 3, sources: [y("HIUS.L")] },
  { id: "SAMSUNG", label: "Samsung Elec",   group: "equities", kind: "price", decimals: 0, sources: [y("005930.KS")] },
  { id: "HYNIX",  label: "SK Hynix",        group: "equities", kind: "price", decimals: 0, sources: [y("000660.KS")] },
  { id: "TEL",    label: "Tokyo Electron",  group: "equities", kind: "price", decimals: 0, sources: [y("8035.T")] },

  // ── Commodities ─────────────────────────────────────────────────────────────
  { id: "GOLD",   label: "Gold",        group: "commodities", kind: "price", decimals: 1, sources: [y("GC=F")] },
  { id: "WTI",    label: "WTI crude",   group: "commodities", kind: "price", decimals: 2, sources: [y("CL=F"), fr("DCOILWTICO")] },
  { id: "BRENT",  label: "Brent crude", group: "commodities", kind: "price", decimals: 2, sources: [y("BZ=F"), fr("DCOILBRENTEU")] },
  { id: "COPPER", label: "Copper",      group: "commodities", kind: "price", decimals: 3, sources: [y("HG=F")] },
  { id: "NATGAS", label: "Natural gas", group: "commodities", kind: "price", decimals: 3, sources: [y("NG=F"), fr("DHHNGSP")] },

  // ── Crypto ──────────────────────────────────────────────────────────────────
  { id: "BTC", label: "Bitcoin",  group: "crypto", kind: "price", decimals: 0, sources: [y("BTC-USD")] },
  { id: "ETH", label: "Ethereum", group: "crypto", kind: "price", decimals: 2, sources: [y("ETH-USD")] },

  // ── Macro (monthly) ─────────────────────────────────────────────────────────
  { id: "USCPI", label: "US CPI (YoY)", group: "macro", kind: "macro", unit: "%", decimals: 2, sources: [fr("CPIAUCSL", { transform: "yoy" })] },
  { id: "USM2",  label: "US M2 money supply", group: "macro", kind: "macro", unit: "$tn", decimals: 2, sources: [fr("M2SL", { scale: 0.001 })] },
];

// Prediction markets are discovered at refresh time (top Polymarket economy /
// geopolitics events) rather than hard-coded — see providers/polymarket.js.
const POLYMARKET_TAGS  = (process.env.POLYMARKET_TAGS || "economy,geopolitics").split(",").map(s => s.trim()).filter(Boolean);
const POLYMARKET_COUNT = parseInt(process.env.POLYMARKET_COUNT, 10) || 4;

module.exports = { GROUPS, INSTRUMENTS, POLYMARKET_TAGS, POLYMARKET_COUNT };
