/**
 * server/markets/service.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Builds, stores and serves the Markets snapshot.
 *
 *  refresh(trigger)  — fetch every instrument (primary source, then fallbacks),
 *                      persist to data/markets_snapshot.json, update the legacy
 *                      `snapshot:*` cache keys that Events/Risk/Brief read.
 *  getSnapshot()     — last snapshot (memory → disk). Never fetches by itself.
 *  getHistory(id,tf) — chart history on demand (cached 15–60 min).
 *
 * Provenance rules (shown in the UI for every value):
 *  - source / sourceDetail / sourceUrl — who published the number
 *  - releasedAt — when it was published (exchange print time or FRED update)
 *  - asOf       — the moment / period the value describes
 *  - fetchedAt  — when The Dispatch retrieved it
 *  - freshness  — measured, not assumed: Real-time (≤2 min old at fetch),
 *                 Delayed ~N min (≤30), Last trade (market closed), or the
 *                 publication cadence for FRED / ECB data.
 *  If an instrument fails on every source, the previous value is kept but
 *  flagged `stale` with the time it was last fetched — never silently reused.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const fs    = require("fs");
const path  = require("path");
const cache = require("../cache");
const { GROUPS, INSTRUMENTS, POLYMARKET_TAGS, POLYMARKET_COUNT } = require("./instruments");
const sources = require("./sources");

const IS_TEST   = process.env.NODE_ENV === "test";
const DATA_PATH = process.env.MARKETS_SNAPSHOT_PATH || path.join(__dirname, "../../data/markets_snapshot.json");
const COMPAT_TTL = 7 * 24 * 60 * 60 * 1000;

let current   = null;   // in-memory snapshot
let inFlight  = null;   // promise of a running refresh (dedupes concurrent calls)
const historyCache = new Map();

// ── helpers ──────────────────────────────────────────────────────────────────
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

function classifyFreshness(quote, fetchedAt) {
  switch (quote.cadence) {
    case "monthly":   return { code: "monthly",   label: "Monthly data" };
    case "daily":     return { code: "daily",     label: "Daily close" };
    case "reference": return { code: "reference", label: "ECB daily reference" };
    default: {
      const ageMin = Math.max(0, Math.round((Date.parse(fetchedAt) - Date.parse(quote.asOf)) / 60000));
      if (ageMin <= 2)  return { code: "realtime", label: "Real-time", ageMin };
      if (ageMin <= 30) return { code: "delayed",  label: `Delayed ~${ageMin} min`, ageMin };
      return { code: "closed", label: "Last trade", ageMin };
    }
  }
}

async function fetchInstrument(inst, fetchedAt) {
  const attempted = [];
  for (let i = 0; i < inst.sources.length; i++) {
    const src = inst.sources[i];
    const fn  = sources.QUOTE[src.provider];
    try {
      const quote = await fn(src);
      return {
        id: inst.id, label: inst.label, group: inst.group, kind: inst.kind,
        unit: inst.unit || null, decimals: inst.decimals ?? 2,
        ok: true, stale: false, fallbackUsed: i > 0,
        attempted, quote, fetchedAt,
        freshness: classifyFreshness(quote, fetchedAt),
        chartable: true,
      };
    } catch (err) {
      attempted.push({ provider: src.provider, error: err.message });
    }
  }
  return { id: inst.id, label: inst.label, group: inst.group, kind: inst.kind, unit: inst.unit || null,
           decimals: inst.decimals ?? 2, ok: false, attempted, fetchedAt };
}

// ── persistence ──────────────────────────────────────────────────────────────
function loadFromDisk() {
  if (IS_TEST && !process.env.MARKETS_SNAPSHOT_PATH) return null;
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  } catch { return null; }
}

function saveToDisk(snap) {
  if (IS_TEST && !process.env.MARKETS_SNAPSHOT_PATH) return;
  try {
    fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
    const tmp = DATA_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 2));
    fs.renameSync(tmp, DATA_PATH);
  } catch (err) {
    console.warn("[markets] could not persist snapshot:", err.message);
  }
}

// ── legacy cache keys used by Events / Risk / Brief / AI refresh ─────────────
function writeCompatCache(snap) {
  const by = Object.fromEntries((snap.items || []).filter(i => i.ok).map(i => [i.id, i]));
  const rate = (id) => by[id] ? { value: by[id].quote.value, date: (by[id].quote.asOfDate || by[id].quote.asOf || "").slice(0, 10), source: by[id].quote.source } : null;
  const rates = {
    dgs10: rate("US10Y"), dfii10: rate("REAL10"), t10yie: rate("BEI10"),
    hy_spread: rate("HYOAS"), t10y2y: rate("T10Y2Y"),
  };
  const haveRates = Object.values(rates).every(Boolean);
  const gbp = by.GBPUSD;
  const fx  = gbp ? { value: +(1 / gbp.quote.value).toFixed(6), pair: "USDGBP", date: gbp.quote.asOf, source: gbp.quote.source } : null;
  const watchlist = ["AMD", "NVDA", "MSFT", "TSLA", "MU", "AMAT", "LRCX"].filter(s => by[s]).map(s => ({
    sym: s, price: by[s].quote.value, chg: by[s].quote.changePct != null ? +by[s].quote.changePct.toFixed(2) : 0,
    note: by[s].freshness.label, source: by[s].quote.source, date: by[s].quote.asOf.slice(0, 10),
  }));
  if (haveRates) cache.set("snapshot:rates", rates, COMPAT_TTL);
  cache.set("snapshot:data", {
    rates: haveRates ? rates : (cache.get("snapshot:rates") || undefined),
    fx: fx || undefined,
    watchlist: watchlist.length ? watchlist : undefined,
  }, COMPAT_TTL);
}

// ── public API ───────────────────────────────────────────────────────────────
function getSnapshot() {
  if (!current) {
    current = loadFromDisk();
    if (current) writeCompatCache(current);
  }
  return current;
}

function markScheduledRun(dateStr) {
  const snap = getSnapshot();
  if (snap) { snap.lastScheduledDate = dateStr; saveToDisk(snap); }
}

async function doRefresh(trigger) {
  const started   = Date.now();
  const fetchedAt = new Date(started).toISOString();
  const previous  = getSnapshot();
  const prevById  = Object.fromEntries((previous?.items || []).map(i => [i.id, i]));

  const [fixed, pm] = await Promise.all([
    mapLimit(INSTRUMENTS, 6, inst => fetchInstrument(inst, fetchedAt)),
    sources.polymarketTop(POLYMARKET_TAGS, POLYMARKET_COUNT).catch(err => {
      console.warn("[markets] Polymarket failed:", err.message);
      return null;
    }),
  ]);

  let predictions;
  if (pm) {
    predictions = pm.map(p => ({
      ...p, ok: true, stale: false, fallbackUsed: false, attempted: [], fetchedAt,
      freshness: classifyFreshness(p.quote, fetchedAt), chartable: !!p.history,
    }));
  } else {
    predictions = (previous?.items || []).filter(i => i.group === "predictions")
      .map(i => ({ ...i, stale: true, staleSince: i.fetchedAt }));
  }

  // Carry forward last good value (flagged stale) for anything that failed.
  const items = fixed.map(it => {
    if (it.ok) return it;
    const last = prevById[it.id];
    if (last && last.quote) return { ...last, ok: true, stale: true, staleSince: last.fetchedAt, attempted: it.attempted };
    return it;
  }).concat(predictions);

  const failed = items.filter(i => !i.ok || i.stale).map(i => ({ id: i.id, attempted: i.attempted }));
  const snap = {
    version: 1,
    generatedAt: fetchedAt,
    trigger,
    durationMs: Date.now() - started,
    lastScheduledDate: previous?.lastScheduledDate || null,
    groups: GROUPS,
    items,
    summary: {
      total: items.length,
      live: items.filter(i => i.ok && !i.stale).length,
      stale: items.filter(i => i.stale).length,
      failed: items.filter(i => !i.ok).length,
      fallbacks: items.filter(i => i.fallbackUsed).map(i => i.id),
    },
    failed,
  };
  current = snap;
  historyCache.clear();
  saveToDisk(snap);
  writeCompatCache(snap);
  console.log(`[markets] refresh (${trigger}) — ${snap.summary.live}/${snap.summary.total} live, ${snap.summary.stale} stale, ${snap.summary.failed} failed in ${snap.durationMs}ms`);
  return snap;
}

/** Refresh all instruments. Concurrent callers share one in-flight refresh. */
function refresh(trigger = "manual") {
  if (!inFlight) inFlight = doRefresh(trigger).finally(() => { inFlight = null; });
  return inFlight;
}

