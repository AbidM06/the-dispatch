/**
 * server/retry.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Retry wrapper with exponential backoff, jitter, and per-attempt timeout.
 * Used by all provider adapters to handle transient network failures and
 * rate-limit responses (429s from Alpha Vantage free tier, etc.).
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * fetchWithTimeout — wraps native fetch with an AbortController timeout.
 * @param {string} url
 * @param {RequestInit} opts
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, opts = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * withRetry — retries an async fn on failure with exponential backoff.
 *
 * @param {() => Promise<T>} fn          Async function to retry
 * @param {object}           opts
 * @param {number}           opts.attempts   Max total attempts (default 3)
 * @param {number}           opts.baseMs     Initial backoff ms (default 400)
 * @param {number}           opts.maxMs      Max backoff ms (default 8000)
 * @param {(err: Error, attempt: number) => boolean} opts.shouldRetry
 *         Return false to abort early (e.g. 401 auth errors are not retryable)
 * @returns {Promise<T>}
 */
async function withRetry(fn, opts = {}) {
  const {
    attempts   = 3,
    baseMs     = 400,
    maxMs      = 8_000,
    shouldRetry = (_err, _attempt) => true,
  } = opts;

  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isLast = i === attempts - 1;
      if (isLast || !shouldRetry(err, i + 1)) break;

      // Exponential backoff with ±20% jitter
      const backoff = Math.min(baseMs * 2 ** i, maxMs);
      const jitter  = backoff * 0.2 * (Math.random() * 2 - 1);
      const delay   = Math.round(backoff + jitter);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

/**
 * isRetryable — helper for shouldRetry option.
 * Network errors, 429, 500–504 are retryable; 4xx auth errors are not.
 */
function isRetryable(err) {
  if (err.name === "AbortError") return true;        // timeout
  if (!err.status) return true;                       // network error
  if (err.status === 429) return true;               // rate limit — backoff helps
  if (err.status === 529) return true;               // Anthropic overloaded — retry after backoff
  if (err.status >= 500 && err.status <= 504) return true;
  return false;
}

module.exports = { fetchWithTimeout, withRetry, isRetryable };
