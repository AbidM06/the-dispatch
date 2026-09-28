/**
 * tests/journalTracking.test.js — Journal stage 2 (D-16, D-18): outcome
 * tracking on daily bars. Entry only inside the zone; target / stop / expiry;
 * "uncertain" when a day cannot show the order; R multiples; S&P comparison;
 * FRED closes-only; horizonDays from the model; append-only outcome events.
 */
"use strict";

const request = require("supertest");

const T = (date) => Math.floor(Date.parse(date + "T20:00:00Z") / 1000);
const bar = (date, o, h, l, c) => ({ t: T(date), o, h, l, c, closeOnly: false });
const IDEA = {
  id: "IDEA-t1", origin: "news", createdAt: "2026-09-01T09:00:00.000Z", instrument: "Test ETF", marketId: "XLE",
  direction: "LONG", entryLow: 99, entryHigh: 101, target: 110, stop: 95, horizon: "2-6 weeks", horizonDays: 42,
};
const HZ = { category: "swing", maxDays: 42 };

describe("tracker.advance — pure rules", () => {
  const { plan, advance, withBenchmark, toBars } = require("../server/journal/tracker")._internal;
  const p = plan(IDEA, HZ);

  test("plan: entry is the zone midpoint, 1R = entry − stop, expiry from horizonDays", () => {
    expect(p).toMatchObject({ entry: 100, risk: 5, reward: 10, horizonDays: 42, horizonAssumed: false, expiresOn: "2026-10-13" });
  });

  test("the day the idea was generated is skipped (its range predates the idea)", () => {
    const s = advance({}, p, [bar("2026-09-01", 100, 100, 99, 100), bar("2026-09-02", 104, 105, 103, 104)]);
    expect(s.status).toBe("waiting");
  });

  test("fills only when price trades in the zone; then target hit → +2R", () => {
    const s = advance({}, p, [
      bar("2026-09-02", 104, 105, 103, 104),          // above the zone: no fill
      bar("2026-09-03", 102, 102, 100.5, 101),        // fills
      bar("2026-09-04", 104, 111, 103, 110.5),        // target
    ]);
    expect(s).toMatchObject({ status: "target_hit", fillDate: "2026-09-03", fillPrice: 100, exitPrice: 110, R: 2, returnPct: 10 });
  });

  test("stop hit → −1R; a gap through the stop exits at the open", () => {
    const hit = advance({}, p, [bar("2026-09-02", 100, 101, 99.5, 100), bar("2026-09-03", 97, 98, 94, 96)]);
    expect(hit).toMatchObject({ status: "stop_hit", exitPrice: 95, R: -1 });
    const gap = advance({}, p, [bar("2026-09-02", 100, 101, 99.5, 100), bar("2026-09-03", 92, 93, 91, 92)]);
    expect(gap).toMatchObject({ status: "stop_hit", exitPrice: 92, R: -1.6 });
    expect(gap.note).toMatch(/Gapped/);
  });

  test("a day that reaches both target and stop is UNCERTAIN — never guessed", () => {
    const s = advance({}, p, [bar("2026-09-02", 100, 101, 99.5, 100), bar("2026-09-03", 100, 111, 94, 100)]);
    expect(s).toMatchObject({ status: "uncertain", R: null });
  });

  test("the fill day also touching target or stop is uncertain", () => {
    const s = advance({}, p, [bar("2026-09-02", 104, 104, 94, 96)]);
    expect(s.status).toBe("uncertain");
    expect(s.note).toMatch(/same day/);
  });

  test("horizon expiry closes at that day's close; unfilled by expiry → never_entered", () => {
    // weekly bars in between (a gap of more than 10 days would be "unavailable")
    const weekly = (from, to, o, h, l, c) => { const out = []; for (let t = Date.parse(from); t <= Date.parse(to); t += 7 * 86400000) out.push(bar(new Date(t).toISOString().slice(0, 10), o, h, l, c)); return out; };
    const filled = advance({}, p, [bar("2026-09-02", 100, 101, 99.5, 100), ...weekly("2026-09-09", "2026-10-07", 102, 103, 101, 102), bar("2026-10-13", 103, 104, 102, 103)]);
    expect(filled).toMatchObject({ status: "expired", exitPrice: 103, R: 0.6 });
    const never = advance({}, p, [...weekly("2026-09-02", "2026-10-07", 104, 105, 103, 104), bar("2026-10-14", 104, 105, 103, 104)]);
    expect(never.status).toBe("never_entered");
  });

  test("an unfilled idea is settled ON its expiry day, not the day after", () => {
    const weekly = (from, to) => { const out = []; for (let t = Date.parse(from); t <= Date.parse(to); t += 7 * 86400000) out.push(bar(new Date(t).toISOString().slice(0, 10), 104, 105, 103, 104)); return out; };
    const s = advance({}, p, [...weekly("2026-09-06", "2026-10-11"), bar("2026-10-13", 104, 105, 103, 104)]);
    expect(s).toMatchObject({ status: "never_entered", exitDate: "2026-10-13" });
  });

  test("open ideas are marked to market; state is incremental", () => {
    const s1 = advance({}, p, [bar("2026-09-02", 100, 101, 99.5, 100), bar("2026-09-03", 102, 103, 101, 102)]);
    expect(s1).toMatchObject({ status: "open", R: 0.4, markDate: "2026-09-03" });
    // later update with a window that no longer contains the fill day
    const s2 = advance(s1, p, [bar("2026-09-04", 105, 111, 104, 110)]);
    expect(s2).toMatchObject({ status: "target_hit", fillDate: "2026-09-02", R: 2 });
  });

  test("shorts: target below, stop above", () => {
    const sp = plan({ ...IDEA, direction: "SHORT", target: 90, stop: 105 }, HZ);
    const s = advance({}, sp, [bar("2026-09-02", 100, 101, 99.5, 100), bar("2026-09-03", 95, 96, 89, 90)]);
    expect(s).toMatchObject({ status: "target_hit", R: 2 });
  });

  test("inconsistent levels are not trackable, not guessed", () => {
    expect(plan({ ...IDEA, stop: 120 }, HZ).problem).toMatch(/inconsistent/);
  });

  test("a declared horizon beyond a year is honoured, not replaced by the assumption", () => {
    expect(plan(IDEA, { category: "undeclared", maxDays: 540 })).toMatchObject({ horizonDays: 540, horizonAssumed: false });
  });

  test("benchmark: the fill-day S&P close is kept, and a stale end date is dropped", () => {
    const s = { status: "target_hit", fillDate: "2026-03-02", exitDate: "2026-09-04", returnPct: 10 };
    const recent = [bar("2026-08-01", 0, 0, 0, 5200), bar("2026-09-04", 0, 0, 0, 5500)];   // history no longer reaches March
    expect(withBenchmark(s, recent).spx).toBeNull();                                        // cannot compare → pending
    expect(withBenchmark({ ...s, spxAtFill: 5000 }, recent).spx).toMatchObject({ returnPct: 10, vsPct: 0 });
    const lagging = [bar("2026-03-02", 0, 0, 0, 5000), bar("2026-08-01", 0, 0, 0, 5200)];   // nothing near the exit date
    expect(withBenchmark(s, lagging)).toMatchObject({ spx: null, spxAtFill: 5000 });
  });

  test("history that starts after the horizon ended → unavailable, never 'never entered'", () => {
    const s = advance({}, p, [bar("2026-11-20", 100, 101, 99, 100), bar("2026-11-21", 100, 101, 99, 100)]);
    expect(s.status).toBe("unavailable");
    expect(s.note).toMatch(/No price history between 2026-09-01 and 2026-11-20/);
  });

  test("a hole in the history mid-trade → unavailable", () => {
    const s = advance({}, p, [bar("2026-09-02", 100, 101, 99.5, 100), bar("2026-09-25", 100, 101, 99.5, 100)]);
    expect(s).toMatchObject({ status: "unavailable", fillDate: "2026-09-02", R: null });
  });

  test("undeclared horizon → assumed 91 days, labelled", () => {
    expect(plan(IDEA, { category: "undeclared", maxDays: null })).toMatchObject({ horizonDays: 91, horizonAssumed: true });
  });

  test("FRED closes-only: the range is the move between closes, and the result says so", () => {
    const bars = toBars({ type: "line", points: [
      { t: T("2026-09-02"), v: 100 }, { t: T("2026-09-03"), v: 104 }, { t: T("2026-09-04"), v: 111 } ] });
    const s = advance({}, p, bars);
    expect(s).toMatchObject({ status: "target_hit", exitPrice: 111, closeOnly: true });
  });

  test("S&P comparison over the same dates (fill close → exit close)", () => {
    const s = advance({}, p, [bar("2026-09-02", 100, 101, 99.5, 100), bar("2026-09-04", 104, 111, 103, 110)]);
    const spx = [bar("2026-09-02", 0, 0, 0, 5000), bar("2026-09-03", 0, 0, 0, 5050), bar("2026-09-04", 0, 0, 0, 5100)];
    expect(withBenchmark(s, spx).spx).toMatchObject({ returnPct: 2, vsPct: 8, fromDate: "2026-09-02", toDate: "2026-09-04" });
  });
});

