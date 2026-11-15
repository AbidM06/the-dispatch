/**
 * tests/newsCardTransport.test.js — WO-03 tests the builder adds (spec tests 10, 11, 13 + the
 * top-story rule). Unlike tests/newsCard.test.js, `callAgent` is REAL here: only global.fetch is
 * mocked, with Messages-API-shaped replies, so the calls go through claudeTransport, are priced
 * and land on the card's receipt, and the web-search citations arrive in the API's own shape
 * (web_search_tool_result blocks + text blocks whose `citations` carry `cited_text`).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const request = require("supertest");

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
let mockHeadlines;

const SNAPSHOT = {
  generatedAt: iso(NOW - 600_000),
  items: [
    { id: "BRENT", label: "Brent crude", group: "commodities", ok: true, unit: null, freshness: { label: "Delayed ~10 min" },
      quote: { value: 100.5, changePct: 3.5, change: null, asOf: iso(NOW - 600_000), releasedAt: iso(NOW - 600_000), source: "Yahoo Finance", sourceUrl: "https://finance.yahoo.com/quote/BZ=F" } },
    { id: "US10Y", label: "US 10Y yield", group: "rates", ok: true, unit: "%", freshness: { label: "Delayed ~15 min" },
      quote: { value: 4.31, changePct: 1.2, change: 0.053, asOf: iso(NOW - 600_000), releasedAt: iso(NOW - 600_000), source: "Yahoo Finance", sourceUrl: "https://finance.yahoo.com/quote/%5ETNX" } },
  ],
};

const SEARCH_URL = "https://example.org/refining";
/** A writer reply: JSON split over text blocks, one of them cited by web search, as the API returns it. */
function writerMessage({ cited = "Refinery margins hit 32 dollars a barrel this week", passage = "Refinery margins hit 32 dollars a barrel this week, the most since 2022.", extra = {} } = {}) {
  const head = JSON.stringify({ whatHappened: [{ text: "Tanker traffic through Hormuz stalled and oil rose.", basedOn: ["N1"] }], ...extra }).slice(0, -1);
  const citation = { type: "web_search_result_location", url: SEARCH_URL, title: "Refining margins", encrypted_index: "Eo8B..." };
  if (passage !== null) citation.cited_text = passage;   // null = the API returned no passage
  return {
    model: "claude-sonnet-5-5", stop_reason: "end_turn",
    usage: { input_tokens: 20_000, output_tokens: 1_500, server_tool_use: { web_search_requests: 2 } },
    content: [
      { type: "text", text: "I'll search for refining margins." },
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "refining margins" } },
      { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [
        { type: "web_search_result", url: SEARCH_URL, title: "Refining margins", encrypted_content: "EqgfCio...", page_age: "2 days ago" }] },
      { type: "text", text: head + ',"whyItMatters":[{"text":"' },
      { type: "text", text: cited, citations: [citation] },
      { type: "text", text: '.","basedOn":[]},{"text":"Brent is up 3.5% at 100.5.","basedOn":["M:BRENT"]}],"sentiment":[],"whatWouldChangeIt":[]}' },
    ],
  };
}
function checkerMessage(userText) {
  const verdicts = [...userText.matchAll(/\[(S\d+)\]/g)].map(m => ({ id: m[1], verdict: "SUPPORTS", recommendation: false, reason: "stated in the evidence" }));
  return { model: "claude-sonnet-5-5", stop_reason: "end_turn", usage: { input_tokens: 2_000, output_tokens: 300 },
    content: [{ type: "text", text: JSON.stringify({ verdicts }) }] };
}

let anthropicBodies, writerReplies;
function setup({ writers = [writerMessage()] } = {}) {
  jest.resetModules();
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.NEWS_CHECK_RETRY_MS = "0";
  delete process.env.FRED_API_KEY;
  delete process.env.LOW_COST_MODE;
  anthropicBodies = []; writerReplies = writers.slice();
  global.fetch = jest.fn(async (url, opts) => {
    if (String(url) === "https://api.anthropic.com/v1/messages") {
      const body = JSON.parse(opts.body);
      anthropicBodies.push(body);
      const user = typeof body.messages[0].content === "string" ? body.messages[0].content : body.messages[0].content.map(b => b.text).join("\n");
      const msg = body.tools ? writerReplies.shift() || writers[writers.length - 1] : checkerMessage(user);
      return { ok: true, status: 200, json: async () => msg };
    }
    throw new Error("no network in tests: " + url);
  });
  mockHeadlines = [
    { id: 101, headline: "Oil jumps as Hormuz traffic stalls", summary: "Brent up 3.5% to 100.5", source: "Reuters", url: "https://example.com/oil", datetime: iso(NOW - 3_600_000) },
    { id: 102, headline: "Refiners warn on margins", summary: "", source: "CNBC", url: "https://example.com/ref", datetime: iso(NOW - 7_200_000) },
  ];
  jest.mock("../server/providers/finnhub", () => ({
    getMarketNews: jest.fn(async () => mockHeadlines), getCompanyNews: jest.fn(async () => []),
    getEarningsCalendar: jest.fn(async () => []), getEconomicCalendar: jest.fn(async () => []),
    getNewsSentiment: jest.fn(async () => null), isConfigured: () => true, TTL_NEWS_MS: 60000, TTL_CALENDAR_MS: 60000,
  }));
  const markets = require("../server/markets/service");
  jest.spyOn(markets, "getSnapshot").mockReturnValue(SNAPSHOT);
  return require("../server/index");
}
const make = (app, body = { headlineId: 101 }) => request(app).post("/api/news/card").send(body);
const userOf = (body) => typeof body.messages[0].content === "string" ? body.messages[0].content : body.messages[0].content.map(b => b.text).join("\n");

