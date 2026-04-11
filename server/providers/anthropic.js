/**
 * server/providers/anthropic.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Anthropic Messages API adapter.
 * API key is server-side only — never sent to the browser.
 *
 * Cost-reduction measures (Phase 2b):
 *   - fetchAllAnalysis(): ONE merged AI call returns events + risks + econ.
 *     Replaces the previous 2–3 separate calls per refresh cycle.
 *   - Reduced max_tokens per call (concise JSON output enforced in prompts).
 *   - Explainer TTL raised to 24 h; events/risk/econ to 12 h (see routes).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { fetchWithTimeout, withRetry, isRetryable } = require("../retry");
const budget   = require("./budget");
const { callOpenAI } = require("./openai");

const API_URL      = "https://api.anthropic.com/v1/messages";
const MODEL        = "claude-haiku-4-5-20251001";  // Haiku — events, risk, econ, explains, fx, rates
const MODEL_SONNET = "claude-sonnet-4-5-20250929";  // Sonnet — macro, commodities, equity, thematic (4-6 too overloaded)

function apiKey() {
  const k = process.env.ANTHROPIC_API_KEY;
  if (!k) throw new Error("ANTHROPIC_API_KEY not set — add it to .env");
  return k;
}

/**
 * callClaude — raw Messages API call.
 */
async function _callClaudeOnce(systemPrompt, userPrompt, maxTokens, model) {
  const body = {
    model,
    max_tokens: maxTokens,
    system:     systemPrompt,
    tools:      [{ type: "web_search_20250305", name: "web_search" }],
    tool_choice: { type: "any" },
    messages:   [{ role: "user", content: userPrompt }],
  };

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
        300_000  // 5 min ceiling — web_search + large reports can take 2-3 min; no artificial cap
      );

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        const msg = errJson?.error?.message || `HTTP ${res.status}`;
        const err = new Error(`Anthropic: ${msg}`);
        err.status = res.status;

        const isBillingError =
          res.status === 402 ||
          /credit|billing|balance|payment|plan|quota/i.test(msg);
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

  return (json.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n");
}

async function callClaude(systemPrompt, userPrompt, maxTokens = 1500, model = MODEL) {
  if (process.env.DISABLE_AI === "true") throw new Error("AI disabled via DISABLE_AI=true");
  // Budget gate — throws BUDGET_DAILY or BUDGET_MONTHLY if over cap
  budget.checkAndIncrement();

  try {
    return await _callClaudeOnce(systemPrompt, userPrompt, maxTokens, model);
  } catch (err) {
    // If Sonnet is overloaded (529) after all retries, fall back to Haiku rather than
    // returning deterministic seed data — a Haiku report is far better than nothing.
    if (model !== MODEL && err.status === 529) {
      console.warn(`[anthropic] ${model} overloaded — falling back to Haiku for this call`);
      return await _callClaudeOnce(systemPrompt, userPrompt, maxTokens, MODEL);
    }
    throw err;
  }
}

/**
 * callWithFallback — three-tier AI fallback for research reports.
 * Order: Claude Sonnet → OpenAI GPT → Claude Haiku → throw
 *
 * Bypasses callClaude's automatic Sonnet→Haiku cascade so OpenAI gets a
 * chance before Haiku. Budget check is run independently for each Claude tier.
 */
async function callWithFallback(systemPrompt, userPrompt, maxTokens) {
  if (process.env.DISABLE_AI === "true") throw new Error("AI disabled via DISABLE_AI=true");

  // Tier 1: Claude Sonnet
  let sonnetErr;
  try {
    budget.checkAndIncrement();
    return await _callClaudeOnce(systemPrompt, userPrompt, maxTokens, MODEL_SONNET);
  } catch (err) {
    sonnetErr = err;
    console.warn(`[anthropic] Sonnet failed (${err.message}) — trying OpenAI ${process.env.OPENAI_FALLBACK_MODEL || "gpt-4.1"}`);
  }

  // Tier 2: OpenAI GPT
  try {
    return await callOpenAI(systemPrompt, userPrompt, maxTokens);
  } catch (openaiErr) {
    console.warn(`[anthropic] OpenAI failed (${openaiErr.message}) — trying Haiku`);
  }

  // Tier 3: Claude Haiku
  try {
    budget.checkAndIncrement();
    return await _callClaudeOnce(systemPrompt, userPrompt, maxTokens, MODEL);
  } catch (haikusErr) {
    console.warn(`[anthropic] Haiku also failed: ${haikusErr.message}`);
    throw sonnetErr; // surface the original Sonnet error to the route's catch
  }
}

/**
 * repairJSON — state-machine JSON fixer.
 *
 * Walks the string character by character, tracking whether we're inside a
 * JSON string value.  Fixes two failure modes that are common in AI output:
 *
 *  1. Literal control characters (newline, CR, tab) inside strings.
 *     JSON requires these to be written as the two-char escapes \n \r \t.
 *
 *  2. Unescaped double-quote characters inside string values.
 *     Claude often outputs quoted text like "transformative" without escaping.
 *     Detection: when inside a string, a '"' followed (after whitespace) by
 *     anything other than , } ] : or end-of-input is treated as content, not
 *     a closing delimiter, and is emitted as \".
 */
function repairJSON(str) {
  let out   = "";
  let inStr = false;
  let esc   = false;   // previous char was an unprocessed backslash

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    // If previous char was \ we're in an escape sequence — pass both chars through unchanged
    if (esc) { out += ch; esc = false; continue; }

    if (inStr) {
      if (ch === "\\") { out += ch; esc = true; continue; }

      if (ch === '"') {
        // Decide: is this the closing delimiter, or an unescaped content quote?
        // Peek at the next non-whitespace character.
        let j = i + 1;
        while (j < str.length && /[ \t\r\n]/.test(str[j])) j++;
        const nxt = j < str.length ? str[j] : "";
        if (nxt === "" || nxt === "," || nxt === "}" || nxt === "]" || nxt === ":") {
          inStr = false;
          out += ch;          // legitimate closing quote
        } else {
          out += '\\"';       // unescaped content quote — escape it
        }
        continue;
      }

      // Fix literal control characters (must be escaped inside JSON strings)
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }

      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
}

/**
 * extractJSON — parse JSON from a Claude text response.
 *
 * Handles four common failure modes:
 *  1. Cite tags embedded in string values (<cite index="0">text</cite>)
 *  2. Markdown fences or preamble text wrapping the JSON
 *  3. Literal control characters inside string values
 *  4. Unescaped double-quote characters inside string values
 */
function sliceJSONCandidate(str, type = "array") {
  const open = type === "array" ? "[" : "{";
  const start = str.indexOf(open);
  if (start === -1) return null;

  let inStr = false;
  let esc = false;
  const stack = [];
  let end = -1;

  for (let i = start; i < str.length; i++) {
    const ch = str[i];

    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }

    if (ch === '"') {
      inStr = true;
      esc = false;
      continue;
    }

    if (ch === "{") { stack.push("}"); continue; }
    if (ch === "[") { stack.push("]"); continue; }

    if ((ch === "}" || ch === "]") && stack.length > 0 && ch === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) { end = i; break; }
    }
  }

  if (end !== -1) {
    return {
      candidate: str.slice(start, end + 1),
      truncated: false,
    };
  }

  // Truncated output: close any unterminated string + remaining structures.
  let candidate = str.slice(start);
  if (inStr) {
    if (esc) candidate += "\\";
    candidate += '"';
  }
  while (stack.length > 0) candidate += stack.pop();

  return {
    candidate,
    truncated: true,
  };
}

