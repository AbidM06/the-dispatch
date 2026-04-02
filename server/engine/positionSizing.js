/**
 * server/engine/positionSizing.js
 * Fixed-fraction risk model for position sizing.
 * No external dependencies.
 */
"use strict";

function getConfig() {
  return {
    riskPerTradePct:     parseFloat(process.env.RISK_PER_TRADE_PCT     || "0.5"),
    maxPositionPct:      parseFloat(process.env.MAX_POSITION_PCT        || "8"),
    minOrderNotionalGBP: parseFloat(process.env.MIN_ORDER_NOTIONAL_GBP || "25"),
  };
}

/**
 * Compute position size from risk budget.
 * @param {number} entry         Entry price (native currency)
 * @param {number} stop          Stop price (native currency)
 * @param {number} accountEquityGBP  Total portfolio value in GBP
 * @param {number} priceInGBP    Current price in GBP (for US stocks: price * usdgbp)
 * @param {object} configOverride
 * @returns {{ qty, riskPerShare, riskGBP, notionalGBP, sizingReason, blocked, blockReason }}
 */
function computeSize(entry, stop, accountEquityGBP, priceInGBP, configOverride = {}) {
  const cfg = { ...getConfig(), ...configOverride };
  const { riskPerTradePct, maxPositionPct, minOrderNotionalGBP } = cfg;

  if (!entry || !stop || entry <= 0 || stop <= 0) {
    return { qty: 0, riskPerShare: null, riskGBP: null, notionalGBP: null,
             sizingReason: "entry/stop unavailable", blocked: true,
             blockReason: "Missing numeric entry/stop — cannot size position." };
  }
  if (entry <= stop) {
    return { qty: 0, riskPerShare: null, riskGBP: null, notionalGBP: null,
             sizingReason: "invalid entry/stop", blocked: true,
             blockReason: `Entry (${entry}) must be above stop (${stop}) for LONG.` };
  }
  if (!accountEquityGBP || accountEquityGBP <= 0 || !priceInGBP || priceInGBP <= 0) {
    return { qty: 0, riskPerShare: null, riskGBP: null, notionalGBP: null,
             sizingReason: "account data unavailable", blocked: true,
             blockReason: "Account equity or GBP price not available." };
  }

  const riskBudgetGBP    = accountEquityGBP * (riskPerTradePct / 100);
  const riskPerShareNative = entry - stop;
  const fxFactor         = priceInGBP / entry;
  const riskPerShareGBP  = riskPerShareNative * fxFactor;

  if (riskPerShareGBP <= 0) {
    return { qty: 0, riskPerShare: null, riskGBP: null, notionalGBP: null,
             sizingReason: "zero risk per share", blocked: true,
             blockReason: "Risk per share is zero." };
  }

  let qty = Math.floor(riskBudgetGBP / riskPerShareGBP);
  let notionalGBP = qty * priceInGBP;

  const maxNotionalGBP = accountEquityGBP * (maxPositionPct / 100);
  if (notionalGBP > maxNotionalGBP) {
    qty = Math.floor(maxNotionalGBP / priceInGBP);
    notionalGBP = qty * priceInGBP;
  }

  if (notionalGBP < minOrderNotionalGBP || qty < 1) {
    return { qty: 0, riskPerShare: +riskPerShareNative.toFixed(4), riskGBP: 0, notionalGBP: 0,
             sizingReason: `below min notional \u00a3${minOrderNotionalGBP}`, blocked: true,
             blockReason: `Computed notional \u00a3${notionalGBP.toFixed(2)} below minimum \u00a3${minOrderNotionalGBP}.` };
  }

  return {
    qty,
    riskPerShare: +riskPerShareNative.toFixed(4),
    riskGBP:      +(qty * riskPerShareGBP).toFixed(2),
    notionalGBP:  +notionalGBP.toFixed(2),
    sizingReason: `${riskPerTradePct}% risk budget, ${qty} shares @ \u00a3${priceInGBP.toFixed(4)}/sh`,
    blocked:      false,
    blockReason:  null,
  };
}

module.exports = { computeSize, getConfig };
