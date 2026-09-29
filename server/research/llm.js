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
 * Every call goes through providers/claudeTransport.js, which prices it from
 * real usage, adds it to the spend ledger and the open cost receipt, and sends
 * it through the Batch API when the pipeline runs in batch mode.
 *
 * Note: the Lead Analyst *draft* call reuses anthropic.fetchResearchReport
 * (existing per-type prompts; Sonnet, or unavailable — never Haiku, D-19), so the
 * lead role env var governs extraction and revision calls, not the draft.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const budget    = require("../providers/budget");
const transport = require("../providers/claudeTransport");
const anthropic = require("../providers/anthropic");

// Model ids carry no date suffix. Sonnet 5 is cheaper per token and more
// capable than the Sonnet 4.5 this pipeline was first written against.
const models       = require("../providers/models");
const MODEL_HAIKU  = models.HAIKU;
const MODEL_SONNET = models.sonnetModel();   // SONNET_MODEL in .env (default Sonnet 5)

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

/** Usage accumulator for a pipeline run — call/token counts per role. */
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
 * buildUserContent — the user turn, optionally led by a cacheable shared block.
 *
 * Caching is a prefix match over tools → system → messages, so the shared block
 * (verified market data + the draft under review) must come FIRST in the user
 * turn, with the role-specific instructions after it. Reviewers that share a
 * model, tool set and system preamble then read that block from cache at 0.1x.
 */
function buildUserContent(user, sharedPrefix) {
  if (!sharedPrefix) return user;
  return [
    { type: "text", text: sharedPrefix, cache_control: { type: "ephemeral" } },
    { type: "text", text: user },
  ];
}

/**
 * callAgent — one budget-gated model call for a named role.
 *
 * @param {string} role     one of lead|extract|auditor|redteam|portfolio|chair|chat|ideas
 * @param {string} system   system prompt
 * @param {string} user     user prompt (role-specific part)
 * @param {object} opts     { maxTokens, search: "force"|"auto"|false, usage, sharedPrefix }
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

  const { maxTokens = 3000, search = false, usage = null, sharedPrefix = null } = opts;
  const model = modelForRole(role);

  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: buildUserContent(user, sharedPrefix) }],
  };
  if (search) {
    body.tools = [anthropic.webSearchTool(model)];
    if (search === "force") body.tool_choice = { type: "any" };
  }

  const json = await transport.send(body, { role, label: `Anthropic[${role}]` });
  recordUsage(usage, role, json);

  return (json.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n");
}

module.exports = { callAgent, modelForRole, newUsageTracker, buildUserContent, MODEL_HAIKU, MODEL_SONNET };
