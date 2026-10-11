/**
 * tests/umushroom.test.js — the Journal tab's UMushroom view source (D-23).
 * Display-only: validated files in, labelled arithmetic out, "unavailable" on any
 * problem. fetch is mocked by URL; nothing touches the network.
 */
"use strict";

const BASE = "https://raw.githubusercontent.com/owner/dispatch-umushroom/main";

const portfolio = () => ({
  schemaVersion: 1, name: "Test", label: "Paper portfolio. Not advice.",
  window: { start: "2026-10-12", end: "2026-12-07" },
  constraints: { maxSevereTailLossPct: 18 }, maxChangesPerWeek: 2,
  positions: [
    { ticker: "AAA", name: "Alpha", bucket: "X", view: "Overweight", weightPct: 60, targetUSD: 110, reviewLevelUSD: 90, thesisBreakers: ["b1"] },
    { ticker: "BBB", name: "Beta", bucket: "Y", view: "Hedge", weightPct: 30, targetUSD: 55, reviewLevelUSD: 45, entry: { price: 50 } },
  ],
  cash: [{ id: "C", weightPct: 10 }],
  triggers: [
    { id: "HY", name: "HY spread", direction: "above", level: 3.75, unit: "%", source: "FRED" },
    { id: "FED", name: "Fed hike", direction: "delivered", level: null, unit: "event", source: "Fed" },
  ],
  drawdownLadder: [{ atPct: -6, action: "review" }],
  calendar: [["2026-10-01", "past", "x"], ["2026-10-15", "TSMC", "Confirmed"], ["2026-10-25", "Runoff", "Confirmed"]],
});
const status = (over = {}) => ({
  schemaVersion: 1, asOf: "2026-10-13", verdict: "HOLD", verdictReason: "quiet", navGBP: 101000, returnPct: 1.0,
  benchmarkReturnPct: 0.6, alphaPct: 0.4, drawdownFromPeakPct: -0.5, changesThisWeek: 0,
  positions: { AAA: { price: 100, asOf: "2026-10-13", source: "t", status: "ok", thesis: "intact" },
               BBB: { price: 52, asOf: "2026-10-13", source: "t", status: "ok", thesis: "watch", thesisNote: "n" } },
  triggers: { HY: { reading: 3.2, asOf: "2026-10-12", fired: false }, FED: { reading: "n/a", asOf: "2026-10-12", fired: false } },
  unverified: ["Brent"], ...over,
});
const index = () => [{ date: "2026-10-12", title: "Day 1", verdict: "HOLD", kind: "note", file: "notes/2026-10-12.md", summary: "s" },
                     { date: "2026-10-13", title: "Day 2", verdict: "HOLD", kind: "note", file: "notes/2026-10-13.md", summary: "s" }];

function mockRepo(files) {
  const calls = [];
  global.fetch = jest.fn(async (url) => {
    calls.push(url);
    const rel = url.replace(BASE + "/", "");
    if (!(rel in files)) return { ok: false, status: 404, text: async () => "404" };
    const f = files[rel];
    if (f instanceof Error) throw f;
    return { ok: true, status: 200, text: async () => (typeof f === "string" ? f : JSON.stringify(f)) };
  });
  return calls;
}
const goodFiles = (over = {}) => ({
  "portfolio.json": portfolio(), "status.json": status(), "notes/index.json": index(),
  "notes/2026-10-12.md": "# Day 1", "notes/2026-10-13.md": "# Day 2\nbody",
  "journal/decisions.jsonl": JSON.stringify({ id: "D-001", date: "2026-10-10", title: "t" }) + "\n",
  "journal/challenges.jsonl": "", "journal/reflections.json": "[]", ...over,
});
const NOW = new Date("2026-10-14T08:00:00Z");