describe("tracker.stats", () => {
  const { stats } = require("../server/journal/tracker");
  test("win rate and R over closed ideas; uncertain and never-entered kept separate; fill rate", () => {
    const st = stats({
      a: { status: "target_hit", R: 2, fillDate: "x", spx: { vsPct: 5 } },
      b: { status: "stop_hit", R: -1, fillDate: "x", spx: { vsPct: -3 } },
      c: { status: "uncertain", R: null, fillDate: "x" },
      d: { status: "never_entered" },
      e: { status: "open", R: 0.5, fillDate: "x" },
      f: { status: "not_trackable" },
    });
    expect(st).toMatchObject({ closed: 2, wins: 1, winRate: 50, avgR: 0.5, totalR: 1, uncertain: 1, neverEntered: 1, open: 1,
      beatSpx: 1, avgVsSpxPct: 1, fillRate: 80, notTrackable: 1, tracked: 5 });
  });
});

describe("horizonDays from the model", () => {
  beforeEach(() => jest.resetModules());
  test("a declared horizonDays beats the text; old cards fall back to parsing", () => {
    const { horizonFor } = require("../server/journal/store")._internal;
    expect(horizonFor({ horizon: "a while", horizonDays: 42 })).toMatchObject({ category: "swing", maxDays: 42, source: "declared" });
    expect(horizonFor({ horizon: "2 weeks" })).toMatchObject({ category: "tactical", source: "parsed" });
  });
});

