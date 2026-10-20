/**
 * server/routes/bulletin.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Morning Bulletin — a daily read of the day's most market-moving story.
 *
 *   GET  /api/bulletin          — latest bulletin (today's if generated, else most recent)
 *   GET  /api/bulletin/history  — rolling log (?days=7)
 *   POST /api/bulletin/refresh  — generate a fresh bulletin now (auth-required if DISPATCH_ADMIN_KEY set)
 *
 * News source: Finnhub market news (real-time, already wired).
 * Analysis:    Claude Sonnet — single call, structured JSON output.
 *              If the AI call cannot run or fails, the route answers 503 with
 *              `available: false` and the plain-English reason. Nothing is
 *              invented and nothing is saved as the day's bulletin (D-02, D-24).
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const { Router }       = require("express");
const finnhub          = require("../providers/finnhub");
const macro            = require("../providers/macroContext");
const eia              = require("../providers/eia");
const yahoo            = require("../providers/yahoo");
const twitter          = require("../providers/twitter");
const twitterVerify    = require("../providers/twitterVerify");
const { callClaude, MODEL_SONNET } = require("../providers/anthropic");
const budget           = require("../providers/budget");
const requireWriteAuth = require("../middleware/auth");
const { appendBulletin, getLatest, getTodaysBulletin, getHistory } = require("../importers/bulletinLog");

const router = Router();

function now() { return new Date().toISOString(); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

function stripCiteTags(str) {
  if (typeof str !== "string") return str;
  // web_search emits both `<cite …>` and `(cite …>` opening forms (see AGENTS.md).
  return str.replace(/[<(]cite[^>]*>(.*?)<\/cite>/gs, "$1").replace(/(?:<\/cite>|[<(]cite[^>]*>)/g, "");
}
function deepStrip(obj) {
  if (typeof obj === "string") return stripCiteTags(obj);
  if (Array.isArray(obj))     return obj.map(deepStrip);
  if (obj && typeof obj === "object")
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, deepStrip(v)]));
  return obj;
}

// Sonnet sometimes returns `opportunities` as a sibling of `tradingView` instead of
// nested inside it. Move it into place so the client's analysis.tradingView.opportunities
// read doesn't render an empty table.
function fixOpportunitiesNesting(analysis) {
  if (analysis && analysis.opportunities && analysis.tradingView && !analysis.tradingView.opportunities) {
    analysis.tradingView.opportunities = analysis.opportunities;
    delete analysis.opportunities;
  }
  return analysis;
}

// ── Verified macro facts (D-29) ───────────────────────────────────────────────
// The same dated, stale-flagged layer every research report uses (providers/macroContext):
// each figure carries its own source and observation date, newer Markets prices are
// overlaid, and a figure older than 2 trading days is marked STALE. The bulletin used to
// build its own block from fred.getAllRates() — which returns observation objects, not
// numbers — so `.toFixed` threw and the whole block was silently dropped; it also printed
// the HY spread (a percent figure) as "3bps" and dated every line "as of today".
/** Fetch the verified macro context, or null if no figure could be fetched. */
async function fetchMacroContext() {
  try {
    const ctx = await macro.getMacroContext();
    return ctx && ctx.facts && Object.keys(ctx.facts).length ? ctx : null;
  } catch {
    return null;
  }
}

// ── Live cross-asset price action (Yahoo Finance) ──────────────────────────────
// Used to ground the "most market-moving" story selection in what actually moved
// today, rather than just narrative drama (e.g. an ongoing geopolitical conflict
// that markets have already priced in).
const MARKET_MOVERS = [
  { sym: "^GSPC",    label: "S&P 500" },
  { sym: "^IXIC",    label: "Nasdaq Composite" },
  { sym: "^VIX",     label: "VIX" },
  { sym: "CL=F",     label: "WTI Crude" },
  { sym: "GC=F",     label: "Gold" },
  { sym: "DX-Y.NYB", label: "US Dollar Index (DXY)" },
  { sym: "^TNX",     label: "10Y Treasury Yield (intraday)" },
];

/** Fetch live same-day % moves across major indices/commodities/FX/rates. Degrades to null. */
async function fetchMarketMovers() {
  try {
    const results = await Promise.allSettled(MARKET_MOVERS.map(m => yahoo.getQuote(m.sym)));
    const lines = [];
    results.forEach((r, i) => {
      if (r.status !== "fulfilled") return;
      const { price, changePct } = r.value;
      const sign = changePct >= 0 ? "+" : "";
      lines.push(`${MARKET_MOVERS[i].label}: ${price.toFixed(2)} (${sign}${changePct.toFixed(2)}%)`);
    });
    return lines.length ? lines.join("\n") : null;
  } catch {
    return null;
  }
}

