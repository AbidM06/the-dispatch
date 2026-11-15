/**
 * tests/newsCard.test.js — WO-03 acceptance tests, written by the overseer BEFORE the build.
 * Black-box through the routes; the two model calls are mocked.
 *
 * THE CONTRACT THESE TESTS PIN (see docs/WORK_ORDERS.md, WO-03):
 *
 *  Routes   POST /api/news/card { headlineId } | { top: true }  → 200 { card }
 *           GET  /api/news/cards                                 → 200 { cards }   (newest first)
 *           GET  /api/news/cards/:id                             → 200 { card }
 *           no route edits or deletes a card.
 *  Calls    writer  = callAgent("newscard",  system, user, opts) → JSON text
 *           gate B  = callAgent("newscheck", system, user, opts) → JSON text
 *  Writer   { whatHappened[], whyItMatters[], sentiment[], whatWouldChangeIt[] },
 *           each sentence { text, basedOn: [ids] }.
 *  Gate B   prompt lists each surviving sentence as a block starting "[S<n>] <sentence text>",
 *           followed by the text of ITS OWN cited evidence only.
 *           reply { verdicts: [{ id: "S<n>", verdict: "SUPPORTS"|"PARTLY"|"NO", recommendation: bool, reason }] }
 *  Card     { id, headline: { text, source, url, publishedAt },
 *             whatHappened[], whyItMatters[], sentiment[], whatWouldChangeIt[]   — sentences
 *               { text, basedOn: [{ ref, label, url, publisher, ... }], tags: [] , checkReason? },
 *             whatMoved[], whatToWatch[],
 *             removed: { total, byReason: { <reason>: n } },     — counts only, never the text
 *             check: { status: "checked" | "not_checked", reason? },
 *             noExplanation: bool, receipt, hash, generatedAt }
 *  Reasons  no_evidence | unknown_source | figure_not_in_evidence | sentiment_needs_measured_input
 *           | not_supported | recommendation | search_evidence_unavailable
 *  Tags     stale | partly_supported | not_checked
 *  Retry    gate B is retried ONCE on a temporary error (429/529/5xx/timeout), after
 *           NEWS_CHECK_RETRY_MS milliseconds (default about 60 s; the tests set 0).
 *
 * Left for the builder to add (they need the transport or the search-response shape):
 * both calls on the receipt, W# search passages (spec tests 11), and the no-scheduler guard (13).
 */
"use strict";

const request = require("supertest");

const mockHeadlines = [
  { id: 101, headline: "Oil jumps as Hormuz traffic stalls", summary: "Brent up 3.5% to 100.5", source: "Reuters", url: "https://example.com/oil", datetime: "2026-09-28T08:00:00.000Z" },
  { id: 102, headline: "Gold slides as yields climb", summary: "", source: "CNBC", url: "https://example.com/gold", datetime: "2026-09-28T07:00:00.000Z" },
];

const q = (value, changePct, over = {}) => ({
  value, changePct, change: null, asOf: "2026-09-28T08:50:00.000Z", releasedAt: "2026-09-28T08:50:00.000Z",
  source: "Yahoo Finance", sourceUrl: "https://finance.yahoo.com/quote/X", ...over,
});
const SNAPSHOT = {
  generatedAt: "2026-09-28T09:00:00.000Z",
  items: [
    { id: "BRENT", label: "Brent crude", group: "commodities", ok: true, unit: null, quote: q(100.5, 3.5), freshness: { label: "Delayed ~10 min" } },
    { id: "GOLD", label: "Gold", group: "commodities", ok: true, unit: null, stale: true, staleSince: "2026-09-25T20:00:00.000Z", quote: q(2600, -0.4), freshness: { label: "Last trade" } },
    { id: "PM-FEDCUT", label: "Fed cuts in December?", group: "predictions", ok: true, unit: "%",
      quote: q(62, null, { source: "Polymarket", sourceUrl: "https://polymarket.com/event/fed-cut" }), freshness: { label: "Delayed ~10 min" } },
  ],
};