describe("updateAll — end to end over the Journal and Markets history", () => {
  function setup(history) {
    jest.resetModules();
    const markets = require("../server/markets/service");
    jest.spyOn(markets, "getHistory").mockImplementation(async (id) => {
      // every series ends with a still-trading bar, which the tracker must ignore
      const live = bar("2026-09-07", 1, 1, 1, 1);
      if (id === "SPX") return { type: "ohlc", bars: [bar("2026-09-02", 0, 0, 0, 5000), bar("2026-09-04", 0, 0, 0, 5100), live] };
      if (history[id]) return { ...history[id], bars: [...history[id].bars, live] };
      throw new Error("no source");
    });
    const journal = require("../server/journal/store"); journal._reset();
    const tracker = require("../server/journal/tracker"); tracker._reset();
    return { journal, tracker, markets };
  }

  test("closes an idea, appends ONE outcome event, and the route shows tracking + stats", async () => {
    const { journal, tracker } = setup({ XLE: { type: "ohlc", bars: [bar("2026-09-02", 100, 101, 99.5, 100), bar("2026-09-04", 104, 111, 103, 110)] } });
    const e = journal.logIdea({ ...IDEA });
    await tracker.updateAll();
    await tracker.updateAll();                                     // final: not re-processed, no second event
    const after = journal.getEntry(e.entryId);
    expect(after.outcome).toMatchObject({ status: "target_hit", R: 2 });
    expect(after.integrity).toBe("intact");
    expect(journal._internal.readEvents().filter(ev => ev.type === "outcome")).toHaveLength(1);

    const app = require("../server/index");
    const res = await request(app).get("/api/journal");
    expect(res.body.entries[0].tracking).toMatchObject({ status: "target_hit", spx: { returnPct: 2 } });
    expect(res.body.stats).toMatchObject({ closed: 1, wins: 1, avgR: 2 });
  });

  test("a failed outcome write is retried on the next update, not lost", async () => {
    const { journal, tracker } = setup({ XLE: { type: "ohlc", bars: [bar("2026-09-02", 100, 101, 99.5, 100), bar("2026-09-04", 104, 111, 103, 110)] } });
    const e = journal.logIdea({ ...IDEA });
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const spy = jest.spyOn(journal, "recordOutcome").mockImplementationOnce(() => { throw new Error("disk full"); });
    let doc = await tracker.updateAll();
    expect(doc.entries[e.entryId]).toMatchObject({ status: "target_hit", outcomeRecorded: false });
    expect(journal.getEntry(e.entryId).outcome).toBeNull();
    doc = await tracker.updateAll();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(doc.entries[e.entryId].outcomeRecorded).toBe(true);
    expect(journal.getEntry(e.entryId).outcome).toMatchObject({ status: "target_hit", R: 2 });
  });

  test("a missing S&P benchmark is retried; the outcome event waits for it", async () => {
    const { journal, tracker, markets } = setup({ XLE: { type: "ohlc", bars: [bar("2026-09-02", 100, 101, 99.5, 100), bar("2026-09-04", 104, 111, 103, 110)] } });
    const e = journal.logIdea({ ...IDEA });
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const real = markets.getHistory.getMockImplementation();
    markets.getHistory.mockImplementation(async (id) => { if (id === "SPX") throw new Error("Yahoo 503"); return real(id); });
    let doc = await tracker.updateAll();
    expect(doc.entries[e.entryId]).toMatchObject({ status: "target_hit", benchmarkPending: true, outcomeRecorded: false });
    expect(journal.getEntry(e.entryId).outcome).toBeNull();
    markets.getHistory.mockImplementation(real);
    doc = await tracker.updateAll();
    expect(doc.entries[e.entryId]).toMatchObject({ status: "target_hit", benchmarkPending: false, outcomeRecorded: true, spx: { returnPct: 2 } });
    expect(journal.getEntry(e.entryId).outcome.spx).toMatchObject({ returnPct: 2 });
  });

  test("watch / pitch responses include tracking, so the result badge survives", async () => {
    const { journal, tracker } = setup({ XLE: { type: "ohlc", bars: [bar("2026-09-02", 100, 101, 99.5, 100), bar("2026-09-04", 104, 111, 103, 110)] } });
    const e = journal.logIdea({ ...IDEA });
    await tracker.updateAll();
    const app = require("../server/index");
    const w = await request(app).post(`/api/journal/${e.entryId}/watch`).send({ watched: true });
    expect(w.body.entry.tracking).toMatchObject({ status: "target_hit" });
    const p = await request(app).post(`/api/journal/${e.entryId}/pitch`).send({ text: "mine", beforeReveal: false });
    expect(p.body.entry.tracking).toMatchObject({ status: "target_hit" });
  });

  test("the newest (possibly still-trading) bar is never scored", async () => {
    const { journal, tracker } = setup({ XLE: { type: "ohlc", bars: [bar("2026-09-02", 100, 101, 99.5, 100), bar("2026-09-03", 104, 111, 103, 110)] } });
    const e = journal.logIdea({ ...IDEA });
    // setup() appends a live bar; here the target-hit day is the last COMPLETE bar, so it counts…
    let doc = await tracker.updateAll();
    expect(doc.entries[e.entryId].status).toBe("target_hit");
    // …but a target touched only on the live bar would not.
    const s2 = setup({ XLE: { type: "ohlc", bars: [bar("2026-09-02", 100, 101, 99.5, 100)] } });
    const markets = require("../server/markets/service");
    markets.getHistory.mockImplementation(async (id) => ({ type: "ohlc", bars: id === "SPX"
      ? [bar("2026-09-02", 0, 0, 0, 5000), bar("2026-09-03", 0, 0, 0, 5050)]
      : [bar("2026-09-02", 100, 101, 99.5, 100), bar("2026-09-03", 104, 111, 103, 110)] }));
    const e2 = s2.journal.logIdea({ ...IDEA });
    doc = await s2.tracker.updateAll();
    expect(doc.entries[e2.entryId]).toMatchObject({ status: "open", markDate: "2026-09-02" });
  });

  test("a lost tracking file is rebuilt from the Journal's outcome, not recomputed", async () => {
    const { journal, tracker, markets } = setup({ XLE: { type: "ohlc", bars: [bar("2026-09-02", 100, 101, 99.5, 100), bar("2026-09-04", 104, 111, 103, 110)] } });
    const e = journal.logIdea({ ...IDEA });
    await tracker.updateAll();
    tracker._reset();                                              // derived file lost
    markets.getHistory.mockImplementation(async () => ({ type: "ohlc", bars: [bar("2026-09-02", 100, 101, 99.5, 100), bar("2026-09-04", 90, 91, 89, 90), bar("2026-09-07", 1, 1, 1, 1)] }));
    const doc = await tracker.updateAll();                         // revised history would say "stop"…
    expect(doc.entries[e.entryId]).toMatchObject({ status: "target_hit", R: 2, restoredFromJournal: true });   // …the recorded outcome wins
  });

  test("a rebuild from the Journal is saved even when nothing else needs work", async () => {
    const { journal, tracker } = setup({ XLE: { type: "ohlc", bars: [bar("2026-09-02", 100, 101, 99.5, 100), bar("2026-09-04", 104, 111, 103, 110)] } });
    const e = journal.logIdea({ ...IDEA });
    await tracker.updateAll();
    tracker._reset();
    expect(tracker.getState().entries[e.entryId]).toBeUndefined();
    await tracker.updateAll();
    expect(tracker.getState().entries[e.entryId]).toMatchObject({ status: "target_hit", restoredFromJournal: true });
  });

  test("an 'unavailable' result after a fill is recorded at once — it has no S&P period to wait for", async () => {
    const { journal, tracker } = setup({ XLE: { type: "ohlc", bars: [bar("2026-09-02", 100, 101, 99.5, 100), bar("2026-09-25", 100, 101, 99.5, 100)] } });
    const e = journal.logIdea({ ...IDEA });
    const doc = await tracker.updateAll();
    expect(doc.entries[e.entryId]).toMatchObject({ status: "unavailable", fillDate: "2026-09-02", benchmarkPending: false, outcomeRecorded: true });
    expect(journal.getEntry(e.entryId).outcome.status).toBe("unavailable");
  });

  test("detail and edit responses fall back to the Journal outcome too", async () => {
    const { journal, tracker } = setup({ XLE: { type: "ohlc", bars: [bar("2026-09-02", 100, 101, 99.5, 100), bar("2026-09-04", 104, 111, 103, 110)] } });
    const e = journal.logIdea({ ...IDEA });
    await tracker.updateAll();
    tracker._reset();                                              // derived file lost, not yet rebuilt
    const app = require("../server/index");
    expect((await request(app).get(`/api/journal/${e.entryId}`)).body.entry.tracking).toMatchObject({ status: "target_hit" });
    expect((await request(app).post(`/api/journal/${e.entryId}/watch`).send({ watched: true })).body.entry.tracking).toMatchObject({ status: "target_hit" });
  });

  test("closes-only series get the 45-day allowance before 'series stopped' → unavailable", async () => {
    const { journal, tracker, markets } = setup({});
    const now = Date.now(), iso = (ms) => new Date(ms).toISOString();
    // monthly closes; horizon ended 20 days ago, next observation not published yet
    markets.getHistory.mockImplementation(async (id) => id === "SPX"
      ? { type: "ohlc", bars: [bar(iso(now - 60 * 86400000).slice(0, 10), 0, 0, 0, 5000), bar("2099-01-01", 1, 1, 1, 1)] }
      : { type: "line", points: [{ t: Math.floor((now - 55 * 86400000) / 1000), v: 2.9 }, { t: Math.floor((now - 25 * 86400000) / 1000), v: 3.0 }, { t: Math.floor(now / 1000), v: 3.1 }] });
    const e = journal.logIdea({ ...IDEA, id: "IDEA-cpi", marketId: "CPI", createdAt: iso(now - 60 * 86400000), horizonDays: 40,
      entryLow: 2.8, entryHigh: 3.05, target: 4, stop: 2 });
    const doc = await tracker.updateAll();
    expect(doc.entries[e.entryId].status).not.toBe("unavailable");
  });

  test("a prediction market that left the snapshot is still priced from the saved source", async () => {
    const { journal, tracker, markets } = setup({});
    const calls = [];
    markets.getHistory.mockImplementation(async (id, tf, opts) => {
      calls.push({ id, source: opts && opts.source });
      if (id === "SPX") return { type: "ohlc", bars: [bar("2026-09-02", 0, 0, 0, 5000), bar("2026-09-07", 1, 1, 1, 1)] };
      if (opts && opts.source && opts.source.tokenId === "tok1") return { type: "line", points: [{ t: T("2026-09-02"), v: 0.40 }, { t: T("2026-09-07"), v: 0.41 }] };
      throw new Error("not in snapshot");
    });
    const e = journal.logIdea({ ...IDEA, id: "IDEA-pm", marketId: "PM-fed-cut", marketHistory: { provider: "polymarket", tokenId: "tok1" },
      entryLow: 0.39, entryHigh: 0.41, target: 0.6, stop: 0.3 });
    const doc = await tracker.updateAll();
    expect(calls.find(c => c.id === "PM-fed-cut").source).toEqual({ provider: "polymarket", tokenId: "tok1" });
    expect(doc.entries[e.entryId].status).toBe("open");
  });

  test("no instrument or no history → says so, never invents a result", async () => {
    const { journal, tracker } = setup({});
    const a = journal.logIdea({ ...IDEA, id: "IDEA-nomkt", marketId: null });
    const b = journal.logIdea({ ...IDEA, id: "IDEA-nohist", marketId: "NOPE" });
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const doc = await tracker.updateAll();
    expect(doc.entries[a.entryId]).toMatchObject({ status: "not_trackable" });
    expect(doc.entries[b.entryId]).toMatchObject({ status: "waiting", lastError: expect.stringMatching(/unavailable/) });
  });

  test("every Markets refresh path goes through the one helper that re-scores the Journal", () => {
    const fs = require("fs"), path = require("path");
    const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    expect(read("server/jobs/refreshMarkets.js")).toMatch(/await require\("\.\.\/journal\/tracker"\)\.updateAll\(\)/);
    for (const f of ["server/routes/markets.js", "server/jobs/marketsScheduler.js"]) {
      expect(read(f)).not.toMatch(/markets\.refresh\(/);                 // no bypass
      expect(read(f)).toMatch(/refreshMarkets\(/);
    }
  });

  test("refreshMarkets refreshes, then re-scores (awaited), and survives a tracking failure", async () => {
    jest.resetModules();
    const markets = require("../server/markets/service");
    const tracker = require("../server/journal/tracker");
    const order = [];
    jest.spyOn(markets, "refresh").mockImplementation(async () => { order.push("refresh"); return { ok: 1 }; });
    jest.spyOn(tracker, "updateAll").mockImplementation(async () => { order.push("track"); throw new Error("boom"); });
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const snap = await require("../server/jobs/refreshMarkets").refreshMarkets("startup");
    expect(snap).toEqual({ ok: 1 });
    expect(order).toEqual(["refresh", "track"]);
  });
});
