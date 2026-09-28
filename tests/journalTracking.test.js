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
    const filled = advance({}, p, [bar("2026-09-02", 100, 101, 99.5, 100), bar("2026-10-13", 103, 104, 102, 103)]);
    expect(filled).toMatchObject({ status: "expired", exitPrice: 103, R: 0.6 });
    const never = advance({}, p, [bar("2026-09-02", 104, 105, 103, 104), bar("2026-10-14", 104, 105, 103, 104)]);
    expect(never.status).toBe("never_entered");
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
      if (id === "SPX") return { type: "ohlc", bars: [bar("2026-09-02", 0, 0, 0, 5000), bar("2026-09-04", 0, 0, 0, 5100)] };
      if (history[id]) return history[id];
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

  test("no instrument or no history → says so, never invents a result", async () => {
    const { journal, tracker } = setup({});
    const a = journal.logIdea({ ...IDEA, id: "IDEA-nomkt", marketId: null });
    const b = journal.logIdea({ ...IDEA, id: "IDEA-nohist", marketId: "NOPE" });
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const doc = await tracker.updateAll();
    expect(doc.entries[a.entryId]).toMatchObject({ status: "not_trackable" });
    expect(doc.entries[b.entryId]).toMatchObject({ status: "waiting", lastError: expect.stringMatching(/unavailable/) });
  });

  test("the tracker runs after a manual Markets refresh", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "../server/routes/markets.js"), "utf8");
    expect(src).toMatch(/journal\/tracker"\)\.updateAll\(\)/);
    const sched = require("fs").readFileSync(require("path").join(__dirname, "../server/jobs/marketsScheduler.js"), "utf8");
    expect(sched).toMatch(/journal\/tracker"\)\.updateAll\(\)/);
  });
});