const S = (text, ...basedOn) => ({ text, basedOn });
function writerReply(over = {}) {
  return {
    whatHappened: [S("Tanker traffic through Hormuz stalled and oil rose.", "N1")],
    whyItMatters: [S("Brent is up 3.5% at 100.5, the largest move in commodities.", "M:BRENT", "N1")],
    sentiment: [],
    whatWouldChangeIt: [S("A resumption of tanker traffic would reverse the move.", "N1")],
    ...over,
  };
}

/** Default gate B: every listed sentence SUPPORTS; `overrides` maps a text fragment to a verdict. */
function checker(overrides = {}) {
  return (user) => {
    const verdicts = [];
    for (const m of String(user).matchAll(/\[(S\d+)\]\s*([^\n]*)/g)) {
      const hit = Object.keys(overrides).find((frag) => m[2].includes(frag));
      verdicts.push({ id: m[1], verdict: "SUPPORTS", recommendation: false, reason: "evidence states it", ...(hit ? overrides[hit] : {}) });
    }
    return JSON.stringify({ verdicts });
  };
}

const asText = (u) => typeof u === "string" ? u
  : Array.isArray(u) ? u.map((b) => (typeof b === "string" ? b : b.text || "")).join("\n") : JSON.stringify(u);

let callAgent, seen;
function setup({ writer = writerReply(), check = checker(), env = {} } = {}) {
  jest.resetModules();
  Object.assign(process.env, { NEWS_CHECK_RETRY_MS: "0" }, env);
  global.fetch = jest.fn(async () => { throw new Error("no network in tests"); });
  jest.mock("../server/providers/anthropic", () => ({ fetchAllAnalysis: jest.fn(), fetchTickerExplain: jest.fn(), callClaude: jest.fn() }));
  jest.mock("../server/research/llm", () => ({
    callAgent: jest.fn(),
    modelForRole: () => "test-model",
    newUsageTracker: () => ({ calls: 0, inputTokens: 0, outputTokens: 0, byRole: {} }),
  }));
  jest.mock("../server/providers/finnhub", () => ({
    getMarketNews: jest.fn(async () => mockHeadlines), getCompanyNews: jest.fn(async () => []),
    getEarningsCalendar: jest.fn(async () => []), getEconomicCalendar: jest.fn(async () => []),
    getNewsSentiment: jest.fn(async () => null), isConfigured: () => true, TTL_NEWS_MS: 60000, TTL_CALENDAR_MS: 60000,
  }));
  const markets = require("../server/markets/service");
  jest.spyOn(markets, "getSnapshot").mockReturnValue(SNAPSHOT);
  seen = { newscard: [], newscheck: [] };
  callAgent = require("../server/research/llm").callAgent;
  callAgent.mockImplementation(async (role, system, user) => {
    (seen[role] = seen[role] || []).push({ system, user: asText(user) });
    if (role === "newscard") {
      if (typeof writer === "function") return writer();
      return "Here is the card:\n" + JSON.stringify(writer);
    }
    if (role === "newscheck") return check(seen.newscheck[seen.newscheck.length - 1].user);
    throw new Error("unexpected role " + role);
  });
  return require("../server/index");
}

const make = (app, body = { headlineId: 101 }) => request(app).post("/api/news/card").send(body);
const texts = (arr) => (arr || []).map((s) => s.text);
const allText = (card) => JSON.stringify(card);

afterEach(() => { delete process.env.LOW_COST_MODE; delete process.env.NEWS_CHECK_RETRY_MS; });

