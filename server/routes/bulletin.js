/**
 * server/routes/bulletin.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Morning Bulletin — JPMorgan Spring Week prep.
 *
 *   GET  /api/bulletin          — latest bulletin (today's if generated, else most recent)
 *   GET  /api/bulletin/history  — rolling log (?days=7)
 *   POST /api/bulletin/refresh  — generate a fresh bulletin now (auth-required if DISPATCH_ADMIN_KEY set)
 *
 * News source: Finnhub market news (real-time, already wired).
 * Analysis:    Claude Sonnet — single call, structured JSON output.
 *              Falls back to deterministic summary if AI unavailable.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const { Router }       = require("express");
const finnhub          = require("../providers/finnhub");
const fred             = require("../providers/fred");
const { callClaude, MODEL_SONNET } = require("../providers/anthropic");
const budget           = require("../providers/budget");
const requireWriteAuth = require("../middleware/auth");
const { appendBulletin, getLatest, getTodaysBulletin, getHistory } = require("../importers/bulletinLog");

const router = Router();

function now() { return new Date().toISOString(); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

function stripCiteTags(str) {
  if (typeof str !== "string") return str;
  return str.replace(/<cite[^>]*>(.*?)<\/cite>/gs, "$1").replace(/<\/?cite[^>]*>/g, "");
}
function deepStrip(obj) {
  if (typeof obj === "string") return stripCiteTags(obj);
  if (Array.isArray(obj))     return obj.map(deepStrip);
  if (obj && typeof obj === "object")
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, deepStrip(v)]));
  return obj;
}

// ── Live macro context from FRED ──────────────────────────────────────────────
/** Fetch current FRED rates and format as a grounding data block for the prompt. */
async function fetchMacroContext() {
  try {
    const rates = await fred.getAllRates();
    if (!rates) return null;
    const lines = [];
    if (rates.dgs10      != null) lines.push(`10Y UST Nominal Yield (DGS10):     ${rates.dgs10.toFixed(2)}%`);
    if (rates.dfii10     != null) lines.push(`10Y Real Yield (DFII10):           ${rates.dfii10.toFixed(2)}%`);
    if (rates.t10yie     != null) lines.push(`10Y Breakeven Inflation (T10YIE):  ${rates.t10yie.toFixed(2)}%`);
    if (rates.hy_spread  != null) lines.push(`US HY OAS Spread (BAML):           ${Math.round(rates.hy_spread)}bps`);
    if (rates.t10y2y     != null) lines.push(`Yield Curve 10Y-2Y (T10Y2Y):       ${rates.t10y2y.toFixed(2)}%`);
    return lines.length ? lines.join("\n") : null;
  } catch {
    return null;
  }
}

// ── Shared prompt builders ────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a dual-role expert: (1) a senior macro economist at a major research house, and (2) a senior S&T professional at JPMorgan briefing buy-side clients before market open. You produce morning bulletins combining rigorous economic analysis with immediately actionable cross-asset trading ideas. Your audience is an Economics student preparing for JPMorgan Spring Week.

ACCURACY RULES — NON-NEGOTIABLE:
- Only cite specific figures (yields, spreads, price levels, bps moves, % changes) that appear in the source article or in the LIVE MACRO DATA block below. Never invent statistics.
- For historical parallels: you may reference well-established episodes by name (e.g. 2013 Taper Tantrum, 2022 Fed hiking cycle, 2015 CNY devaluation) but do not fabricate specific bps moves or percentage drawdowns unless they are universally established facts.
- If the source article lacks a specific number, describe direction and mechanism — never substitute an invented figure.
- Trade rationales must follow a direct, mechanistic causal chain from the article to the asset. No speculative leaps without a stated transmission mechanism.
- Every sentence must carry information. No filler phrases, no hedging language that adds no meaning.`;

function buildUserPrompt(articleList, macroContext) {
  const macroBlock = macroContext
    ? `LIVE MACRO DATA (FRED, as of ${todayStr()}):\n${macroContext}\n\n`
    : "";

  return `Today is ${todayStr()}.
${macroBlock}ARTICLES (Finnhub real-time feed — select the single most market-moving story):
${articleList}

Your tasks:
1. SELECT the single most market-moving article for cross-asset implications and buy-side relevance. Avoid opinion pieces or company-specific earnings unless they have clear macro significance.
2. Generate a complete morning bulletin grounded strictly in the article content and the live macro data above.

Return ONLY a valid JSON object — no markdown, no text outside the JSON:

