/**
 * server/ideas/generator.js
 * ─────────────────────────────────────────────────────────────────────────────
 * On-demand trade idea cards for the News and Research tabs (view-only — The
 * Dispatch no longer executes anything).
 *
 * One Claude call per idea, no web search: the model sees only what we give
 * it — the headlines (or a research report), the Markets snapshot with each
 * value's source and time, and the macro calendar — and must cite those
 * inputs by id. Citations are resolved server-side, so every "based on" link
 * on a card points at something The Dispatch actually fetched; the model
 * cannot invent a URL. Price levels are checked against the latest price.
 *
 * No direction/universe restrictions (long or short, any instrument).
 * Model: IDEAS_MODEL env, else SONNET_MODEL (default Sonnet 5). Cost ≈ $0.02–0.05 per idea,
 * counted against ANTHROPIC_DAILY_CAP / MONTHLY_CAP via the shared budget gate.
 *
 * Every generated idea is written to the append-only Journal (server/journal)
 * before it is returned — all of them, not a hand-picked subset (D-16).
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const crypto   = require("crypto");
const { z }    = require("zod");
const { callAgent, modelForRole } = require("../research/llm");
const markets  = require("../markets/service");
const store    = require("./store");
const journal  = require("../journal/store");

// Long model text is clipped rather than rejected (a paid call shouldn't fail on length).
const clip = (n) => z.string().min(1).transform(v => (v.length > n ? v.slice(0, n - 1).trimEnd() + "…" : v));
const num  = z.preprocess(v => (typeof v === "string" ? parseFloat(v.replace(/[^0-9.eE+\-]/g, "")) : v), z.number().finite());

const IdeaSchema = z.object({
  instrument:   clip(80),
  marketId:     z.string().max(200).nullable().optional(),
  assetClass:   z.preprocess(v => String(v || "other").toLowerCase(), z.enum(["fx", "rates", "credit", "equities", "commodities", "crypto", "macro", "other"]).catch("other")),
  direction:    z.preprocess(v => String(v || "").toUpperCase(), z.enum(["LONG", "SHORT"])),
  expression:   clip(240),
  headline:     clip(160),
  thesis:       clip(1600),
  catalyst:     clip(500),
  entryLow:     num,
  entryHigh:    num,
  target:       num,
  stop:         num,
  horizon:      clip(60),
  // The holding period as a number — the Journal tracks against this rather than
  // guessing from the prose. Unreadable → null (the Journal then reads the text).
  horizonDays:  z.preprocess(v => (v == null || v === "") ? null : Math.round(Number(v)), z.number().int().min(1).max(3650).nullable().catch(null)).optional(),
  confidence:   z.preprocess(v => Math.round(Number(v)), z.number().int().min(0).max(100)),
  keyRisks:     z.array(clip(300)).min(1).transform(a => a.slice(0, 5)),
  invalidation: clip(500),
  basedOn:      z.array(z.string()).min(1).transform(a => a.slice(0, 15)),
});

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
    };
    const chg = q.changePct != null ? `${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%` :
                q.change != null ? `${q.change >= 0 ? "+" : ""}${q.change}` : "n/a";
    lines.push(`[${ref}] ${it.label} (${it.group}) = ${q.value}${it.unit === "%" ? "%" : ""} | chg ${chg} | ${it.stale ? "STALE" : it.freshness?.label} | as of ${q.asOf} | ${q.source}`);
  }
  return { registry, text: lines.join("\n"), generatedAt: snap?.generatedAt || null };
}

function calendarContext(events = []) {
  const registry = {}, lines = [];
  events.slice(0, 12).forEach((e, i) => {
    const ref = `C${i + 1}`;
    registry[ref] = { kind: "calendar", ref, label: `${e.event} (${e.country || ""}) ${e.date || e.time || ""}`.trim(), url: null, publisher: e.seeded ? "Dispatch calendar (seeded)" : "Finnhub", publishedAt: null };
    lines.push(`[${ref}] ${e.date || e.time || ""} ${e.country || ""} ${e.event}${e.estimate ? ` est ${e.estimate}` : ""}${e.previous ? ` prev ${e.previous}` : ""}`);
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

// ── prompt ───────────────────────────────────────────────────────────────────
const SYSTEM = `You are a senior cross-asset strategist writing ONE actionable trade idea for a sophisticated individual investor.
Rules:
- Use ONLY the data supplied. Do not assume prices, events or facts that are not in the inputs.
- Any instrument, long or short, is allowed. Pick the cleanest expression of the view.
- If the instrument is in the market data, set "marketId" to its id (the part after "M:") and anchor entry, stop and target to its CURRENT price. Otherwise set "marketId": null and only use levels you can justify from the inputs.
- Levels must be internally consistent: LONG → stop < entryLow ≤ entryHigh < target; SHORT → target < entryLow ≤ entryHigh < stop.
- For yields/spreads quote levels in percent (e.g. 4.25), for odds in percent (0-100).
- "basedOn" must list the input ids you actually relied on (e.g. "N3", "M:GOLD", "C2", "REPORT", "SRC-004"). Never cite anything else.
- Be specific about the catalyst and what would prove the idea wrong.
Return ONLY a JSON object with keys: instrument, marketId, assetClass (fx|rates|credit|equities|commodities|crypto|macro|other), direction (LONG|SHORT), expression, headline (≤ 14 words), thesis (3-5 sentences), catalyst, entryLow, entryHigh, target, stop, horizon (e.g. "2-6 weeks"), horizonDays (integer: calendar days the trade is held — the UPPER end of horizon, e.g. 42 for "2-6 weeks"), confidence (0-100 integer), keyRisks (2-4 strings), invalidation, basedOn (array of ids).`;

function parseJsonObject(text) {
  const s = String(text || "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("model returned no JSON object");
  return JSON.parse(s.slice(a, b + 1));
}

function checkLevels(idea, livePrice) {
  const w = [];
  const { direction: d, entryLow: lo, entryHigh: hi, target: t, stop: s } = idea;
  if (lo > hi) w.push("Entry zone is inverted.");
  if (d === "LONG"  && !(s < lo && hi < t)) w.push("Levels are not consistent for a LONG (expected stop < entry < target).");
  if (d === "SHORT" && !(t < lo && hi < s)) w.push("Levels are not consistent for a SHORT (expected target < entry < stop).");
  if (livePrice != null && isFinite(livePrice)) {
    const mid = (lo + hi) / 2;
    const dev = Math.abs(mid / livePrice - 1);
    if (dev > 0.15) w.push(`Entry zone is ${(dev * 100).toFixed(0)}% away from the latest price (${livePrice}).`);
  }
  return w;
}

/**
 * Match the idea to a Markets instrument: the model's marketId if valid,
 * else the instrument name against cited (then all) market labels/ids.
 */
