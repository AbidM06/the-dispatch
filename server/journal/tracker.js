/**
 * server/journal/tracker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Journal stage 2 — outcome tracking & scoring (DECISIONS D-16, D-18).
 *
 * Every logged idea is followed on free DAILY prices (the Markets history:
 * Yahoo OHLC, FRED closes). No AI, no cost. Runs after each Markets refresh.
 *
 * Rules (owner-approved, D-18):
 *   ENTRY    Only when price trades inside the entry zone [entryLow, entryHigh]
 *            (a limit order, not "at the reference price"). Fill price = zone
 *            midpoint. The idea may fill at any time within its horizon;
 *            unfilled by then → "never_entered" (reported as a fill rate).
 *   START    Tracking starts with the first daily bar AFTER the day the idea
 *            was generated — that day's high/low includes prices from before
 *            the idea existed.
 *   LIVE BAR The newest bar of a series is skipped while recent (< 4 days):
 *            it may still be trading. An older newest bar is a completed
 *            final bar (instrument stopped trading) and is scored.
 *   CLOSE    The first of: target hit, stop hit, horizon expiry (closed at
 *            that day's close). A gap through a level exits at the open.
 *   UNCERTAIN  Daily bars cannot show intraday order. A day whose range
 *            touches both target and stop — or, on the fill day, touches
 *            either — is "uncertain": never guessed, no R.
 *   HORIZON  The idea's horizonDays (or the parsed text). Undeclared → an
 *            ASSUMED 91 days, labelled as such.
 *   R        1R = |entry − stop|. Result R = signed move / 1R.
 *   BENCH    S&P 500 index (^GSPC price, no dividends) over the same dates:
 *            fill day's close → exit (or latest) close.
 *   UNAVAILABLE  If the history does not cover the idea's period (it starts
 *            too late, has a gap, or stops before the horizon ends), the
 *            result is "unavailable" — never "never entered" by default.
 *   CLOSES-ONLY series (FRED) have no high/low: the day's range is taken as
 *            the move between consecutive closes, and the result is labelled.
 *
 * State is incremental (only bars newer than the last processed one are
 * read), so an idea older than the 6-month history window keeps its result.
 * Final outcomes are ALSO appended to the Journal as an `outcome` event —
 * append-only, like everything else there.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const fs   = require("fs");
const path = require("path");

const DAY_MS = 86_400_000;
const ASSUMED_HORIZON_DAYS = 91;
const FINAL = new Set(["target_hit", "stop_hit", "expired", "uncertain", "never_entered", "not_trackable", "unavailable"]);
// Larger gaps between consecutive daily bars mean the history cannot show what
// happened in between (window moved past it, market delisted, data hole) — the
// result is then "unavailable", never asserted. Closes-only monthly series get more room.
const BENCHMARKED = new Set(["target_hit", "stop_hit", "expired", "uncertain"]);
const MAX_GAP_DAYS = 10, MAX_GAP_DAYS_CLOSES_ONLY = 45;

// ── pure scoring ─────────────────────────────────────────────────────────────
const dateOf = (tSec) => new Date(tSec * 1000).toISOString().slice(0, 10);

/** Normalise a history payload to daily bars {t, o, h, l, c, closeOnly}. */
function toBars(history) {
  if (!history) return [];
  if (history.type === "ohlc") return (history.bars || []).map(b => ({ ...b, closeOnly: false }));
  const pts = history.points || [];
  return pts.map((p, i) => {
    const prev = i > 0 ? pts[i - 1].v : p.v;
    return { t: p.t, o: prev, h: Math.max(prev, p.v), l: Math.min(prev, p.v), c: p.v, closeOnly: true };
  });
}

