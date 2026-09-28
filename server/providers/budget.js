/**
 * server/providers/budget.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared Anthropic API budget gate — in US DOLLARS.
 *
 * Spend is measured from each call's real token usage (providers/aiCost.js)
 * and persisted to data/ai_spend.json, so a restart does not reset it.
 * Caps are read from env at call time:
 *   ANTHROPIC_DAILY_CAP    USD per UTC day    (default 5)
 *   ANTHROPIC_MONTHLY_CAP  USD per UTC month  (default 50)
 * Set a cap to 0 to disable that dimension. DISABLE_AI=true blocks all calls.
 *
 * History: this used to count CALLS while every doc called it a USD cap, and
 * `parseInt(undefined) ?? 5` produced NaN — so an unset cap was silently off
 * and a set cap of 5 meant five calls, fewer than one five-agent report needs.
 *
 * The gate is checked BEFORE a call against spend so far; the call's own cost
 * is recorded after it returns. One call can therefore overshoot a cap by its
 * own cost — the alternative (pre-reserving a guess) would block calls on an
 * invented number.
 *
 * Usage:
 *   budget.checkAndIncrement();   // throws BUDGET_DAILY / BUDGET_MONTHLY if over cap
 *   budget.getStatus();           // { daily, monthly } in USD
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const aiCost = require("./aiCost");

// ── Auto-fallback state ───────────────────────────────────────────────────────
// When the Anthropic API returns a billing/credit error the server automatically
// enters "API fallback" mode for a configurable window (default 60 min).
// The window auto-expires so that if the user tops up their credits, AI resumes
// on the next scheduled refresh.
let _apiFallbackUntil = 0; // epoch ms; 0 = not in fallback

function _cap(name, dflt) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}
function _dailyCap()   { return _cap("ANTHROPIC_DAILY_CAP", 5); }
function _monthlyCap() { return _cap("ANTHROPIC_MONTHLY_CAP", 50); }

/**
 * Check spend so far against the USD caps. Name kept for its callers; nothing
 * is incremented here — aiCost.record() adds each call's real cost afterwards.
 * Throws an Error with err.code === "BUDGET_DAILY" or "BUDGET_MONTHLY".
 */
function checkAndIncrement() {
  const s = aiCost.spendSummary();
  const daily   = _dailyCap();
  const monthly = _monthlyCap();

  if (daily > 0 && s.today.usd >= daily) {
    const err = new Error(
      `Anthropic daily budget reached ($${s.today.usd.toFixed(2)} of $${daily.toFixed(2)} today). Resets at midnight UTC — raise ANTHROPIC_DAILY_CAP to continue.`
    );
    err.code = "BUDGET_DAILY";
    throw err;
  }
  if (monthly > 0 && s.month.usd >= monthly) {
    const err = new Error(
      `Anthropic monthly budget reached ($${s.month.usd.toFixed(2)} of $${monthly.toFixed(2)} this month).`
    );
    err.code = "BUDGET_MONTHLY";
    throw err;
  }
}

function getStatus() {
  const s = aiCost.spendSummary();
  const daily   = _dailyCap();
  const monthly = _monthlyCap();
  const round = (n) => Math.round(n * 100) / 100;
  return {
    currency: "USD",
    daily:   { used: round(s.today.usd), cap: daily,   remaining: daily   > 0 ? round(Math.max(0, daily   - s.today.usd)) : null, calls: s.today.calls, webSearches: s.today.webSearches, unpricedCalls: s.today.unpricedCalls },
    monthly: { used: round(s.month.usd), cap: monthly, remaining: monthly > 0 ? round(Math.max(0, monthly - s.month.usd)) : null, calls: s.month.calls, webSearches: s.month.webSearches, unpricedCalls: s.month.unpricedCalls },
    pricesChecked: s.pricesChecked,
  };
}

// ── API credit fallback ───────────────────────────────────────────────────────

/** Duration (ms) the server stays in fallback mode after a billing error. */
function _fallbackDurationMs() {
  return (parseInt(process.env.ANTHROPIC_FALLBACK_RETRY_MIN, 10) || 60) * 60_000;
}

/**
 * Enter API-credits fallback mode for `durationMs` milliseconds.
 * Called automatically by anthropic.js when a billing error is detected.
 */
function setApiFallback(durationMs) {
  const ms = durationMs ?? _fallbackDurationMs();
  _apiFallbackUntil = Date.now() + ms;
  const mins = Math.round(ms / 60_000);
  console.warn(`[budget] Anthropic API billing error — entering deterministic fallback for ${mins} min. ` +
    `AI will retry automatically after ${new Date(_apiFallbackUntil).toISOString()}.`);
}

/**
 * Exit fallback mode immediately.
 * Called by routes when an AI call succeeds, meaning credits are available again.
 */
function clearApiFallback() {
  if (_apiFallbackUntil > 0) {
    console.log("[budget] API credits confirmed available — exiting deterministic fallback.");
    _apiFallbackUntil = 0;
  }
}

/**
 * Returns true when the server should use deterministic narrative instead of AI
 * because a billing error was recently received.
 * Auto-expires: once the retry window passes, this returns false and the next
 * AI call is attempted normally.
 */
function isApiFallback() {
  if (_apiFallbackUntil === 0) return false;
  if (Date.now() >= _apiFallbackUntil) {
    _apiFallbackUntil = 0; // auto-expire
    console.log("[budget] API fallback window expired — will attempt AI on next refresh.");
    return false;
  }
  return true;
}

/**
 * Return fallback state info for the /api/health endpoint.
 */
function getApiFallbackInfo() {
  const active = isApiFallback();
  return {
    active,
    expiresAt:    active ? new Date(_apiFallbackUntil).toISOString() : null,
    retryInMins:  active ? Math.ceil((_apiFallbackUntil - Date.now()) / 60_000) : 0,
  };
}

/** Reset all state — for tests only. */
function _reset() {
  aiCost._reset();
  _apiFallbackUntil = 0;
}

module.exports = {
  checkAndIncrement,
  getStatus,
  setApiFallback,
  clearApiFallback,
  isApiFallback,
  getApiFallbackInfo,
  _reset,
};
