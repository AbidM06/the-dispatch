/**
 * server/news/card.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The news card (WO-03, D-35/D-38/D-41/D-43): press a button on a headline and get
 * what happened, what moved, why it matters and what to watch — every sentence with
 * its evidence, anything without evidence removed by code and counted.
 *
 *   inputs (code) → writer (Sonnet, 1 call, web search, no max_uses) → gate A (code)
 *     → gate B (Sonnet, 1 call, no search) → merge + append-only store (code)
 *
 * "What moved" and "What to watch" are built by code from the Markets snapshot and the
 * stored FRED calendar — no model writes them. The card explains; it never recommends
 * (D-41): a recommendation found by gate B is removed. Button-driven only — nothing here
 * runs on a schedule or a page load. Both calls go through claudeTransport inside one
 * cost receipt, stored on the card.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const crypto    = require("crypto");
const { callAgent } = require("../research/llm");
const transport = require("../providers/claudeTransport");
const aiCost    = require("../providers/aiCost");
const markets   = require("../markets/service");
const inputsLib = require("../inputs/registry");
const gates     = require("./gates");
const store     = require("./store");

const RETRY_MS = () => Number(process.env.NEWS_CHECK_RETRY_MS ?? 60_000);
const WATCH_DAYS = 14, WATCH_MAX = 3;

function unavailable(reason, status = 503) {
  const e = new Error(reason);
  e.status = status;
  e.unavailable = true;
  return e;
}

/** Same rule as the research reviewers (orchestrator.safeReview): only a temporary error is retried. */
function isTransient(err) {
  if (["BUDGET_DAILY", "BUDGET_MONTHLY", "API_CREDITS_EXHAUSTED"].includes(err?.code)) return false;
  const s = err?.status;
  return s === 429 || s === 529 || (s >= 500 && s < 600) || /timed out|timeout|ECONNRESET|socket hang up/i.test(err?.message || "");
}

// ── code-built sections ──────────────────────────────────────────────────────
const MOVE_GROUPS = ["rates", "credit", "fx", "equities", "commodities", "crypto"];

/**
 * whatMoved — per asset group, the instruments with the largest move since their previous
 * close: rates and spreads in bp, everything else in %. Monthly macro series and prediction
 * markets are left out (they have no "previous close"). Each row keeps source, time and STALE.
 */
function whatMoved(snapshot, perGroup = 3) {
  const rows = [];
  for (const group of MOVE_GROUPS) {
    const inGroup = [];
    for (const it of (snapshot?.items || []).filter(i => i.ok && i.group === group && i.quote)) {
      const q = it.quote;
      const bp = inputsLib.bpMove(it);
      const move = bp != null ? { move: bp, moveUnit: "bp" }
        : q.changePct != null && Number.isFinite(Number(q.changePct)) ? { move: Math.round(Number(q.changePct) * 100) / 100, moveUnit: "%" } : null;
      if (!move) continue;
      inGroup.push({ id: it.id, ref: `M:${it.id}`, label: it.label, group, value: q.value, unit: it.unit || null, ...move,
        asOf: q.asOf || null, source: q.source || null, sourceUrl: q.sourceUrl || null,
        freshness: it.stale ? "STALE" : (it.freshness?.label || null), stale: Boolean(it.stale), ...(it.staleSince ? { staleSince: it.staleSince } : {}) });
    }
    inGroup.sort((a, b) => Math.abs(b.move) - Math.abs(a.move));
    rows.push(...inGroup.slice(0, perGroup));
  }
  return rows;
}

const addDays = (d, n) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);

/** whatToWatch — the next stored calendar events (up to 3, within 14 days), with date and previous reading. */
function whatToWatch(events = [], now = new Date()) {
  const today = now.toISOString().slice(0, 10), until = addDays(today, WATCH_DAYS);
  return events.filter(e => e && e.date && e.date >= today && e.date <= until).slice(0, WATCH_MAX).map(e => ({
    date: e.date, event: e.event, previous: Array.isArray(e.previous) ? e.previous : [],
    source: e.source ? `${e.source} release calendar` : null, sourceUrl: e.sourceUrl || null, stale: Boolean(e.calendarStale),
  }));
}