/** Levels + validity for one idea. */
function plan(idea, horizon) {
  const dir = idea.direction === "SHORT" ? -1 : 1;
  const lo = Number(idea.entryLow), hi = Number(idea.entryHigh);
  const zoneLow  = Number.isFinite(lo) && Number.isFinite(hi) ? Math.min(lo, hi) : (Number.isFinite(lo) ? lo : hi);
  const zoneHigh = Number.isFinite(lo) && Number.isFinite(hi) ? Math.max(lo, hi) : (Number.isFinite(hi) ? hi : lo);
  const entry = (zoneLow + zoneHigh) / 2;
  const target = Number(idea.target), stop = Number(idea.stop);
  const risk = dir * (entry - stop);
  const reward = dir * (target - entry);
  let problem = null;
  if (![zoneLow, zoneHigh, target, stop].every(Number.isFinite)) problem = "Entry, target or stop is missing.";
  else if (!(risk > 0) || !(reward > 0)) problem = "Levels are inconsistent with the direction (stop or target on the wrong side of entry).";
  // Any positive declared length is honoured — including beyond a year (the
  // display bucket is "undeclared" then, but the idea still said how long).
  const assumed = !(horizon && Number(horizon.maxDays) > 0);
  const days = assumed ? ASSUMED_HORIZON_DAYS : Number(horizon.maxDays);
  const createdMs = Date.parse(idea.createdAt);
  return {
    dir, zoneLow, zoneHigh, entry, target, stop, risk, reward, problem,
    horizonDays: days, horizonAssumed: assumed,
    startAfter: dateOf(Math.floor(createdMs / 1000)),                         // bars strictly after this date
    expiresOn: new Date(createdMs + days * DAY_MS).toISOString().slice(0, 10),
  };
}

const r2 = (n) => Math.round(n * 100) / 100;

function closeState(s, p, status, exitPrice, bar, note) {
  const R = exitPrice == null ? null : r2(p.dir * (exitPrice - p.entry) / p.risk);
  return {
    ...s, status, exitPrice: exitPrice == null ? null : exitPrice, exitDate: dateOf(bar.t), R,
    returnPct: exitPrice == null ? null : r2(p.dir * (exitPrice / p.entry - 1) * 100),
    note: note || s.note || null, closeOnly: s.closeOnly || bar.closeOnly,
  };
}

/**
 * advance — pure. Feed an idea's state forward through new daily bars.
 * @param {object} state  previous state (or {status:"waiting"} for a new idea)
 * @param {object} p      plan(...)
 * @param {Array}  bars   daily bars, ascending; only t > state.lastBarT are used
 */
