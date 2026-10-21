/**
 * server/research/exhibits.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Which live market charts sit inside each research report type (D-28, PR 4).
 *
 * The set is FIXED, chosen here in code — never by the model — so a report can
 * never plot something invented, and no AI call is involved (cost: $0). Every
 * exhibit points at data the app already serves from free sources:
 *
 *   compare — GET /api/markets/compare   (shared days only, never filled)
 *   chart   — GET /api/markets/history/:id
 *   curve   — GET /api/markets/curve     (FRED Treasury constant maturities)
 *   macro   — GET /api/markets/macro/:id (FRED, with release dates)
 *
 * `factKeys` name the report's own verified figures (macroContext fact keys)
 * for the same series; the client prints "at report time: <value>" next to the
 * chart so a claim in the text can be checked against the picture. A report
 * written before the keys existed simply shows no such line.
 *
 * Charts are LIVE (latest data) with a marker at the report's generation date.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const { INSTRUMENTS } = require("../markets/instruments");
const { MACRO } = require("../markets/views");

const compare = (title, ids, mode = "rebased", tf = "1d", factKeys = []) => ({ kind: "compare", title, ids, mode, tf, factKeys });
const chart   = (id, tf = "1d", factKeys = []) => ({ kind: "chart", id, tf, factKeys });
const macro   = (id) => ({ kind: "macro", id, label: (MACRO.find(m => m.id === id) || {}).label || id, factKeys: [] });
const curve   = () => ({ kind: "curve", factKeys: ["dgs2", "dgs10", "t10y2y"] });

const EQUITY = [
  compare("S&P 500 vs FTSE 100 (rebased to 100)", ["SPX", "UKX"]),
  chart("US10Y", "1d", ["dgs10"]),
  chart("WTI", "1d", ["wti"]),
];

const EXHIBITS = {
  rates:       [curve(), chart("T10Y2Y", "1y", ["t10y2y"])],
  fx:          [compare("GBP/USD, EUR/USD and USD/JPY (rebased to 100)", ["GBPUSD", "EURUSD", "USDJPY"], "rebased", "1d", ["eurusd"]), chart("DXY")],
  equity:      EQUITY,
  sector:      EQUITY,
  macro:       [macro("cpi"), macro("payrolls")],
  thematic:    [compare("Gold, WTI and the dollar index (rebased to 100)", ["GOLD", "WTI", "DXY"], "rebased", "1d", ["wti"])],
  commodities: [compare("WTI − Brent spread", ["WTI", "BRENT"], "spread", "1d", ["wti", "brent"])],
};

/** The instrument fields the client needs to format a single-instrument chart. */
function itemFor(id) {
  const i = INSTRUMENTS.find(x => x.id === id);
  return i ? { id: i.id, label: i.label, decimals: i.decimals, unit: i.unit || null, kind: i.kind } : null;
}

/** exhibitsFor — the exhibit specs for a report type ([] for an unknown type). */
function exhibitsFor(type) {
  // Fresh copies (arrays included): a caller that edits a spec must never alter the shared set.
  return (EXHIBITS[type] || []).map(e => ({
    ...e,
    ...(e.ids ? { ids: [...e.ids] } : {}),
    factKeys: [...e.factKeys],
    ...(e.kind === "chart" ? { item: itemFor(e.id) } : {}),
  }));
}

module.exports = { exhibitsFor, EXHIBITS };