describe("WO-03 news card — the happy path", () => {
  test("a card is built, stored and readable; evidence resolves to real inputs", async () => {
    const app = setup();
    const res = await make(app);
    expect(res.status).toBe(200);
    const c = res.body.card;
    expect(c.id).toBeTruthy();
    expect(c.headline.text).toBe(mockHeadlines[0].headline);
    expect(c.headline.url).toBe(mockHeadlines[0].url);
    expect(texts(c.whyItMatters)).toEqual(["Brent is up 3.5% at 100.5, the largest move in commodities."]);
    const refs = c.whyItMatters[0].basedOn.map((b) => b.ref);
    expect(refs).toEqual(expect.arrayContaining(["M:BRENT", "N1"]));
    expect(c.whyItMatters[0].basedOn.find((b) => b.ref === "N1").url).toBe(mockHeadlines[0].url);
    expect(c.check.status).toBe("checked");
    expect(c.removed.total).toBe(0);
    expect(c.noExplanation).toBe(false);
    expect(c.hash).toBeTruthy();

    const list = await request(app).get("/api/news/cards");
    expect(list.status).toBe(200);
    expect(list.body.cards.map((x) => x.id)).toEqual([c.id]);
    const one = await request(app).get(`/api/news/cards/${c.id}`);
    expect(one.status).toBe(200);
    expect(one.body.card.id).toBe(c.id);
  });

  test("What moved is built by code from the snapshot, with source and STALE flag", async () => {
    const app = setup();
    const c = (await make(app)).body.card;
    const brent = c.whatMoved.find((r) => r.id === "BRENT");
    expect(brent).toBeTruthy();
    expect(brent.source).toBe("Yahoo Finance");
    const gold = c.whatMoved.find((r) => r.id === "GOLD");
    if (gold) expect(gold.stale).toBe(true);
    expect(Array.isArray(c.whatToWatch)).toBe(true);
  });

  test("a sentence citing a STALE input is kept and tagged stale", async () => {
    const app = setup({ writer: writerReply({ whyItMatters: [S("Gold is lower alongside the oil move.", "M:GOLD", "N2")] }) });
    const c = (await make(app)).body.card;
    expect(c.whyItMatters).toHaveLength(1);
    expect(c.whyItMatters[0].tags).toContain("stale");
  });
});

describe("WO-03 gate A — cite or drop, in code", () => {
  test("1. a sentence with no evidence is removed and counted", async () => {
    const app = setup({ writer: writerReply({ whyItMatters: [
      S("Brent is up 3.5% at 100.5, the largest move in commodities.", "M:BRENT"),
      S("Markets always overreact to supply shocks."),
    ] }) });
    const c = (await make(app)).body.card;
    expect(texts(c.whyItMatters)).toEqual(["Brent is up 3.5% at 100.5, the largest move in commodities."]);
    expect(c.removed.byReason.no_evidence).toBe(1);
    expect(allText(c)).not.toContain("always overreact");
  });

  test("2. a sentence citing an id that is not in the registry is removed", async () => {
    const app = setup({ writer: writerReply({ whyItMatters: [S("Refiners will pass the cost on within weeks.", "N99")] }) });
    const c = (await make(app)).body.card;
    expect(c.whyItMatters).toHaveLength(0);
    expect(c.removed.byReason.unknown_source).toBe(1);
    expect(allText(c)).not.toContain("Refiners will pass");
  });

  test("3. a figure that is in none of the cited inputs removes the sentence; the right figure survives", async () => {
    const app = setup({ writer: writerReply({ whyItMatters: [
      S("Brent is up 7.2% on the day.", "M:BRENT"),
      S("Brent is up 3.5% on the day.", "M:BRENT"),
    ] }) });
    const c = (await make(app)).body.card;
    expect(texts(c.whyItMatters)).toEqual(["Brent is up 3.5% on the day."]);
    expect(c.removed.byReason.figure_not_in_evidence).toBe(1);
    expect(allText(c)).not.toContain("7.2");
  });

  test("4. sentiment must cite a measured input: a headline alone is not enough, a prediction market is", async () => {
    const app = setup({ writer: writerReply({ sentiment: [
      S("Traders sound nervous about supply.", "N1"),
      S("Prediction markets put a December Fed cut at 62%.", "M:PM-FEDCUT"),
    ] }) });
    const c = (await make(app)).body.card;
    expect(texts(c.sentiment)).toEqual(["Prediction markets put a December Fed cut at 62%."]);
    expect(c.removed.byReason.sentiment_needs_measured_input).toBe(1);
  });

  test("the writer cannot smuggle in a URL: evidence links come only from the registry", async () => {
    const app = setup({ writer: writerReply({ whyItMatters: [
      { text: "Brent is up 3.5% on the day.", basedOn: ["M:BRENT"], url: "https://evil.example/fake", sources: [{ url: "https://evil.example/fake" }] },
    ] }) });
    const c = (await make(app)).body.card;
    expect(c.whyItMatters).toHaveLength(1);
    expect(allText(c)).not.toContain("evil.example");
  });
});