// ── Live X/Twitter context (verified) ─────────────────────────────────────────
/**
 * Search X for chatter related to the top story, run it through the
 * verification pipeline (dedup, recency, cross-reference, Haiku classification),
 * and format the survivors as a grounding block.
 *
 * Degrades to null on any failure — opencli not installed, daemon down, no
 * browser session, or Anthropic call failure all result in the bulletin
 * proceeding exactly as before.
 */
async function fetchTwitterContext(headline, macroCtx) {
  if (!headline) return null;
  try {
    // crossReference() compares a claimed 10Y yield with a plain number. A STALE figure
    // is never used to corroborate or contradict a post.
    const dgs10     = macroCtx?.facts?.dgs10;
    const fredRates = dgs10 && !dgs10.stale ? { dgs10: dgs10.value } : {};
    const eiaPrices = await eia.getLatestPrices().catch(() => null);

    const query  = headline.length > 80 ? headline.slice(0, 80) : headline;
    const tweets = await twitter.searchTweets(query, { limit: 15, filter: "live" });
    if (!tweets || !tweets.length) return null;

    const verified = await twitterVerify.verifyTweets(tweets, {
      marketData:   { fredRates, eiaPrices },
      contextLabel: headline,
    });
    if (!verified.length) return null;

    return verified.map(v => {
      const tags = [];
      if (v.isAmplification)    tags.push(`amplifying @${v.claimAuthor}`);
      if (v.clusterSize > 1)    tags.push(`${v.clusterSize}x similar posts`);
      if (v.crossRef.tag !== "n/a") tags.push(`cross-ref: ${v.crossRef.tag}${v.crossRef.note ? " — " + v.crossRef.note : ""}`);
      const tagStr = tags.length ? ` (${tags.join("; ")})` : "";
      return `- @${v.author}: "${v.text}"${tagStr} [${v.verdict}]`;
    }).join("\n");
  } catch (err) {
    console.warn("[bulletin] Twitter context unavailable:", err.message);
    return null;
  }
}

// ── Shared prompt builders ────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a dual-role expert: (1) a senior macro economist at a major research house, and (2) a senior sales & trading professional briefing buy-side clients before market open. You produce morning bulletins combining rigorous economic analysis with immediately actionable cross-asset trading ideas. Your reader is a student learning how markets work: explain plainly, and say why each point matters.

