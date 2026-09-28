/**
 * server/providers/aiCost.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Turns Anthropic `usage` objects into US dollars, keeps a persistent spend
 * ledger, and builds per-report cost receipts.
 *
 * WHY
 * The budget used to count CALLS while every document called it a USD cap, and
 * the counter lived in memory so a restart reset it. A five-agent report makes
 * 6-8 calls, so a "$5" cap of 5 calls could not finish a single report — and
 * nobody could see what anything actually cost. Every figure here is computed
 * from the token counts the API returns, never guessed.
 *
 * PRICES — Anthropic list prices, USD per million tokens, checked 2026-09-28.
 * If Anthropic changes prices, update PRICES and PRICES_CHECKED together.
 *   Sonnet 5   $2 in / $10 out      Haiku 4.5  $1 in / $5 out
 *   Cache write 1.25x input (5-min TTL) · cache read 0.1x input
 *   Message Batches: 50% of the synchronous rate
 *   Web search: $10 per 1,000 searches
 * A model missing from PRICES is recorded as UNPRICED (counted, never
 * silently costed at $0).
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const fs   = require("fs");
const path = require("path");

const PRICES_CHECKED = "2026-09-28";
const PRICES = {
  "claude-sonnet-5":  { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT  = 0.10;
const BATCH_MULT       = 0.50;
const WEB_SEARCH_USD   = 10 / 1000;

/** Normalise dated ids (claude-haiku-4-5-20251001) to the price-table key. */
function priceKey(model) {
  const m = String(model || "");
  if (PRICES[m]) return m;
  const stripped = m.replace(/-\d{8}$/, "");
  return PRICES[stripped] ? stripped : null;
}

/**
 * priceCall — dollars for one API call.
 * @param {{ model: string, usage: object, batch?: boolean }} call
 * @returns {{ usd: number|null, priced: boolean, tokens: object, webSearches: number, batchSavingsUSD: number, cacheSavingsUSD: number }}
 */
function priceCall({ model, usage = {}, batch = false }) {
  const tokens = {
    input:      usage.input_tokens || 0,
    output:     usage.output_tokens || 0,
    cacheWrite: usage.cache_creation_input_tokens || 0,
    cacheRead:  usage.cache_read_input_tokens || 0,
  };
  const webSearches = usage.server_tool_use?.web_search_requests || 0;
  const key = priceKey(model);
  if (!key) return { usd: null, priced: false, tokens, webSearches, batchSavingsUSD: 0, cacheSavingsUSD: 0 };

  const p = PRICES[key];
  const perTok = (rate) => rate / 1_000_000;
  const tokenUSD =
    tokens.input      * perTok(p.input) +
    tokens.cacheWrite * perTok(p.input) * CACHE_WRITE_MULT +
    tokens.cacheRead  * perTok(p.input) * CACHE_READ_MULT +
    tokens.output     * perTok(p.output);
  const mult = batch ? BATCH_MULT : 1;
  const usd  = tokenUSD * mult + webSearches * WEB_SEARCH_USD;

  // What the cached tokens would have cost uncached, net of the write premium.
  const cacheSavingsUSD = (tokens.cacheRead * perTok(p.input) * (1 - CACHE_READ_MULT)
    - tokens.cacheWrite * perTok(p.input) * (CACHE_WRITE_MULT - 1)) * mult;

  return {
    usd, priced: true, tokens, webSearches,
    batchSavingsUSD: batch ? tokenUSD * (1 - BATCH_MULT) : 0,
    cacheSavingsUSD,
  };
}

// ── Persistent spend ledger ───────────────────────────────────────────────────
const IS_TEST = process.env.NODE_ENV === "test";
function ledgerPath() {
  return process.env.AI_SPEND_PATH || path.join(__dirname, "../../data/ai_spend.json");
}

let _ledger = null;

function load() {
  if (_ledger) return _ledger;
  _ledger = { days: {}, months: {} };
  if (IS_TEST && !process.env.AI_SPEND_PATH) return _ledger;
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPath(), "utf8"));
    if (raw && raw.days && raw.months) _ledger = raw;
  } catch (_) { /* first run — empty ledger */ }
  return _ledger;
}

function persist() {
  if (IS_TEST && !process.env.AI_SPEND_PATH) return;
  try {
    // Keep ~90 days of daily rows; months are small.
    const days = Object.keys(_ledger.days).sort();
    for (const d of days.slice(0, Math.max(0, days.length - 90))) delete _ledger.days[d];
    const file = ledgerPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + ".tmp", JSON.stringify(_ledger, null, 2));
    fs.renameSync(file + ".tmp", file);
  } catch (err) {
    console.warn("[aiCost] ledger persist failed:", err.message);
  }
}

function today()     { return new Date().toISOString().slice(0, 10); }
function thisMonth() { return new Date().toISOString().slice(0, 7); }
function blank()     { return { usd: 0, calls: 0, unpricedCalls: 0, webSearches: 0 }; }