{
  "article": {
    "headline": "[exact headline from the selected article]",
    "source": "[source name]",
    "url": "[article URL]",
    "publishedAt": "[ISO timestamp]",
    "summary": "[factual summary drawn from the article, ~150 chars — no invented detail]"
  },
  "pitchScript": "[A flowing paragraph read aloud in ~60 seconds. Structure: (1) Headline + source [5s]. (2) What happened — use only figures from the article or the live macro data [15s]. (3) Which client types are most exposed and why [15s]. (4) One core trade + one hedge, named precisely, with a one-line mechanism each [15s]. (5) Bottom line + the next catalyst to watch [10s]. Crisp, jargon-dense, zero filler.]",
  "analysis": {
    "economistView": {
      "macroRegime": "[The macro regime this event signals — be specific: e.g. stagflation, demand shock, supply-side inflation, credit contraction, risk-off flight-to-quality. Explain why in one sentence.]",
      "transmissionMechanism": "[Step-by-step causal chain: Event → intermediate variable → market impact. Each arrow must be a real economic mechanism. Use actual figures from the article or macro data where available.]",
      "historicalContext": "[The closest historical parallel. Name the episode and explain the structural similarity. If no close parallel exists, say so — do not force one.]",
      "centralBankImplications": "[What the Fed / relevant central bank will likely do in response, on what timeline, and why — grounded in current rate levels from the macro data above.]",
      "tailRisks": "[The 2-3 specific tail scenarios that could make this materially worse. Each must be a concrete event or threshold, not a generic disclaimer.]"
    },
    "tradingView": {
      "clientExposure": "[Which specific client types — HFs, long-only AMs, pensions, credit investors, real asset managers, insurance — are most exposed and the specific mechanism of their exposure.]",
      "clientConcerns": "[What these clients are specifically worried about: duration risk, spread widening, liquidity deterioration, correlation breakdown, leverage unwind, FX impact on unhedged positions — be precise.]",
      "opportunities": [
        {
          "asset": "[Specific instrument: e.g. '10Y UST', 'S&P 500 e-mini', 'EUR/USD', 'CDX HY', 'XAU/USD', 'WTI front-month', 'VIX calls', 'EM local debt' — not generic labels like 'bonds' or 'FX']",
          "direction": "Long or Short or Neutral",
          "conviction": "High or Medium or Low",
          "hedge": "[Specific paired instrument for risk management, or 'Standalone' if truly uncorrelated]",
          "rationale": "[One sentence: Article event → transmission mechanism → why this asset moves in this direction. Must be mechanistic, not just directional.]"
        }
      ]
    },
    "risks": [
      "[Risk 1: a specific data release, central bank action, or geopolitical event that would invalidate the thesis — not a generic disclaimer]",
      "[Risk 2]",
      "[Risk 3]",
      "[Risk 4]",
      "[Risk 5]"
    ]
  }
}