describe("WO-03 gate B — does the evidence support the sentence?", () => {
  test("5. NO → removed; recommendation → removed; PARTLY → kept with a tag and the reason", async () => {
    const app = setup({
      writer: writerReply({
        whyItMatters: [
          S("Brent is up 3.5% at 100.5, the largest move in commodities.", "M:BRENT"),
          S("Higher crude feeds straight into headline inflation.", "N1"),
          S("This is a good moment to buy Brent.", "M:BRENT"),
        ],
        whatWouldChangeIt: [S("A resumption of tanker traffic would reverse the move.", "N1")],
      }),
      check: checker({
        "feeds straight into headline inflation": { verdict: "NO", reason: "the headline says nothing about inflation" },
        "good moment to buy": { verdict: "SUPPORTS", recommendation: true, reason: "this is advice" },
        "resumption of tanker traffic": { verdict: "PARTLY", reason: "the headline covers the stall, not a reversal" },
      }),
    });
    const c = (await make(app)).body.card;
    expect(texts(c.whyItMatters)).toEqual(["Brent is up 3.5% at 100.5, the largest move in commodities."]);
    expect(c.removed.byReason.not_supported).toBe(1);
    expect(c.removed.byReason.recommendation).toBe(1);
    expect(c.whatWouldChangeIt[0].tags).toContain("partly_supported");
    expect(c.whatWouldChangeIt[0].checkReason).toMatch(/reversal/);
    expect(allText(c)).not.toContain("good moment to buy");
    expect(c.check.status).toBe("checked");
  });

  test("6. gate B sees each sentence with ITS OWN evidence only — never an uncited headline or the removed text", async () => {
    const app = setup({ writer: writerReply({
      whatHappened: [S("Tanker traffic through Hormuz stalled and oil rose.", "N1")],
      whyItMatters: [S("Brent is up 3.5% on the day.", "M:BRENT"), S("Nothing supports this one.")],
      whatWouldChangeIt: [],
    }) });
    await make(app);
    expect(seen.newscheck).toHaveLength(1);
    const prompt = seen.newscheck[0].user + "\n" + seen.newscheck[0].system;
    expect(prompt).toContain("Tanker traffic through Hormuz stalled");
    expect(prompt).toContain(mockHeadlines[0].headline);          // cited evidence is shown
    expect(prompt).not.toContain(mockHeadlines[1].headline);      // an uncited headline is not
    expect(prompt).not.toContain("Nothing supports this one"); // gate A already dropped it
  });

  test("12. a whatHappened sentence is checked too: a false account or a recommendation there is removed", async () => {
    const app = setup({
      writer: writerReply({ whatHappened: [
        S("Tanker traffic through Hormuz stalled and oil rose.", "N1"),
        S("Oil fell after traffic resumed.", "N1"),
        S("Investors should sell airlines on this.", "N1"),
      ] }),
      check: checker({
        "Oil fell after traffic resumed": { verdict: "NO", reason: "the headline says oil jumped" },
        "should sell airlines": { verdict: "SUPPORTS", recommendation: true, reason: "advice" },
      }),
    });
    const c = (await make(app)).body.card;
    expect(texts(c.whatHappened)).toEqual(["Tanker traffic through Hormuz stalled and oil rose."]);
    expect(c.removed.byReason.not_supported).toBe(1);
    expect(c.removed.byReason.recommendation).toBe(1);
  });

  test("a sentence gate B returned no verdict for is tagged not_checked, never shown as checked", async () => {
    const app = setup({ check: () => JSON.stringify({ verdicts: [] }) });
    const c = (await make(app)).body.card;
    for (const s of [...c.whatHappened, ...c.whyItMatters, ...c.whatWouldChangeIt]) expect(s.tags).toContain("not_checked");
    expect(c.check.status).toBe("not_checked");
  });

  test("7. gate B failing twice (one retry) → the card is stored, every sentence NOT CHECKED, with the reason", async () => {
    const app = setup({ check: () => { const e = new Error("Overloaded"); e.status = 529; throw e; } });
    const res = await make(app);
    expect(res.status).toBe(200);
    const c = res.body.card;
    expect(seen.newscheck).toHaveLength(2);                    // the call and its single retry
    expect(c.check.status).toBe("not_checked");
    expect(c.check.reason).toBeTruthy();
    expect(c.whyItMatters.length).toBeGreaterThan(0);
    for (const s of [...c.whatHappened, ...c.whyItMatters, ...c.whatWouldChangeIt]) expect(s.tags).toContain("not_checked");
    expect((await request(app).get("/api/news/cards")).body.cards).toHaveLength(1);
  });
});