// ── prompts ──────────────────────────────────────────────────────────────────
const WRITER_SYSTEM = `You explain one market news story for a careful reader. You do not give advice.
Rules:
- Use figures EXACTLY as they appear in the inputs or in a page you searched. Never compute, round, convert or recall a figure.
- No recommendation, no trade, no direction call, no price target, no "should". Explain; do not advise.
- Every sentence lists in "basedOn" the input ids it rests on (e.g. "N1", "M:BRENT", "C2", "F:dgs10"). Cite only ids that appear in the inputs. A sentence that rests on a web page you searched must contain the cited text from that page.
- Do not use Financial Times (ft.com) content, in a search or from memory.
- A sentence with nothing to cite is left out. Fewer sentences is correct; zero is allowed in every section.
- "sentiment" is allowed ONLY when it cites a measured sentiment input (a prediction-market line, group "predictions"); otherwise return an empty list.
- Do not write URLs. Do not describe the inputs' formatting.
Return ONLY a JSON object:
{"whatHappened":[{"text":"...","basedOn":["..."]}],   // 2-3 sentences: the event itself
 "whyItMatters":[{"text":"...","basedOn":["..."]}],   // 2-5 sentences: the chain from the event to a variable to an asset, one link per sentence
 "sentiment":[{"text":"...","basedOn":["..."]}],      // 0-2 sentences, measured inputs only
 "whatWouldChangeIt":[{"text":"...","basedOn":["..."]}]  // 1-2 sentences
 <SELECTION>}`;

const SELECTION_FIELD = `,
 "selection":{"ref":"N<number>","reason":"...","basedOn":["..."],"newDevelopment":null}`;

function writerPrompt({ focusRef, top, news, mk, cal, facts, previous }) {
  const intro = top
    ? `First pick the ONE headline that best explains today's market moves and return it as "selection" (its N id, why, and the inputs that show it). Then explain that story.${previous
      ? `\nThe previous card covered: "${previous.headline.text}" (generated ${previous.generatedAt}). Do NOT pick that story again unless something new and material happened since; if you do, set "selection.newDevelopment" to {"text": what is new, "basedOn": [ids of inputs dated after that card]}.`
      : ""}`
    : `Explain the headline marked ◀ FOCUS (${focusRef}). Use the other inputs only where they bear on it.`;
  return `${intro}

=== HEADLINES (Finnhub) ===
${news.text || "(none)"}

=== MARKET DATA (The Dispatch Markets snapshot ${mk.generatedAt || "n/a"}; source, time and freshness per line) ===
${mk.text || "(no market snapshot available)"}

=== MACRO CALENDAR (stored FRED release calendar) ===
${cal.text || "(none)"}

=== VERIFIED MACRO FACTS (FRED, Markets-overlaid where newer) ===
${facts.text || "(none fetched)"}

Today is ${new Date().toISOString()}. Return the JSON object only.`;
}

// ── helpers ──────────────────────────────────────────────────────────────────
function mergeInputs(...parts) {
  const out = { registry: {}, evidence: {}, stale: new Set(), sentiment: new Set() };
  for (const p of parts) {
    Object.assign(out.registry, p.registry || {});
    Object.assign(out.evidence, p.evidence || {});
    for (const x of p.stale || []) out.stale.add(x);
    for (const x of p.sentiment || []) out.sentiment.add(x);
  }
  return out;
}

/** A "based on" chip: publisher, time, link — the same fields idea cards show. Never the writer's text. */
function chip(ref, inputs) {
  const r = inputs.registry[ref] || {};
  return { ref, kind: r.kind || null, label: r.label || ref, url: r.url || null, publisher: r.publisher || null,
    publishedAt: r.publishedAt || null, ...(r.freshness ? { freshness: r.freshness } : {}),
    ...(inputs.stale.has(ref) || r.stale ? { stale: true } : {}), ...(r.kind === "search" ? { passage: r.passage } : {}) };
}

function countRemoved(removed) {
  const byReason = {};
  for (const r of removed) byReason[r.reason] = (byReason[r.reason] || 0) + 1;
  return { total: removed.length, byReason };
}

const sameStory = (a, b) => a && b && ((a.newsId != null && String(a.newsId) === String(b.newsId)) ||
  String(a.text || "").trim().toLowerCase() === String(b.text || "").trim().toLowerCase());

/**
 * The top-story rule, as far as code can hold it: the previous card's story may be picked
 * again only with a `newDevelopment` that cites at least one input dated AFTER that card
 * (a headline published later, or a market line observed later) other than the headline itself.
 */
