/**
 * server/news/gates.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The news card's checks that are pure code (WO-03). No AI, no fetch, no cost.
 *
 *   readWriterReply()  — the writer's JSON + the web-search passages the API itself
 *                        returned, registered as W# inputs (never the writer's own prose)
 *   gateA()            — cite or drop: unknown id, no evidence, search passage missing,
 *                        sentiment without a measured input, a figure not in its evidence
 *   checkPrompt()      — gate B's prompt: each surviving sentence with ITS OWN evidence only
 *   applyVerdicts()    — NO → removed, recommendation → removed, PARTLY → tagged
 *
 * Conservative on purpose, like research/factCheck.js: a sentence that cannot be shown
 * to rest on its inputs is dropped and counted, never shown.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const { NUMBER, TENOR, ISO_DATE } = require("../research/factCheck");

// "whySelected" is the writer's reason for its top-story pick (card.js fills it from `selection`). It is a
// sentence like any other: it goes through both gates or it is not shown (Codex review of PR #19).
const SECTIONS = ["whySelected", "whatHappened", "whyItMatters", "sentiment", "whatWouldChangeIt"];
const REASONS = ["no_evidence", "unknown_source", "search_evidence_unavailable", "sentiment_needs_measured_input",
  "figure_not_in_evidence", "not_supported", "recommendation"];

// ── the writer's reply ───────────────────────────────────────────────────────
/** The final answer: text blocks after the last tool block (the model's pre-search chatter is not the answer). */
function finalTextBlocks(content) {
  let last = -1;
  content.forEach((b, i) => { if (b && b.type !== "text") last = i; });
  return content.slice(last + 1).filter(b => b && b.type === "text");
}

/** page_age per URL from the web_search_tool_result blocks (an error result is an object, not a list). */
function resultMeta(content) {
  const meta = new Map();
  for (const b of content) {
    if (!b || b.type !== "web_search_tool_result" || !Array.isArray(b.content)) continue;
    for (const r of b.content) if (r && r.type === "web_search_result" && r.url) meta.set(r.url, { title: r.title || null, pageAge: r.page_age || null });
  }
  return meta;
}

// Cite markup some responses carry inside JSON strings: (cite index="2-0">text</cite> or <cite ...>.
// It is rewritten to a plain marker BEFORE JSON.parse (its quotes would break the JSON), then resolved per sentence.
const CITE_RAW = /[<(]cite[^>]*?\bindex\s*=\s*\\?"([^"\\]*)\\?"[^>]*>([\s\S]*?)<\/cite>/gi;
const MARK = /⟦cite:(\d+)⟧([\s\S]*?)⟦\/cite⟧/g;

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// Publishers whose content a news card never uses (D-38: Financial Times, for now). A search
// citation from one is registered without a passage, so it can support nothing; a headline
// from one is not offered to the writer at all (card.js).
const EXCLUDED_DOMAINS = ["ft.com"];
function isExcludedSource(url, publisher = "") {
  let host = "";
  try { host = new URL(String(url || "")).hostname.toLowerCase().replace(/^www\./, ""); } catch { /* not a URL */ }
  if (host && EXCLUDED_DOMAINS.some(d => host === d || host.endsWith("." + d))) return true;
  return /^\s*(?:the\s+)?financial\s+times\s*$|^\s*ft(?:\.com)?\s*$/i.test(String(publisher || ""));
}

/**
 * readWriterReply — parse the writer's JSON and collect its search evidence.
 * @param {string|{text,content}} out  callAgent's result (a string when no content was returned)
 * @returns {{ parsed, sentences: {section: {text, basedOn, wIds}[]}, searchInputs: { registry, evidence }, attach }}
 *   each sentence's `wIds` are the W# ids whose cited passage the API attached to that text.
 */