function advance(state, p, bars) {
  let s = { status: "waiting", lastBarT: 0, ...state };
  if (FINAL.has(s.status)) return s;
  for (const b of bars) {
    if (b.t <= s.lastBarT) continue;
    const d = dateOf(b.t);
    if (d <= p.startAfter) { s.lastBarT = b.t; continue; }
    const seen = s.lastBarT && dateOf(s.lastBarT) > p.startAfter ? dateOf(s.lastBarT) : p.startAfter;
    const gap = (Date.parse(d) - Date.parse(seen)) / DAY_MS;
    if (gap > (b.closeOnly ? MAX_GAP_DAYS_CLOSES_ONLY : MAX_GAP_DAYS)) {
      return { ...s, status: "unavailable", R: null,
        note: `No price history between ${seen} and ${d}, so what happened then cannot be seen — no result is asserted.` };
    }
    if (d > p.expiresOn) {                                   // horizon over
      if (s.status === "waiting") return { ...s, status: "never_entered", exitDate: p.expiresOn, note: "Price never traded in the entry zone within the horizon." };
      return closeState(s, p, "expired", s.lastClose, { t: s.lastBarT, closeOnly: s.closeOnly }, "Horizon ended; closed at the last close.");
    }
    s.lastBarT = b.t;
    s.closeOnly = s.closeOnly || b.closeOnly;
    const hitsTarget = p.dir > 0 ? b.h >= p.target : b.l <= p.target;
    const hitsStop   = p.dir > 0 ? b.l <= p.stop   : b.h >= p.stop;

    if (s.status === "waiting") {
      const inZone = b.l <= p.zoneHigh && b.h >= p.zoneLow;
      if (!inZone) {
        // The whole horizon has now been seen without a fill.
        if (d === p.expiresOn) return { ...s, status: "never_entered", exitDate: p.expiresOn, note: "Price never traded in the entry zone within the horizon." };
        continue;
      }
      s = { ...s, status: "open", fillDate: d, fillPrice: p.entry };
      if (hitsTarget || hitsStop) {
        return closeState(s, p, "uncertain", null, b,
          "Entered, and the same day also reached the " + (hitsTarget && hitsStop ? "target and the stop" : hitsTarget ? "target" : "stop") +
          " — daily prices cannot show the order.");
      }
      s.lastClose = b.c;
      continue;
    }

    // open
    if (hitsTarget && hitsStop) {
      return closeState(s, p, "uncertain", null, b, "The day's range reached both target and stop — daily prices cannot show which came first.");
    }
    if (hitsStop) {
      const gap = p.dir > 0 ? b.o < p.stop : b.o > p.stop;
      return closeState(s, p, "stop_hit", b.closeOnly ? b.c : (gap ? b.o : p.stop), b, gap && !b.closeOnly ? "Gapped through the stop; exit at the open." : null);
    }
    if (hitsTarget) {
      const gap = p.dir > 0 ? b.o > p.target : b.o < p.target;
      return closeState(s, p, "target_hit", b.closeOnly ? b.c : (gap ? b.o : p.target), b, gap && !b.closeOnly ? "Gapped through the target; exit at the open." : null);
    }
    s.lastClose = b.c;
    if (d === p.expiresOn) return closeState(s, p, "expired", b.c, b, "Horizon ended; closed at the day's close.");
  }
  if (s.status === "open" && s.lastClose != null) {            // mark to market
    s.R = r2(p.dir * (s.lastClose - p.entry) / p.risk);
    s.returnPct = r2(p.dir * (s.lastClose / p.entry - 1) * 100);
    s.markDate = dateOf(s.lastBarT);
  }
  return s;
}

/** S&P 500 close on or before a date (YYYY-MM-DD). */
const BENCH_MAX_GAP_DAYS = 5;   // a benchmark close further than this from the date asked for is not used
function closeOn(bars, date) {
  let v = null, at = null;
  for (const b of bars) { if (dateOf(b.t) <= date) { v = b.c; at = dateOf(b.t); } else break; }
  if (v == null || (Date.parse(date) - Date.parse(at)) / DAY_MS > BENCH_MAX_GAP_DAYS) return null;
  return v;
}

/** Attach the S&P comparison (same dates) to a state. */
// The S&P close on the fill day is stored the first time it is seen
// (spxAtFill), because Yahoo's daily history only reaches back ~6 months and a
// long-held idea would otherwise lose its starting point. The end close must
// match the CURRENT exit/mark date — a comparison over other dates is dropped,
// never kept (the outcome then waits as benchmarkPending).
function withBenchmark(s, spxBars) {
  if (!s.fillDate) return s;
  const endDate = s.exitDate || s.markDate;
  const a = s.spxAtFill != null ? s.spxAtFill : (spxBars?.length ? closeOn(spxBars, s.fillDate) : null);
  const b = endDate && spxBars?.length ? closeOn(spxBars, endDate) : null;
  const base = a != null ? { ...s, spxAtFill: a } : s;
  if (a == null || b == null) return { ...base, spx: null };
  const spxPct = r2((b / a - 1) * 100);
  return { ...base, spx: { fromDate: s.fillDate, toDate: endDate, returnPct: spxPct,
    vsPct: s.returnPct == null ? null : r2(s.returnPct - spxPct),
    basis: "S&P 500 index price (^GSPC), dividends excluded" } };
}