ACCURACY RULES — NON-NEGOTIABLE:
- Only cite specific figures (yields, spreads, price levels, bps moves, % changes) that appear in the source article or in the VERIFIED MARKET DATA block below. Never invent statistics.
- For historical parallels: you may reference well-established episodes by name (e.g. 2013 Taper Tantrum, 2022 Fed hiking cycle, 2015 CNY devaluation) but do not fabricate specific bps moves or percentage drawdowns unless they are universally established facts.
- If the source article lacks a specific number, describe direction and mechanism — never substitute an invented figure.
- Trade rationales must follow a direct, mechanistic causal chain from the article to the asset. No speculative leaps without a stated transmission mechanism.
- Every sentence must carry information. No filler phrases, no hedging language that adds no meaning.`;

function buildUserPrompt(articleList, macroCtx, xContext, moversContext, prevBulletin) {
  const macroBlock = macroCtx ? `${macro.toPromptBlock(macroCtx)}\n\n` : "";

  const moversBlock = moversContext
    ? `TODAY'S CROSS-ASSET PRICE ACTION (Yahoo Finance, live, % = change from prior close):\n${moversContext}\n\n`
    : "";

  const dedupBlock = (prevBulletin && prevBulletin.article && prevBulletin.article.headline)
    ? `PREVIOUS BULLETIN (${prevBulletin.date || "last session"}): "${prevBulletin.article.headline}"\nDo not re-select this same underlying story unless there has been a new, material development since then (escalation/de-escalation, ceasefire, data release, policy action). If nothing material has changed, select a different story.\n\n`
    : "";

  const xBlock = xContext
    ? `X / SOCIAL CONTEXT (verified live posts related to today's top story — each tagged with a reliability verdict):\n${xContext}\n\nUse this only as supplementary color for clientExposure/clientConcerns or sentiment framing. Treat "plausible-unverified" as opinion, not fact. Never use this block as the source of any specific figure — figures must come from the article or the verified market data above.\n\n`
    : "";

  return `Today is ${todayStr()}.
${macroBlock}${moversBlock}${dedupBlock}${xBlock}ARTICLES (Finnhub real-time feed — select the single most market-moving story):
${articleList}

Your tasks:
1. SELECT the single most market-moving article for cross-asset implications and buy-side relevance. Avoid opinion pieces or company-specific earnings unless they have clear macro significance.
   - Cross-reference the cross-asset price action above: the selected story should plausibly explain a meaningful share of TODAY's observed moves in at least one of those assets.
   - A dramatic-sounding headline (e.g. an ongoing geopolitical conflict) that is NOT producing measurable price action today should be DEPRIORITIZED in favor of a quieter story that better explains today's actual moves (a data release, central bank comment, credit event, etc.).
   - You may use web_search to sanity-check "what is driving markets today" for additional confirmation of your selection — but every figure in your output must still come from the article or the live data blocks above, never invented from a search result.
   - Respect the PREVIOUS BULLETIN note above if present.
2. Generate a complete morning bulletin grounded strictly in the article content and the verified market data above.

Return ONLY a valid JSON object — no markdown, no text outside the JSON:

{
  "article": {
    "headline": "[exact headline from the selected article]",
    "source": "[source name]",
    "url": "[article URL]",
    "publishedAt": "[ISO timestamp]",
    "summary": "[factual summary drawn from the article, ~150 chars — no invented detail]"
  },
  "newsSummary": "[A short plain-English summary, 4-6 sentences (~100 words), for someone following markets. Cover in order: (1) what the news is, (2) why it matters — its significance for rates, equities, credit, FX or commodities, (3) is there cause for concern, and how serious — say plainly if there is not, (4) what to look out for next — the specific data release, decision, level or event. Only figures from the article or the live data above. No script, no filler.]",
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

  // ── 2. AI unavailable → say so; never invent a bulletin (D-02, D-24) ──────
  const off = aiUnavailableReason();
  if (off) return unavailable(res, off, articles[0]);

  // ── 3. Generate with Claude ────────────────────────────────────────────────
  try {
    const bulletin = await generateWithClaude(articles, articleList);
    appendBulletin(bulletin);
    sendMacNotification(
      bulletin.article.headline || "Morning Bulletin Ready",
      (bulletin.newsSummary || "").slice(0, 120) + "…"
    );
    return res.json({ source: "live", fetchedAt: now(), data: bulletin });
  } catch (err) {
    console.error("[bulletin] Claude error:", err.message);
    return unavailable(res, err.message, articles[0]);
  }
});

/** Why the AI cannot run right now, in plain English — or null when it can. */
function aiUnavailableReason() {
  if (process.env.LOW_COST_MODE === "true")
    return "Low-cost mode is on (LOW_COST_MODE=true in .env), so all AI calls are switched off.";
  if (process.env.DISABLE_AI === "true")
    return "AI is disabled (DISABLE_AI=true in .env).";
  if (!process.env.ANTHROPIC_API_KEY)
    return "ANTHROPIC_API_KEY is not set in .env, so Claude cannot be reached.";
  const fb = budget.getApiFallbackInfo();
  if (fb.active)
    return `Anthropic reported a billing problem, so AI is paused for another ~${fb.retryInMins} min. Check your Anthropic credit.`;
  return null;
}

/** 503 with the reason and the real top headline (a fact, not analysis). Nothing is saved. */
function unavailable(res, reason, top) {
  const lastBulletin = getLatest();
  return res.status(503).json({
    available:  false,
    reason,
    fetchedAt:  now(),
    topArticle: top ? { headline: top.headline || "", source: top.source || "", url: top.url || "" } : null,
    lastBulletinDate: lastBulletin?.date || null,
  });
}

/**
 * Pull the bulletin object out of the model's reply. The reply can hold several
 * text blocks (web_search narration around the JSON), so a greedy `{…}` match is
 * not enough: try the whole text, then every balanced `{…}` (string-aware) and
 * keep the first that parses and looks like a bulletin.
 */
function extractBulletinJson(raw) {
  const text = String(raw || "").replace(/```(?:json)?/gi, "");
  const looksRight = o => o && typeof o === "object" && o.article && o.analysis;
  try { const o = JSON.parse(text.trim()); if (looksRight(o)) return o; } catch { /* fall through */ }

  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try { const o = JSON.parse(text.slice(start, i + 1)); if (looksRight(o)) return o; } catch { /* try next start */ }
        break;
      }
    }
  }
  return null;
}