function extractJSON(raw, type = "array") {
  if (typeof raw !== "string" || raw.trim() === "") return null;

  // Step 1 — strip cite tags that web_search injects into text values
  const cleaned = raw
    .replace(/<cite[^>]*>([\s\S]*?)<\/cite>/gi, "$1")
    .replace(/<cite[^>]*>/gi, "")
    .replace(/<\/cite>/gi, "")
    .trim();

  // Step 2 — try direct parse
  try { return JSON.parse(cleaned); } catch (_) {}

  // Step 3 — isolate first JSON structure while respecting strings so braces
  // inside narrative text don't break depth counting.
  const sliced = sliceJSONCandidate(cleaned, type);
  if (!sliced?.candidate) return null;
  const candidate = sliced.candidate;

  // Step 4 — try sliced candidate
  try { return JSON.parse(candidate); } catch (_) {}

  // Step 5 — fix structural issues Claude occasionally emits in long pretty-printed arrays:
  //   a) missing comma between objects: }\n{ → },\n{
  //   b) trailing comma before ] or }:  ,]  → ]   and  ,}  → }
  const structural = candidate
    .replace(/\}(\s*\n\s*)\{/g, "},$1{")
    .replace(/,(\s*[}\]])/g, "$1");
  try { return JSON.parse(structural); } catch (_) {}

  // Step 6 — run state-machine repair (control chars + unescaped quotes)
  const repaired = repairJSON(structural);
  try { return JSON.parse(repaired); } catch (e) {
    console.warn("[Anthropic] extractJSON parse error:", e.message);
  }
  return null;
}