describe("umushroom source", () => {
  let src;
  beforeEach(() => { jest.resetModules(); process.env.UMUSHROOM_RAW_BASE = BASE; src = require("../server/umushroom/source"); src._reset(); });
  afterEach(() => { delete process.env.UMUSHROOM_RAW_BASE; jest.restoreAllMocks(); });

  test("not configured → says so, fetches nothing", async () => {
    delete process.env.UMUSHROOM_RAW_BASE; global.fetch = jest.fn();
    expect(await src.load(NOW)).toEqual({ configured: false });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test.each(["http://raw.githubusercontent.com/o/r/main", "https://evil.example.com/o/r/main", "https://169.254.169.254/x", "nonsense"])(
    "refuses base URL %s", async (bad) => {
      process.env.UMUSHROOM_RAW_BASE = bad; global.fetch = jest.fn();
      const out = await src.load(NOW);
      expect(out.error).toMatch(/UMUSHROOM_RAW_BASE/);
      expect(global.fetch).not.toHaveBeenCalled();
    });

  test("happy path: summary, positions, arithmetic, latest note, upcoming events", async () => {
    mockRepo(goodFiles());
    const out = await src.load(NOW);
    expect(out.errors).toEqual({});
    const v = out.view;
    expect(v.verdict).toBe("HOLD");
    expect(v.dayNumber).toBe(3);            // 12 Oct = Day 1, so 14 Oct = Day 3
    expect(v.totalDays).toBe(57);           // 12 Oct … 7 Dec inclusive
    expect(v.ageDays).toBe(1);
    expect(v.warnings).toEqual([]);
    const a = v.positions.find((p) => p.ticker === "AAA");
    expect(a.toTargetPct).toBe(10);          // 110/100
    expect(a.toReviewPct).toBe(-10);         // 90/100
    expect(a.level).toBeNull();
    const b = v.positions.find((p) => p.ticker === "BBB");
    expect(b.sinceEntryPct).toBe(4);         // 52/50
    expect(b.thesis).toBe("watch");
    expect(v.upcoming.map((u) => u.event)).toEqual(["TSMC", "Runoff"]); // past event dropped
    expect(out.latestNote.date).toBe("2026-10-13");
    expect(out.latestNote.markdown).toContain("Day 2");
    expect(out.decisions).toHaveLength(1);
    expect(out.challenges).toEqual([]);
  });

  test("a 404 or malformed file makes only its own section unavailable", async () => {
    const files = goodFiles({ "status.json": status({ verdict: "BUY" }) }); delete files["journal/reflections.json"];
    mockRepo(files);
    const out = await src.load(NOW);
    expect(out.errors.status).toMatch(/verdict/);
    expect(out.errors.reflections).toMatch(/not found/);
    expect(out.view).toBeUndefined();         // no summary invented without a valid status
    expect(out.reflections).toBeNull();
    expect(out.notes).toHaveLength(2);        // unrelated sections still shown
    expect(out.decisions).toHaveLength(1);
  });

  test("flags a price at or through its review level and at its target", async () => {
    const st = status(); st.positions.AAA.price = 89; st.positions.BBB.price = 56;
    mockRepo(goodFiles({ "status.json": st }));
    const v = (await src.load(NOW)).view;
    expect(v.positions.find((p) => p.ticker === "AAA").level).toBe("review level hit");
    expect(v.positions.find((p) => p.ticker === "BBB").level).toBe("target hit");
  });

  test("a position with no price is shown without numbers, never zero", async () => {
    const st = status(); delete st.positions.AAA;
    mockRepo(goodFiles({ "status.json": st }));
    const a = (await src.load(NOW)).view.positions.find((p) => p.ticker === "AAA");
    expect(a.price).toBeNull(); expect(a.toTargetPct).toBeNull(); expect(a.priceStatus).toBe("missing");
  });

  test("warns when alpha ≠ return − benchmark, when weights ≠ 100, when status is old", async () => {
    const pf = portfolio(); pf.positions[0].weightPct = 50;
    mockRepo(goodFiles({ "portfolio.json": pf, "status.json": status({ alphaPct: 2.0, asOf: "2026-10-08" }) }));
    const w = (await src.load(NOW)).view.warnings.join(" | ");
    expect(w).toMatch(/weights add to 90/); expect(w).toMatch(/alpha/i); expect(w).toMatch(/6 days ago/);
  });

  test("a trigger whose reading contradicts its fired flag is called out", async () => {
    const st = status(); st.triggers.HY = { reading: 3.9, asOf: "2026-10-13", fired: false };
    mockRepo(goodFiles({ "status.json": st }));
    const v = (await src.load(NOW)).view;
    expect(v.triggers.find((t) => t.id === "HY").mismatch).toBe(true);
    expect(v.triggers.find((t) => t.id === "FED").mismatch).toBe(false); // event triggers are the PM's call
    expect(v.warnings.join(" ")).toMatch(/HY spread/);
  });

  test("valid JSON with a malformed optional collection marks only that file unavailable", async () => {
    const pf = portfolio(); pf.triggers = {};
    mockRepo(goodFiles({ "portfolio.json": pf }));
    const out = await src.load(NOW);
    expect(out.errors.portfolio).toMatch(/triggers must be a list/);
    expect(out.view).toBeUndefined();
    expect(out.notes).toHaveLength(2); expect(out.decisions).toHaveLength(1);
    const st = status(); st.triggers = [];
    mockRepo(goodFiles({ "status.json": st })); src._reset();
    expect((await src.load(NOW)).errors.status).toMatch(/triggers must be an object/);
  });

  test("an unexpected failure while building the view is contained", async () => {
    const pf = portfolio(); pf.positions[0].thesisBreakers = 5; // not validated; map over a number would only matter if used
    mockRepo(goodFiles({ "portfolio.json": pf }));
    jest.spyOn(Array.prototype, "filter").mockImplementationOnce(() => { throw new Error("boom"); });
    const out = await src.load(NOW);
    expect(out.errors.view).toMatch(/boom/);
    expect(out.notes).toHaveLength(2);
  });

  test("malformed log and reflection entries cannot reach the client", async () => {
    mockRepo(goodFiles({
      "journal/reflections.json": [null],
      "journal/decisions.jsonl": JSON.stringify({ id: "D-1", date: "2026-10-10", title: { x: 1 }, reasoning: "ok", unverified: ["a", 5] }) + "\n",
    }));
    const out = await src.load(NOW);
    expect(out.errors.reflections).toMatch(/missing its text/);
    expect(out.reflections).toBeNull();
    expect(out.decisions[0].title).toBeUndefined();      // object where text is expected: dropped
    expect(out.decisions[0].reasoning).toBe("ok");
    expect(out.decisions[0].unverified).toEqual(["a"]);
  });

  test("jsonl: bad lines are counted, not hidden", async () => {
    mockRepo(goodFiles({ "journal/decisions.jsonl": '{"id":"D-1","date":"2026-10-10"}\nnot json\n{"no":"id"}\n' }));
    const out = await src.load(NOW);
    expect(out.decisions).toHaveLength(1); expect(out.badLines.decisions).toBe(2);
  });

  test("network failure after a good load serves the last good copy flagged stale", async () => {
    mockRepo(goodFiles());
    await src.load(NOW);
    const realNow = Date.now;
    jest.spyOn(Date, "now").mockImplementation(() => realNow() + 10 * 60 * 1000); // past the 5-minute cache
    global.fetch = jest.fn(async () => { throw new Error("offline"); });
    const out = await src.load(NOW);
    expect(out.stale).toBe(true); expect(out.errors).toEqual({}); expect(out.view.verdict).toBe("HOLD");
  });

  test("network failure with nothing cached → every section unavailable, nothing invented", async () => {
    global.fetch = jest.fn(async () => { throw new Error("offline"); });
    const out = await src.load(NOW);
    expect(Object.keys(out.errors)).toEqual(expect.arrayContaining(["portfolio", "status", "notes", "decisions"]));
    expect(out.view).toBeUndefined(); expect(out.latestNote).toBeNull();
  });

  test("a note path comes only from the index; bad or unknown dates are rejected", async () => {
    const calls = mockRepo(goodFiles());
    const n = await src.loadNote("2026-10-12");
    expect(n.markdown).toBe("# Day 1");
    await expect(src.loadNote("../../etc/passwd")).rejects.toMatchObject({ status: 400 });
    await expect(src.loadNote("2026-01-01")).rejects.toMatchObject({ status: 404 });
    expect(calls.every((u) => u.startsWith(BASE + "/"))).toBe(true);
  });

  test("an index entry that points outside notes/ is rejected", async () => {
    mockRepo(goodFiles({ "notes/index.json": [{ date: "2026-10-12", title: "x", verdict: "HOLD", file: "../secrets.md" }] }));
    const out = await src.load(NOW);
    expect(out.errors.notes).toMatch(/bad date, file or verdict/);
  });
});

describe("umushroom routes", () => {
  const request = require("supertest");
  let app;
  beforeEach(() => { jest.resetModules(); process.env.UMUSHROOM_RAW_BASE = BASE; mockRepo(goodFiles()); app = require("../server/index"); });
  afterEach(() => { delete process.env.UMUSHROOM_RAW_BASE; });

  test("GET /api/umushroom and /note/:date", async () => {
    const r = await request(app).get("/api/umushroom");
    expect(r.status).toBe(200); expect(r.body.view.verdict).toBe("HOLD");
    const n = await request(app).get("/api/umushroom/note/2026-10-13");
    expect(n.body.markdown).toContain("Day 2");
    expect((await request(app).get("/api/umushroom/note/bad")).status).toBe(400);
  });

  test("there are no write routes", async () => {
    for (const m of ["post", "put", "patch", "delete"]) expect((await request(app)[m]("/api/umushroom")).status).toBe(404);
  });

  test("decision outcome objects are preserved (scalar fields only)", () => {
    const { items } = require("../server/umushroom/source").parseJsonl(JSON.stringify({ id: "D-9", date: "2026-10-12", outcome: { result: "right", pct: 2.1, nested: { x: 1 } } }));
    expect(items[0].outcome).toEqual({ result: "right", pct: 2.1 });
  });
});