/** record — add one priced call to today's and this month's totals. */
function record(priced) {
  const l = load();
  const rows = [l.days[today()] ||= blank(), l.months[thisMonth()] ||= blank()];
  for (const r of rows) {
    r.calls += 1;
    r.webSearches += priced.webSearches || 0;
    if (priced.priced) r.usd += priced.usd;
    else r.unpricedCalls += 1;
  }
  persist();
}

function spendSummary() {
  const l = load();
  return {
    currency: "USD",
    today: { date: today(), ...(l.days[today()] || blank()) },
    month: { month: thisMonth(), ...(l.months[thisMonth()] || blank()) },
    pricesChecked: PRICES_CHECKED,
  };
}

// ── Per-report receipts ───────────────────────────────────────────────────────
function newReceipt() {
  return {
    currency: "USD", totalUSD: 0, calls: 0, unpricedCalls: 0, webSearches: 0,
    batchSavingsUSD: 0, cacheSavingsUSD: 0, byRole: {}, pricesChecked: PRICES_CHECKED,
  };
}

function addToReceipt(receipt, role, model, priced, { batch = false } = {}) {
  if (!receipt) return;
  const r = (receipt.byRole[role] ||= {
    model, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    webSearches: 0, usd: 0, batched: 0,
  });
  r.calls += 1;
  r.inputTokens      += priced.tokens.input;
  r.outputTokens     += priced.tokens.output;
  r.cacheReadTokens  += priced.tokens.cacheRead;
  r.cacheWriteTokens += priced.tokens.cacheWrite;
  r.webSearches      += priced.webSearches;
  if (batch) r.batched += 1;
  receipt.calls       += 1;
  receipt.webSearches += priced.webSearches;
  if (priced.priced) {
    r.usd                   += priced.usd;
    receipt.totalUSD        += priced.usd;
    receipt.batchSavingsUSD += priced.batchSavingsUSD;
    receipt.cacheSavingsUSD += priced.cacheSavingsUSD;
  } else {
    receipt.unpricedCalls += 1;
  }
}

/** finalizeReceipt — round for display; raw sums stay accurate until here. */
function finalizeReceipt(receipt) {
  if (!receipt) return null;
  const round = (n) => Math.round(n * 10_000) / 10_000;
  const out = { ...receipt, byRole: {} };
  for (const k of ["totalUSD", "batchSavingsUSD", "cacheSavingsUSD"]) out[k] = round(receipt[k]);
  for (const [role, r] of Object.entries(receipt.byRole)) out.byRole[role] = { ...r, usd: round(r.usd) };
  return out;
}

// ── Estimates ─────────────────────────────────────────────────────────────────
// Used only until real receipts exist for a report type: a five-agent run is
// ~6 calls on Sonnet 5 with ~10-15 web searches. Stated as an assumption so the
// UI can say so, and replaced by the measured average after the first run.
const DEFAULT_ESTIMATE_USD = 0.70;

/**
 * estimateReport — projected cost of the next run of a report type.
 * @param {string} type
 * @param {object[]} recentRecords  stored reports of that type, newest first
 */
function estimateReport(type, recentRecords = []) {
  const totals = recentRecords
    .map(r => r?.meta?.cost)
    .filter(c => c && c.unpricedCalls === 0 && c.totalUSD > 0 && !Object.values(c.byRole || {}).some(x => x.batched))
    .map(c => c.totalUSD)
    .slice(0, 5);

  if (!totals.length) {
    return {
      estimateUSD: DEFAULT_ESTIMATE_USD,
      lowUSD: 0.40, highUSD: 1.20,
      basis: "assumption",
      basisDetail: "No measured runs of this report type yet — typical five-agent run on Sonnet 5 with web search. Replaced by real receipts after the first run.",
    };
  }
  const avg = totals.reduce((a, b) => a + b, 0) / totals.length;
  return {
    estimateUSD: Math.round(avg * 100) / 100,
    lowUSD: Math.round(Math.min(...totals) * 100) / 100,
    highUSD: Math.round(Math.max(...totals) * 100) / 100,
    basis: "measured",
    basisDetail: `Average of the last ${totals.length} ${type} run${totals.length > 1 ? "s" : ""} (synchronous rate).`,
  };
}

/** Manual refreshes above this estimate need an explicit confirm. Default 0 = always ask. */
function confirmThresholdUSD() {
  const v = parseFloat(process.env.RESEARCH_CONFIRM_ABOVE_USD);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

function _reset() { _ledger = null; }

module.exports = {
  PRICES, PRICES_CHECKED, WEB_SEARCH_USD, BATCH_MULT,
  priceCall, record, spendSummary,
  newReceipt, addToReceipt, finalizeReceipt,
  estimateReport, confirmThresholdUSD, DEFAULT_ESTIMATE_USD,
  _reset,
};
