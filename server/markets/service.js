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

async function getHistory(id, tf = "1d") {
  if (!["1d", "1h"].includes(tf)) tf = "1d";
  const key = `${id}:${tf}`;
  const hit = historyCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  let chain;
  const inst = INSTRUMENTS.find(i => i.id === id);
  if (inst) {
    chain = inst.sources.filter(s => sources.HISTORY[s.provider]);
  } else {
    const pm = (getSnapshot()?.items || []).find(i => i.id === id && i.history);
    chain = pm ? [pm.history] : [];
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

function _reset() { current = null; inFlight = null; historyCache.clear(); }

module.exports = { refresh, getSnapshot, getHistory, isRefreshing, markScheduledRun, classifyFreshness, _reset, DATA_PATH };
