/**
 * server/inputs/registry.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The one registry of inputs a model may cite, shared by idea cards and news cards.
 * Each builder returns { registry, text }: `registry` maps an id (N#, M:ID, C#, REPORT,
 * SRC-xxx, F:key) to { label, url, publisher, publishedAt, ... } — what a "based on"
 * chip shows — and `text` is the prompt block. Links come only from what The Dispatch
 * fetched; the model never writes a URL.
 *
 * News cards also need, per id, the TEXT a checker can compare a sentence against
 * (`evidence`), which ids are stale and which are measured sentiment. Those come back
 * as extra fields so the idea-card registry entries stay exactly as they were.
 * No AI, no fetch.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const markets = require("../markets/service");

// ── context builders ─────────────────────────────────────────────────────────
function marketContext() {
  const snap = markets.getSnapshot();
  const registry = {};
  const lines = [];
  for (const it of (snap?.items || []).filter(i => i.ok)) {
    const q = it.quote;
    const ref = `M:${it.id}`;
    registry[ref] = {
      kind: "market", ref, label: `${it.label} ${q.value}${it.unit === "%" ? "%" : ""}`,
      url: q.sourceUrl, publisher: q.source, publishedAt: q.releasedAt || q.asOf, observedAt: q.asOf || null, marketId: it.id, value: q.value,
      freshness: it.stale ? "stale" : it.freshness?.label, cadence: q.cadence || null,
      history: it.history || null,   // dynamic markets: lets the Journal find history after the market leaves the snapshot
    };
    const chg = q.changePct != null ? `${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%` :
                q.change != null ? `${q.change >= 0 ? "+" : ""}${q.change}` : "n/a";
    lines.push(`[${ref}] ${it.label} (${it.group}) = ${q.value}${it.unit === "%" ? "%" : ""} | chg ${chg} | ${it.stale ? "STALE" : it.freshness?.label} | as of ${q.asOf} | ${q.source}`);
  }
  return { registry, text: lines.join("\n"), generatedAt: snap?.generatedAt || null };
}

/** `previous` is a plain value on Finnhub-shaped events and a list of { text } readings on FRED calendar events (D-31). */
function previousText(p) {
  return Array.isArray(p) ? p.map(r => r && r.text).filter(Boolean).join("; ") : (p == null ? "" : String(p));
}

function calendarContext(events = []) {
  const registry = {}, lines = [];
  events.slice(0, 12).forEach((e, i) => {
    const ref = `C${i + 1}`;
    const when = e.date || e.time || "";
    const prev = previousText(e.previous);
    registry[ref] = {
      kind: "calendar", ref, label: `${`${e.event}${e.country ? ` (${e.country})` : ""} ${when}`.trim()}${e.calendarStale ? " (STALE calendar)" : ""}`,
      url: e.sourceUrl || null,
      publisher: e.source ? `${e.source} release calendar` : e.seeded ? "Dispatch calendar (seeded)" : "Finnhub",
      publishedAt: null,
      ...(e.calendarStale ? { stale: true } : {}),
    };
    lines.push(`[${ref}] ${[when, e.country, e.event].filter(Boolean).join(" ")}${e.estimate ? ` est ${e.estimate}` : ""}${prev ? ` prev ${prev}` : ""}${e.calendarStale ? " | STALE: calendar last refreshed over 3 days ago, this date may have changed" : ""}`);
  });
  return { registry, text: lines.join("\n") };
}

function newsContext(headlines = [], focusId = null) {
  const registry = {}, lines = [];
  headlines.slice(0, 15).forEach((h, i) => {
    const ref = `N${i + 1}`;
    registry[ref] = { kind: "news", ref, label: h.headline, url: h.url || null, publisher: h.source || "Finnhub", publishedAt: h.datetime || null, newsId: h.id };
    const focus = focusId != null && String(h.id) === String(focusId) ? " ◀ FOCUS" : "";
    lines.push(`[${ref}]${focus} ${h.datetime || ""} · ${h.source || ""} · ${h.headline}${h.summary ? ` — ${h.summary.slice(0, 280)}` : ""}`);
  });
  return { registry, text: lines.join("\n") };
}

function researchContext(report) {
  const registry = {
    REPORT: { kind: "report", ref: "REPORT", label: `${report.reportType} research report v${report.version || 1} (${report.reportId})`, url: null, publisher: "The Dispatch Research", publishedAt: report.generatedAt, reportId: report.reportId },
  };
  for (const s of (report.sources || [])) {
    registry[s.sourceId] = { kind: "report-source", ref: s.sourceId, label: s.title, url: s.url || null, publisher: s.publisher, publishedAt: s.publishedAt || s.dataAsOf || null };
  }
  const body = JSON.stringify({ thesisFrame: report.thesisFrame, research: report.research }).slice(0, 14_000);
  const srcLines = (report.sources || []).slice(0, 25).map(s => `[${s.sourceId}] ${s.publisher}: ${s.title}${s.publishedAt ? ` (${s.publishedAt})` : ""}`);
  const qa = report.institutionalQA ? `QA status: ${report.institutionalQA.status || "n/a"}, score ${report.institutionalQA.score ?? "n/a"}` : "QA: not run";
  return { registry, text: `[REPORT] generated ${report.generatedAt} · ${qa}\n${body}\n\nReport sources:\n${srcLines.join("\n")}` };
}


