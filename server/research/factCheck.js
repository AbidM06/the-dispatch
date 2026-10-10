/**
 * server/research/factCheck.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Deterministic claim check against the verified FRED facts (no AI, no cost).
 *
 * The Data Auditor used to web-search every material number — including the
 * 10Y yield or Brent price the server had already fetched from FRED. This pass
 * settles those claims in code first, with a real source link, so the auditor
 * only spends searches on claims the fact layer cannot cover.
 *
 * It is deliberately conservative. A claim is only settled when ALL hold:
 *   - it is classified FACT (never a forecast, estimate or opinion)
 *   - it names exactly one series we hold (by alias)
 *   - it contains exactly one number in that series' plausible level range
 *   - it does not read as a change or a forecast, and is not dated more than
 *     a week away from the FRED observation (or in an earlier year)
 * Anything ambiguous is left to the auditor. A wrong automated verdict would be
 * worse than an extra search.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

// Series aliases and level bounds. `exclude` stops a nominal-yield alias from
// matching a real-yield or breakeven statement, and so on.
const RULES = {
  dgs10:    { re: /\b(10[- ]?y(ea)?r?|ten[- ]year)\b[^.]*\b(treasury|ust|yield|note)s?\b|\bus ?10y\b/i, exclude: /\b(real|tips|breakeven|inflation[- ]protected|10y[- ]?2y|2s10s|curve)\b/i, min: 0, max: 15, tol: 0.10 },
  dfii10:   { re: /\b(10[- ]?y(ea)?r?|ten[- ]year)\b[^.]*\b(real yield|tips)\b|\breal (10[- ]?y(ea)?r?|ten[- ]year) yield\b/i, min: -3, max: 6, tol: 0.10 },
  t10yie:   { re: /\bbreakeven\b/i, exclude: /\b5[- ]?y(ea)?r?\b/i, min: 0, max: 6, tol: 0.10 },
  dgs2:     { re: /\b(2[- ]?y(ea)?r?|two[- ]year)\b[^.]*\b(treasury|ust|yield|note)s?\b|\bus ?2y\b/i, exclude: /\b(10y[- ]?2y|2s10s|curve|spread)\b/i, min: 0, max: 15, tol: 0.10 },
  dff:      { re: /\b(effective (fed(eral)? )?funds|fed funds rate|effr)\b/i, exclude: /\b(target|range|futures)\b/i, min: 0, max: 15, tol: 0.05 },
  hySpread: { re: /\b(high[- ]yield|hy)\b[^.]*\b(spread|oas)\b/i, min: 0.5, max: 25, tol: 0.15 },
  brent:    { re: /\bbrent\b/i, exclude: /\bwti\b/i, min: 15, max: 250, tolPct: 0.03 },
  wti:      { re: /\bwti\b/i, exclude: /\bbrent\b/i, min: 15, max: 250, tolPct: 0.03 },
  vix:      { re: /\bvix\b/i, min: 5, max: 100, tolPct: 0.08 },
  eurusd:   { re: /\beur\s?\/?\s?usd\b|\beuro[- ]dollar exchange rate\b/i, min: 0.7, max: 1.7, tolPct: 0.01 },
};

// Signals the statement is about a move, a past point or the future — not the current level.
const NOT_A_LEVEL = /\b(bp|bps|basis points?|rose|fell|up|down|gained|lost|increase[ds]?|decrease[ds]?|jump(ed)?|drop(ped)?|climb(ed)?|slid|change[ds]?|since|ago|last (week|month|year|quarter)|peak(ed)?|trough|high of|low of|averag(e|ed)|will|would|expect(ed|s)?|forecast|target|by (end|year|q[1-4])|in (january|february|march|april|may|june|july|august|september|october|november|december))\b/i;

// Dates are metadata, not levels: stripped before number extraction and
// compared separately against the observation date.
const ISO_DATE = /\b(20\d\d)-(\d\d)-(\d\d)\b/g;
const YEAR     = /\b(19|20)\d\d\b/g;
const MAX_DATE_GAP_DAYS = 7;

function daysBetween(a, b) {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
}

/** A claim dated away from the observation (or naming a past year) is about another point in time. */
function aboutAnotherTime(text, claimAsOf, factAsOf) {
  const dates = [...text.matchAll(ISO_DATE)].map(m => m[0]);
  if (claimAsOf) dates.push(claimAsOf);
  if (dates.some(d => daysBetween(d, factAsOf) > MAX_DATE_GAP_DAYS)) return true;
  const factYear = Number(String(factAsOf).slice(0, 4));
  const years = (text.replace(ISO_DATE, " ").match(YEAR) || []).map(Number);
  return years.some(y => y < factYear);
}