function resolveMarket(idea, registry) {
  const id = idea.marketId ? String(idea.marketId).replace(/^M:/, "") : null;
  if (id && registry[`M:${id}`]) return registry[`M:${id}`];
  const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const instr = norm(idea.instrument);
  if (!instr) return null;
  const all = Object.values(registry).filter(r => r.kind === "market");
  const cited = new Set(idea.basedOn);
  const ordered = all.filter(r => cited.has(r.ref)).concat(all.filter(r => !cited.has(r.ref)));
  for (const r of ordered) {
    const label = norm(r.label.replace(/\s[-\d.,%]+$/, ""));   // strip trailing value
    const mid = norm(r.marketId);
    if (!label) continue;
    if (instr.includes(label) || label.includes(instr) || new RegExp(`\\b${mid}\\b`).test(instr)) return r;
  }
  return null;
}

function riskReward(idea) {
  const mid = (idea.entryLow + idea.entryHigh) / 2;
  const reward = Math.abs(idea.target - mid), risk = Math.abs(mid - idea.stop);
  return risk > 0 ? Math.round((reward / risk) * 100) / 100 : null;
}

/**
 * generate — build context, call the model once, validate, resolve sources, save.
 * @param {"news"|"research"} origin
 * @param {object} input  news: { headlines, calendar, focusId }  research: { report }
 */