function isRefreshing() { return !!inFlight; }

async function getHistory(id, tf = "1d", { source } = {}) {
  if (!["1d", "1h", "1y", "5y"].includes(tf)) tf = "1d";
  const key = `${id}:${tf}`;
  const hit = historyCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  let chain;
  const inst = INSTRUMENTS.find(i => i.id === id);
  if (inst) {
    chain = inst.sources.filter(s => sources.HISTORY[s.provider]);
  } else {
    const pm = (getSnapshot()?.items || []).find(i => i.id === id && i.history);
    // A dynamic market (Polymarket) is found in the current snapshot, or via a
    // source the caller saved earlier — it may have left the top list since.
    chain = pm ? [pm.history] : (source && sources.HISTORY[source.provider] ? [source] : []);
  }
  if (!chain.length) { const e = new Error(`No chart source for ${id}`); e.status = 404; throw e; }

  const errors = [];
  for (const src of chain) {
    try {
      const h = await sources.HISTORY[src.provider](src, tf);
      const value = { id, tf, fetchedAt: new Date().toISOString(), ...h };
      historyCache.set(key, { value, expires: Date.now() + (tf === "1h" ? 15 : 60) * 60_000 });
      return value;
    } catch (err) { errors.push(`${src.provider}: ${err.message}`); }
  }
  const e = new Error(`History unavailable for ${id} — ${errors.join("; ")}`);
  e.status = 502;
  throw e;
}