function repeatsWithoutNews(selection, chosen, previous, inputs) {
  if (!previous || !sameStory({ newsId: chosen.newsId, text: chosen.label }, previous.headline)) return false;
  const nd = selection && selection.newDevelopment;
  const after = Date.parse(previous.generatedAt);
  const refs = Array.isArray(nd?.basedOn) ? nd.basedOn : [];
  const fresh = refs.some(ref => {
    const r = inputs.registry[ref];
    if (!r || ref === chosen.ref) return false;
    const t = Date.parse(r.observedAt || r.publishedAt || "");
    return Number.isFinite(t) && t > after;
  });
  return !(nd && typeof nd.text === "string" && nd.text.trim() && fresh);
}

async function getFacts() {
  try { return await require("../providers/macroContext").getMacroContext(); }
  catch (err) { console.warn("[news-card] macro facts unavailable:", err.message); return null; }
}

// ── the pipeline ─────────────────────────────────────────────────────────────
/**
 * buildCard — one news card. Throws an `unavailable` error (503, nothing stored) when AI is
 * off, the budget refuses, the writer fails or its reply is unusable.
 * @param {{ headlines: object[], calendar: object[], focusId?: any, top?: boolean }} input
 */
async function buildCard({ headlines = [], calendar = [], focusId = null, top = false }) {
  if (process.env.DISABLE_AI === "true" || process.env.LOW_COST_MODE === "true") {
    throw unavailable("AI is switched off (LOW_COST_MODE or DISABLE_AI), so no news card can be written. Nothing was stored.");
  }
  if (!headlines.length) throw unavailable("No headlines are loaded (check FINNHUB_API_KEY), so there is nothing to explain.");

  // Financial Times content is not used (D-38): refused as the story, never offered as an input.
  const isFt = (h) => gates.isExcludedSource(h.url, h.source);
  if (!top && headlines.some(h => String(h.id) === String(focusId) && isFt(h))) {
    throw unavailable("Financial Times content is not used for news cards, so this headline cannot be explained. Nothing was stored.", 422);
  }
  headlines = headlines.filter(h => !isFt(h));
  if (!headlines.length) throw unavailable("No usable headlines are loaded, so there is nothing to explain.");

  const previous = top ? store.latest() : null;
  // Aged against now: a print labelled "Real-time" at the last refresh is not real-time hours later.
  const snapshot = markets.ageFreshness(markets.getSnapshot());
  const news  = inputsLib.newsEvidence(headlines, top ? null : focusId);
  const mk    = inputsLib.marketEvidence();
  const cal   = inputsLib.calendarEvidence(calendar);
  const facts = inputsLib.factsEvidence(await getFacts());
  const focusRef = top ? null : Object.keys(news.registry).find(ref => String(news.registry[ref].newsId) === String(focusId));
  if (!top && !focusRef) throw unavailable("That headline is no longer in the current news feed — reload News and try again.", 404);

  const receipt = aiCost.newReceipt();
  return transport.runWithContext({ receipt }, async () => {
    // 1. writer
    let out;
    const system = WRITER_SYSTEM.replace("<SELECTION>", top ? SELECTION_FIELD : "");
    try {
      out = await callAgent("newscard", system, writerPrompt({ focusRef, top, news, mk, cal, facts, previous }),
        { maxTokens: 8000, search: true, withContent: true, blockedDomains: gates.EXCLUDED_DOMAINS });   // web search on, no max_uses (D-43)
    } catch (err) {
      throw unavailable(`The news card writer failed: ${err.message} Nothing was stored.`);
    }
    let reply;
    try { reply = gates.readWriterReply(out); }
    catch (err) { throw unavailable(`${err.message} Nothing was stored.`); }
    const p = reply.parsed || {};
    if (!gates.SECTIONS.some(k => Array.isArray(p[k]))) throw unavailable("The writer's reply did not contain the card's sections. Nothing was stored.");

    // 2. which story
    let headlineRef = focusRef, selection = null;
    if (top) {
      const ref = p.selection && typeof p.selection.ref === "string" ? p.selection.ref.trim() : null;
      if (!ref || !news.registry[ref]) throw unavailable("The writer picked a top story that is not one of the loaded headlines. Nothing was stored.");
      headlineRef = ref;
      const inputsSoFar = mergeInputs(news, mk, cal, facts);
      if (repeatsWithoutNews(p.selection, { ...news.registry[ref], ref }, previous, inputsSoFar)) {
        throw unavailable("The writer picked the same story as the previous card without citing anything new since that card. Nothing was stored — open the previous card, or try again later.");
      }
      selection = { ref,
        basedOn: (Array.isArray(p.selection.basedOn) ? p.selection.basedOn : []).filter(id => inputsSoFar.registry[id]),
        repeatOfPrevious: Boolean(previous && sameStory({ newsId: news.registry[ref].newsId, text: news.registry[ref].label }, previous.headline)) };
    }
    const h = news.registry[headlineRef];
    // The writer's reason for its pick is gated like every other sentence — never shown unchecked.
    // Only the top-story button produces one; a "whySelected" the writer adds on its own is ignored.
    const why = top && p.selection && typeof p.selection.reason === "string" ? p.selection.reason.trim().slice(0, 400) : "";
    const whyRead = why ? reply.attach(why) : null;
    reply.sentences.whySelected = whyRead && whyRead.text
      ? [{ text: whyRead.text, basedOn: Array.isArray(p.selection.basedOn) ? p.selection.basedOn : [], wIds: whyRead.ids }] : [];

    // 3. gate A — code
    const inputs = mergeInputs(news, mk, cal, facts, reply.searchInputs);
    const a = gates.gateA(reply.sentences, inputs);
    if (selection) selection.basedOn = selection.basedOn.map(ref => chip(ref, inputs));

    // 4. gate B — one Sonnet call, each sentence with its own evidence only
    let kept = a.kept, removedB = [], check;
    if (!kept.length) {
      check = { status: "checked", reason: "No sentence passed the code check, so there was nothing to send to the evidence check." };
    } else {
      const user = gates.checkPrompt(kept, inputs);
      let replyB = null, failure = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try { replyB = await callAgent("newscheck", gates.CHECK_SYSTEM, user, { maxTokens: 3000, search: false }); failure = null; break; }
        catch (err) {
          failure = err;
          if (attempt === 1 && isTransient(err)) { await new Promise(r => setTimeout(r, RETRY_MS())); continue; }
          break;
        }
      }
      if (failure) {
        kept = kept.map(s => ({ ...s, tags: [...s.tags, "not_checked"] }));
        check = { status: "not_checked", reason: `The evidence check could not run (${failure.message})${isTransient(failure) ? " — it was retried once" : ""}. These sentences passed the code check only.` };
      } else {
        const b = gates.applyVerdicts(kept, replyB);
        kept = b.kept; removedB = b.removed;
        check = b.unchecked
          ? { status: "not_checked", reason: `The evidence check returned no usable verdict for ${b.unchecked} of ${b.kept.length + b.removed.length} sentences; those are marked NOT CHECKED.` }
          : { status: "checked" };
      }
    }

    // 5. merge + store
    const removed = [...a.removed, ...removedB];
    const section = (name) => kept.filter(s => s.section === name).map(s => ({
      text: s.text, basedOn: s.refs.map(ref => chip(ref, inputs)), tags: s.tags, ...(s.checkReason ? { checkReason: s.checkReason } : {}),
    }));
    const card = {
      id: "NEWS-" + crypto.randomBytes(5).toString("hex"),
      generatedAt: new Date().toISOString(),
      origin: top ? "top" : "headline",
      headline: { text: h.label, source: h.publisher, url: h.url, publishedAt: h.publishedAt, newsId: h.newsId, ref: headlineRef },
      ...(selection ? { selection, whySelected: section("whySelected") } : {}),
      whatHappened: section("whatHappened"),
      whatMoved: whatMoved(snapshot),
      whyItMatters: section("whyItMatters"),
      sentiment: section("sentiment"),
      whatWouldChangeIt: section("whatWouldChangeIt"),
      whatToWatch: whatToWatch(calendar),
      removed: countRemoved(removed),
      check,
      noExplanation: section("whyItMatters").length === 0,
      marketsSnapshotAt: snapshot?.generatedAt || null,
      searchSources: Object.keys(reply.searchInputs.registry).length,
      receipt: aiCost.finalizeReceipt(receipt),
    };
    try {
      return store.append(card, removed.map(r => ({ section: r.section, text: r.text, reason: r.reason, ...(r.checkReason ? { checkReason: r.checkReason } : {}) })));
    } catch (err) {
      throw unavailable(`The card was written but could not be saved (${err.message}), so it is not shown.`, 500);
    }
  });
}

module.exports = { buildCard, _internal: { whatMoved, whatToWatch, repeatsWithoutNews, writerPrompt, isTransient } };