/** Summary over tracked entries. Uncertain and never-entered stay separate. */
function stats(states) {
  const all = Object.values(states);
  const closed = all.filter(s => ["target_hit", "stop_hit", "expired"].includes(s.status));
  const entered = all.filter(s => s.fillDate);
  const decided = all.filter(s => s.fillDate || s.status === "never_entered");
  const avg = (xs) => xs.length ? r2(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  const vs = closed.map(s => s.spx?.vsPct).filter(v => v != null);
  return {
    tracked: all.filter(s => !["not_trackable", "unavailable"].includes(s.status)).length,
    open: all.filter(s => s.status === "open").length,
    waiting: all.filter(s => s.status === "waiting").length,
    closed: closed.length,
    wins: closed.filter(s => s.R > 0).length,
    winRate: closed.length ? r2(closed.filter(s => s.R > 0).length / closed.length * 100) : null,
    avgR: avg(closed.map(s => s.R)),
    totalR: closed.length ? r2(closed.reduce((a, s) => a + s.R, 0)) : null,
    beatSpx: vs.length ? vs.filter(v => v > 0).length : null,
    avgVsSpxPct: avg(vs),
    uncertain: all.filter(s => s.status === "uncertain").length,
    neverEntered: all.filter(s => s.status === "never_entered").length,
    fillRate: decided.length ? r2(entered.length / decided.length * 100) : null,
    notTrackable: all.filter(s => s.status === "not_trackable").length,
    unavailable: all.filter(s => s.status === "unavailable").length,
  };
}

/**
 * dropLiveBar — the newest bar may still be trading (the 14:45 UK refresh is
 * just after the US open; FX never closes), so it is not scored while RECENT.
 * A newest bar older than LIVE_BAR_DAYS is a completed terminal bar (the
 * instrument stopped trading, e.g. delisted or a market closed) and is kept,
 * so an idea can still settle on it.
 */
const LIVE_BAR_DAYS = 4;
function dropLiveBar(bars, now = Date.now()) {
  if (!bars.length) return bars;
  const last = bars[bars.length - 1];
  return (now - last.t * 1000) / DAY_MS < LIVE_BAR_DAYS ? bars.slice(0, -1) : bars;
}

// ── persistence (derived state — recomputable, but kept for old ideas) ───────
const IS_TEST = process.env.NODE_ENV === "test";
const statePath = () => process.env.JOURNAL_TRACKING_PATH || path.join(__dirname, "../../data/journal_tracking.json");
let _memory = null;
function load() {
  if (IS_TEST && !process.env.JOURNAL_TRACKING_PATH) return _memory || { updatedAt: null, entries: {} };
  try { return JSON.parse(fs.readFileSync(statePath(), "utf8")); } catch { return { updatedAt: null, entries: {} }; }
}
function save(doc) {
  if (IS_TEST && !process.env.JOURNAL_TRACKING_PATH) { _memory = doc; return; }
  const f = statePath();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + ".tmp", JSON.stringify(doc, null, 2));
  fs.renameSync(f + ".tmp", f);
}

// ── update (impure: reads the Journal and Markets history) ───────────────────
let inFlight = null;