// ── Compare / overlay ────────────────────────────────────────────────────────
// Plots 2–4 of the fixed Markets instruments on shared dates. Every plotted value is a real daily
// close from the same sources the single charts use: dates are INTERSECTED (a day missing from
// any series is dropped and counted), never filled, interpolated or carried forward.
const COMPARE_TFS   = ["1d", "1y", "5y"];          // 6M / 1Y / 5Y daily — no hourly (sessions don't align)
const COMPARE_MODES = ["rebased", "spread"];
const MIN_COMMON_DAYS = 5;

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const rnd = (n, dp = 4) => Math.round(n * 10 ** dp) / 10 ** dp;
const dayKey = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const dayEpoch = (d) => Math.floor(Date.parse(d + "T00:00:00Z") / 1000);

/** The unit a difference between two instruments is expressed in, or null if a spread would be meaningless. */
function spreadUnit(inst) { return inst.spreadUnit || (inst.kind === "macro" ? inst.unit || null : null); }

/** day → value (the last print of each UTC day wins) from either history shape. */
function dailyCloses(h) {
  const m = new Map();
  const rows = h.type === "ohlc" ? h.bars.map(b => [b.t, b.c]) : h.points.map(p => [p.t, p.v]);
  for (const [t, v] of rows.sort((a, b) => a[0] - b[0])) if (Number.isFinite(v)) m.set(dayKey(t), v);
  return m;
}

async function getComparison(ids, tf = "1y", mode = "rebased") {
  if (!COMPARE_TFS.includes(tf)) throw httpError(400, `Range must be one of ${COMPARE_TFS.join(", ")}`);
  if (!COMPARE_MODES.includes(mode)) throw httpError(400, `Mode must be one of ${COMPARE_MODES.join(", ")}`);
  ids = [...new Set((ids || []).map(s => String(s).trim()).filter(Boolean))];
  if (ids.length < 2 || ids.length > 4) throw httpError(400, "Pick between 2 and 4 different instruments");
  const insts = ids.map(id => INSTRUMENTS.find(i => i.id === id));
  const unknown = ids.filter((_, i) => !insts[i]);
  if (unknown.length) throw httpError(404, `Not comparable: ${unknown.join(", ")} (only the fixed Markets instruments can be compared, not prediction markets)`);
  if (mode === "spread") {
    if (ids.length !== 2) throw httpError(422, "A spread needs exactly 2 instruments");
    const [ua, ub] = insts.map(spreadUnit);
    if (!ua || ua !== ub) throw httpError(422, `${insts[0].label} − ${insts[1].label} is not a meaningful spread (different or unspecified units). Spreads are offered for rates/credit/macro series in the same unit, and WTI vs Brent.`);
  }

  const hists  = await Promise.all(ids.map(id => getHistory(id, tf)));
  const maps   = hists.map(dailyCloses);
  const common = [...maps[0].keys()].filter(d => maps.every(m => m.has(d))).sort();
  if (common.length < MIN_COMMON_DAYS) {
    throw httpError(422, `Too little overlap to compare: only ${common.length} shared day${common.length === 1 ? "" : "s"} in this range (monthly and daily series share few dates).`);
  }

  const legs = ids.map((id, i) => ({
    id, label: insts[i].label, decimals: insts[i].decimals ?? 2, unit: insts[i].unit || null,
    firstDate: common[0], first: rnd(maps[i].get(common[0])),
    lastDate: common[common.length - 1], last: rnd(maps[i].get(common[common.length - 1])),
    source: hists[i].source, sourceUrl: hists[i].sourceUrl,
    dropped: maps[i].size - common.length,
  }));

  let series;
  if (mode === "rebased") {
    const bad = ids.filter((_, i) => !(maps[i].get(common[0]) > 0));
    if (bad.length) throw httpError(422, `Can't rebase to 100: ${bad.join(", ")} is zero or negative on ${common[0]}. Use a spread, or compare a different range.`);
    series = ids.map((id, i) => ({
      id, label: insts[i].label,
      points: common.map(d => ({ t: dayEpoch(d), v: rnd(maps[i].get(d) / maps[i].get(common[0]) * 100, 2) })),
    }));
  } else {
    const dp = Math.max(insts[0].decimals ?? 2, insts[1].decimals ?? 2);
    series = [{
      id: `${ids[0]}-${ids[1]}`, label: `${insts[0].label} − ${insts[1].label}`, unit: spreadUnit(insts[0]),
      points: common.map(d => ({ t: dayEpoch(d), v: rnd(maps[0].get(d) - maps[1].get(d), dp) })),
    }];
  }

  return {
    ids, tf, mode, generatedAt: new Date().toISOString(),
    baseDate: common[0], from: common[0], to: common[common.length - 1], sharedDays: common.length,
    series, legs,
    note: "Only days on which every selected series has a value are plotted; nothing is filled or interpolated.",
  };
}

function _reset() { current = null; inFlight = null; historyCache.clear(); }

module.exports = { refresh, getSnapshot, getHistory, getComparison, spreadUnit, isRefreshing, markScheduledRun, classifyFreshness, _reset, DATA_PATH };