describe("WO-03 failure and storage rules", () => {
  test("8a. writer failure → 503 available:false with the reason; nothing stored; gate B never called", async () => {
    const app = setup({ writer: () => { throw new Error("SONNET_UNAVAILABLE: model overloaded"); } });
    const res = await make(app);
    expect(res.status).toBe(503);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toBeTruthy();
    expect(seen.newscheck).toHaveLength(0);
    expect((await request(app).get("/api/news/cards")).body.cards).toEqual([]);
  });

  test("8b. AI off (LOW_COST_MODE) → 503 available:false; no model call; nothing stored", async () => {
    const app = setup({ env: { LOW_COST_MODE: "true" } });
    const res = await make(app);
    expect(res.status).toBe(503);
    expect(res.body.available).toBe(false);
    expect(callAgent).not.toHaveBeenCalled();
    expect((await request(app).get("/api/news/cards")).body.cards).toEqual([]);
  });

  test("8c. a writer reply that is not the expected JSON → 503, nothing stored", async () => {
    const app = setup({ writer: () => "I could not find anything useful today." });
    const res = await make(app);
    expect(res.status).toBe(503);
    expect(res.body.available).toBe(false);
    expect((await request(app).get("/api/news/cards")).body.cards).toEqual([]);
  });

  test("an unknown headline id → 404, no model call", async () => {
    const app = setup();
    const res = await make(app, { headlineId: 999999 });
    expect(res.status).toBe(404);
    expect(callAgent).not.toHaveBeenCalled();
  });

  test("9. no whyItMatters survives → the card says so and still has What moved and What to watch", async () => {
    const app = setup({ writer: writerReply({ whyItMatters: [S("It simply matters a lot.")] }) });
    const res = await make(app);
    expect(res.status).toBe(200);
    const c = res.body.card;
    expect(c.whyItMatters).toEqual([]);
    expect(c.noExplanation).toBe(true);
    expect(c.whatMoved.length).toBeGreaterThan(0);
    expect(Array.isArray(c.whatToWatch)).toBe(true);
  });

  test("10. cards are append-only: newest first, and no route edits or deletes one", async () => {
    const app = setup();
    const a = (await make(app, { headlineId: 101 })).body.card;
    const b = (await make(app, { headlineId: 102 })).body.card;
    expect(a.id).not.toBe(b.id);
    const list = (await request(app).get("/api/news/cards")).body.cards;
    expect(list.map((x) => x.id)).toEqual([b.id, a.id]);
    for (const method of ["delete", "put", "patch"]) {
      const r = await request(app)[method](`/api/news/cards/${a.id}`).send({ whyItMatters: [] });
      expect(r.status).toBe(404);
    }
    expect((await request(app).get(`/api/news/cards/${a.id}`)).body.card.hash).toBe(a.hash);
  });

  test("removed sentences are counted on the card but their text is never served", async () => {
    const app = setup({ writer: writerReply({ whyItMatters: [
      S("Brent is up 3.5% on the day.", "M:BRENT"),
      S("SECRET-REMOVED-SENTENCE with no evidence."),
    ] }) });
    const c = (await make(app)).body.card;
    expect(c.removed.total).toBe(1);
    const served = allText(c) + JSON.stringify((await request(app).get("/api/news/cards")).body);
    expect(served).not.toContain("SECRET-REMOVED-SENTENCE");
  });

  test("the top-story button: the writer's selection must be a real headline, else 503", async () => {
    const good = setup({ writer: { ...writerReply(), selection: { ref: "N1", reason: "It explains the oil move.", basedOn: ["N1", "M:BRENT"] } } });
    const ok = await make(good, { top: true });
    expect(ok.status).toBe(200);
    expect(ok.body.card.headline.text).toBe(mockHeadlines[0].headline);

    const bad = setup({ writer: { ...writerReply(), selection: { ref: "N42", reason: "made up", basedOn: [] } } });
    const res = await make(bad, { top: true });
    expect(res.status).toBe(503);
    expect(res.body.available).toBe(false);
  });
});
