/**
 * server/providers/openai.js
 * ─────────────────────────────────────────────────────────────────────────────
 * OpenAI Chat Completions adapter — used as a fallback when Claude Sonnet is
 * overloaded or returns an unparseable response.
 *
 * No SDK dependency — uses the same fetch pattern as anthropic.js.
 * Model: gpt-4o (override via OPENAI_FALLBACK_MODEL env var).
 *
 * Note: unlike Claude, this call has no web_search tool. The analysis is
 * grounded by the rates context string passed in the prompt, not live search.
 * Still substantially better than returning the static seeded fallback.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const { fetchWithTimeout, withRetry, isRetryable } = require("../retry");

const API_URL = "https://api.openai.com/v1/chat/completions";

function apiKey() {
  const k = process.env.OPENAI_API_KEY;
  if (!k) throw new Error("OPENAI_API_KEY not set — add it to .env to enable OpenAI fallback");
  return k;
}

function model() {
  return process.env.OPENAI_FALLBACK_MODEL || "gpt-4o";
}

/**
 * callOpenAI — raw Chat Completions call.
 * Returns the assistant message text string.
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {number} maxTokens
 * @returns {Promise<string>}
 */
async function callOpenAI(systemPrompt, userPrompt, maxTokens) {
  const json = await withRetry(
    async () => {
      const res = await fetchWithTimeout(
        API_URL,
        {
          method:  "POST",
          headers: {
            "content-type":  "application/json",
            "authorization": `Bearer ${apiKey()}`,
          },
          body: JSON.stringify({
            model:      model(),
            max_tokens: maxTokens,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user",   content: userPrompt   },
            ],
          }),
        },
        120_000  // 2 min ceiling — no web_search, so faster than Claude
      );

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        const msg = errJson?.error?.message || `HTTP ${res.status}`;
        const err = new Error(`OpenAI: ${msg}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    {
      attempts:    2,
      baseMs:      4_000,
      maxMs:       15_000,
      shouldRetry: (e) => isRetryable(e) && e.status !== 401 && e.status !== 403,
    }
  );

  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI: empty response content");
  return text;
}

module.exports = { callOpenAI };
