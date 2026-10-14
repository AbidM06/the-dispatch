/**
 * tests/bulletin.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Morning Bulletin (D-24): when the AI cannot produce a bulletin the route says
 * so and the reason — it never saves or serves canned "analysis" — and the
 * summary replaces the old read-aloud pitch script.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const fs      = require("fs");
const os      = require("os");
const path    = require("path");
const request = require("supertest");
const express = require("express");

const ARTICLES = [
  { headline: "Fed holds rates, signals patience", source: "Reuters", url: "https://example.com/a", datetime: 1760000000, summary: "The Fed held." },
  { headline: "Second story", source: "Bloomberg", url: "https://example.com/b", datetime: 1760000100, summary: "" },
];

const GOOD = {
  article: { headline: "Fed holds rates, signals patience", source: "Reuters", url: "https://example.com/a", publishedAt: "2026-10-14T07:00:00Z", summary: "The Fed held." },
  newsSummary: "The Fed held rates. It matters because policy-sensitive assets reprice. Concern is low. Watch CPI on Thursday.",
  analysis: { economistView: { macroRegime: "Patience" }, tradingView: { opportunities: [] }, risks: ["Hot CPI"] },
};

let logFile, callClaude, app, budget;

function load({ claude, env = {} } = {}) {
  jest.resetModules();
  Object.assign(process.env, { FINNHUB_API_KEY: "x", ANTHROPIC_API_KEY: "y", BULLETIN_LOG_PATH: logFile }, env);
  delete process.env.LOW_COST_MODE;
  if (env.LOW_COST_MODE) process.env.LOW_COST_MODE = env.LOW_COST_MODE;
  callClaude = jest.fn(claude || (async () => JSON.stringify(GOOD)));
  jest.doMock("../server/providers/finnhub", () => ({ getMarketNews: jest.fn(async () => ARTICLES) }));
  jest.doMock("../server/providers/fred", () => ({ getAllRates: jest.fn(async () => null) }));
  jest.doMock("../server/providers/eia", () => ({ getLatestPrices: jest.fn(async () => null) }));
  jest.doMock("../server/providers/yahoo", () => ({ getQuote: jest.fn(async () => { throw new Error("no"); }) }));
  jest.doMock("../server/providers/twitter", () => ({ searchTweets: jest.fn(async () => []) }));
  jest.doMock("../server/providers/twitterVerify", () => ({ verifyTweets: jest.fn(async () => []) }));
  jest.doMock("../server/providers/anthropic", () => ({ callClaude, MODEL_SONNET: "claude-sonnet-5-5" }));
  budget = require("../server/providers/budget");
  app = express();
  app.use(express.json());
  app.use("/api/bulletin", require("../server/routes/bulletin"));
}

const lines = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean) : []);

beforeEach(() => {
  logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bulletin-")), "log.jsonl");
});
afterEach(() => { delete process.env.BULLETIN_LOG_PATH; delete process.env.LOW_COST_MODE; });

describe("bulletin — AI fails → unavailable, nothing invented or saved", () => {
  test("Claude error → 503 available:false with the reason and the real headline; log untouched", async () => {
    load({ claude: async () => { throw new Error("Claude Sonnet (claude-sonnet-5-5) hit Anthropic's rate limit (error 429)"); } });
    const res = await request(app).post("/api/bulletin/refresh?force=true");
    expect(res.status).toBe(503);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toMatch(/rate limit/);
    expect(res.body.topArticle.headline).toBe("Fed holds rates, signals patience");
    expect(res.body.data).toBeUndefined();
    expect(lines()).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toMatch(/Gold|10Y UST|deterministic|Enable ANTHROPIC_API_KEY/i);
  });

  test("an unreadable reply is a failure, not a saved bulletin", async () => {
    load({ claude: async () => "Let me search first. { not json" });
    const res = await request(app).post("/api/bulletin/refresh?force=true");
    expect(res.status).toBe(503);
    expect(res.body.reason).toMatch(/not a complete bulletin/);
    expect(lines()).toHaveLength(0);
  });

  test("a reply with no summary is rejected", async () => {
    load({ claude: async () => JSON.stringify({ ...GOOD, newsSummary: "" }) });
    const res = await request(app).post("/api/bulletin/refresh?force=true");
    expect(res.status).toBe(503);
    expect(lines()).toHaveLength(0);
  });

  test("LOW_COST_MODE → 503 naming the setting; Claude is never called", async () => {
    load({ env: { LOW_COST_MODE: "true" } });
    const res = await request(app).post("/api/bulletin/refresh?force=true");
    expect(res.status).toBe(503);
    expect(res.body.reason).toMatch(/LOW_COST_MODE/);
    expect(callClaude).not.toHaveBeenCalled();
    expect(lines()).toHaveLength(0);
  });

  test("a missing key says the key is missing — a set key is never blamed", async () => {
    load();
    delete process.env.ANTHROPIC_API_KEY;
    const res = await request(app).post("/api/bulletin/refresh?force=true");
    expect(res.body.reason).toMatch(/ANTHROPIC_API_KEY is not set/);
    expect(callClaude).not.toHaveBeenCalled();
  });
});

describe("bulletin — success path", () => {
  test("saves newsSummary (no pitchScript) and returns it", async () => {
    load();
    const res = await request(app).post("/api/bulletin/refresh?force=true");
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("live");
    expect(res.body.data.newsSummary).toMatch(/Watch CPI/);
    expect(res.body.data.pitchScript).toBeUndefined();
    expect(lines()).toHaveLength(1);
  });

  test("reply wrapped in search narration and fences still parses", async () => {
    load({ claude: async () => "I searched. {see note}\n```json\n" + JSON.stringify(GOOD) + "\n```\nDone {x}." });
    const res = await request(app).post("/api/bulletin/refresh?force=true");
    expect(res.status).toBe(200);
    expect(res.body.data.article.headline).toBe(GOOD.article.headline);
  });

  test("both cite-tag forms are stripped", async () => {
    const dirty = { ...GOOD, newsSummary: 'Rates held. <cite index="0-1">Patience</cite> and (cite index="1-2">CPI</cite> next.' };
    load({ claude: async () => JSON.stringify(dirty) });
    const res = await request(app).post("/api/bulletin/refresh?force=true");
    expect(res.body.data.newsSummary).toBe("Rates held. Patience and CPI next.");
  });

  test("the prompt asks for a summary with concern and what to watch, not a read-aloud script", async () => {
    load();
    await request(app).post("/api/bulletin/refresh?force=true");
    const prompt = callClaude.mock.calls[0][1];
    expect(prompt).toMatch(/"newsSummary"/);
    expect(prompt).toMatch(/cause for concern/);
    expect(prompt).toMatch(/what to look out for/);
    expect(prompt).not.toMatch(/pitchScript|read aloud/i);
  });
});

describe("bulletin log — legacy deterministic entries are never served", () => {
  test("a stored '-deterministic' bulletin is invisible, so it cannot block a real one", async () => {
    fs.writeFileSync(logFile, JSON.stringify({
      date: new Date().toISOString().slice(0, 10), bulletinId: `${new Date().toISOString().slice(0, 10)}-deterministic`,
      article: { headline: "x" }, analysis: { economistView: { macroRegime: "Regime classification unavailable — AI offline." } },
    }) + "\n");
    load();
    const get = await request(app).get("/api/bulletin");
    expect(get.body.data).toBeNull();
    const res = await request(app).post("/api/bulletin/refresh");   // no force: must generate, not serve the fake
    expect(res.body.source).toBe("live");
  });
});

describe("bulletin scheduler entry point", () => {
  test("AI failure returns null and saves nothing", async () => {
    load({ claude: async () => { throw new Error("boom"); } });
    const out = await require("../server/routes/bulletin").generateBulletin();
    expect(out).toBeNull();
    expect(lines()).toHaveLength(0);
  });
});

describe("bulletin source no longer carries the canned fallback", () => {
  test("buildFallbackBulletin and its text are gone", () => {
    const src = fs.readFileSync(path.join(__dirname, "../server/routes/bulletin.js"), "utf8");
    expect(src).not.toMatch(/buildFallbackBulletin|Regime classification unavailable|Flight-to-safety hedge/);
  });
});