function todayString() {
  return new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

/**
 * stripCiteTags — remove citation markup that the model occasionally emits
 * when web_search is enabled, e.g. <cite index="0-2">text</cite>.
 * Keeps the inner text; silently removes the tags.
 * Applied to all free-text fields before returning data to callers.
 */
function stripCiteTags(str) {
  if (typeof str !== "string") return str;
  return str
    .replace(/<cite[^>]*>([\s\S]*?)<\/cite>/gi, "$1") // <cite ...>text</cite> → text
    .replace(/<cite[^>]*>/gi, "")                      // orphaned opening tag
    .replace(/<\/cite>/gi, "")                         // orphaned closing tag
    .trim();
}

// ── MERGED: fetchAllAnalysis ──────────────────────────────────────────────────
/**
 * Single AI call that returns events + risks + econ together.
 * Replaces fetchMarketEvents() + fetchRiskScores() + fetchEconAnalysis() (3 calls → 1).
 *
 * @returns {{ events, risks, econ }}
 */
async function fetchAllAnalysis(newsContext = "") {
  if (process.env.DISABLE_AI === "true") throw new Error("AI disabled via DISABLE_AI=true");

  const today   = todayString();
  const isoDate = new Date().toISOString().slice(0, 10);
  const system  = `Today is ${today}. You MUST use web_search before answering. Return ONLY a single valid JSON object — no markdown fences, no preamble, no commentary.`;

  const prompt = `Search for the latest financial and geopolitical news as of ${today}. Focus on: US-Iran conflict, tariffs, AI semiconductors, Federal Reserve, credit markets, EM currencies, Bank of Japan.

Return a single JSON object with EXACTLY these three keys:

"events": array of exactly 5 objects, each: { "headline": string, "impact": "BULLISH"|"BEARISH"|"NEUTRAL", "ticker": string (most relevant or "MACRO"), "date": "YYYY-MM-DD", "detail": string (one concise sentence with specific data) }

"risks": array of exactly 7 objects in this order — (1) US/Israel-Iran War, (2) US Tariffs Canada/Mexico, (3) AMD ASIC Competitive Threat, (4) Rising Real Yields, (5) EM Currency Stress, (6) Credit Spread Widening, (7) Japan YCC Exit — each: { "id": number, "title": string, "level": "HIGH"|"MEDIUM"|"LOW", "score": integer 0-100, "date": "${isoDate}", "detail": string (2 sentences max, specific data), "affects": string }

"econ": array of exactly 3 objects: { "id": number, "label": string, "color": string, "bg": string, "border": string, "date": "${isoDate}", "title": string, "body": string (3 sentences max, specific current data) }
Labels/colors: ["MACRO THEME","RATES ANALYSIS","EQUITY DEEP DIVE"] / ["#c8392b","#1a3a5c","#2c6e49"]
Bg: ["rgba(200,57,43,.08)","rgba(26,58,92,.15)","rgba(44,110,73,.08)"]
Border: ["rgba(200,57,43,.2)","rgba(88,166,255,.2)","rgba(63,185,80,.2)"]

Be concise. Total response must fit in 3500 tokens.${newsContext}`;

  const raw  = await callClaude(system, prompt, 3500);
  const data = extractJSON(raw, "object");

  if (!data || !Array.isArray(data.events) || !Array.isArray(data.risks) || !Array.isArray(data.econ)) {
    throw new Error("fetchAllAnalysis: could not parse merged JSON from AI response");
  }

  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const now = Date.now();
  const RECENCY_MS = 30 * 24 * 60 * 60_000; // 30 days

  function validateEventDate(dateStr) {
    if (!dateStr || !ISO_DATE_RE.test(dateStr)) return { date: null, dateVerified: false };
    const ts = Date.parse(dateStr);
    if (isNaN(ts) || ts > now + 86_400_000 || ts < now - RECENCY_MS) {
      return { date: null, dateVerified: false };
    }
    return { date: dateStr, dateVerified: true };
  }

  return {
    events: data.events.slice(0, 5).map(e => ({
      ...e,
      headline: stripCiteTags(e.headline),
      detail:   stripCiteTags(e.detail),
      ...validateEventDate(e.date),
    })),
    risks: data.risks.slice(0, 7).map((r, i) => ({
      ...r,
      id:     i + 1,
      title:  stripCiteTags(r.title),
      detail: stripCiteTags(r.detail),
    })),
    econ: data.econ.slice(0, 3).map(e => ({
      ...e,
      title: stripCiteTags(e.title),
      body:  stripCiteTags(e.body),
    })),
  };
}

// ── Individual functions (kept for backward compat / explain route) ───────────

async function fetchMarketEvents() {
  if (process.env.DISABLE_AI === "true") throw new Error("AI disabled via DISABLE_AI=true");
  const today = todayString();
  const isoDate = new Date().toISOString().slice(0, 10);
  const system = `Today is ${today}. Use web_search. Return ONLY valid JSON array.`;
  const prompt = `Search for top 5 market-moving events from the past 7 days. Return JSON array of 5 objects: { "headline", "impact": "BULLISH"|"BEARISH"|"NEUTRAL", "ticker", "date": "YYYY-MM-DD", "detail" }. Be concise.`;
  const raw  = await callClaude(system, prompt, 1200);
  const data = extractJSON(raw, "array");
  if (!data || !Array.isArray(data)) throw new Error("Could not parse events JSON");
  return data.slice(0, 5);
}

async function fetchRiskScores() {
  if (process.env.DISABLE_AI === "true") throw new Error("AI disabled via DISABLE_AI=true");
  const today = todayString();
  const isoDate = new Date().toISOString().slice(0, 10);
  const system = `Today is ${today}. Use web_search. Return ONLY valid JSON array.`;
  const prompt = `Search latest news on 7 portfolio risks (AMD, HIES, HIUS, HIJS, SGLN, HBKS): (1) US/Israel-Iran conflict, (2) US tariffs Canada/Mexico, (3) AMD ASIC threats, (4) US real yields, (5) EM currency stress, (6) HY credit spreads, (7) BoJ normalisation. Return JSON array of 7 objects: { "title", "level": "HIGH"|"MEDIUM"|"LOW", "score": 0-100, "date": "${isoDate}", "detail" (2 sentences), "affects" }. Be concise.`;
  const raw  = await callClaude(system, prompt, 1600);
  const data = extractJSON(raw, "array");
  if (!data || data.length < 7) throw new Error("Insufficient risk items from AI");
  return data.slice(0, 7).map((r, i) => ({ ...r, id: i + 1 }));
}

async function fetchEconAnalysis() {
  if (process.env.DISABLE_AI === "true") throw new Error("AI disabled via DISABLE_AI=true");
  const today = todayString();
  const isoDate = new Date().toISOString().slice(0, 10);
  const system = `Today is ${today}. Use web_search. Return ONLY valid JSON array.`;
  const prompt = `Search today's macro/markets. Return JSON array of 3 objects — MACRO THEME (Iran/oil), RATES ANALYSIS (Fed/yields), EQUITY DEEP DIVE (AMD). Each: { "id", "label", "color", "bg", "border", "date": "${isoDate}", "title", "body" (3 sentences, specific data) }. Colors: #c8392b,#1a3a5c,#2c6e49. Be concise.`;
  const raw  = await callClaude(system, prompt, 2000);
  const data = extractJSON(raw, "array");
  if (!data || data.length !== 3) throw new Error("Expected 3 econ items");
  return data;
}

async function evaluateThesis(ticker, thesis, horizon = "12 months") {
  if (process.env.DISABLE_AI === "true") throw new Error("AI disabled via DISABLE_AI=true");
  const today = todayString();
  const system = `Today is ${today}. You are a senior sell-side analyst. Use web_search for current data. Return ONLY valid JSON object — no markdown.`;
  const prompt = `Evaluate this ${ticker} thesis (${horizon} horizon): "${thesis}"

Search: current price, latest earnings/guidance, analyst consensus, competitive developments, macro headwinds.

Return JSON: { "bull": { "score": 0-100, "rationale": "2 sentences", "triggers": ["x","y","z"] }, "bear": { "score": 0-100, "rationale": "2 sentences", "triggers": ["x","y","z"] }, "base": { "score": 0-100, "rationale": "2 sentences", "recommendation": "BUY|HOLD|SELL" }, "confidence": 0-100, "risks": ["x","y","z"], "keyMetrics": { "currentPrice": number|null, "analystTarget": number|null, "upsidePct": number|null, "nextCatalyst": "string" } }`;
  const raw  = await callClaude(system, prompt, 2000);
  const data = extractJSON(raw, "object");
  if (!data || !data.bull) throw new Error(`Could not parse thesis evaluation for ${ticker}`);
  return data;
}

async function fetchTickerExplain(ticker) {
  if (process.env.DISABLE_AI === "true") throw new Error("AI disabled via DISABLE_AI=true");
  const today = todayString();
  const system = `Today is ${today}. Use web_search. Return ONLY valid JSON object.`;
  const prompt = `Search latest info on ${ticker}. Return JSON: { "ticker", "what" (2 sentences: what this asset IS, for an economics student), "now" (current situation with data), "portfolio" (how it affects AMD/HIES/HIUS/HIJS/SGLN/HBKS portfolio), "confidence": 0-100 }. Be concise.`;
  const raw  = await callClaude(system, prompt, 1000);
  const data = extractJSON(raw, "object");
  if (!data || !data.what) throw new Error(`Could not parse explanation for ${ticker}`);
  return {
    ...data,
    what:      stripCiteTags(data.what),
    now:       stripCiteTags(data.now),
    portfolio: stripCiteTags(data.portfolio),
  };
}

// Legacy export kept for backward compat (watchlist prices no longer AI-fetched)
async function fetchWatchlistPrices(symbols) {
  throw new Error("fetchWatchlistPrices deprecated — use AV or seed fallback");
}

/**
 * generateTradeIdeas — generate 1–3 trade idea drafts using Claude.
 *
 * Calls the API WITHOUT web search (context is supplied by the caller).
 * Cheaper than callClaude (no tool loop) and faster (~2–4s vs 8–15s).
 *
 * @param {string} portfolioContext  Pre-formatted string: portfolio + rates + regime
 * @param {number} count             Number of ideas to generate (1–3)
 * @returns {object[]}               Array of idea draft objects (not persisted)
 */
async function generateTradeIdeas(portfolioContext, count = 3) {
  budget.checkAndIncrement();

  const body = {
    model:      MODEL,
    max_tokens: 2000,
    system:     "You are an institutional equity analyst. Return ONLY valid JSON — no markdown fences, no preamble, no commentary.",
    messages:   [{
      role:    "user",
      content: `Based on the portfolio and market context below, generate exactly ${count} trade idea(s).\n` +
               `Use ONLY instruments from: AMD, SGLN, HIES, HIUS, HIJS, HBKS, NVDA, MU.\n\n` +
               `${portfolioContext}\n\n` +
               `Return JSON:\n` +
               `{ "ideas": [ {\n` +
               `  "ticker": string,\n` +
               `  "direction": "LONG"|"SHORT",\n` +
               `  "thesis": string (2-3 sentences, include strategy type e.g. macro hedge/earnings momentum/mean reversion/duration long),\n` +
               `  "catalyst": string (1 sentence, specific and near-term),\n` +
               `  "entry": number,\n` +
               `  "stop": number,\n` +
               `  "target": number,\n` +
               `  "invalidation": string (1 sentence),\n` +
               `  "horizon": string (e.g. "3 months"),\n` +
               `  "confidence": integer 0-100,\n` +
               `  "sizePct": number 1-8,\n` +
               `  "notes": string (risk/sizing context)\n` +
               `} ] }`,
    }],
  };

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
    35_000
  );

  if (!res.ok) {
    const errJson = await res.json().catch(() => ({}));
    const msg = errJson?.error?.message || `HTTP ${res.status}`;
    const err = new Error(`Anthropic: ${msg}`);
    const isBillingErr = res.status === 402 || /credit|billing|balance|payment|plan|quota/i.test(msg);
    if (isBillingErr) { err.code = "API_CREDITS_EXHAUSTED"; budget.setApiFallback(); }
    throw err;
  }

  const json = await res.json();
  const text = (json.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
  const data = extractJSON(text, "object");

  if (!data?.ideas || !Array.isArray(data.ideas)) {
    throw new Error("generateTradeIdeas: could not parse ideas JSON");
  }

  const REQUIRED = ["ticker", "direction", "thesis", "catalyst", "entry", "stop", "target",
                    "invalidation", "horizon", "confidence", "sizePct"];
  const valid = data.ideas.filter(idea =>
    REQUIRED.every(f => idea[f] !== undefined && idea[f] !== null && idea[f] !== "")
  );
  if (valid.length === 0) throw new Error("generateTradeIdeas: no valid ideas returned");

  return valid.slice(0, count);
}

/**
 * fetchMacroView — institutional-grade morning note for S&T Sales.
 *
 * Produces a JPMorgan/Goldman-quality briefing a salesperson can use
 * on the phone with institutional clients from 7:30am. Uses Sonnet via
 * callWithFallback (Sonnet → OpenAI → Haiku) with 6500 tokens.
 *
 * JSON fields (backward-compatible + new sections):
 *   Existing: headline, regimeLabel, scenarios, crossAsset, centralBank, catalysts
 *   New:      overnightRecap, keyLevels, salesNote, tradeIdea, clientTalkingPoints, volSurface
 *
 * @param {string} ratesContext  - FRED rates string (already includes VIX3M/SKEW if available)
 * @param {{ vix3m, skew }}      - vol surface from Yahoo Finance (optional, for output pass-through)
 */
async function fetchMacroView(ratesContext = "", volSurface = {}) {
  const today = todayString();

  const system = `Today is ${today}. You are the head of global macro strategy at a bulge-bracket bank (JPMorgan / Goldman Sachs tier). You write the morning note that S&T sales read before speaking to pension funds, hedge funds, and asset managers. You MUST use web_search to find today's actual market levels — specific prices, not approximations. Return ONLY valid JSON. No markdown fences. No commentary outside the JSON object.`;

  const prompt = `Use web_search right now to find today's actual market data as of ${today}. Search for:
1. SPX futures, Nasdaq futures (current pre-market or most recent)
2. US 10Y yield, 2Y yield (exact, with today's move in bps)
3. DXY and GBP/USD (cable) specifically — do NOT substitute EUR/USD for cable
4. Brent crude and WTI spot
5. Gold spot (single consistent price — do not cite two different prices for gold)
6. VIX level
7. CDX HY spread (today's level and OVERNIGHT move in bps — not monthly or weekly)
8. Asian session: Nikkei, Hang Seng, Shanghai (closing levels with % change)
9. European session: FTSE 100, DAX, Euro Stoxx 50 (opening levels with % change)
10. The single biggest macro story driving markets right now

Current FRED rates (prior close): ${ratesContext || "use web search for latest"}

CRITICAL OUTPUT RULES — violating any of these makes the note unusable:
- Every number must be internally consistent. If Gold is $X and the move is -Y%, then yesterday's price must equal X / (1 - Y/100). Check this before writing. If inconsistent, write [UNVERIFIED] for that field.
- cable (GBP/USD): if you cannot find it, return null. Do NOT substitute EUR/USD or any other pair.
- CDX HY OAS: report the overnight bps move only. Do not cite a monthly or weekly figure.
- Never write parenthetical hedges like "(prior day)", "(data limited)", or "(limited in searches)" — if data is unavailable, return null for that field.
- Append a source tag to every keyLevels value: "(FRED)", "(web search)", or "(unverified)".

Return a single JSON object with ALL of the following keys:

"headline": string — one sentence with the dominant theme and 2-3 specific levels. Example: "10Y at 4.37% (+5bps) as oil hits $111 on Iran escalation — SPX futures -0.8%, VIX 25"

"regimeLabel": string — 2-4 words

"overnightRecap": object:
  "asia": string — 2 sentences, specific index levels and % changes, one causal driver. State dates explicitly, no hedging language.
  "europe": string — 2 sentences, specific index levels and % changes, one causal driver. State dates explicitly.
  "dominantTheme": string — 1 sentence, the single biggest force in markets right now

"keyLevels": object — append source tag to each value, return null if unavailable:
  "spxFutures": string or null (e.g. "5,210 (-0.8%) (web search)")
  "us10y": string or null (e.g. "4.37% (+5bps) (web search)")
  "us2y": string or null
  "dxy": string or null
  "cable": string or null — GBP/USD ONLY, null if not found
  "brent": string or null
  "gold": string or null — ONE price only, math-checked against pct move
  "vix": string or null
  "hyOas": string or null — must include overnight bps move (e.g. "376bps (+8bps overnight) (web search)")
  "vix3m": string or null — CBOE 3-Month VIX level with source tag (e.g. "23.1 (Yahoo Finance)")
  "skew": string or null — CBOE SKEW Index level with interpretation (e.g. "132 — elevated tail risk (Yahoo Finance)")

"scenarios": object:
  "base":  { "probability": integer, "title": string, "narrative": string (2 sentences with specific thresholds), "keyAssets": string }
  "bull":  { "probability": integer, "title": string, "narrative": string (2 sentences), "keyAssets": string }
  "bear":  { "probability": integer, "title": string, "narrative": string (2 sentences), "keyAssets": string }
Probabilities must sum to 100.

"crossAsset": array of exactly 10 objects — US Treasuries (Long Duration), TIPS / Inflation-Linked, IG Credit, HY Credit, US Equities (Growth/Tech), US Equities (Value/Cyclical), EM Equities, USD (DXY), Gold, Commodities:
  { "asset": string, "signal": "BULLISH"|"BEARISH"|"NEUTRAL", "rationale": string (1 sentence with a specific level or overnight move) }

"centralBank": object:
  "fed": string — 3 sentences: current rate, next meeting date + expected decision, one specific data point that would change the call
  "boe": string — 2 sentences: current stance, GBP implication
  "ecb": string — 2 sentences: current stance, EUR implication

"catalysts": array of exactly 3 objects — most market-moving events in the next 2 weeks:
  { "event": string, "date": string (YYYY-MM-DD), "consensus": string, "impact": string (beat vs miss with specific asset reaction) }

"salesNote": string — STRICT STRUCTURE, 5 sentences maximum:
  Sentences 1-2: What happened overnight and the single catalyst that drove it (specific levels, no index closes to 2 decimal places).
  Sentences 3-5: What the client should DO today — specific rotation, hedge, or position change with instrument named. End with one concrete reason to act now, not tomorrow.
  Do not recap after sentence 2. No passive voice. No generic macro commentary without a number attached.

"tradeIdea": object:
  "instrument": string — specific and tradeable (ETF ticker, futures contract, or single name)
  "direction": "LONG"|"SHORT"
  "rationale": string — ONE sentence only: why this trade and what is the catalyst
  "entry": string (current level)
  "stop": string (specific trigger, not just a price — tie it to a catalyst or level break)
  "target": string (specific level with implied return %)
  "timeframe": string

"clientTalkingPoints": array of exactly 3 strings — one sentence each, usable verbatim on the phone right now. Each must contain a specific number and an action verb. No generic macro commentary.

Total response under 6000 tokens.`;

  const raw  = await callWithFallback(system, prompt, 6500);
  const data = extractJSON(raw, "object");

  if (!data || !data.headline || !data.scenarios || !Array.isArray(data.crossAsset)) {
    throw new Error("fetchMacroView: could not parse JSON response");
  }

  return {
    // ── Backward-compatible fields ──────────────────────────────────────────────
    headline:    stripCiteTags(data.headline),
    regimeLabel: data.regimeLabel || "Unknown",
    scenarios:   {
      base: { ...data.scenarios.base, narrative: stripCiteTags(data.scenarios.base?.narrative || "") },
      bull: { ...data.scenarios.bull, narrative: stripCiteTags(data.scenarios.bull?.narrative || "") },
      bear: { ...data.scenarios.bear, narrative: stripCiteTags(data.scenarios.bear?.narrative || "") },
    },
    crossAsset:  data.crossAsset.slice(0, 10).map(a => ({
      ...a,
      rationale: stripCiteTags(a.rationale || ""),
    })),
    centralBank: {
      fed: stripCiteTags(data.centralBank?.fed || ""),
      boe: stripCiteTags(data.centralBank?.boe || ""),
      ecb: stripCiteTags(data.centralBank?.ecb || ""),
    },
    catalysts:   (data.catalysts || []).slice(0, 3).map(c => ({
      ...c,
      impact: stripCiteTags(c.impact || ""),
    })),
    // Keep morningNote for any consumers that depend on it — maps to salesNote
    morningNote: stripCiteTags(data.salesNote || data.morningNote || ""),
    // ── New institutional fields ────────────────────────────────────────────────
    overnightRecap: {
      asia:           stripCiteTags(data.overnightRecap?.asia || ""),
      europe:         stripCiteTags(data.overnightRecap?.europe || ""),
      dominantTheme:  stripCiteTags(data.overnightRecap?.dominantTheme || ""),
    },
    keyLevels:   data.keyLevels || {},
    salesNote:   stripCiteTags(data.salesNote || ""),
    tradeIdea:   data.tradeIdea ? {
      ...data.tradeIdea,
      rationale: stripCiteTags(data.tradeIdea.rationale || ""),
    } : null,
    clientTalkingPoints: (data.clientTalkingPoints || []).map(s => stripCiteTags(s)),
    // ── Vol surface (pass-through from Yahoo + AI-formatted fields) ────────────
    volSurface: {
      vix3m: volSurface.vix3m || null,
      skew:  volSurface.skew  || null,
      // Also surface AI-formatted strings from keyLevels for convenience
      vix3mFormatted: data.keyLevels?.vix3m || null,
      skewFormatted:  data.keyLevels?.skew  || null,
    },
    fetchedAt:   new Date().toISOString(),
  };
}

/**
 * fetchClientImpact — maps current macro to each institutional client type.
 * Returns analysis for 6 client types: pension, hedge fund, asset manager,
 * insurance, private bank, mutual fund.
 */
async function fetchClientImpact(ratesContext = "", regime = "") {
  const today  = todayString();
  const system = `Today is ${today}. You are a senior S&T salesperson at a major bank. Use web_search for current data. Return ONLY valid JSON — no markdown fences.`;

  const prompt = `You are preparing client impact notes for your S&T sales team. Use web_search to verify current macro data as of ${today}.

Macro context: ${ratesContext || "search for latest rates and market conditions"}
Regime: ${regime || "current market regime"}

For each of the 6 institutional client types below, produce a structured impact note covering what is happening to their portfolios RIGHT NOW and how a salesperson should engage them.

Return a single JSON object with key "clients" — an array of exactly 6 objects, one per client type, in this order:
1. Pension Fund
2. Hedge Fund (Global Macro / Multi-Strat)
3. Asset Manager (Long-Only)
4. Insurance Company
5. Private Bank / Wealth Manager
6. Mutual Fund

Each object:
{
  "type": string (client type name),
  "icon": string (1 emoji that represents this client),
  "primaryConcern": string (1 sentence — the #1 thing keeping their CIO up at night right now),
  "portfolioImpact": string (2 sentences — specific $ / bps / % impact where possible; what's working and what's hurting),
  "theyAreAsking": array of exactly 3 strings (the 3 questions they are most likely to call you about this week),
  "talkingPoint": string (2 sentences — what YOU would say to this client when they call; be specific, cite data, project confidence),
  "productOpportunity": string (1 sentence — what product/trade could you show them that addresses their current pain point or expresses your view),
  "urgency": "HIGH" | "MEDIUM" | "LOW"
}

Be specific. Cite real data. Write as a senior salesperson who knows these clients. Total under 4000 tokens.`;

  const raw  = await callClaude(system, prompt, 4000);
  const data = extractJSON(raw, "object");

  if (!data || !Array.isArray(data.clients) || data.clients.length < 6) {
    throw new Error("fetchClientImpact: could not parse JSON response");
  }

  return data.clients.slice(0, 6).map(c => ({
    ...c,
    primaryConcern:     stripCiteTags(c.primaryConcern || ""),
    portfolioImpact:    stripCiteTags(c.portfolioImpact || ""),
    talkingPoint:       stripCiteTags(c.talkingPoint || ""),
    productOpportunity: stripCiteTags(c.productOpportunity || ""),
    theyAreAsking:      (c.theyAreAsking || []).map(q => stripCiteTags(q)),
  }));
}

/**
 * fetchResearchReport — generates a Goldman Sachs-style economics comment.
 *
 * Format modelled on GS Global Economics Comment methodology:
 *  - Prose-first, exhibit-punctuated, no section headers
 *  - Two scenarios: Baseline + Stress/Upside
 *  - Language: "We estimate...", "We see risks from...", "Effects could be larger if..."
 *  - Empirical anchoring with specific data points (bp, pp, $, %)
 *  - Policy implications tied to central bank reaction functions
 *  - Market implications section (rates, equities, credit, FX)
 *
 * Cached 24h — call is ~$0.015, generated once daily unless force-refreshed.
 * topic: optional focus (e.g. "US tariffs", "Iran geopolitics", "Fed policy")
 */
async function fetchResearchReport(ratesContext = "", topic = "", reportType = "macro") {
  const today   = todayString();
  const isoDate = new Date().toISOString().slice(0, 10);

  // ── FX Viewpoint (BofA style) ─────────────────────────────────────────────
  if (reportType === "fx") {
    const system = `Today is ${today}. You are a senior G10 FX strategist at BofA Global Research. You MUST use web_search to ground every FX claim in real, current data. Return ONLY valid JSON — no markdown fences, no preamble, no trailing text.`;
    const focusInstruction = topic
      ? `Focus this FX Viewpoint on: ${topic}.`
      : `Identify the dominant FX theme of the past 7 days — commodity shock, central bank divergence, carry unwind, or geopolitical risk.`;
    const prompt = `${focusInstruction}
Current macro context: ${ratesContext}

Use web_search to find current G10 FX rates, CB statements, oil prices, CFTC positioning, rate differentials.

Return EXACTLY this JSON object (pure JSON, no markdown):

{
  "title": "<punchy headline like Think Outside the Barrel>",
  "subtitle": "<one sentence: key tension in FX markets right now>",
  "date": "${isoDate}",
  "keyTakeaways": [
    "<max 2 sentences — headline finding with number>",
    "<max 2 sentences — Long X vs Y screens well...>",
    "<max 2 sentences — We stay bearish/bullish beyond...>",
    "<max 2 sentences — tail risk or positioning observation>"
  ],
  "thesis": "<max 2 sentences — dominant driver of G10 FX today>",
  "framework": "<max 2 sentences — analytical lens that explains the price action>",
  "pairViews": [
    { "pair": "EUR/USD", "direction": "SHORT", "type": "conviction", "rationale": "<max 2 sentences>", "horizon": "3 months" },
    { "pair": "USD/JPY", "direction": "LONG", "type": "conviction", "rationale": "<max 2 sentences>", "horizon": "near-term" },
    { "pair": "AUD/NZD", "direction": "LONG", "type": "normalisation", "rationale": "<max 2 sentences>", "horizon": "1-3 months" },
    { "pair": "EUR/NOK", "direction": "SHORT", "type": "normalisation", "rationale": "<max 2 sentences>", "horizon": "medium-term" }
  ],
  "cbReactionFunctions": [
    { "bank": "Federal Reserve", "stance": "<e.g. Hawkish hold>", "rationale": "<max 1 sentence>" },
    { "bank": "Bank of Japan", "stance": "<e.g. Slow normaliser>", "rationale": "<max 1 sentence>" },
    { "bank": "ECB", "stance": "<e.g. Gradual easer>", "rationale": "<max 1 sentence>" }
  ],
  "tradeBarbell": {
    "hedges": ["<near-term hedge 1>", "<near-term hedge 2>"],
    "normalisationTrades": ["<medium-term trade 1>", "<medium-term trade 2>"]
  },
  "risks": ["<tail risk 1>", "<tail risk 2>", "<tail risk 3>"]
}

BofA language: "screens well for", "we stay bearish beyond", "fading the skew premium". Return pure JSON only.`;

    const raw  = await callClaude(system, prompt, 4000);
    const data = extractJSON(raw, "object");
    if (!data || !data.title || !Array.isArray(data.pairViews)) {
      throw new Error("fetchResearchReport[fx]: could not parse JSON response");
    }
    function stripAll(obj) {
      if (typeof obj === "string") return stripCiteTags(obj);
      if (Array.isArray(obj))     return obj.map(stripAll);
      if (obj && typeof obj === "object") {
        const out = {};
        for (const [k, v] of Object.entries(obj)) out[k] = stripAll(v);
        return out;
      }
      return obj;
    }
    return { ...stripAll(data), reportType: "fx", generatedAt: new Date().toISOString() };
  }

  // ── Rates & Carry Deep-Dive (MS G10 FX style) ────────────────────────────
  if (reportType === "rates") {
    const system = `Today is ${today}. You are a Morgan Stanley rates and G10 FX strategist. You MUST use web_search to find current CFTC positioning, central bank statements, and rate differentials. Return ONLY valid JSON — no markdown fences, no preamble, no trailing text.`;
    const focusInstruction = topic
      ? `Focus this rates deep-dive on: ${topic}.`
      : `Identify the key puzzle in current rates and FX markets — what is not behaving as conventional wisdom predicts?`;
    const prompt = `${focusInstruction}
Current macro context: ${ratesContext}

Use web_search to find CFTC positioning, CB minutes, real yield differentials, and carry trade data.

Return EXACTLY this JSON object (pure JSON, no markdown):

{
  "title": "<specific title like Linking the JPY Carry Trade to JPY Weakness>",
  "subtitle": "<the central paradox in one sentence>",
  "date": "${isoDate}",
  "keyTakeaways": [
    "<max 2 sentences — key observation 1>",
    "<max 2 sentences — key observation 2>",
    "<max 2 sentences — key observation 3>",
    "<max 2 sentences — key observation 4>",
    "<max 2 sentences — key observation 5>"
  ],
  "executiveSummary": "<max 3 sentences — what is happening, why, what to watch>",
  "thePuzzle": "<max 2 sentences — specific market behaviour that defies conventional wisdom>",
  "flowAnalysis": "<max 2 sentences — who is doing what, CFTC/MoF data>",
  "clientConversations": "In our conversations with clients, <max 2 sentences on what they are debating>",
  "catalysts": [
    { "catalyst": "<event>", "impact": "POSITIVE", "detail": "<max 1 sentence>" },
    { "catalyst": "<event>", "impact": "NEGATIVE", "detail": "<max 1 sentence>" },
    { "catalyst": "<event>", "impact": "MIXED", "detail": "<max 1 sentence>" }
  ],
  "levelTargets": [
    { "pair": "USD/JPY", "target": "<e.g. 145>", "rationale": "<max 1 sentence>" },
    { "pair": "EUR/USD", "target": "<e.g. 1.05-1.09>", "rationale": "<max 1 sentence>" }
  ]
}

MS language: "We believe", "In our conversations with clients". Return pure JSON only.`;

    const raw  = await callClaude(system, prompt, 4000);
    const data = extractJSON(raw, "object");
    if (!data || !data.title || !data.thePuzzle) {
      throw new Error("fetchResearchReport[rates]: could not parse JSON response");
    }
    function stripAll(obj) {
      if (typeof obj === "string") return stripCiteTags(obj);
      if (Array.isArray(obj))     return obj.map(stripAll);
      if (obj && typeof obj === "object") {
        const out = {};
        for (const [k, v] of Object.entries(obj)) out[k] = stripAll(v);
        return out;
      }
      return obj;
    }
    return { ...stripAll(data), reportType: "rates", generatedAt: new Date().toISOString() };
  }

  // ── Thematic Analysis (MS Thematic Lens style) ────────────────────────────
  if (reportType === "thematic") {
    const system = `Today is ${today}. You are Morgan Stanley's head of global thematics, producing the annual "World Through a Thematic Lens" report. You MUST use web_search to ground predictions in current data. Return ONLY valid JSON — no markdown fences, no preamble, no trailing text.`;
    const focusInstruction = topic
      ? `Focus this thematic analysis on: ${topic}.`
      : `Identify the 4 dominant structural themes shaping global markets over the next 12-24 months.`;
    const prompt = `${focusInstruction}
Current macro context: ${ratesContext}

Use web_search to find current AI capex, energy policy, and geopolitical developments.

Return EXACTLY this JSON object (pure JSON, no markdown):

{
  "title": "The World Through a Thematic Lens: Predictions, Debates and Structural Change",
  "subtitle": "<one sentence framing the 4 key themes>",
  "date": "${isoDate}",
  "keyThemes": [
    { "theme": "<name>", "description": "<max 2 sentences>", "stockImplication": "<max 1 sentence>" },
    { "theme": "<name>", "description": "<max 2 sentences>", "stockImplication": "<max 1 sentence>" },
    { "theme": "<name>", "description": "<max 2 sentences>", "stockImplication": "<max 1 sentence>" },
    { "theme": "<name>", "description": "<max 2 sentences>", "stockImplication": "<max 1 sentence>" }
  ],
  "predictions": [
    { "n": 1, "prediction": "<max 2 sentences>", "keyTheme": "<theme name>", "investingImplication": "<max 1 sentence>" },
    { "n": 2, "prediction": "<max 2 sentences>", "keyTheme": "<theme name>", "investingImplication": "<max 1 sentence>" },
    { "n": 3, "prediction": "<max 2 sentences>", "keyTheme": "<theme name>", "investingImplication": "<max 1 sentence>" },
    { "n": 4, "prediction": "<max 2 sentences>", "keyTheme": "<theme name>", "investingImplication": "<max 1 sentence>" },
    { "n": 5, "prediction": "<max 2 sentences>", "keyTheme": "<theme name>", "investingImplication": "<max 1 sentence>" }
  ],
  "debates": [
    { "title": "<debate question>", "bull": "<max 2 sentences>", "bear": "<max 2 sentences>", "ourView": "<max 1 sentence>" },
    { "title": "<debate question>", "bull": "<max 2 sentences>", "bear": "<max 2 sentences>", "ourView": "<max 1 sentence>" },
    { "title": "<debate question>", "bull": "<max 2 sentences>", "bear": "<max 2 sentences>", "ourView": "<max 1 sentence>" }
  ],
  "portfolioLinks": [
    { "ticker": "AMD", "theme": "<theme name>", "rationale": "<max 1 sentence>" },
    { "ticker": "NVDA", "theme": "<theme name>", "rationale": "<max 1 sentence>" },
    { "ticker": "SGLN", "theme": "<theme name>", "rationale": "<max 1 sentence>" },
    { "ticker": "HIES", "theme": "<theme name>", "rationale": "<max 1 sentence>" }
  ]
}

Use MS language: "We believe", "Key Theme: X". Return pure JSON only — no extra text outside the JSON object.`;

    const raw  = await callWithFallback(system, prompt, 5000);
    const data = extractJSON(raw, "object");
    if (!data || !data.title || !Array.isArray(data.keyThemes) || !Array.isArray(data.predictions)) {
      throw new Error("fetchResearchReport[thematic]: could not parse JSON response");
    }
    function stripAll(obj) {
      if (typeof obj === "string") return stripCiteTags(obj);
      if (Array.isArray(obj))     return obj.map(stripAll);
      if (obj && typeof obj === "object") {
        const out = {};
        for (const [k, v] of Object.entries(obj)) out[k] = stripAll(v);
        return out;
      }
      return obj;
    }
    return { ...stripAll(data), reportType: "thematic", generatedAt: new Date().toISOString() };
  }

  // ── Equity Views (GS US Equity Views style) ─────────────────────────────
  if (reportType === "equity") {
    const system = `Today is ${today}. You are a Goldman Sachs portfolio strategy analyst producing a US Equity Views research note. You MUST use web_search to find current S&P 500 EPS estimates, AI capex data, and AMD analyst estimates. Return ONLY valid JSON — no markdown fences, no preamble, no trailing text.`;
    const focusInstruction = topic
      ? `Focus this equity views report on: ${topic}.`
      : `Produce a current S&P 500 earnings outlook covering 2026–2027 EPS forecasts, AI-driven margin dynamics, and sector rotation implications. Include specific AMD implications given its AI accelerator position.`;
    const prompt = `${focusInstruction}
Current macro context: ${ratesContext}

Use web_search to find current S&P 500 EPS consensus, mega-cap tech earnings, AI capex announcements, and AMD's latest estimates.

Return EXACTLY this JSON object (pure JSON, no markdown):

{
  "title": "S&P 500 Outlook: AI Adoption and Economic Acceleration Should Support Solid EPS Growth in 2026-2027",
  "subtitle": "<one sentence with key EPS number and thesis>",
  "date": "${isoDate}",
  "keyTakeaways": [
    "We forecast S&P 500 EPS growth of +X% in 2026 (to $XXX)...",
    "We estimate...",
    "We expect...",
    "We see risks from..."
  ],
  "epsOutlook": {
    "year2026": { "epsGrowth": "<e.g. +11%>", "epsLevel": "<e.g. $275>", "revenueGrowth": "<e.g. +6%>", "marginExpansion": "<e.g. +30bp>" },
    "year2027": { "epsGrowth": "<e.g. +13%>", "epsLevel": "<e.g. $310>", "revenueGrowth": "<e.g. +7%>", "marginExpansion": "<e.g. +40bp>" },
    "narrative": "<max 2 sentences on what drives the forecast>"
  },
  "megaCapContribution": {
    "marketCapShare": "<e.g. 36%>",
    "earningsShare": "<e.g. 26%>",
    "epsGrowthContribution2026": "<e.g. 46% of index EPS growth>",
    "names": ["AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA"],
    "narrative": "<max 2 sentences>"
  },
  "aiProductivityLift": {
    "eps2026": "<e.g. +0.4% EPS boost>",
    "eps2027": "<e.g. +1.5% EPS boost>",
    "adoptionStatus": "<max 2 sentences>",
    "mechanism": "<max 1 sentence>"
  },
  "sectorViews": [
    { "sector": "Technology", "stance": "Overweight", "rationale": "<max 1 sentence>", "keyRisk": "<max 1 sentence>" },
    { "sector": "Financials", "stance": "Overweight", "rationale": "<max 1 sentence>", "keyRisk": "<max 1 sentence>" },
    { "sector": "Energy", "stance": "Neutral", "rationale": "<max 1 sentence>", "keyRisk": "<max 1 sentence>" },
    { "sector": "Consumer Discretionary", "stance": "Neutral", "rationale": "<max 1 sentence>", "keyRisk": "<max 1 sentence>" }
  ],
  "amdImplications": {
    "currentEps": "<most recent annual EPS>",
    "epsGrowthForecast": "<e.g. +18% in 2026>",
    "aiRevenue": "<share of revenue from AI accelerators>",
    "keyRisk": "<max 2 sentences>",
    "keyOpportunity": "<max 2 sentences>",
    "valuation": "<current P/E vs historical>"
  },
  "consensusComparison": {
    "vsBottomUp": "<above/below/in-line vs analyst consensus>",
    "vsTopDown": "<vs strategist consensus>",
    "keyDifference": "<max 1 sentence>"
  }
}

Use GS language: "We forecast", "We estimate", "We expect". Return pure JSON only — no extra text outside the JSON object.`;

    const raw  = await callWithFallback(system, prompt, 5000);
    const data = extractJSON(raw, "object");
    if (!data || !data.title || !data.epsOutlook) {
      throw new Error("fetchResearchReport[equity]: could not parse JSON response");
    }
    function stripAll(obj) {
      if (typeof obj === "string") return stripCiteTags(obj);
      if (Array.isArray(obj))     return obj.map(stripAll);
      if (obj && typeof obj === "object") {
        const out = {};
        for (const [k, v] of Object.entries(obj)) out[k] = stripAll(v);
        return out;
      }
      return obj;
    }
    return { ...stripAll(data), reportType: "equity", generatedAt: new Date().toISOString() };
  }

  // ── Commodities (GS Oil/Gold Comment style) ───────────────────────────────
  if (reportType === "commodities") {
    const system = `Today is ${today}. You are a senior Goldman Sachs commodities strategist (Daan Struyven / Jeff Currie school). You MUST use web_search for current prices, inventory data, supply disruption data, OPEC statements, and positioning. Return ONLY valid JSON — no markdown fences, no preamble. Every number must be real. Do not fabricate figures.`;
    const focusInstruction = topic
      ? `Focus this commodities comment on: ${topic}.`
      : `Identify the single most important commodity market development in the past 7 days — supply shock, demand shift, geopolitical disruption, or structural change. Build around the most actionable story.`;
    const prompt = `${focusInstruction}
Current macro context: ${ratesContext}

Use web_search to find: current Brent/WTI/gold/copper prices, OPEC+ production figures, EIA/IEA inventory data, shipping data, positioning (CFTC), and any supply disruption headlines as of ${today}.

Return EXACTLY this JSON object (pure JSON, no markdown):

{
  "title": "<GS-style punchy title e.g. 'Mounting Upside Risks to Oil Prices From Hormuz'>",
  "subtitle": "<one sentence — the core tension: supply shock vs demand response>",
  "reportType": "commodities",
  "date": "${isoDate}",
  "commodity_focus": "<primary commodity: Oil | Gold | Copper | Natural Gas | Multi-commodity>",
  "conviction": "<HIGH | MEDIUM | SPECULATIVE>",
  "keyTakeaways": [
    "<2-3 sentences — headline finding with specific number>",
    "<2-3 sentences — supply/demand mechanism>",
    "<2-3 sentences — price implication with target>",
    "<2-3 sentences — key risk or tail scenario>"
  ],
  "supply_demand": {
    "supply_narrative": "<3-4 sentences — current supply situation: production, disruption, OPEC, inventories. All numbers sourced.>",
    "demand_narrative": "<3-4 sentences — current demand: global consumption trends, regional demand, seasonal factors.>",
    "balance": "<1-2 sentences — market balance: surplus/deficit in mb/d or metric tons, current vs 5-year average inventory.>"
  },
  "price_targets": [
    { "commodity": "<e.g. Brent Crude>", "current": "<$/bbl>", "dispatch_base": "<$/bbl 3m>", "dispatch_bull": "<$/bbl>", "dispatch_bear": "<$/bbl>", "rationale": "<1 sentence>" },
    { "commodity": "<e.g. Gold>", "current": "<$/oz>", "dispatch_base": "<$/oz 3m>", "dispatch_bull": "<$/oz>", "dispatch_bear": "<$/oz>", "rationale": "<1 sentence>" }
  ],
  "scenarios": {
    "bear": { "label": "Bear", "probability": "<e.g. 20%>", "trigger": "<what causes this>", "price_outcome": "<commodity price in this scenario>", "narrative": "<2-3 sentences>" },
    "base": { "label": "Base", "probability": "<e.g. 55%>", "trigger": "<conditions for base case>", "price_outcome": "<commodity price in this scenario>", "narrative": "<2-3 sentences>" },
    "bull": { "label": "Bull", "probability": "<e.g. 25%>", "trigger": "<what causes upside>", "price_outcome": "<commodity price in this scenario>", "narrative": "<2-3 sentences>" }
  },
  "scenario_chart": [
    { "period": "NOW", "bear": null, "base": null, "bull": null, "actual": <current price as number> },
    { "period": "Q2-26", "bear": <number>, "base": <number>, "bull": <number>, "actual": null },
    { "period": "Q3-26", "bear": <number>, "base": <number>, "bull": <number>, "actual": null },
    { "period": "Q4-26", "bear": <number>, "base": <number>, "bull": <number>, "actual": null },
    { "period": "Q1-27", "bear": <number>, "base": <number>, "bull": <number>, "actual": null }
  ],
  "scenario_chart_label": "<e.g. 'Brent Crude ($/bbl)' or 'Gold ($/oz)'>",
  "dispatch_angle": {
    "headline": "<max 12 words — the overlooked second-order consequence>",
    "mechanism": "<3 sentences — the causal chain A → B → C → D that consensus is missing. Specific magnitudes.>",
    "winners": ["<specific asset/sector/geography + one-sentence reason>", "<winner 2>", "<winner 3>"],
    "losers": ["<specific loser + one-sentence reason>", "<loser 2>"],
    "trade_expression": "<the single most elegant trade to capture this angle>"
  },
  "client_impact": [
    { "type": "Pension / Insurance", "relevance": "HIGH|MEDIUM|LOW", "positioning_change": "<one sentence>", "risk": "<one sentence>", "opportunity": "<one sentence>" },
    { "type": "Hedge Fund / Macro PM", "relevance": "HIGH|MEDIUM|LOW", "positioning_change": "<one sentence>", "risk": "<one sentence>", "opportunity": "<one sentence>" },
    { "type": "Sovereign Wealth / Endowment", "relevance": "HIGH|MEDIUM|LOW", "positioning_change": "<one sentence>", "risk": "<one sentence>", "opportunity": "<one sentence>" },
    { "type": "Long-Only Asset Manager", "relevance": "HIGH|MEDIUM|LOW", "positioning_change": "<one sentence>", "risk": "<one sentence>", "opportunity": "<one sentence>" }
  ],
  "macro_linkages": "<2-3 sentences — how commodity moves feed through to FX (petrocurrencies, EM terms of trade), rates (inflation pass-through), and equities (sector rotation).>",
  "key_watchpoints": ["<data release or event to watch 1>", "<watchpoint 2>", "<watchpoint 3>"],
  "live_market_data": [
    { "label": "<e.g. Brent Crude>", "value": "<e.g. $112.40/bbl>", "change": "<e.g. +1.2% 1D>", "direction": "<up|down|flat>", "source": "<e.g. CME / Bloomberg>", "as_of": "<e.g. Apr 4, 2026>" },
    { "label": "<e.g. WTI Crude>",   "value": "<e.g. $108.20/bbl>", "change": "<e.g. +0.8% 1D>", "direction": "<up|down|flat>", "source": "<e.g. CME / Bloomberg>", "as_of": "<e.g. Apr 4, 2026>" },
    { "label": "<e.g. Henry Hub NG>","value": "<e.g. $3.10/mmbtu>","change": "<e.g. -0.5% 1D>", "direction": "<up|down|flat>", "source": "<e.g. CME / Bloomberg>", "as_of": "<e.g. Apr 4, 2026>" }
  ]
}

Write at graduate level. Every price, volume, and percentage must be real and sourced from your web search. Use web_search to find today's actual spot prices for the live_market_data array — search CME, Bloomberg, or Reuters for current Brent, WTI, and Henry Hub prices as of ${today}. The EIA historical data in context is for trend reference only (it lags ~1 week). Populate live_market_data with today's actual market prices. Return pure JSON only.`;

    const raw  = await callWithFallback(system, prompt, 6000);
    const data = extractJSON(raw, "object");
    if (!data || !data.title || !Array.isArray(data.keyTakeaways)) {
      throw new Error("fetchResearchReport[commodities]: could not parse JSON response");
    }
    function stripAllComm(obj) {
      if (typeof obj === "string") return stripCiteTags(obj);
      if (Array.isArray(obj))     return obj.map(stripAllComm);
      if (obj && typeof obj === "object") {
        const out = {};
        for (const [k, v] of Object.entries(obj)) out[k] = stripAllComm(v);
        return out;
      }
      return obj;
    }
    return { ...stripAllComm(data), reportType: "commodities", generatedAt: new Date().toISOString() };
  }

  // ── Macro (GS Global Economics Comment — default) ─────────────────────────
  const system = `Today is ${today}. You are a senior Goldman Sachs global economist producing a research note for institutional clients. You MUST use web_search to ground every claim in real, current data. Return ONLY valid JSON — no markdown fences, no preamble. Every number must be sourced from your web search. Do not fabricate figures.`;

  const focusInstruction = topic
    ? `Focus this report on: ${topic}.`
    : `Identify the single most important macro development of the past 7 days and build the report around it.`;

  const prompt = `${focusInstruction}

Use web_search extensively to find: current asset prices, central bank statements, economic data releases, geopolitical developments, and analyst consensus as of ${today}.

Produce a Goldman Sachs-style Global Economics Comment. Return a single JSON object with EXACTLY these keys:

"title": string — punchy title like "Global Economic Impacts of [event]" (never vague)

"subtitle": string — one sentence contextualising the event (e.g. "Oil rises 14% as Iran conflict escalates; we assess the macro transmission channels")

"date": "${isoDate}"

"abstract": array of EXACTLY 4 strings — each 2-4 sentences. Format: Lead claim with key number + conditional escalation clause. These are the bullet summary at the top of the GS note. Start each with the key finding, then "We estimate...", "We see...", or "We anticipate..." language.

"mainChannel": string — 3-4 sentences. The primary transmission mechanism: how does the event flow through to GDP and inflation? Be specific (cite elasticity estimates, historical analogues, bps/pp impacts). This is the opening of the body.

"scenarios": object with two keys:
  "baseline": {
    "label": string (e.g. "Baseline"),
    "anchor": string (e.g. "Oil at $80/bbl, Strait disruption 5 days"),
    "gdpImpact": string (e.g. "-0.1pp to global GDP growth"),
    "cpiImpact": string (e.g. "+0.2pp to headline inflation"),
    "narrative": string (3 sentences — what happens under this scenario, why, what data supports it)
  }
  "stress": {
    "label": string (e.g. "Upside / Stress"),
    "anchor": string (e.g. "Oil spikes to $100/bbl, Strait closed 5 weeks"),
    "gdpImpact": string,
    "cpiImpact": string,
    "narrative": string (3 sentences — what makes this scenario materialise, magnitude of impact, policy response)
  }

"secondaryRisks": array of 2-3 objects, each: {
  "channel": string (e.g. "Financial conditions tightening"),
  "magnitude": string (e.g. "31bp FCI tightening"),
  "growthImpact": string (e.g. "-0.3pp if sustained 1 year"),
  "narrative": string (2 sentences — mechanism and historical precedent)
}

"policyImplications": object: {
  "fed": string (2-3 sentences — Fed reaction function: does this change the path? Hawkish or dovish tilt?),
  "boe": string (1-2 sentences),
  "ecb": string (1-2 sentences),
  "overall": string (1-2 sentences — are DM central banks on hold, cutting, or hawkish?)
}

"marketImplications": object: {
  "rates": string (2 sentences — what does this mean for the Treasury curve? Which part?),
  "equities": string (2 sentences — sector rotation, multiple compression, earnings impact),
  "credit": string (2 sentences — IG vs HY, spread trajectory),
  "fx": string (2 sentences — USD, EM FX, commodity currencies),
  "topTrade": string (1 sentence — the single best expression of this view: e.g. "Long 10Y UST vs. short HY credit")
}

"keyMetrics": array of 4-6 objects, each: {
  "label": string,
  "current": string,
  "baseline": string | null,
  "stress": string | null
}

"conclusion": string — 2-3 sentences. Synthesise: what does this mean for the global growth outlook? Where are the risks skewed? What do we watch next?

"dispatch_angle": object — THE one overlooked second-order consequence that consensus is missing. Be opinionated and specific. Format:
{
  "headline": string — max 12 words. The contrarian or overlooked angle (e.g. "Iran closure accelerates Gulf states' pivot to renewables"),
  "mechanism": string — 3 sentences. The causal chain: A leads to B because C; B leads to D which the market is underpricing. Be specific with magnitudes where possible,
  "winners": array of 2-3 strings — each naming a specific asset class, sector, or geography + one-sentence reason why they benefit from this angle,
  "losers": array of 2-3 strings — each naming a specific loser + one-sentence reason,
  "trade_expression": string — the single most elegant trade to capture this angle. Specific instrument or pair.
}

"client_impact": array of exactly 4 objects — how this report changes positioning for each institutional client type:
[
  { "type": "Pension / Insurance", "relevance": "HIGH|MEDIUM|LOW", "positioning_change": "one sentence — what allocation shift does this suggest?", "risk": "one sentence — the specific downside they face", "opportunity": "one sentence — the opportunity they should evaluate" },
  { "type": "Hedge Fund / Macro PM", "relevance": "HIGH|MEDIUM|LOW", "positioning_change": "...", "risk": "...", "opportunity": "..." },
  { "type": "Sovereign Wealth / Endowment", "relevance": "HIGH|MEDIUM|LOW", "positioning_change": "...", "risk": "...", "opportunity": "..." },
  { "type": "Long-Only Asset Manager", "relevance": "HIGH|MEDIUM|LOW", "positioning_change": "...", "risk": "...", "opportunity": "..." }
]

"scenario_chart": array of 5 objects — forward projection for the primary variable in this report (e.g. oil price, 10Y yield, EPS). Label each point as a quarter. Use real numbers consistent with your scenario analysis above:
[
  { "period": "NOW", "bear": null, "base": null, "bull": null, "actual": <current value as number> },
  { "period": "Q2-26", "bear": <number>, "base": <number>, "bull": <number>, "actual": null },
  { "period": "Q3-26", "bear": <number>, "base": <number>, "bull": <number>, "actual": null },
  { "period": "Q4-26", "bear": <number>, "base": <number>, "bull": <number>, "actual": null },
  { "period": "Q1-27", "bear": <number>, "base": <number>, "bull": <number>, "actual": null }
]
"scenario_chart_label": string — what metric is being projected (e.g. "Brent Crude ($/bbl)", "10Y UST Yield (%)", "S&P 500 EPS ($)")

Write at graduate level. Every number must be specific and sourced. Use language: "We estimate", "We see incremental risks", "Effects could be larger if", "Under our baseline". Keep each string value under 200 words. Return pure JSON only — no markdown, no preamble, no trailing text.`;

  const raw  = await callWithFallback(system, prompt, 8000);
  const data = extractJSON(raw, "object");

  if (!data || !data.title || !data.scenarios || !Array.isArray(data.abstract)) {
    throw new Error("fetchResearchReport: could not parse JSON response");
  }

  // Strip cite tags from all string fields
  function stripAll(obj) {
    if (typeof obj === "string") return stripCiteTags(obj);
    if (Array.isArray(obj))     return obj.map(stripAll);
    if (obj && typeof obj === "object") {
      const out = {};
      for (const [k, v] of Object.entries(obj)) out[k] = stripAll(v);
      return out;
    }
    return obj;
  }

  return {
    ...stripAll(data),
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  fetchAllAnalysis,
  fetchMarketEvents,
  fetchRiskScores,
  fetchEconAnalysis,
  fetchWatchlistPrices,
  fetchTickerExplain,
  evaluateThesis,
  generateTradeIdeas,
  fetchMacroView,
  fetchClientImpact,
  fetchResearchReport,
  callClaude,
  MODEL_SONNET,
};
