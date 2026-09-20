/**
 * server/providers/budget.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared Anthropic API budget gate.
 *
 * Tracks daily and monthly call counts in memory.
 * Caps are read from env vars at call time (hot-reloadable via .env changes):
 *   ANTHROPIC_DAILY_CAP    default 5
 *   ANTHROPIC_MONTHLY_CAP  default 50
 *
 * Set either cap to 0 to disable that dimension of gating.
 * Set DISABLE_AI=true to block all calls regardless.
 *
 * Usage:
 *   const budget = require('./budget');
 *   budget.checkAndIncrement();   // throws BudgetError if over cap
 *   budget.getStatus();           // { daily, monthly }
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

let _dayKey     = "";
let _monthKey   = "";
let _dayCount   = 0;
let _monthCount = 0;

// ── Auto-fallback state ───────────────────────────────────────────────────────
// When the Anthropic API returns a billing/credit error the server automatically
// enters "API fallback" mode for a configurable window (default 60 min).
// During this window all routes return deterministic narrative instead of calling
// AI, preventing repeated failed API calls.  The window auto-expires so that if
// the user tops up their credits, AI resumes on the next scheduled refresh.
let _apiFallbackUntil = 0; // epoch ms; 0 = not in fallback

/**
 * `parseInt(undefined, 10)` is NaN, and NaN is neither null nor undefined, so
 * `?? 5` never fired: with the env var unset both caps evaluated to NaN and
 * every `spend > cap` comparison was false. The spend limits the README
 * advertises have therefore never been enforced by default.
 *
 * `||` is not a safe fix either — it would silently turn a deliberate cap of 0
 * into the default. Validate explicitly instead.
 */
function _intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[budget] ${name}="${raw}" is not a non-negative integer — using ${fallback}.`);
    return fallback;
  }
  return n;
}

function _dailyCap()   { return _intEnv("ANTHROPIC_DAILY_CAP",   5); }
function _monthlyCap() { return _intEnv("ANTHROPIC_MONTHLY_CAP", 50); }
function _today()      { return new Date().toISOString().slice(0, 10); }
function _thisMonth()  { return new Date().toISOString().slice(0, 7);  }

function _sync() {
  const d = _today();
  const m = _thisMonth();
  if (_dayKey   !== d) { _dayKey   = d; _dayCount   = 0; }
  if (_monthKey !== m) { _monthKey = m; _monthCount = 0; }
}

/**
 * Check current caps and increment counters if within budget.
 * Throws an Error with err.code === "BUDGET_DAILY" or "BUDGET_MONTHLY" if exceeded.
 */
function checkAndIncrement() {
  _sync();
  const daily   = _dailyCap();
  const monthly = _monthlyCap();

  if (daily > 0 && _dayCount >= daily) {
    const err = new Error(
      `Anthropic daily budget exhausted (${_dayCount}/${daily} calls today). Resets at midnight UTC.`
    );
    err.code = "BUDGET_DAILY";
    throw err;
  }
  if (monthly > 0 && _monthCount >= monthly) {
    const err = new Error(
      `Anthropic monthly budget exhausted (${_monthCount}/${monthly} calls this month).`
    );
    err.code = "BUDGET_MONTHLY";
    throw err;
  }

  _dayCount++;
  _monthCount++;
}

/**
 * Return current usage vs caps without incrementing.
 */
function getStatus() {
  _sync();
  const daily   = _dailyCap();
  const monthly = _monthlyCap();
  return {
    daily:   { used: _dayCount,   cap: daily,   remaining: daily   > 0 ? Math.max(0, daily   - _dayCount)   : Infinity },
    monthly: { used: _monthCount, cap: monthly, remaining: monthly > 0 ? Math.max(0, monthly - _monthCount) : Infinity },
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
  _dayKey = ""; _monthKey = "";
  _dayCount = 0; _monthCount = 0;
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