async function generate(origin, input) {
  const mk  = marketContext();
  const cal = calendarContext(input.calendar || []);
  let primary, userIntro;
  if (origin === "news") {
    primary = newsContext(input.headlines || [], input.focusId);
    if (!Object.keys(primary.registry).length) { const e = new Error("No headlines available to base an idea on"); e.status = 422; throw e; }
    userIntro = input.focusId != null
      ? "Build the idea around the headline marked ◀ FOCUS, using the other headlines, market data and calendar as wider context."
      : "Find the single most compelling trade suggested by today's headlines taken together with the market data and calendar.";
  } else {
    primary = researchContext(input.report);
    userIntro = "Turn this research report's view into the single best trade, checked against the current market data and calendar. Prefer citing the report's own sources (SRC-xxx) where they support the idea.";
  }

  const user = `${userIntro}

=== ${origin === "news" ? "HEADLINES" : "RESEARCH REPORT"} ===
${primary.text}

=== MARKET DATA (The Dispatch Markets snapshot ${mk.generatedAt || "n/a"}; source and time per line) ===
${mk.text || "(no market snapshot available)"}

=== MACRO CALENDAR ===
${cal.text || "(none)"}

Today is ${new Date().toISOString()}. Return the JSON object only.`;

  const model = modelForRole("ideas");
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0, byRole: {} };
  const raw  = await callAgent("ideas", SYSTEM, user, { maxTokens: 1600, search: false, usage });

  let parsed;
  try { parsed = parseJsonObject(raw); } catch (err) { const e = new Error("Idea generation returned unreadable output — try again"); e.status = 502; throw e; }
  const v = IdeaSchema.safeParse(parsed);
  if (!v.success) {
    const e = new Error("Idea failed validation: " + v.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
    e.status = 502; throw e;
  }
  const idea = v.data;

  const registry = { ...primary.registry, ...mk.registry, ...cal.registry };
  const basedOn  = [...new Set(idea.basedOn)].map(ref => registry[ref]).filter(Boolean);
  const dropped  = idea.basedOn.filter(ref => !registry[ref]);
  const marketRef = resolveMarket(idea, registry);
  const warnings = checkLevels(idea, marketRef?.value);
  if (!basedOn.length) warnings.push("The model did not cite any of the supplied inputs.");
  if (dropped.length) warnings.push(`Ignored ${dropped.length} citation(s) that did not match any input.`);
  if (marketRef?.freshness === "stale") warnings.push("The latest price for this instrument is stale.");

  const card = {
    id: "IDEA-" + crypto.randomBytes(5).toString("hex"),
    origin,
    createdAt: new Date().toISOString(),
    context: origin === "news"
      ? { focusHeadline: input.focusId != null ? (Object.values(primary.registry).find(r => String(r.newsId) === String(input.focusId))?.label || null) : null, headlinesUsed: Object.keys(primary.registry).length }
      : { reportId: input.report.reportId, reportType: input.report.reportType, reportVersion: input.report.version },
    ...idea,
    marketId: marketRef ? marketRef.marketId : null,
    // asOf is the OBSERVATION time (FRED: the observation date); releasedAt is when the
    // provider published it (FRED: series last_updated). The Journal ages the former.
    priceAtIdea: marketRef ? { value: marketRef.value, source: marketRef.publisher, asOf: marketRef.observedAt || marketRef.publishedAt, releasedAt: marketRef.publishedAt || null, url: marketRef.url, freshness: marketRef.freshness || null, cadence: marketRef.cadence || null } : null,
    riskReward: riskReward(idea),
    basedOn,
    warnings,
    marketsSnapshotAt: mk.generatedAt,
    model,
    usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
  };
  // Journal first (frozen copy of the card exactly as generated), then the card
  // list. If the Journal write fails the idea is still returned, but says so —
  // "every idea is logged" must never fail silently.
  try {
    card.journalEntryId = journal.logIdea(card).entryId;
  } catch (err) {
    console.error("[ideas] journal write failed:", err.message);
    card.journalEntryId = null;
    card.warnings.push("This idea could not be written to the Journal: " + err.message);
  }
  store.add(card);
  return card;
}

module.exports = { generate, _internal: { resolveMarket, checkLevels, riskReward, parseJsonObject, newsContext, researchContext, IdeaSchema } };
