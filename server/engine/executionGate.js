/**
 * server/engine/executionGate.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The single path from "an idea exists" to "an order may be sent". Used by
 * BOTH auto-execution (autoExecute.js) and manual approval (routes/ideas.js),
 * which previously each carried their own — diverging — copy of this logic.
 *
 * It fails CLOSED. Any missing, stale or unsuitable input stops the order and
 * names the stage that stopped it:
 *
 *   direction → price → account → positions → fx → sizing → policy
 *
 * PRICE. The order is sized off an EXECUTABLE price: a quote carrying a real
 * timestamp no older than TRADING_PRICE_MAX_AGE_MIN (default 20). A daily
 * close — Polygon /v2/aggs on the free tier, Alpha Vantage GLOBAL_QUOTE — is a
 * settled historical price with a DATE, not a quote, and never qualifies. The
 * idea's own `entry` is a planning level and is not used for sizing. With the
 * free feeds this app has, no price qualifies, so execution is blocked by
 * design; that is the correct outcome, not a bug.
 *
 * Freshness is the TRADED INSTRUMENT'S price observation time. It used to be
 * the rates-cache write time, so a freshly re-cached old observation passed.
 *
 * SIZING then POLICY, with the final quantity, the GBP-converted notional,
 * the open-position count, account equity and the existing exposure to the
 * ticker. Blocked sizing is "do not trade", never "trade one share".
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const executionPolicy = require("../analytics/executionPolicy");
const { computeSize } = require("./positionSizing");

const USD_TICKERS = new Set(["AMD", "NVDA", "MSFT", "TSLA", "MU", "AMAT", "LRCX"]);

function priceMaxAgeMin() { return parseInt(process.env.TRADING_PRICE_MAX_AGE_MIN, 10) || 20; }
function fxMaxAgeHours()  { return parseInt(process.env.TRADING_FX_MAX_AGE_HOURS, 10)  || 48; }

function block(stage, reason, extra = {}) {
  return { ok: false, stage, reasons: [reason], ...extra };
}

/**
 * checkExecutablePrice — is this price fit to size an order against?
 * @param {object} fact  { value, executable, observedAt, observedAtPrecision, source }
 */
function checkExecutablePrice(ticker, fact, now = new Date()) {
  if (!fact || !Number.isFinite(fact.value) || fact.value <= 0) {
    return { ok: false, reason: `No price for ${ticker}.` };
  }
  if (fact.executable !== true) {
    const what = fact.priceType || (fact.profile === "eod-bar" ? "daily close" : "non-executable price");
    return { ok: false, reason: `${ticker} price is a ${what} (${fact.source || "source n/a"}, ${fact.observedAt || fact.date || "date n/a"}), not an executable quote.` };
  }
  if (fact.observedAtPrecision !== "timestamp" || !fact.observedAt) {
    return { ok: false, reason: `${ticker} price has no observation timestamp — its age cannot be established.` };
  }
  const ageMin = (now.getTime() - new Date(fact.observedAt).getTime()) / 60_000;
  if (!Number.isFinite(ageMin)) return { ok: false, reason: `${ticker} price timestamp unparseable.` };
  if (ageMin > priceMaxAgeMin()) {
    return { ok: false, reason: `${ticker} price observed ${ageMin.toFixed(0)} min ago (max ${priceMaxAgeMin()} min).` };
  }
  return { ok: true, price: fact.value, ageMin };
}

/** FX is required to convert USD prices and USD account equity into GBP. */
function checkFx(fx, now = new Date()) {
  if (!fx || !Number.isFinite(fx.value) || fx.value <= 0) return { ok: false, reason: "USD/GBP rate unavailable." };
  if (!fx.observedAt) return { ok: false, reason: "USD/GBP observation time unknown — cannot establish its age." };
  const ageH = (now.getTime() - new Date(fx.observedAt).getTime()) / 3_600_000;
  if (!Number.isFinite(ageH)) return { ok: false, reason: "USD/GBP observation time unparseable." };
  if (ageH > fxMaxAgeHours()) return { ok: false, reason: `USD/GBP observed ${ageH.toFixed(0)}h ago (max ${fxMaxAgeHours()}h).` };
  return { ok: true, rate: fx.value, ageH };
}

