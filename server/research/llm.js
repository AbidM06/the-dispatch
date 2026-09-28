/**
 * server/research/llm.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Role-based LLM adapter for the five-agent research pipeline.
 *
 * Every call:
 *   - passes through the shared Anthropic budget gate (budget.checkAndIncrement)
 *   - respects DISABLE_AI / LOW_COST_MODE / API-fallback state
 *   - detects billing errors and triggers budget.setApiFallback()
 *   - can enable web_search (forced, auto, or off) per call
 *
 * Model per role is configurable via env:
 *   RESEARCH_LEAD_MODEL, RESEARCH_AUDITOR_MODEL, RESEARCH_REDTEAM_MODEL,
 *   RESEARCH_PORTFOLIO_MODEL, RESEARCH_CHAIR_MODEL, RESEARCH_CHAT_MODEL,
 *   RESEARCH_EXTRACT_MODEL
 *
 * Note: the Lead Analyst *draft* call reuses anthropic.fetchResearchReport
 * (existing per-type prompts + Sonnet→OpenAI→Haiku fallback chain), so the
 * lead role env var governs extraction and revision calls, not the draft.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const { fetchWithTimeout, withRetry, isRetryable } = require("../retry");
const budget = require("../providers/budget");

const API_URL      = "https://api.anthropic.com/v1/messages";
const MODEL_HAIKU  = "claude-haiku-4-5-20251001";
const MODEL_SONNET = "claude-sonnet-4-5-20250929";

const ROLE_DEFAULTS = {
  lead:      MODEL_SONNET,
  extract:   MODEL_HAIKU,
  auditor:   MODEL_SONNET,
  redteam:   MODEL_SONNET,
  portfolio: MODEL_SONNET,
  chair:     MODEL_SONNET,
  chat:      MODEL_SONNET,
  ideas:     MODEL_SONNET,
};

const ROLE_ENV = {
  lead:      "RESEARCH_LEAD_MODEL",
  extract:   "RESEARCH_EXTRACT_MODEL",
  auditor:   "RESEARCH_AUDITOR_MODEL",
  redteam:   "RESEARCH_REDTEAM_MODEL",
  portfolio: "RESEARCH_PORTFOLIO_MODEL",
  chair:     "RESEARCH_CHAIR_MODEL",
  chat:      "RESEARCH_CHAT_MODEL",
  ideas:     "IDEAS_MODEL",
};

function modelForRole(role) {
  const envName = ROLE_ENV[role];
  return (envName && process.env[envName]) || ROLE_DEFAULTS[role] || MODEL_HAIKU;
}

function apiKey() {
  const k = process.env.ANTHROPIC_API_KEY;
  if (!k) throw new Error("ANTHROPIC_API_KEY not set — add it to .env");
  return k;
}

/** Usage accumulator for a pipeline run — approximate cost visibility (§19). */
function newUsageTracker() {
  return { calls: 0, inputTokens: 0, outputTokens: 0, byRole: {} };
}

function recordUsage(tracker, role, json) {
  if (!tracker) return;
  tracker.calls += 1;
  const u = json?.usage;
  if (u) {
    tracker.inputTokens  += u.input_tokens  || 0;
    tracker.outputTokens += u.output_tokens || 0;
  }
  const r = (tracker.byRole[role] = tracker.byRole[role] || { calls: 0, inputTokens: 0, outputTokens: 0 });
  r.calls += 1;
  if (u) {
    r.inputTokens  += u.input_tokens  || 0;
    r.outputTokens += u.output_tokens || 0;
  }
}

/**
 * callAgent — one budget-gated model call for a named role.
 *
 * @param {string} role     one of lead|extract|auditor|redteam|portfolio|chair|chat
 * @param {string} system   system prompt
 * @param {string} user     user prompt
 * @param {object} opts     { maxTokens, search: "force"|"auto"|false, usage }
 * @returns {Promise<string>} concatenated text blocks
 */
async function callAgent(role, system, user, opts = {}) {
  if (process.env.DISABLE_AI === "true")     throw new Error("AI disabled via DISABLE_AI=true");
  if (process.env.LOW_COST_MODE === "true")  throw new Error("LOW_COST_MODE");
  if (budget.isApiFallback()) {
    const err = new Error("Anthropic API in billing-fallback window");
    err.code = "API_CREDITS_EXHAUSTED";
    throw err;
  }

  budget.checkAndIncrement();

  const { maxTokens = 3000, search = false, usage = null } = opts;
  const model = modelForRole(role);

  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  };
  if (search) {
    body.tools = [{ type: "web_search_20250305", name: "web_search" }];
    if (search === "force") body.tool_choice = { type: "any" };
  }

  const json = await withRetry(
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
        300_000
      );
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        const msg = errJson?.error?.message || `HTTP ${res.status}`;
        const err = new Error(`Anthropic[${role}]: ${msg}`);
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

  recordUsage(usage, role, json);

  return (json.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n");
}

module.exports = { callAgent, modelForRole, newUsageTracker, MODEL_HAIKU, MODEL_SONNET };