async function updateAll() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const journal = require("./store");
    const markets = require("../markets/service");
    const doc = load();
    const entries = journal.list({ limit: 100000 });
    // Work left: anything not final, and final results whose Journal outcome
    // event has not been written yet (a failed append, or a benchmark still
    // missing) — so neither is lost to a one-off error.
    const done = (st) => FINAL.has(st?.status) && st.outcomeRecorded;
    // The Journal's outcome event is the durable record: if the derived file
    // was lost or is behind, the recorded outcome wins and is never recomputed.
    let restored = 0;
    for (const e of entries) {
      if (e.outcome && !done(doc.entries[e.entryId])) { doc.entries[e.entryId] = { ...e.outcome, outcomeRecorded: true, restoredFromJournal: true }; restored++; }
    }
    const needs = entries.filter(e => !done(doc.entries[e.entryId]));
    if (!needs.length) {                                   // may still have restored entries from the Journal
      if (restored) { doc.updatedAt = new Date().toISOString(); save(doc); }
      return doc;
    }

    const histories = {};
    const getBars = async (id, source) => {
      if (!(id in histories)) {
        // The newest daily bar may still be trading (the 14:45 UK refresh runs
        // just after the US open; FX never closes), so it is never scored —
        // it is read again, complete, at a later refresh.
        try { histories[id] = dropLiveBar(toBars(await markets.getHistory(id, "1d", { source }))); }
        catch (err) { histories[id] = null; console.warn(`[journal] no history for ${id}: ${err.message}`); }
      }
      return histories[id];
    };
    const spx = await getBars("SPX");

    for (const e of needs) {
      const p = plan(e.idea, e.horizon);
      const prev = doc.entries[e.entryId] || { status: "waiting", lastBarT: 0 };
      let s;
      if (FINAL.has(prev.status)) {
        s = BENCHMARKED.has(prev.status) && prev.fillDate && !prev.spx ? withBenchmark(prev, spx) : prev;      // result is settled; only the benchmark may be missing
      } else if (p.problem) s = { status: "not_trackable", note: p.problem };
      else if (!e.idea.marketId) s = { status: "not_trackable", note: "No Markets instrument to price this idea against." };
      else {
        const bars = await getBars(e.idea.marketId, e.idea.marketHistory || undefined);
        if (!bars) { doc.entries[e.entryId] = { ...prev, lastError: "Price history unavailable at the last update." }; continue; }
        s = withBenchmark(advance(prev, p, bars), spx);
        delete s.lastError;
        // The series stopped (market closed / delisted) before the horizon ended.
        const lastSeen = s.lastBarT ? dateOf(s.lastBarT) : p.startAfter;
        // Same allowance as advance(): closes-only (e.g. monthly FRED) series publish less often.
        const grace = (s.closeOnly || bars.some(x => x.closeOnly)) ? MAX_GAP_DAYS_CLOSES_ONLY : MAX_GAP_DAYS;
        const graceOver = (Date.now() - Date.parse(p.expiresOn)) / DAY_MS > grace;
        if (!FINAL.has(s.status) && graceOver && lastSeen < p.expiresOn) {
          s = { ...s, status: "unavailable", R: null, note: `Price history stops at ${lastSeen}, before the horizon ended (${p.expiresOn}) — no result is asserted.` };
        }
      }
      s = { ...s, plan: { entry: p.entry, zoneLow: p.zoneLow, zoneHigh: p.zoneHigh, target: p.target, stop: p.stop,
        riskPerR: p.risk, horizonDays: p.horizonDays, horizonAssumed: p.horizonAssumed, expiresOn: p.expiresOn }, updatedAt: new Date().toISOString() };
      if (FINAL.has(s.status)) {
        // The Journal's outcome event is written once, so it waits until the
        // S&P comparison is available for entered ideas; until then (and after
        // a failed write) the entry stays in the work list and is retried.
        // Only results with an exit (or uncertain day) have an S&P period to
        // compare; "unavailable" has no endpoint, so it never waits for one.
        s.benchmarkPending = Boolean(BENCHMARKED.has(s.status) && s.fillDate && !s.spx);
        s.outcomeRecorded = false;
        if (!s.benchmarkPending) {
          try { journal.recordOutcome(e.entryId, s); s.outcomeRecorded = true; }
          catch (err) { console.warn("[journal] outcome write failed (will retry):", err.message); }
        }
      }
      doc.entries[e.entryId] = s;
    }
    doc.updatedAt = new Date().toISOString();
    save(doc);
    return doc;
  })();
  try { return await inFlight; } finally { inFlight = null; }
}

function getState() { return load(); }

/**
 * trackingFor — THE lookup every Journal response uses: the derived state,
 * or — if that file was lost — the durable outcome recorded in the Journal.
 */
function trackingFor(entry, state = load()) {
  return state.entries[entry.entryId] || (entry.outcome ? { ...entry.outcome, outcomeRecorded: true } : null);
}
function _reset() { _memory = null; inFlight = null; }

module.exports = {
  updateAll, getState, stats, trackingFor,
  _internal: { plan, advance, toBars, withBenchmark, closeOn, dropLiveBar, ASSUMED_HORIZON_DAYS },
  _reset,
};