Requirements for opportunities: exactly 4-6 trades. Cover at least 3 different asset classes. Include at least one explicit hedge or defensive idea. Use precise instrument names throughout.`;
}

// ── GET /api/bulletin ─────────────────────────────────────────────────────────
router.get("/", (req, res) => {
  const bulletin = getLatest();
  if (!bulletin) {
    return res.json({ source: "empty", fetchedAt: now(), data: null,
      message: "No bulletin generated yet. POST /api/bulletin/refresh to generate the first one." });
  }
  res.json({ source: "log", fetchedAt: now(), data: bulletin });
});

// ── GET /api/bulletin/history ─────────────────────────────────────────────────
router.get("/history", (req, res) => {
  const days     = Math.min(parseInt(req.query.days || "7", 10), 30);
  const history  = getHistory(days);
  res.json({ source: "log", fetchedAt: now(), data: { history, count: history.length } });
});

// ── POST /api/bulletin/refresh ────────────────────────────────────────────────
router.post("/refresh", requireWriteAuth, async (req, res) => {
  const force = req.query.force === "true";

  // Return today's cached bulletin unless force=true
  if (!force) {
    const existing = getTodaysBulletin();
    if (existing) {
      return res.json({ source: "cache", fetchedAt: now(), data: existing,
        message: "Today's bulletin already generated. Use ?force=true to regenerate." });
    }
  }

  if (!process.env.FINNHUB_API_KEY) {
    return res.status(503).json({ error: "FINNHUB_API_KEY not configured — cannot fetch news" });
  }

  // ── 1. Fetch Finnhub news ──────────────────────────────────────────────────
  let articles = [];
  try {
    articles = await finnhub.getMarketNews("general", 20);
  } catch (err) {
    console.error("[bulletin] Finnhub fetch failed:", err.message);
    return res.status(503).json({ error: "News fetch failed: " + err.message });
  }

  if (!articles || articles.length === 0) {
    return res.status(503).json({ error: "No articles returned from Finnhub" });
  }

  // Format articles for the prompt — headline + summary + source + time
  const articleList = articles
    .slice(0, 15)
    .map((a, i) => {
      const time = a.datetime
        ? new Date(typeof a.datetime === "number" ? a.datetime * 1000 : a.datetime).toISOString()
        : "unknown";
      return `[${i + 1}] SOURCE: ${a.source || "Unknown"} | TIME: ${time}\nHEADLINE: ${a.headline || ""}\nSUMMARY: ${a.summary || "(no summary)"}\nURL: ${a.url || ""}`;
    })
    .join("\n\n");

  // ── 2. AI unavailable → deterministic fallback ────────────────────────────
  if (budget.getApiFallbackInfo().active || process.env.LOW_COST_MODE === "true") {
    const top = articles[0];
    const bulletin = buildFallbackBulletin(top, articles);
    appendBulletin(bulletin);
    sendMacNotification(bulletin.article.headline, (bulletin.pitchScript || "").slice(0, 100) + "…");
    return res.json({ source: "deterministic", fetchedAt: now(), data: bulletin });
  }

  // ── 3. Generate with Claude ────────────────────────────────────────────────
  const macroContext = await fetchMacroContext();
  const userPrompt   = buildUserPrompt(articleList, macroContext);

  try {
    const raw       = await callClaude(SYSTEM_PROMPT, userPrompt, 3000, MODEL_SONNET);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON object in Claude response");

    const parsed  = JSON.parse(jsonMatch[0]);
    const cleaned = deepStrip(parsed);

    const bulletin = {
      date:        todayStr(),
      bulletinId:  `${todayStr()}-${(cleaned.article?.source || "finnhub").toLowerCase().replace(/\s+/g, "-")}`,
      generatedAt: now(),
      dataSource:  "finnhub",
      article:     cleaned.article    || {},
      pitchScript: cleaned.pitchScript || "",
      analysis:    cleaned.analysis   || {},
      metadata: {
        next_fetch:  new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) + "T07:00:00Z",
        api_version: "1.1",
      },
    };

    appendBulletin(bulletin);
    sendMacNotification(
      bulletin.article.headline || "Morning Bulletin Ready",
      (bulletin.pitchScript || "").slice(0, 120) + "…"
    );

    return res.json({ source: "live", fetchedAt: now(), data: bulletin });

  } catch (err) {
    console.error("[bulletin] Claude error:", err.message);
    const top      = articles[0];
    const bulletin = buildFallbackBulletin(top, articles);
    appendBulletin(bulletin);
    sendMacNotification(bulletin.article.headline, "Deterministic bulletin — AI unavailable.");
    return res.json({ source: "deterministic", fetchedAt: now(), data: bulletin, warning: err.message });
  }
});

// ── macOS notification ────────────────────────────────────────────────────────
function sendMacNotification(title, body) {
  try {
    const { exec } = require("child_process");
    const safeTitle = (title || "").replace(/"/g, "'").slice(0, 100);
    const safeBody  = (body  || "").replace(/"/g, "'").slice(0, 200);
    exec(`osascript -e 'display notification "${safeBody}" with title "The Dispatch" subtitle "${safeTitle}" sound name "Default"'`,
      (err) => { if (err) console.warn("[bulletin] macOS notification failed:", err.message); }
    );
  } catch (err) {
    console.warn("[bulletin] macOS notification error:", err.message);
  }
}

// ── Deterministic fallback ────────────────────────────────────────────────────
function buildFallbackBulletin(top, articles) {
  const headline = top?.headline || "No headline available";
  const source   = top?.source   || "Unknown";
  const url      = top?.url      || "";
  const summary  = top?.summary  || "";
  const pubAt    = top?.datetime
    ? new Date(typeof top.datetime === "number" ? top.datetime * 1000 : top.datetime).toISOString()
    : now();

  return {
    date:        todayStr(),
    bulletinId:  `${todayStr()}-deterministic`,
    generatedAt: now(),
    dataSource:  "finnhub",
    article: { headline, source, url, publishedAt: pubAt, summary },
    pitchScript: `"${headline}" — reported by ${source}. ${summary} This story is relevant because it may affect cross-asset positioning across rates, equities, and credit. Monitor closely for follow-through in European and US session.`,
    analysis: {
      economistView: {
        macroRegime:              "Regime classification unavailable — AI offline. Enable ANTHROPIC_API_KEY.",
        transmissionMechanism:    `${headline} → assess impact on rates, credit, and FX.`,
        historicalContext:        "Historical analogy generation requires AI. See article for context.",
        centralBankImplications:  "Central bank response analysis unavailable in deterministic mode.",
        tailRisks:                "Tail risk analysis requires AI. Monitor for follow-up data releases.",
      },
      tradingView: {
        clientExposure:  "Hedge funds, long-only asset managers, and credit investors are likely exposed to this development.",
        clientConcerns:  "Volatility, liquidity, and correlation risk in a risk-off environment.",
        opportunities: [
          { asset: "10Y UST", direction: "Neutral", conviction: "Low", hedge: "Standalone", rationale: "Monitor yield moves for rates signal" },
          { asset: "Gold",    direction: "Long",    conviction: "Low", hedge: "Standalone", rationale: "Flight-to-safety hedge in uncertainty" },
        ],
      },
      risks: [
        "AI analysis unavailable — enable ANTHROPIC_API_KEY for full risk assessment.",
        "Data surprises could invalidate any preliminary directional view.",
        "Geopolitical escalation risk not captured in deterministic mode.",
      ],
    },
    metadata: {
      next_fetch:  new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) + "T07:00:00Z",
      api_version: "1.1",
    },
  };
}

module.exports = router;
module.exports.generateBulletin = async function() {
  // Callable by the scheduler without going through HTTP
  const existing = getTodaysBulletin();
  if (existing) { console.log("[bulletin] Today's bulletin already exists — skipping."); return existing; }

  if (!process.env.FINNHUB_API_KEY) { console.warn("[bulletin] FINNHUB_API_KEY not set — skipping."); return null; }

  let articles = [];
  try { articles = await finnhub.getMarketNews("general", 20); } catch (err) { console.error("[bulletin] News fetch:", err.message); return null; }
  if (!articles?.length) { console.warn("[bulletin] No articles from Finnhub."); return null; }

  const articleList = articles.slice(0, 15).map((a, i) => {
    const time = a.datetime ? new Date(typeof a.datetime === "number" ? a.datetime * 1000 : a.datetime).toISOString() : "unknown";
    return `[${i + 1}] SOURCE: ${a.source || "Unknown"} | TIME: ${time}\nHEADLINE: ${a.headline || ""}\nSUMMARY: ${a.summary || "(no summary)"}\nURL: ${a.url || ""}`;
  }).join("\n\n");

  if (budget.getApiFallbackInfo().active || process.env.LOW_COST_MODE === "true") {
    const b = buildFallbackBulletin(articles[0], articles);
    appendBulletin(b);
    sendMacNotification(b.article.headline, b.pitchScript.slice(0, 100) + "…");
    return b;
  }

  const macroContext = await fetchMacroContext();
  const userPrompt   = buildUserPrompt(articleList, macroContext);

  try {
    const raw       = await callClaude(SYSTEM_PROMPT, userPrompt, 3000, MODEL_SONNET);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in Claude response");
    const cleaned   = deepStrip(JSON.parse(jsonMatch[0]));
    const bulletin  = {
      date: todayStr(), bulletinId: `${todayStr()}-${(cleaned.article?.source||"finnhub").toLowerCase().replace(/\s+/g,"-")}`,
      generatedAt: now(), dataSource: "finnhub",
      article: cleaned.article || {}, pitchScript: cleaned.pitchScript || "",
      analysis: cleaned.analysis || {},
      metadata: { next_fetch: new Date(Date.now()+86_400_000).toISOString().slice(0,10)+"T07:00:00Z", api_version: "1.1" },
    };
    appendBulletin(bulletin);
    sendMacNotification(bulletin.article.headline || "Morning Bulletin", (bulletin.pitchScript||"").slice(0,120)+"…");
    console.log("[bulletin] Generated:", bulletin.article.headline);
    return bulletin;
  } catch (err) {
    console.error("[bulletin] Scheduler generate error:", err.message);
    const b = buildFallbackBulletin(articles[0], articles);
    appendBulletin(b); sendMacNotification(b.article.headline, (b.pitchScript || "").slice(0, 100) + "…");
    return b;
  }
};