// ── news-card extras ─────────────────────────────────────────────────────────
// Kept apart from the builders above so idea cards' prompt text and "based on"
// entries do not change. Every line here is built from fetched values only.

const fmtChg = (q) => q.changePct != null ? `${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%` :
                      q.change != null ? `${q.change >= 0 ? "+" : ""}${q.change}` : "n/a";

/** Rates and credit move in basis points; a `%`-unit series' change is in percentage points. */
const BP_GROUPS = new Set(["rates", "credit"]);
function bpMove(it) {
  const q = it.quote || {};
  if (!BP_GROUPS.has(it.group) || it.unit !== "%" || q.change == null || !Number.isFinite(Number(q.change))) return null;
  return Math.round(Number(q.change) * 1000) / 10;   // 0.053 pp → 5.3 bp
}

/**
 * marketEvidence — the Markets snapshot as news-card inputs: the same registry as
 * marketContext, plus per-id evidence text, the stale set and the measured-sentiment
 * set (prediction-market lines: the only sentiment the card may state, WO-03).
 */
function marketEvidence() {
  const base = marketContext();
  // Freshness is graded at refresh time; re-grade it against NOW so an hours-old print is never
  // handed to the writer, the checker or the card's chips as "Real-time" (Codex review of PR #19).
  const snap = markets.ageFreshness(markets.getSnapshot());
  const registry = { ...base.registry };
  const evidence = {}, stale = new Set(), sentiment = new Set(), lines = [];
  for (const it of (snap?.items || []).filter(i => i.ok)) {
    const q = it.quote, ref = `M:${it.id}`;
    if (registry[ref]) registry[ref] = { ...registry[ref], freshness: it.stale ? "stale" : it.freshness?.label };
    const bp = bpMove(it);
    const line = `${it.label} (${it.group}) = ${q.value}${it.unit === "%" ? "%" : ""} | chg ${fmtChg(q)}${bp != null ? ` (${bp >= 0 ? "+" : ""}${bp}bp)` : ""} | ${it.stale ? "STALE" : it.freshness?.label} | as of ${q.asOf} | ${q.source}`;
    evidence[ref] = line;
    lines.push(`[${ref}] ${line}`);
    if (it.stale) stale.add(ref);
    if (it.group === "predictions") sentiment.add(ref);
  }
  return { registry, text: lines.join("\n"), generatedAt: base.generatedAt, evidence, stale, sentiment };
}

function newsEvidence(headlines = [], focusId = null) {
  const base = newsContext(headlines, focusId);
  const evidence = {};
  headlines.slice(0, 15).forEach((h, i) => {
    evidence[`N${i + 1}`] = `${h.datetime || ""} · ${h.source || ""} · ${h.headline}${h.summary ? ` — ${h.summary.slice(0, 280)}` : ""}`;
  });
  return { ...base, evidence, stale: new Set(), sentiment: new Set() };
}

function calendarEvidence(events = []) {
  const base = calendarContext(events);
  const evidence = {}, stale = new Set();
  events.slice(0, 12).forEach((e, i) => {
    const ref = `C${i + 1}`, prev = previousText(e.previous);
    evidence[ref] = `${[e.date || e.time || "", e.country, e.event].filter(Boolean).join(" ")}${prev ? ` prev ${prev}` : ""}${e.calendarStale ? " | STALE calendar" : ""} | ${e.source || "calendar"}`;
    if (e.calendarStale) stale.add(ref);
  });
  return { ...base, evidence, stale, sentiment: new Set() };
}

/** Verified macro facts (macroContext) as F:key inputs — each with its own source, as-of date and STALE flag. */
function factsEvidence(macroCtx) {
  const registry = {}, evidence = {}, stale = new Set(), lines = [];
  for (const f of Object.values(macroCtx?.facts || {})) {
    const ref = `F:${f.key}`;
    registry[ref] = { kind: "fact", ref, label: `${f.label} ${f.formatted}`, url: f.url || null,
      publisher: f.source === "FRED" ? "FRED" : f.source, publishedAt: f.asOf || null, ...(f.stale ? { stale: true } : {}) };
    const line = `${f.label} = ${f.formatted} (${f.source}${f.seriesId ? " " + f.seriesId : ""}, as of ${f.asOf})${f.stale ? " | STALE: last known value" : ""}`;
    evidence[ref] = line;
    lines.push(`[${ref}] ${line}`);
    if (f.stale) stale.add(ref);
  }
  return { registry, evidence, stale, sentiment: new Set(), text: lines.join("\n") };
}

module.exports = {
  marketContext, calendarContext, newsContext, researchContext, previousText,
  marketEvidence, newsEvidence, calendarEvidence, factsEvidence, bpMove,
};
