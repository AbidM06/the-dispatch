"use strict";

/**
 * server/providers/twitterVerify.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Reliability filter for live X/Twitter content before it reaches the bulletin
 * prompt. A pipeline of cheap, deterministic layers runs first; only the
 * survivors are sent to Haiku for a final classification pass.
 *
 *   Layer 0a — financial relevance pre-filter (drop political/off-topic posts)
 *   Layer 0b — recency filter (drop stale posts)
 *   Layer 0c — quote-tweet unwinding (attribute the claim to its original source)
 *   Layer 0d — dedup/cluster near-identical posts (bot/amplification signal)
 *   Layer 1  — cross-reference numeric claims against live FRED/EIA data
 *   Layer 3  — Haiku classification: corroborated / plausible-unverified /
 *              contradicted / suspicious
 *
 * Anything that fails or returns nothing degrades to `[]` — callers should
 * treat an empty array as "no X context available" and proceed unchanged.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { callClaude } = require("./anthropic");

const FINANCE_KEYWORDS = /\$[A-Za-z]{1,5}\b|\b(fed|fomc|rate|yield|inflation|cpi|gdp|earnings|stock|equit|bond|treasury|oil|crude|brent|wti|opec|nasdaq|s&p|dow|recession|tariff|spread|hike|cut|jobs report|nfp)\b/i;

function normalizeText(text) {
  return (text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[@#$]\w+/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isFinanciallyRelevant(tweet) {
  return FINANCE_KEYWORDS.test(tweet?.text || "");
}

function isRecent(tweet, maxAgeHours) {
  const ts = Date.parse(tweet?.created_at);
  if (Number.isNaN(ts)) return true; // unknown timestamp — don't penalize
  return Date.now() - ts <= maxAgeHours * 3600 * 1000;
}

function unwindQuote(tweet) {
  if (tweet.quoted_tweet && tweet.quoted_tweet.text) {
    return {
      ...tweet,
      claimText: tweet.quoted_tweet.text,
      claimAuthor: tweet.quoted_tweet.author || "unknown",
      isAmplification: true,
    };
  }
  return { ...tweet, claimText: tweet.text, claimAuthor: tweet.author, isAmplification: false };
}

/** Group near-identical posts by their first ~8 normalized words. */
function clusterTweets(tweets) {
  const clusters = [];
  for (const t of tweets) {
    const norm = normalizeText(t.claimText);
    const fingerprint = norm.split(" ").slice(0, 8).join(" ");
    const existing = fingerprint.length > 12 && clusters.find(c => c.fingerprint === fingerprint);
    if (existing) existing.members.push(t);
    else clusters.push({ fingerprint, members: [t] });
  }
  return clusters;
}

/** Compare a numeric claim in `text` against live FRED/EIA data. */
function crossReference(text, marketData = {}) {
  const { fredRates, eiaPrices } = marketData;

  if (/\b(brent|wti|crude oil|oil price)\b/i.test(text)) {
    const m = text.match(/\$\s?(\d{2,3}(?:\.\d+)?)/);
    if (m && eiaPrices) {
      const claimed = parseFloat(m[1]);
      const refs = [eiaPrices.brent?.value, eiaPrices.wti?.value].filter(v => v != null);
      if (refs.length) {
        const closest = refs.reduce((a, b) => (Math.abs(b - claimed) < Math.abs(a - claimed) ? b : a));
        const diffPct = (Math.abs(claimed - closest) / closest) * 100;
        if (diffPct <= 8)  return { tag: "corroborated", note: `~$${closest.toFixed(0)}/bbl matches EIA` };
        if (diffPct <= 20) return { tag: "unverified",   note: `EIA shows ~$${closest.toFixed(0)}/bbl` };
        return { tag: "contradicted", note: `claimed $${claimed} vs EIA ~$${closest.toFixed(0)}/bbl` };
      }
    }
  }

  if (/\b10[\s-]?y(?:ear|r)?\b.*\byield\b|\byield\b.*\b10[\s-]?y(?:ear|r)?\b/i.test(text)) {
    const m = text.match(/(\d{1,2}(?:\.\d+)?)\s?%/);
    if (m && fredRates?.dgs10 != null) {
      const claimed = parseFloat(m[1]);
      const diff = Math.abs(claimed - fredRates.dgs10);
      if (diff <= 0.1) return { tag: "corroborated", note: `matches FRED 10Y ${fredRates.dgs10.toFixed(2)}%` };
      if (diff <= 0.3) return { tag: "unverified",   note: `FRED 10Y is ${fredRates.dgs10.toFixed(2)}%` };
      return { tag: "contradicted", note: `claimed ${claimed}% vs FRED 10Y ${fredRates.dgs10.toFixed(2)}%` };
    }
  }

  return { tag: "n/a", note: null };
}