function readWriterReply(out) {
  const content = out && typeof out === "object" && Array.isArray(out.content) ? out.content : null;
  const blocks = content ? finalTextBlocks(content) : null;
  const raw = blocks ? blocks.map(b => b.text || "").join("") : String(out && typeof out === "object" ? out.text : out || "");

  // W# inputs. A citation's passage is the API's own `cited_text` (up to ~150 chars of the page);
  // the writer cannot write it. Same URL + same passage → one id.
  const registry = {}, evidence = {}, spans = [];
  const byKey = new Map();
  const meta = content ? resultMeta(content) : new Map();
  const register = (url, title, passage) => {
    if (isExcludedSource(url)) passage = null;   // excluded publisher: never evidence (D-38)
    const key = `${url}\u0000${passage || ""}`;
    if (byKey.has(key)) return byKey.get(key);
    const ref = `W${byKey.size + 1}`;
    let host = null; try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* not a URL */ }
    registry[ref] = { kind: "search", ref, label: title || meta.get(url)?.title || url, url, publisher: host || "web search",
      publishedAt: meta.get(url)?.pageAge || null, passage: passage || null };
    evidence[ref] = passage || null;          // null = no passage returned: this source cannot support anything
    byKey.set(key, ref);
    return ref;
  };
  if (blocks) {
    let pos = 0;
    for (const b of blocks) {
      const t = b.text || "";
      const refs = (Array.isArray(b.citations) ? b.citations : [])
        .filter(c => c && c.type === "web_search_result_location" && c.url)
        .map(c => register(c.url, c.title, typeof c.cited_text === "string" && c.cited_text.trim() ? c.cited_text.trim() : null));
      if (refs.length) spans.push({ start: pos, end: pos + t.length, text: t, refs });
      pos += t.length;
    }
  }
  // Index-only cite markup resolves to a search result's URL, which carries no readable passage.
  const resultList = [...meta.entries()];
  const marked = raw.replace(CITE_RAW, (_m, index, inner) => `⟦cite:${parseInt(String(index).split("-")[0], 10)}⟧${inner}⟦/cite⟧`);

  const s = marked, a = s.indexOf("{"), z = s.lastIndexOf("}");
  if (a < 0 || z <= a) { const e = new Error("The writer returned no JSON object."); e.status = 502; throw e; }
  let parsed;
  try { parsed = JSON.parse(s.slice(a, z + 1)); }
  catch { const e = new Error("The writer's reply was not readable JSON."); e.status = 502; throw e; }

  /** Clean a sentence of markers and return the W# ids attached to it. */
  function attach(text) {
    const ids = new Set();
    let clean = String(text || "").replace(MARK, (_m, idx, inner) => {
      const r = resultList[Number(idx)];
      if (r) ids.add(register(r[0], r[1].title, null));
      return inner;
    });
    clean = clean.replace(/[<(]\/?cite[^>]*>/gi, "").replace(/\s{2,}/g, " ").trim();
    // A cited text block whose span lies inside this sentence (by position in the raw reply, else by text).
    const escaped = JSON.stringify(clean).slice(1, -1);
    const at = raw.indexOf(escaped);
    const n = norm(clean);
    for (const sp of spans) {
      const overlap = at >= 0 && sp.start < at + escaped.length && sp.end > at;
      const contained = !overlap && norm(sp.text).length >= 8 && (n.includes(norm(sp.text)) || norm(sp.text).includes(n));
      if (overlap || contained) sp.refs.forEach(r => ids.add(r));
    }
    return { text: clean, ids: [...ids] };
  }

  // Resolve every sentence now, so the W# registry is complete before any gate reads it.
  const sentences = {};
  for (const section of SECTIONS) {
    const list = Array.isArray(parsed?.[section]) ? parsed[section] : [];
    sentences[section] = list.map(item => {
      const it = typeof item === "string" ? { text: item, basedOn: [] } : (item && typeof item === "object" ? item : {});
      const { text, ids } = attach(it.text);
      return { text, basedOn: Array.isArray(it.basedOn) ? it.basedOn : [], wIds: ids };
    });
  }
  return { parsed, sentences, searchInputs: { registry, evidence }, attach };
}

// ── gate A: cite or drop ─────────────────────────────────────────────────────
/** Figures in a sentence: ISO dates as whole tokens, then numbers (tenor labels such as "10-year" are names, not figures). */
function figuresOf(text) {
  const s = String(text || "");
  const dates = s.match(ISO_DATE) || [];
  const rest = s.replace(ISO_DATE, " ").replace(TENOR, " ").replace(/(\d),(?=\d{3}\b)/g, "$1");
  const nums = (rest.match(NUMBER) || []).map(n => Math.abs(Number(n))).filter(Number.isFinite);
  return { dates, nums };
}
// Evidence lines carry timestamps ("2026-09-28T08:00:00.000Z") and tenor names ("10Y"). Their digits are not
// figures: left in, "up 9%" would pass on the month of a date and "10bp" on the name of the 10-year. Only the
// year of a date stays usable ("in 2026").
const STAMP = /\b20\d\d-\d\d-\d\d(?:[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)?)?/g;
function numbersIn(text) {
  const s = String(text || "");
  const years = (s.match(STAMP) || []).map(d => Number(d.slice(0, 4)));
  const rest = s.replace(STAMP, " ").replace(TENOR, " ").replace(/(\d),(?=\d{3}\b)/g, "$1");
  return years.concat((rest.match(NUMBER) || []).map(n => Math.abs(Number(n))).filter(Number.isFinite));
}
/** Every figure must appear in the text of at least one cited input (number equality, sign ignored: "up 3.5%" ↔ "+3.50%"). */
function figuresSupported(text, evidenceTexts) {
  const { dates, nums } = figuresOf(text);
  const pool = evidenceTexts.join("\n");
  if (dates.some(d => !pool.includes(d))) return false;
  const have = numbersIn(pool);
  return nums.every(n => have.some(h => Math.abs(h - n) < 1e-9));
}

