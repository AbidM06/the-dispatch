/**
 * server/providers/alpaca.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Alpaca Markets paper-trading REST client.
 * No new npm dependencies — uses built-in fetch (Node ≥ 18).
 *
 * Safety: ONLY ever calls paper-api.alpaca.markets.
 * Auto-execute is OFF by default — requires ALPACA_AUTO_EXECUTE=true.
 *
 * US-listed instruments only: AMD, NVDA, MSFT, TSLA, MU, AMAT, LRCX.
 * LSE ETFs (SGLN, HIES, etc.) are NOT supported by Alpaca — they auto-log
 * to the local trade_ideas.json tracker instead.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const { fetchWithTimeout } = require("../retry");

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL = process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";
const KEY      = process.env.ALPACA_API_KEY    || "";
const SECRET   = process.env.ALPACA_API_SECRET || "";

/**
 * US-listed tickers available via Alpaca paper trading — Shariah-compliant universe.
 * All instruments are pre-screened against DJIM, FTSE Shariah, or S&P 500 Shariah indices.
 * LSE instruments (SGLN, HIES, HIJS, HIUS, HBKS) are NOT in this set (not US-listed).
 * No conventional banks, insurance companies, alcohol, tobacco, gambling, or weapons.
 */
const ALPACA_SUPPORTED = new Set([
  // Core portfolio / watchlist
  "AMD", "NVDA", "MSFT", "TSLA", "MU", "AMAT", "LRCX",
  // Expanded Shariah-compliant tech universe
  "AAPL", "GOOG", "GOOGL", "AMZN", "META",
  "QCOM", "INTC", "AVGO", "TSM",
  "ORCL", "CRM", "ADBE", "SNOW", "NOW",
  "PANW", "CRWD",
  // Clean energy
  "ENPH", "FSLR",
  // Healthcare (passes Shariah screens)
  "JNJ", "ABBV",
]);

// ── Safety guards ─────────────────────────────────────────────────────────────

function getAllowedHosts() {
  const raw = process.env.ALPACA_ALLOWED_HOSTS || "paper-api.alpaca.markets";
  return raw.split(",").map(h => h.trim().toLowerCase()).filter(Boolean);
}

function assertPaperUrl() {
  let hostname;
  try {
    hostname = new URL(BASE_URL).hostname.toLowerCase();
  } catch (_) {
    throw new Error(`[alpaca] SAFETY: BASE_URL "${BASE_URL}" is not a valid URL.`);
  }
  const allowed = getAllowedHosts();
  if (!allowed.includes(hostname)) {
    throw new Error(
      `[alpaca] SAFETY: hostname "${hostname}" not in allowed list (${allowed.join(", ")}). ` +
      "Set ALPACA_ALLOWED_HOSTS to override."
    );
  }
}

function isConfigured() {
  return KEY.length > 0 && SECRET.length > 0;
}