/** Layer 3 — Haiku classifies each candidate using the signals computed above. */
async function classifyTweets(candidates, contextLabel) {
  if (!candidates.length) return [];

  const items = candidates.map((c, i) => {
    const flags = [];
    if (c.clusterSize > 1) flags.push(`posted near-identically by ${c.clusterSize} accounts in this sample`);
    if (c.isAmplification) flags.push(`amplifying a quote of @${c.claimAuthor}`);
    if (c.crossRef.tag !== "n/a") flags.push(`cross-reference vs live data: ${c.crossRef.tag}${c.crossRef.note ? " (" + c.crossRef.note + ")" : ""}`);
    const flagStr = flags.length ? ` [${flags.join("; ")}]` : "";
    return `${i + 1}. @${c.author}: "${c.claimText}"${flagStr}`;
  }).join("\n");

  const system = `You are a financial misinformation filter for a market-intelligence dashboard. The bulletin's top story is: "${contextLabel}". For each tweet below, classify it as exactly one of:
- "corroborated": claim matches the cross-referenced live data, or is a reasonable attributable opinion from a named source
- "plausible-unverified": directionally reasonable commentary with no hard verification available
- "contradicted": a numeric claim conflicts with the cross-referenced live data
- "suspicious": templated/bot-like phrasing, sensational claims with no sourcing, or part of a coordinated near-identical posting cluster

Be skeptical of round numbers, "BREAKING" framing without sourcing, and posts flagged as part of a multi-account cluster. Return ONLY a JSON array, no markdown: [{"i": <number>, "verdict": "...", "reason": "<short clause>"}]`;

  const user = `TWEETS:\n${items}`;

  try {
    const raw = await callClaude(system, user, 1000);
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn("[twitterVerify] classification failed:", err.message);
    return [];
  }
}

/**
 * verifyTweets — run the full pipeline.
 *
 * @param {Array} rawTweets        - raw opencli search results
 * @param {Object} opts
 * @param {Object} opts.marketData - { fredRates, eiaPrices } for Layer 1
 * @param {String} opts.contextLabel - the bulletin's top story headline (for Layer 3)
 * @param {Number} opts.maxAgeHours - recency cutoff (default 24)
 * @param {Number} opts.maxResults  - cap on returned items (default 6)
 * @returns {Array} verified items, each with { author, text, claimAuthor,
 *          isAmplification, clusterSize, crossRef, verdict, reason, url }
 */
async function verifyTweets(rawTweets, { marketData = {}, contextLabel = "", maxAgeHours = 24, maxResults = 6 } = {}) {
  if (!Array.isArray(rawTweets) || !rawTweets.length) return [];

  let pool = rawTweets.filter(t => isFinanciallyRelevant(t) && isRecent(t, maxAgeHours));
  if (!pool.length) return [];

  pool = pool.map(unwindQuote);

  const clusters = clusterTweets(pool);

  const candidates = clusters.map(c => {
    const rep = c.members.reduce((best, m) => ((m.views || 0) > (best.views || 0) ? m : best), c.members[0]);
    return {
      author: rep.author,
      text: rep.text,
      claimText: rep.claimText,
      claimAuthor: rep.claimAuthor,
      isAmplification: rep.isAmplification,
      url: rep.url,
      clusterSize: c.members.length,
      crossRef: crossReference(rep.claimText, marketData),
    };
  });

  const verdicts = await classifyTweets(candidates, contextLabel);

  return candidates
    .map((c, i) => {
      const v = verdicts.find(x => x.i === i + 1);
      return {
        ...c,
        verdict: v?.verdict || (c.clusterSize > 2 ? "suspicious" : "plausible-unverified"),
        reason: v?.reason || null,
      };
    })
    .filter(c => c.verdict !== "suspicious" && c.verdict !== "contradicted")
    .slice(0, maxResults);
}

module.exports = { verifyTweets };