/**
 * gateA — keep a sentence only if it rests on its cited inputs.
 * @param {object} sentences  readWriterReply().sentences
 * @param {object} inputs     { registry, evidence, stale:Set, sentiment:Set } (W# included)
 * @returns {{ kept: {section, text, refs, tags}[], removed: {section, text, reason}[] }}
 */
function gateA(sentences, inputs) {
  const kept = [], removed = [];
  for (const section of SECTIONS) {
    for (const raw of sentences[section] || []) {
      const { text, wIds } = raw;
      if (!text) continue;
      const cited = [...new Set((Array.isArray(raw.basedOn) ? raw.basedOn : []).filter(x => typeof x === "string").map(x => x.trim()).filter(Boolean))];
      const drop = (reason) => removed.push({ section, text, reason });

      if (!cited.length && !wIds.length) { drop("no_evidence"); continue; }
      if (cited.some(id => !inputs.registry[id])) { drop("unknown_source"); continue; }
      const all = [...new Set([...cited, ...wIds])];
      // A search source with no API-returned passage cannot support anything (Codex review of PR #16).
      const usable = all.filter(id => typeof inputs.evidence[id] === "string" && inputs.evidence[id].length);
      if (!usable.length) { drop(all.some(id => inputs.registry[id]?.kind === "search") ? "search_evidence_unavailable" : "no_evidence"); continue; }
      if (section === "sentiment" && !usable.some(id => inputs.sentiment.has(id))) { drop("sentiment_needs_measured_input"); continue; }
      if (!figuresSupported(text, usable.map(id => inputs.evidence[id]))) { drop("figure_not_in_evidence"); continue; }

      const tags = [];
      if (usable.some(id => inputs.stale.has(id) || inputs.registry[id]?.stale)) tags.push("stale");
      kept.push({ section, text, refs: usable, tags });
    }
  }
  return { kept, removed };
}

// ── gate B: prompt and verdicts ──────────────────────────────────────────────
const CHECK_SYSTEM = `You check whether evidence supports a sentence. You are shown sentences, each followed by the evidence it cites. Judge each sentence ONLY against its own evidence lines — not against what you know, not against the other sentences.
For each sentence answer:
- verdict: "SUPPORTS" if the evidence states or directly implies everything the sentence says; "PARTLY" if some of it is supported and some is not; "NO" if the evidence does not support it or contradicts it.
- recommendation: true if the sentence tells anyone to buy, sell, hold, enter, exit or position for anything, or states a price target or trade direction as advice; otherwise false.
- reason: one short sentence saying why.
Return ONLY JSON: {"verdicts":[{"id":"S1","verdict":"SUPPORTS|PARTLY|NO","recommendation":false,"reason":"..."}]} with one entry per sentence.`;

/** Each sentence as "[S<n>] text" followed by the text of its own cited inputs — never the writer's prose. */
function checkPrompt(kept, inputs) {
  const blocks = kept.map((s, i) => [`[S${i + 1}] ${s.text}`, "Evidence:",
    ...s.refs.map(id => `  - (${id}) ${inputs.evidence[id]}`)].join("\n"));
  return `Check each sentence against its own evidence.\n\n${blocks.join("\n\n")}\n\nReturn the JSON only.`;
}

/** Apply gate B. A sentence with no verdict is tagged not_checked — never shown as checked. */
function applyVerdicts(kept, reply) {
  let verdicts = [];
  try {
    const s = String(reply || ""), a = s.indexOf("{"), z = s.lastIndexOf("}");
    verdicts = a >= 0 && z > a ? (JSON.parse(s.slice(a, z + 1)).verdicts || []) : [];
  } catch { verdicts = []; }
  const byId = new Map((Array.isArray(verdicts) ? verdicts : []).filter(v => v && v.id).map(v => [String(v.id).trim(), v]));
  const out = [], removed = [];
  let unchecked = 0;
  kept.forEach((s, i) => {
    const v = byId.get(`S${i + 1}`);
    const verdict = v && String(v.verdict || "").toUpperCase();
    if (!v || !["SUPPORTS", "PARTLY", "NO"].includes(verdict)) { unchecked++; out.push({ ...s, tags: [...s.tags, "not_checked"] }); return; }
    if (v.recommendation === true || v.recommendation === "true") { removed.push({ section: s.section, text: s.text, reason: "recommendation", checkReason: v.reason || null }); return; }
    if (verdict === "NO") { removed.push({ section: s.section, text: s.text, reason: "not_supported", checkReason: v.reason || null }); return; }
    if (verdict === "PARTLY") { out.push({ ...s, tags: [...s.tags, "partly_supported"], checkReason: String(v.reason || "").slice(0, 400) || null }); return; }
    out.push(s);
  });
  return { kept: out, removed, unchecked };
}

module.exports = { SECTIONS, REASONS, EXCLUDED_DOMAINS, isExcludedSource, readWriterReply, gateA, checkPrompt, applyVerdicts, CHECK_SYSTEM, figuresSupported, _internal: { figuresOf, finalTextBlocks } };
