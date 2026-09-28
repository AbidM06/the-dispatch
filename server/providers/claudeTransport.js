/**
 * server/providers/claudeTransport.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The single place a Messages API request leaves the server.
 *
 * Both callers — providers/anthropic.js (report drafts, events, explain…) and
 * research/llm.js (the five-agent pipeline) — send through here, so every call:
 *   - is priced from its real `usage` and added to the persistent spend ledger
 *   - lands on the active cost receipt, if one is open (see runWithContext)
 *   - goes through the Message Batches API at 50% when batch mode is active,
 *     and falls back to a synchronous call if the batch does not deliver
 *   - detects billing errors and trips the budget's API-fallback window
 *
 * Context is carried with AsyncLocalStorage rather than threaded through every
 * agent's signature: the orchestrator opens a context (receipt + batch flag)
 * and every nested call inside it inherits that context automatically.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const { AsyncLocalStorage } = require("async_hooks");
const { fetchWithTimeout, withRetry, isRetryable } = require("../retry");
const budget   = require("./budget");
const aiCost   = require("./aiCost");
const batchApi = require("./anthropicBatch");

const API_URL = "https://api.anthropic.com/v1/messages";
const store   = new AsyncLocalStorage();

/**
 * runWithContext — run fn with a cost receipt and/or batch mode applied to
 * every Claude call made inside it (including nested async calls).
 * @param {{ receipt?: object, batch?: boolean, role?: string }} ctx
 */
function runWithContext(ctx, fn) {
  return store.run({ ...(store.getStore() || {}), ...ctx }, fn);
}

function currentContext() {
  return store.getStore() || {};
}

function apiKey() {
  const k = process.env.ANTHROPIC_API_KEY;
  if (!k) throw new Error("ANTHROPIC_API_KEY not set — add it to .env");
  return k;
}

async function sendSync(body, label) {
  return withRetry(
    async () => {
      const res = await fetchWithTimeout(
        API_URL,
        {
          method:  "POST",
          headers: {
            "content-type":      "application/json",
            "x-api-key":         apiKey(),
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
        },
        300_000  // web_search + large reports can take 2-3 min
      );
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        const msg = errJson?.error?.message || `HTTP ${res.status}`;
        const err = new Error(`${label}: ${msg}`);
        err.status = res.status;
        const isBillingError = res.status === 402 || /credit|billing|balance|payment|plan|quota/i.test(msg);
        if (isBillingError) {
          err.code = "API_CREDITS_EXHAUSTED";
          budget.setApiFallback();
        }
        throw err;
      }
      return res.json();
    },
    {
      attempts: 3,
      baseMs:   8_000,
      maxMs:    30_000,
      shouldRetry: (e) => isRetryable(e) && e.name !== "AbortError" && e.status !== 401 && e.status !== 403,
    }
  );
}

/** One-request batch. Returns the message JSON, or null if the batch did not deliver. */
async function sendBatch(body, role) {
  const results = await batchApi.runBatch([{ customId: `${role}-${Date.now()}`, params: body }]);
  const hit = results && Object.values(results)[0];
  if (!hit || hit.error || !hit.message) return null;
  return hit.message;
}

/**
 * send — make one Messages API call.
 * @param {object} body   full Messages API request body (model, system, messages, tools…)
 * @param {{ role?: string, label?: string }} opts
 *        role  — receipt line this call is charged to (e.g. "redteam");
 *                defaults to the context's role, then "other"
 *        label — error-message prefix
 * @returns {Promise<object>} the API's message JSON (content, usage, …)
 */
async function send(body, { role: roleOpt, label = "Anthropic" } = {}) {
  const ctx = currentContext();
  const role = roleOpt || ctx.role || "other";
  let json = null;
  let batched = false;

  if (ctx.batch) {
    json = await sendBatch(body, role).catch(err => {
      console.warn(`[claude] batch for ${role} failed (${err.message}) — sending synchronously`);
      return null;
    });
    batched = Boolean(json);
    if (!json) console.warn(`[claude] batch for ${role} did not deliver — sending synchronously at full rate`);
  }
  if (!json) json = await sendSync(body, label);

  const model  = json.model || body.model;
  const priced = aiCost.priceCall({ model, usage: json.usage, batch: batched });
  aiCost.record(priced);
  aiCost.addToReceipt(ctx.receipt, role, model, priced, { batch: batched });
  return json;
}

module.exports = { send, runWithContext, currentContext, API_URL };