/** One Sonnet call → a validated bulletin object. Throws a plain-English Error on any failure. */
async function generateWithClaude(articles, articleList) {
  const macroCtx      = await fetchMacroContext();
  const moversContext = await fetchMarketMovers();
  const xContext      = await fetchTwitterContext(articles[0]?.headline, macroCtx);
  const userPrompt    = buildUserPrompt(articleList, macroCtx, xContext, moversContext, getLatest());

  const raw    = await callClaude(SYSTEM_PROMPT, userPrompt, 8000, MODEL_SONNET);
  const parsed = extractBulletinJson(raw);
  if (!parsed) {
    throw new Error("Claude answered, but the reply was not a complete bulletin (it may have been cut off). " +
      "Nothing was saved. Try again; the reply began: \"" + String(raw || "").trim().slice(0, 120).replace(/\s+/g, " ") + "\"");
  }
  const cleaned = deepStrip(parsed);
  const summary = typeof cleaned.newsSummary === "string" ? cleaned.newsSummary.trim() : "";
  if (!cleaned.article?.headline || !summary) {
    throw new Error("Claude's reply was missing the headline or the summary, so it was not saved. Try again.");
  }

  return {
    date:        todayStr(),
    bulletinId:  `${todayStr()}-${(cleaned.article.source || "finnhub").toLowerCase().replace(/\s+/g, "-")}`,
    generatedAt: now(),
    dataSource:  "finnhub",
    article:     cleaned.article,
    newsSummary: summary,
    analysis:    fixOpportunitiesNesting(cleaned.analysis || {}),
    metadata: {
      next_fetch:  new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) + "T07:00:00Z",
      api_version: "1.2",
    },
  };
}

// ── macOS notification ────────────────────────────────────────────────────────
/**
 * The title is a news headline and the body is generated text — both are
 * attacker-influenceable, so neither may reach a shell or an AppleScript
 * source string.
 *
 * execFile does not spawn a shell, and the script below reads its text out of
 * `argv` rather than having it interpolated in, so there is no quoting context
 * for a headline to escape from. The previous implementation built a
 * single-quoted shell string and replaced `"` with `'` — which manufactured
 * the very character that terminated the quoting (a headline containing
 * `"; do shell script "…` became arbitrary command execution).
 * Ported from the external review fixes on claude/relaxed-brown-8q5ynd.
 */
const NOTIFY_SCRIPT =
  "on run argv\n" +
  "  display notification (item 1 of argv) " +
  "with title \"The Dispatch\" subtitle (item 2 of argv) sound name \"Default\"\n" +
  "end run";

function sendMacNotification(title, body) {
  if (process.platform !== "darwin") return;   // osascript is macOS-only
  try {
    const { execFile } = require("child_process");
    const safeTitle = String(title || "").slice(0, 100);
    const safeBody  = String(body  || "").slice(0, 200);
    execFile(
      "osascript",
      ["-e", NOTIFY_SCRIPT, safeBody, safeTitle],
      { timeout: 5_000 },
      (err) => { if (err) console.warn("[bulletin] macOS notification failed:", err.message); }
    );
  } catch (err) {
    console.warn("[bulletin] macOS notification error:", err.message);
  }
}

module.exports = router;
module.exports._internal = { sendMacNotification, NOTIFY_SCRIPT, extractBulletinJson, aiUnavailableReason };
module.exports.generateBulletin = async function() {
  // Callable by the scheduler without going through HTTP
  const existing = getTodaysBulletin();
  if (existing) { console.log("[bulletin] Today's bulletin already exists — skipping."); return existing; }

  if (!process.env.FINNHUB_API_KEY) { console.warn("[bulletin] FINNHUB_API_KEY not set — skipping."); return null; }

  let articles = [];
  try { articles = await finnhub.getMarketNews("general", 20); } catch (err) { console.error("[bulletin] News fetch:", err.message); return null; }
  if (!articles?.length) { console.warn("[bulletin] No articles from Finnhub."); return null; }

  const off = aiUnavailableReason();
  if (off) { console.warn("[bulletin] AI unavailable — no bulletin made:", off); return null; }

  const articleList = articles.slice(0, 15).map((a, i) => {
    const time = a.datetime ? new Date(typeof a.datetime === "number" ? a.datetime * 1000 : a.datetime).toISOString() : "unknown";
    return `[${i + 1}] SOURCE: ${a.source || "Unknown"} | TIME: ${time}\nHEADLINE: ${a.headline || ""}\nSUMMARY: ${a.summary || "(no summary)"}\nURL: ${a.url || ""}`;
  }).join("\n\n");

  try {
    const bulletin = await generateWithClaude(articles, articleList);
    appendBulletin(bulletin);
    sendMacNotification(bulletin.article.headline || "Morning Bulletin", (bulletin.newsSummary || "").slice(0, 120) + "…");
    console.log("[bulletin] Generated:", bulletin.article.headline);
    return bulletin;
  } catch (err) {
    console.error("[bulletin] Scheduler generate error:", err.message);
    return null;   // no invented bulletin (D-24)
  }
};