afterEach(() => { delete process.env.NEWS_CHECK_RETRY_MS; delete process.env.ANTHROPIC_API_KEY; });

describe("10. both model calls are priced and on the stored card's receipt", () => {
  test("writer (with web search, no max_uses, Sonnet) and gate B (no search, Sonnet) both land on the receipt", async () => {
    const app = setup();
    const res = await make(app);
    expect(res.status).toBe(200);
    expect(anthropicBodies).toHaveLength(2);
    const [w, b] = anthropicBodies;
    const sonnet = require("../server/providers/models").sonnetModel();
    expect(w.model).toBe(sonnet);
    expect(b.model).toBe(sonnet);                                     // D-43: gate B on Sonnet, not Haiku
    expect(w.tools).toHaveLength(1);
    expect(w.tools[0].name).toBe("web_search");
    expect(w.tools[0]).not.toHaveProperty("max_uses");                 // D-43: search not capped
    expect(b.tools).toBeUndefined();

    const stored = (await request(app).get(`/api/news/cards/${res.body.card.id}`)).body.card;
    const r = stored.receipt;
    expect(r.calls).toBe(2);
    expect(Object.keys(r.byRole).sort()).toEqual(["newscard", "newscheck"]);
    expect(r.byRole.newscard.webSearches).toBe(2);
    expect(r.webSearches).toBe(2);
    expect(r.totalUSD).toBeGreaterThan(0);
    expect(stored.hash).toBe(res.body.card.hash);
    expect(stored.integrity).toBe("intact");
  });
});

describe("11. W# search sources — only the passage the API returned can be evidence", () => {
  test("a sentence resting only on a search citation survives when the figure is in the API's cited_text", async () => {
    const app = setup();
    const c = (await make(app)).body.card;
    const s = c.whyItMatters.find(x => /Refinery margins/.test(x.text));
    expect(s).toBeTruthy();
    const w = s.basedOn.find(x => x.ref === "W1");
    expect(w.url).toBe(SEARCH_URL);
    expect(w.kind).toBe("search");
    expect(w.publishedAt).toBe("2 days ago");
    expect(w.passage).toMatch(/32 dollars a barrel/);
    // Gate B saw the API's passage as the evidence — not the writer's sentence.
    const check = userOf(anthropicBodies[1]);
    expect(check).toContain("(W1) Refinery margins hit 32 dollars a barrel this week, the most since 2022.");
  });

  test("no passage returned for the citation → removed as search_evidence_unavailable; gate B never sees it", async () => {
    const app = setup({ writers: [writerMessage({ passage: null })] });
    const c = (await make(app)).body.card;
    expect(c.whyItMatters.map(x => x.text)).toEqual(["Brent is up 3.5% at 100.5."]);
    expect(c.removed.byReason.search_evidence_unavailable).toBe(1);
    expect(JSON.stringify(c)).not.toContain("Refinery margins hit");
    expect(userOf(anthropicBodies[1])).not.toContain("Refinery margins");
  });

  test("the passage lacks the sentence's figure → removed as figure_not_in_evidence (the writer's own text is not evidence)", async () => {
    const app = setup({ writers: [writerMessage({ passage: "Refinery margins widened sharply this week." })] });
    const c = (await make(app)).body.card;
    expect(c.removed.byReason.figure_not_in_evidence).toBe(1);
    expect(c.whyItMatters.some(x => /Refinery/.test(x.text))).toBe(false);
  });

  test("index-only cite markup (no passage) cannot support a sentence either", async () => {
    const msg = writerMessage();
    msg.content = msg.content.slice(0, 3).concat([{ type: "text", text: JSON.stringify({
      whatHappened: [{ text: "Tanker traffic through Hormuz stalled and oil rose.", basedOn: ["N1"] }],
      whyItMatters: [{ text: '(cite index="0-1">Refinery margins hit 32 dollars a barrel</cite>.', basedOn: [] }],
      sentiment: [], whatWouldChangeIt: [] }) }]);
    const app = setup({ writers: [msg] });
    const c = (await make(app)).body.card;
    expect(c.removed.byReason.search_evidence_unavailable).toBe(1);
    expect(c.noExplanation).toBe(true);
  });

  test("a rates move is offered to the writer in bp, so a bp figure can be checked", async () => {
    const app = setup();
    const c = (await make(app)).body.card;
    expect(userOf(anthropicBodies[0])).toMatch(/\[M:US10Y\][^\n]*\(\+5\.3bp\)/);
    expect(c.whatMoved.find(r => r.id === "US10Y")).toMatchObject({ move: 5.3, moveUnit: "bp" });
    expect(c.whatMoved.find(r => r.id === "BRENT")).toMatchObject({ move: 3.5, moveUnit: "%" });
  });
});