const NUMBER = /-?\d+(?:\.\d+)?/g;
// Tenor labels ("10-year", "2Y", "10y2y") are names, not values — strip them
// before looking for the stated level.
const TENOR  = /\b\d+\s*-?\s*(?:y|yr|yrs|year|years|m|mo|month|months)\b|\b\d+s\d+s\b|\bq[1-4]\b/gi;

function fredUrl(seriesId) {
  return `https://fred.stlouisfed.org/series/${seriesId}`;
}

/**
 * checkClaims — settle what the fact layer can settle.
 *
 * @param {object[]} claims    ledger claims (mutated: status/notes/confidence/asOf)
 * @param {object}   macroCtx  getMacroContext() result
 * @returns {{ settledIds: string[], sources: object[], results: object[] }}
 *   sources — FRED source candidates (with claim links) for the registry
 */
function checkClaims(claims, macroCtx) {
  const facts = macroCtx?.facts || {};
  const settledIds = [];
  const results = [];
  const sourcesBySeries = new Map();

  for (const claim of claims || []) {
    if (claim.classification !== "FACT") continue;
    const text = String(claim.statement || "");
    if (NOT_A_LEVEL.test(text)) continue;

    const hits = Object.entries(RULES).filter(([key, r]) =>
      facts[key] && r.re.test(text) && !(r.exclude && r.exclude.test(text))
    );
    if (hits.length !== 1) continue;
    const [key, rule] = hits[0];
    const fact = facts[key];

    // A stale figure is the last KNOWN value, not today's — judging a claim
    // against it could wrongly mark a current figure as conflicting.
    if (fact.stale) continue;
    if (aboutAnotherTime(text, claim.asOf, fact.asOf)) continue;

    const nums = (text.replace(ISO_DATE, " ").replace(YEAR, " ").replace(TENOR, " ").match(NUMBER) || []).map(Number).filter(n => n >= rule.min && n <= rule.max);
    if (nums.length !== 1) continue;
    const stated = nums[0];

    const tolerance = rule.tolPct ? Math.abs(fact.value) * rule.tolPct : rule.tol;
    const matches = Math.abs(stated - fact.value) <= tolerance;

    claim.asOf = fact.asOf;
    if (matches) {
      claim.verificationStatus = "VERIFIED";
      claim.confidence = Math.max(claim.confidence || 0, 0.95);
      claim.notes = `${claim.notes ? claim.notes + " | " : ""}Fact check (code): matches ${fact.source || "FRED"} ${fact.seriesId} = ${fact.formatted} as of ${fact.asOf}.`;
      if (!claim.agentsAgreeing.includes("fact_check")) claim.agentsAgreeing.push("fact_check");
    } else {
      claim.verificationStatus = "CONFLICTING_DATA";
      claim.confidence = Math.min(claim.confidence ?? 1, 0.3);
      claim.notes = `${claim.notes ? claim.notes + " | " : ""}Fact check (code): report states ${stated}; ${fact.source || "FRED"} ${fact.seriesId} shows ${fact.formatted} as of ${fact.asOf}.`;
      if (!claim.agentsDisagreeing.includes("fact_check")) claim.agentsDisagreeing.push("fact_check");
    }

    settledIds.push(claim.claimId);
    results.push({ claimId: claim.claimId, seriesId: fact.seriesId, stated, verified: fact.value, asOf: fact.asOf, matches });

    const src = sourcesBySeries.get(fact.seriesId) || {
      title:       `${fact.label} (${fact.seriesId})`,
      publisher:   fact.source && fact.source !== "FRED" ? fact.source : "Federal Reserve Bank of St. Louis (FRED)",
      url:         fact.url || fredUrl(fact.seriesId),
      // FRED is primary (tier 1). A Markets overlay (e.g. Yahoo, unofficial) is
      // left for the registry to classify from its publisher — never passed off as tier 1.
      ...(fact.source && fact.source !== "FRED" ? {} : { sourceType: "PRIMARY", sourceTier: 1 }),
      dataAsOf:    fact.asOf,
      supportsClaims: [],
    };
    src.supportsClaims.push(claim.claimId);
    sourcesBySeries.set(fact.seriesId, src);
  }

  return { settledIds, sources: [...sourcesBySeries.values()], results };
}

module.exports = { checkClaims, RULES, NOT_A_LEVEL };
