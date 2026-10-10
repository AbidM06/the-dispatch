/**
 * server/umushroom/source.js — reads the public UMushroom paper-portfolio repo.
 *
 * The Dispatch only DISPLAYS this data. It never writes to that repo, calls no
 * AI and costs nothing. Every file is validated; a file that is missing or
 * malformed becomes an entry in `errors` and its section reads "unavailable" —
 * nothing is filled in (D-02). A fetch that fails after a good one serves the
 * last good copy flagged `stale`.
 *
 * Base URL: UMUSHROOM_RAW_BASE, e.g.
 *   https://raw.githubusercontent.com/<owner>/dispatch-umushroom/main
 * Only https://raw.githubusercontent.com is accepted, so the setting cannot
 * point this server at an internal address.
 *
 * File contract: SCHEMA.md in the UMushroom repo.
 */
"use strict";

const { fetchWithTimeout } = require("../retry");

const TTL_MS        = 5 * 60 * 1000;
const TIMEOUT_MS    = 8000;
const MAX_FILE_CHARS = 400_000;
const DATE_RE       = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_FILE_RE  = /^notes\/\d{4}-\d{2}-\d{2}\.md$/;
const VERDICTS      = ["HOLD", "WATCH", "ACT"];

const store = new Map(); // url → { text, fetchedAt }
function _reset() { store.clear(); }

function baseUrl() {
  const raw = (process.env.UMUSHROOM_RAW_BASE || "").trim().replace(/\/+$/, "");
  if (!raw) return { configured: false };
  let u;
  try { u = new URL(raw); } catch { return { configured: true, error: "UMUSHROOM_RAW_BASE is not a valid URL" }; }
  if (u.protocol !== "https:" || u.hostname !== "raw.githubusercontent.com")
    return { configured: true, error: "UMUSHROOM_RAW_BASE must start with https://raw.githubusercontent.com/" };
  return { configured: true, base: raw };
}

/** Fetch one text file. Returns { text, stale, fetchedAt } or throws. */
async function fetchText(base, rel) {
  const url = base + "/" + rel;
  const hit = store.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return { text: hit.text, stale: false, fetchedAt: hit.fetchedAt };
  try {
    const r = await fetchWithTimeout(url, { headers: { Accept: "text/plain" } }, TIMEOUT_MS);
    if (!r.ok) throw new Error(r.status === 404 ? "file not found" : "HTTP " + r.status);
    const text = await r.text();
    if (text.length > MAX_FILE_CHARS) throw new Error("file too large");
    const fetchedAt = new Date().toISOString();
    store.set(url, { text, at: Date.now(), fetchedAt });
    return { text, stale: false, fetchedAt };
  } catch (err) {
    if (hit) return { text: hit.text, stale: true, fetchedAt: hit.fetchedAt };
    throw new Error(err.name === "AbortError" ? "timed out" : err.message);
  }
}

// ── validators: return the value or throw a plain-English reason ──────────────
const num = (v) => typeof v === "number" && isFinite(v);
function need(cond, msg) { if (!cond) throw new Error(msg); }

function parsePortfolio(text) {
  const p = JSON.parse(text);
  need(p && p.schemaVersion === 1, "unsupported schemaVersion");
  need(Array.isArray(p.positions) && p.positions.length, "no positions");
  for (const x of p.positions)
    need(x && typeof x.ticker === "string" && num(x.weightPct) && num(x.targetUSD) && num(x.reviewLevelUSD),
      "position " + (x && x.ticker) + " is missing weight, target or review level");
  const total = p.positions.reduce((s, x) => s + x.weightPct, 0) + (p.cash || []).reduce((s, c) => s + (num(c.weightPct) ? c.weightPct : 0), 0);
  p._weightTotal = Math.round(total * 100) / 100;
  return p;
}

function parseStatus(text) {
  const s = JSON.parse(text);
  need(s && s.schemaVersion === 1, "unsupported schemaVersion");
  need(DATE_RE.test(s.asOf || ""), "asOf is not a date");
  need(VERDICTS.includes(s.verdict), "verdict must be HOLD, WATCH or ACT");
  need(s.positions && typeof s.positions === "object", "no positions");
  return s;
}