describe("top story — does not repeat the previous card's story without something new", () => {
  const top = (sel) => writerMessage({ extra: { selection: sel } });
  test("same story again with nothing newer cited → 503, nothing stored; with a newer input cited → stored", async () => {
    const app = setup({ writers: [
      top({ ref: "N1", reason: "explains the oil move", basedOn: ["N1", "M:BRENT"] }),
      top({ ref: "N1", reason: "still the story", basedOn: ["N1"], newDevelopment: null }),
      top({ ref: "N1", reason: "still the story", basedOn: ["N1"], newDevelopment: { text: "Refiners now warn on margins.", basedOn: ["N3"] } }),
    ] });
    const first = await make(app, { top: true });
    expect(first.status).toBe(200);
    expect(first.body.card.headline.text).toBe("Oil jumps as Hormuz traffic stalls");

    const again = await make(app, { top: true });
    expect(again.status).toBe(503);
    expect(again.body.available).toBe(false);
    expect(again.body.reason).toMatch(/same story as the previous card/);
    expect(userOf(anthropicBodies[anthropicBodies.length - 1])).toContain('The previous card covered: "Oil jumps as Hormuz traffic stalls"');
    expect((await request(app).get("/api/news/cards")).body.cards).toHaveLength(1);

    // A headline published AFTER the first card is new evidence.
    mockHeadlines.push({ id: 103, headline: "Refiners cut runs", summary: "", source: "Reuters", url: "https://example.com/runs", datetime: iso(Date.now() + 1000) });
    require("../server/cache").set("news:market", mockHeadlines, 60000);
    const third = await make(app, { top: true });
    expect(third.status).toBe(200);
    expect(third.body.card.selection.repeatOfPrevious).toBe(true);
    expect((await request(app).get("/api/news/cards")).body.cards).toHaveLength(2);
  });
});

describe("13. no timer, scheduler or page-load call for news cards", () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

  test("the server modules start nothing on a clock", () => {
    for (const f of ["server/news/card.js", "server/news/gates.js", "server/news/store.js", "server/inputs/registry.js", "server/routes/news.js"]) {
      const src = read(f);
      expect(src).not.toMatch(/setInterval|node-cron|cron\.schedule|require\(["']\.\.\/jobs/);
    }
    const index = read("server/index.js");
    expect(index).not.toMatch(/news\/card|newsCard/);
    // the only setTimeout is the single gate B retry pause, inside the request
    expect((read("server/news/card.js").match(/setTimeout/g) || []).length).toBe(1);
  });

  test("the client posts a card only from a button handler, never on load", () => {
    const html = read("client/index.html");
    const posts = html.match(/apiFetch\('\/api\/news\/card'/g) || [];
    expect(posts).toHaveLength(1);                                   // one place sends the POST: explainNews()
    const fn = html.slice(html.indexOf("async function explainNews("), html.indexOf("async function explainNews(") + 1500);
    expect(fn).toContain("apiFetch('/api/news/card'");
    const callers = [...html.matchAll(/explainNews\(/g)].map(m => html.slice(Math.max(0, m.index - 120), m.index));
    // every call site other than the definition is inside an onClick handler
    expect(callers.filter(c => !/async function $/.test(c)).every(c => /onClick:\s*(\(\)\s*=>|function\s*\(\)\s*\{)\s*$/.test(c))).toBe(true);
    // loading the News tab reads the stored cards only (GET), which costs nothing
    expect(html).toMatch(/apiFetch\('\/api\/news\/cards'\)/);
  });
});
