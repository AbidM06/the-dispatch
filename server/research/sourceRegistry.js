/**
 * server/research/sourceRegistry.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Structured evidence layer (§8). Sources are contributed by the Lead Analyst
 * (from its web searches) and by the Data Auditor (independent verification).
 *
 * Source shape:
 * {
 *   sourceId: "SRC-001", title, publisher, url: string|null,
 *   sourceType: PRIMARY | SECONDARY | SPECIALIST | COMMENTARY | MODEL_SEARCH,
 *   sourceTier: 1|2|3|4, publishedAt: string|null, accessedAt, dataAsOf: string|null,
 *   supportsClaims: [], stale: boolean, contributedBy: "lead"|"data_auditor"
 * }
 *
 * Rules enforced here:
 *   - URLs must look like real http(s) URLs or they are stored as null.
 *   - Deduplicate by normalized URL, else by title+publisher.
 *   - Tier inferred from publisher when the model omits it.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const TIER1_PATTERNS = [
  /federal reserve/i, /\bfed\b/i, /\bfred\b/i, /\becb\b/i, /bank of england/i, /bank of japan/i,
  /bureau of labor/i, /\bbls\b/i, /bureau of economic/i, /\bbea\b/i, /census/i,
  /treasury/i, /\bsec\b/i, /securities and exchange/i, /\beia\b/i, /\biea\b/i,
  /\bimf\b/i, /world bank/i, /\bbis\b/i, /\boecd\b/i, /\bons\b/i, /eurostat/i,
  /investor relations/i, /10-k/i, /10-q/i, /8-k/i, /company filing/i, /earnings release/i,
  /exchange/i, /\bcme\b/i, /\bice\b/i, /\bcftc\b/i, /st\.? louis fed/i,
];
const TIER2_PATTERNS = [
  /reuters/i, /bloomberg/i, /financial times/i, /\bft\b/i, /wall street journal/i, /\bwsj\b/i,
  /economist/i, /cnbc/i, /marketwatch/i, /barron/i, /nikkei/i, /axios/i, /yahoo finance/i,
  /morningstar/i, /s&p global/i, /moody/i, /fitch/i, /factset/i, /lseg/i,
];
const TIER3_PATTERNS = [
  /oilprice/i, /argus/i, /platts/i, /kpler/i, /rystad/i, /wood mackenzie/i,
  /semianalysis/i, /trendforce/i, /idc\b/i, /gartner/i, /statista/i, /tradingeconomics/i,
];

function inferTier(publisher = "", url = "") {
  const hay = `${publisher} ${url}`;
  if (TIER1_PATTERNS.some(p => p.test(hay))) return 1;
  if (TIER2_PATTERNS.some(p => p.test(hay))) return 2;
  if (TIER3_PATTERNS.some(p => p.test(hay))) return 3;
  return 4;
}

function validUrl(u) {
  if (typeof u !== "string") return null;
  const t = u.trim();
  if (!/^https?:\/\/[^\s<>"']+\.[a-z]{2,}/i.test(t)) return null;
  // Reject obvious placeholder/fabricated URLs
  if (/example\.com|placeholder|your-?url|fake/i.test(t)) return null;
  return t;
}

function pad3(n) { return String(n).padStart(3, "0"); }

const STALE_DAYS_DEFAULT = 45;

function isStale(source, staleDays = STALE_DAYS_DEFAULT) {
  const ref = source.dataAsOf || source.publishedAt;
  if (!ref) return false;
  const ts = Date.parse(ref);
  if (isNaN(ts)) return false;
  return (Date.now() - ts) > staleDays * 86_400_000;
}

/**
 * Normalize + dedupe raw sources from an agent.
 * @param {Array}  rawSources
 * @param {string} contributedBy
 * @param {Array}  existing  already-registered sources (for dedup + id continuity)
 * @returns {Array} combined registry (existing + new)
 */
function registerSources(rawSources, contributedBy, existing = []) {
  const out = [...existing];
  const byUrl = new Map();
  const byTitlePub = new Map();
  for (const s of out) {
    if (s.url) byUrl.set(s.url.toLowerCase().replace(/\/+$/, ""), s);
    byTitlePub.set(`${(s.title || "").toLowerCase()}|${(s.publisher || "").toLowerCase()}`, s);
  }

  if (!Array.isArray(rawSources)) return out;

  for (const raw of rawSources) {
    if (!raw || typeof raw !== "object") continue;
    const title     = typeof raw.title === "string" ? raw.title.trim() : "";
    const publisher = typeof raw.publisher === "string" ? raw.publisher.trim() : "";
    if (!title && !publisher) continue;

    const url = validUrl(raw.url);
    const urlKey = url ? url.toLowerCase().replace(/\/+$/, "") : null;
    const tpKey  = `${title.toLowerCase()}|${publisher.toLowerCase()}`;

    // Dedup: merge supportsClaims into the existing entry
    const existingEntry = (urlKey && byUrl.get(urlKey)) || byTitlePub.get(tpKey);
    const supports = Array.isArray(raw.supportsClaims) ? raw.supportsClaims.filter(c => typeof c === "string") : [];
    if (existingEntry) {
      existingEntry.supportsClaims = [...new Set([...existingEntry.supportsClaims, ...supports])];
      continue;
    }

    const tier = [1, 2, 3, 4].includes(raw.sourceTier) ? raw.sourceTier : inferTier(publisher, url || "");
    const entry = {
      sourceId:       `SRC-${pad3(out.length + 1)}`,
      title:          title || publisher,
      publisher:      publisher || "Unknown",
      url,
      sourceType:     ["PRIMARY", "SECONDARY", "SPECIALIST", "COMMENTARY", "MODEL_SEARCH"].includes(raw.sourceType)
                        ? raw.sourceType
                        : (tier === 1 ? "PRIMARY" : tier === 2 ? "SECONDARY" : "SPECIALIST"),
      sourceTier:     tier,
      publishedAt:    typeof raw.publishedAt === "string" ? raw.publishedAt : null,
      accessedAt:     new Date().toISOString(),
      dataAsOf:       typeof raw.dataAsOf === "string" ? raw.dataAsOf : null,
      supportsClaims: supports,
      contributedBy,
    };
    entry.stale = isStale(entry);
    out.push(entry);
    if (urlKey) byUrl.set(urlKey, entry);
    byTitlePub.set(tpKey, entry);
  }
  return out;
}

/** Re-link: ensure claims' sourceIds only reference registered sources. */
function pruneDanglingSourceRefs(claims, sources) {
  const ids = new Set(sources.map(s => s.sourceId));
  for (const c of claims) c.sourceIds = c.sourceIds.filter(id => ids.has(id));
  return claims;
}

module.exports = { registerSources, pruneDanglingSourceRefs, inferTier, validUrl, isStale };