function parseNotesIndex(text) {
  const a = JSON.parse(text);
  need(Array.isArray(a), "notes index is not a list");
  for (const n of a)
    need(n && DATE_RE.test(n.date || "") && NOTE_FILE_RE.test(n.file || "") && VERDICTS.includes(n.verdict),
      "a notes index entry has a bad date, file or verdict");
  return a;
}

function parseJsonl(text) {
  const items = []; let bad = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o && typeof o === "object" && o.id && DATE_RE.test(o.date || "")) items.push(o); else bad++; }
    catch { bad++; }
  }
  return { items, bad };
}

function parseReflections(text) {
  const a = JSON.parse(text);
  need(Array.isArray(a), "reflections is not a list");
  return a;
}

// ── view: arithmetic only, done here so it is tested and labelled ─────────────
const r2 = (x) => Math.round(x * 100) / 100;
function daysBetween(a, b) { return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000); }

function triggerFired(t, reading) {
  if (!num(reading) || !num(t.level)) return null; // event triggers are judged by the PM, not computed
  return t.direction === "above" ? reading > t.level : t.direction === "below" ? reading < t.level : null;
}

function buildView(portfolio, status, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const win = portfolio.window || {};
  const ageDays = daysBetween(status.asOf, today);
  const warnings = [];
  if (portfolio._weightTotal !== 100) warnings.push("Portfolio weights add to " + portfolio._weightTotal + "%, not 100%.");
  if (num(status.returnPct) && num(status.benchmarkReturnPct) && num(status.alphaPct)
      && Math.abs(status.alphaPct - (status.returnPct - status.benchmarkReturnPct)) > 0.05)
    warnings.push("Reported alpha (" + status.alphaPct + "%) does not equal return minus S&P 500 return (" +
                  r2(status.returnPct - status.benchmarkReturnPct) + "%). Treat these figures as unverified.");
  if (ageDays > 3) warnings.push("Status was last updated " + status.asOf + " (" + ageDays + " days ago).");

  const positions = portfolio.positions.map((x) => {
    const q = status.positions[x.ticker] || null;
    const price = q && num(q.price) ? q.price : null;
    const entryPx = x.entry && num(x.entry.price) ? x.entry.price : null;
    return {
      ticker: x.ticker, name: x.name, bucket: x.bucket, view: x.view, weightPct: x.weightPct,
      price, priceAsOf: q ? q.asOf || null : null, priceSource: q ? q.source || null : null, priceStatus: q ? q.status || "unverified" : "missing",
      targetUSD: x.targetUSD, reviewLevelUSD: x.reviewLevelUSD,
      toTargetPct: price ? r2((x.targetUSD / price - 1) * 100) : null,
      toReviewPct: price ? r2((x.reviewLevelUSD / price - 1) * 100) : null,
      level: price == null ? null : price <= x.reviewLevelUSD ? "review level hit" : price >= x.targetUSD ? "target hit" : null,
      entryPrice: entryPx, sinceEntryPct: price && entryPx ? r2((price / entryPx - 1) * 100) : null,
      thesis: q && ["intact", "watch", "broken"].includes(q.thesis) ? q.thesis : null,
      thesisNote: q ? q.thesisNote || "" : "",
      thesisBreakers: x.thesisBreakers || [],
    };
  });

  const triggers = (portfolio.triggers || []).map((t) => {
    const s = (status.triggers || {})[t.id] || {};
    const reading = s.reading !== undefined ? s.reading : null;
    const computed = triggerFired(t, reading);
    return { id: t.id, name: t.name, direction: t.direction, level: t.level, unit: t.unit, source: t.source,
             reading, asOf: s.asOf || null, fired: s.fired === true,
             mismatch: computed != null && computed !== (s.fired === true) };
  });
  for (const t of triggers) if (t.mismatch) warnings.push("Trigger " + t.name + ": the reading and the fired flag disagree.");

  const start = win.start, end = win.end;
  // Days elapsed since the window opened (0 on the first day; negative before it opens).
  const dayNumber = start ? daysBetween(start, today) : null;
  const totalDays = start && end ? daysBetween(start, end) : null;

  return {
    asOf: status.asOf, ageDays, phase: status.phase || null,
    verdict: status.verdict, verdictReason: status.verdictReason || "",
    navGBP: status.navGBP, returnPct: status.returnPct, benchmarkReturnPct: status.benchmarkReturnPct, alphaPct: status.alphaPct,
    drawdownFromPeakPct: status.drawdownFromPeakPct, drawdownLimitPct: portfolio.constraints ? portfolio.constraints.maxSevereTailLossPct : null,
    changesThisWeek: status.changesThisWeek, maxChangesPerWeek: portfolio.maxChangesPerWeek,
    dayNumber, totalDays, windowStart: start || null, windowEnd: end || null,
    unverified: Array.isArray(status.unverified) ? status.unverified : [],
    warnings, positions, triggers,
    ladder: portfolio.drawdownLadder || [],
    reflectionDates: portfolio.reflectionDates || [],
    upcoming: (portfolio.calendar || []).filter((c) => c[0] >= today).slice(0, 6).map((c) => ({ date: c[0], event: c[1], dateStatus: c[2] })),
    label: portfolio.label || "Paper portfolio for learning. Not investment advice.",
    name: portfolio.name || "UMushroom",
  };
}