/**
 * prepareOrder — every check, in order. Pure given its inputs; the broker and
 * price feed are the caller's boundaries (and a test's mocks).
 *
 * @param {object} p
 * @param {object} p.ticket     { ticker, direction, stop }
 * @param {object} p.priceFact  executable price fact for p.ticket.ticker
 * @param {object} p.fx         USD/GBP fact { value, observedAt }
 * @param {object} p.account    { equity, currency } — broker account, or null on failure
 * @param {Array}  p.positions  broker positions [{ symbol, market_value }], or null on failure
 * @returns {{ ok:true, qty, notionalGBP, priceGBP, equityGBP, sizing, policy } | { ok:false, stage, reasons }}
 */
function prepareOrder({ ticket, priceFact, fx, account, positions, now = new Date() }) {
  const ticker = ticket?.ticker;
  if (!ticker) return block("input", "Ticket has no ticker.");

  // Long-only (owner's Shariah constraint: no short selling).
  if (ticket.direction !== "LONG") return block("direction", `${ticket.direction || "Unknown"} orders are not permitted — long-only.`);

  const px = checkExecutablePrice(ticker, priceFact, now);
  if (!px.ok) return block("price", px.reason);

  const equityNative = Number(account?.equity);
  if (!account || !Number.isFinite(equityNative) || equityNative <= 0) {
    return block("account", "Account equity unavailable — cannot size or cap the order.");
  }
  if (!Array.isArray(positions)) {
    return block("positions", "Open positions unavailable — exposure limits cannot be enforced.");
  }

  const isUsd = USD_TICKERS.has(ticker);
  const acctUsd = (account.currency || "USD").toUpperCase() === "USD";
  let rate = null;
  if (isUsd || acctUsd) {
    const f = checkFx(fx, now);
    if (!f.ok) return block("fx", f.reason);
    rate = f.rate;
  }
  const priceGBP  = isUsd ? px.price * rate : px.price;
  const equityGBP = acctUsd ? equityNative * rate : equityNative;

  if (!Number.isFinite(ticket.stop) || ticket.stop <= 0) {
    return block("sizing", "Idea has no numeric stop — cannot size.");
  }
  // Entry for sizing is the executable price, not the idea's planning level.
  const sizing = computeSize(px.price, ticket.stop, equityGBP, priceGBP);
  if (sizing.blocked || !(sizing.qty > 0)) {
    return block("sizing", sizing.blockReason || sizing.sizingReason || "Position sizing returned no quantity.", { sizing });
  }

  const qty = sizing.qty;
  const notionalGBP = +(qty * priceGBP).toFixed(2);

  const held = positions.find(p => String(p.symbol || "").toUpperCase() === ticker);
  const heldNative = held ? Number(held.market_value) : 0;
  if (held && !Number.isFinite(heldNative)) {
    return block("positions", `Existing ${ticker} position value unavailable — single-ticker cap cannot be evaluated.`);
  }
  const existingTickerGBP = held ? (acctUsd ? heldNative * rate : heldNative) : 0;

  const policy = executionPolicy.checkPolicy({
    ticker,
    notionalGBP,                       // final quantity × converted price
    openPositions: positions.length,
    portfolioGBP:  equityGBP,
    existingTickerGBP,
  });
  if (!policy.allowed) return { ok: false, stage: "policy", reasons: policy.reasons, sizing, notionalGBP, qty };

  return { ok: true, qty, notionalGBP, priceGBP: +priceGBP.toFixed(4), equityGBP: +equityGBP.toFixed(2),
           price: px.price, priceAgeMin: +px.ageMin.toFixed(1), sizing, policy };
}

module.exports = { prepareOrder, checkExecutablePrice, checkFx, USD_TICKERS };