function isAutoExecuteEnabled() {
  return process.env.ALPACA_AUTO_EXECUTE === "true";
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function headers() {
  return {
    "Apca-Api-Key-Id":     KEY,
    "Apca-Api-Secret-Key": SECRET,
    "Content-Type":        "application/json",
    "Accept":              "application/json",
  };
}

async function alpacaFetch(path, opts = {}) {
  if (!isConfigured()) {
    throw new Error("[alpaca] Not configured — set ALPACA_API_KEY and ALPACA_API_SECRET.");
  }
  assertPaperUrl();

  const url = `${BASE_URL}${path}`;
  const res = await fetchWithTimeout(url, {
    ...opts,
    headers: { ...headers(), ...(opts.headers || {}) },
  }, 10_000);

  if (!res.ok) {
    let body = "";
    try { body = await res.text(); } catch (_) {}
    const err = new Error(`[alpaca] HTTP ${res.status} on ${path}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  return res.json();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check whether a ticker is supported by Alpaca (US-listed only).
 */
function isSupported(ticker) {
  return ALPACA_SUPPORTED.has(String(ticker).toUpperCase());
}

/**
 * Get open orders for a specific ticker.
 */
async function getOpenOrdersForTicker(ticker) {
  return alpacaFetch(`/v2/orders?status=open&symbols=${ticker.toUpperCase()}&limit=10`);
}

/**
 * Place a paper order.
 * Only runs if ALPACA_AUTO_EXECUTE=true AND ticker is in ALPACA_SUPPORTED.
 *
 * @param {string} ticker  e.g. "AMD"
 * @param {string} side    "buy" | "sell"
 * @param {number} qty     Number of shares (default 1)
 * @param {string} type    "market" | "limit"
 * @param {string|null} clientOrderId  Optional idempotency key
 * @returns {object}       Alpaca order object
 */
async function placeOrder(ticker, side, qty = 1, type = "market", clientOrderId = null) {
  assertPaperUrl();

  if (!isAutoExecuteEnabled()) {
    throw new Error("[alpaca] placeOrder called but ALPACA_AUTO_EXECUTE is not 'true'.");
  }

  if (!isSupported(ticker)) {
    throw new Error(`[alpaca] ${ticker} is not in ALPACA_SUPPORTED.`);
  }

  // Duplicate check
  try {
    const openOrders = await getOpenOrdersForTicker(ticker);
    if (Array.isArray(openOrders) && openOrders.length > 0) {
      throw new Error(`[alpaca] Duplicate: open order already exists for ${ticker} (${openOrders.length} open). Skipping.`);
    }
  } catch (err) {
    if (err.message.includes("Duplicate:")) throw err;
    console.warn(`[alpaca] Could not check open orders for ${ticker}:`, err.message);
  }

  const body = {
    symbol:        ticker.toUpperCase(),
    qty:           String(qty),
    side:          side.toLowerCase(),
    type:          type.toLowerCase(),
    time_in_force: "day",
  };
  if (clientOrderId) body.client_order_id = clientOrderId;

  const order = await alpacaFetch("/v2/orders", {
    method: "POST",
    body:   JSON.stringify(body),
  });

  console.log(`[alpaca] Paper order placed: ${side.toUpperCase()} ${qty} ${ticker} → id ${order.id}`);
  return order;
}

function getMaxOrdersPerRun() {
  return parseInt(process.env.ALPACA_MAX_ORDERS_PER_RUN || "2", 10);
}

/**
 * Get all current paper positions.
 * @returns {Array} Alpaca position objects
 */
async function getPositions() {
  return alpacaFetch("/v2/positions");
}

/**
 * Get paper account summary.
 * @returns {object} Alpaca account object with portfolio_value, cash, etc.
 */
async function getAccount() {
  return alpacaFetch("/v2/account");
}

/**
 * Close (liquidate) a specific paper position.
 * @param {string} ticker  e.g. "AMD"
 */
async function closePosition(ticker) {
  assertPaperUrl();
  return alpacaFetch(`/v2/positions/${ticker.toUpperCase()}`, { method: "DELETE" });
}

/**
 * Get a summary safe for display in the API response.
 * Returns null if not configured (graceful degradation).
 */
async function getSummary() {
  if (!isConfigured()) return null;
  try {
    const [account, positions] = await Promise.all([getAccount(), getPositions()]);
    return {
      portfolioValue: parseFloat(account.portfolio_value),
      cash:           parseFloat(account.cash),
      buyingPower:    parseFloat(account.buying_power),
      positions:      positions.map(p => ({
        ticker:      p.symbol,
        qty:         parseFloat(p.qty),
        marketValue: parseFloat(p.market_value),
        unrealizedPnL: parseFloat(p.unrealized_pl),
        unrealizedPnLPct: parseFloat(p.unrealized_plpc) * 100,
      })),
    };
  } catch (err) {
    console.warn("[alpaca] getSummary failed:", err.message);
    return null;
  }
}

/**
 * Get all open orders (not filtered by ticker).
 * @returns {Array} Alpaca order objects
 */
async function getOpenOrders() {
  return alpacaFetch("/v2/orders?status=open&limit=100");
}

/**
 * Place a bracket order: entry + take-profit + stop-loss in one atomic order.
 * Only available for limit orders (not market).
 *
 * @param {string} ticker
 * @param {string} side       "buy" | "sell"
 * @param {number} qty
 * @param {number} limitPrice Entry limit price
 * @param {number} takeProfitPrice
 * @param {number} stopLossPrice
 * @param {string} clientOrderId Optional
 */
async function placeBracketOrder(ticker, side, qty, limitPrice, takeProfitPrice, stopLossPrice, clientOrderId = null) {
  assertPaperUrl();
  if (!isAutoExecuteEnabled()) {
    throw new Error("[alpaca] ALPACA_AUTO_EXECUTE not true");
  }
  if (!isSupported(ticker)) {
    throw new Error(`[alpaca] ${ticker} not in ALPACA_SUPPORTED`);
  }

  const body = {
    symbol:        ticker.toUpperCase(),
    qty:           String(qty),
    side:          side.toLowerCase(),
    type:          "limit",
    time_in_force: "day",
    limit_price:   String(limitPrice.toFixed(2)),
    order_class:   "bracket",
    take_profit: {
      limit_price: String(takeProfitPrice.toFixed(2)),
    },
    stop_loss: {
      stop_price: String(stopLossPrice.toFixed(2)),
    },
  };
  if (clientOrderId) body.client_order_id = clientOrderId;

  const order = await alpacaFetch("/v2/orders", { method: "POST", body: JSON.stringify(body) });
  console.log(`[alpaca] Bracket order placed: ${side.toUpperCase()} ${qty} ${ticker} limit@${limitPrice} TP@${takeProfitPrice} SL@${stopLossPrice} -> id ${order.id}`);
  return order;
}

module.exports = {
  ALPACA_SUPPORTED,
  isSupported,
  isConfigured,
  isAutoExecuteEnabled,
  placeOrder,
  getPositions,
  getAccount,
  closePosition,
  getSummary,
  getOpenOrdersForTicker,
  getMaxOrdersPerRun,
  getOpenOrders,
  placeBracketOrder,
};