/** Everything the Journal tab's UMushroom view needs. Never throws. */
async function load(now = new Date()) {
  const b = baseUrl();
  if (!b.configured) return { configured: false };
  if (b.error) return { configured: true, error: b.error };
  const errors = {};
  const get = async (name, rel, parse) => {
    try { const f = await fetchText(b.base, rel); return { ...f, value: parse(f.text) }; }
    catch (err) { errors[name] = err.message; return null; }
  };
  const [pf, st, ni, dc, ch, rf] = await Promise.all([
    get("portfolio", "portfolio.json", parsePortfolio),
    get("status", "status.json", parseStatus),
    get("notes", "notes/index.json", parseNotesIndex),
    get("decisions", "journal/decisions.jsonl", parseJsonl),
    get("challenges", "journal/challenges.jsonl", parseJsonl),
    get("reflections", "journal/reflections.json", parseReflections),
  ]);

  const out = { configured: true, base: b.base, fetchedAt: new Date().toISOString(), errors,
    stale: [pf, st, ni, dc, ch, rf].some((x) => x && x.stale) };
  if (pf && st) out.view = buildView(pf.value, st.value, now);
  const notes = ni ? [...ni.value].sort((a, c) => a.date.localeCompare(c.date)) : null;
  out.notes = notes;
  if (notes && notes.length) {
    const latest = notes[notes.length - 1];
    const body = await get("latestNote", latest.file, (t) => t);
    out.latestNote = body ? { ...latest, markdown: body.value } : null;
  } else out.latestNote = null;
  out.decisions   = dc ? dc.value.items : null;
  out.challenges  = ch ? ch.value.items : null;
  out.reflections = rf ? rf.value : null;
  out.badLines = { decisions: dc ? dc.value.bad : 0, challenges: ch ? ch.value.bad : 0 };
  return out;
}

/** One archived note, addressed by date; the path comes from the index, never from the caller. */
async function loadNote(date) {
  const b = baseUrl();
  if (!b.configured || b.error) throw Object.assign(new Error(b.error || "UMushroom is not configured"), { status: 503 });
  if (!DATE_RE.test(date)) throw Object.assign(new Error("bad date"), { status: 400 });
  const idx = parseNotesIndex((await fetchText(b.base, "notes/index.json")).text);
  const entry = idx.find((n) => n.date === date);
  if (!entry) throw Object.assign(new Error("no note for that date"), { status: 404 });
  const f = await fetchText(b.base, entry.file);
  return { ...entry, markdown: f.text, stale: f.stale };
}

module.exports = { load, loadNote, buildView, parsePortfolio, parseStatus, parseNotesIndex, parseJsonl, baseUrl, _reset };
