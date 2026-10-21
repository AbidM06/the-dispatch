/**
 * tests/economicCalendar.test.js — D-31: the economic calendar from FRED's release dates.
 * Free data, no AI, nothing typed in (D-02). FRED is mocked by URL; no network.
 */
"use strict";

const fs   = require("fs");
const path = require("path");
const request = require("supertest");
const express = require("express");

const NOW = new Date("2026-10-21T10:00:00Z");       // London date 2026-10-21

// 26 months of monthly observations ending 2026-09-01, newest first (what FRED returns for sort_order=desc).
function monthlyObs() {
  const out = [];
  for (let i = 0; i < 26; i++) {
    const d = new Date(Date.UTC(2026, 8 - i, 1));
    out.push({ date: d.toISOString().slice(0, 10), value: String(100 + (25 - i) * 0.25) });
  }
  return out;
}

const RELEASES = [
  { id: 10, name: "Consumer Price Index", link: "https://www.bls.gov/cpi/" },
  { id: 50, name: "Employment Situation" },
  { id: 54, name: "Personal Income and Outlays" },
  { id: 53, name: "Gross Domestic Product" },
  { id: 999, name: "Something Else Entirely" },
];
const DATES = {
  10: ["2026-10-24", "2026-11-13", "2026-12-10"],
  50: ["2026-11-06", "2026-12-04"],
  54: ["2026-10-30", "2026-11-25"],
  53: ["2026-10-29"],
  101: ["2026-12-09"],
};

/** Install a FRED mock. `over` can replace the release list / dates / make a URL fail. */
function mockFred({ releases = RELEASES, dates = DATES, failDates = [], failAll = false } = {}) {
  const calls = [];
  global.fetch = jest.fn(async (url) => {
    const u = new URL(String(url));
    calls.push(u);
    if (failAll) throw new Error("network down");
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    if (u.pathname.endsWith("/fred/releases")) return ok({ releases });
    if (u.pathname.endsWith("/fred/release/dates")) {
      const id = Number(u.searchParams.get("release_id"));
      if (failDates.includes(id)) return { ok: false, status: 500, json: async () => ({}) };
      return ok({ release_dates: (dates[id] || []).map(date => ({ release_id: id, date })) });
    }
    if (u.pathname.endsWith("/fred/series/observations")) return ok({ observations: monthlyObs() });
    return { ok: false, status: 404, json: async () => ({}) };
  });
  return calls;
}

let cal;
beforeEach(() => {
  jest.resetModules();
  process.env.FRED_API_KEY = "test-key";
  delete process.env.CALENDAR_PATH;
  cal = require("../server/markets/calendar");
});

describe("refresh: dates come from FRED, found by release NAME", () => {
  test("stores every FRED date for the named releases, sorted, and says FOMC is missing when FRED has none", async () => {
    mockFred();
    const r = await cal.refresh({ now: NOW });
    expect(r.ok).toBe(true);
    const c = cal.getCalendar({ daysAhead: 90, now: NOW });
    expect(c.available).toBe(true);
    expect(c.source).toBe("FRED");
    expect(c.events.map(e => `${e.date} ${e.key}`)).toEqual([
      "2026-10-24 cpi", "2026-10-29 gdp", "2026-10-30 pce", "2026-11-06 jobs",
      "2026-11-13 cpi", "2026-11-25 pce", "2026-12-04 jobs", "2026-12-10 cpi",
    ]);
    expect(c.missing).toEqual([expect.objectContaining({ key: "fomc", reason: expect.stringMatching(/no release with this name/) })]);
    expect(c.events.every(e => e.source === "FRED" && /^https:\/\//.test(e.sourceUrl))).toBe(true);
  });

  test("asks FRED for upcoming dates INCLUDING ones with no data yet, from today's London date", async () => {
    const calls = mockFred();
    await cal.refresh({ now: NOW });
    const dateCalls = calls.filter(u => u.pathname.endsWith("/release/dates"));
    expect(dateCalls.length).toBeGreaterThan(0);
    for (const u of dateCalls) {
      expect(u.searchParams.get("include_release_dates_with_no_data")).toBe("true");
      expect(u.searchParams.get("realtime_start")).toBe("2026-10-21");
    }
  });

  test("FOMC appears when FRED carries a release with that name", async () => {
    mockFred({ releases: [...RELEASES, { id: 101, name: "FOMC Press Release" }] });
    await cal.refresh({ now: NOW });
    const c = cal.getCalendar({ daysAhead: 90, now: NOW });
    expect(c.events.find(e => e.key === "fomc")).toMatchObject({ date: "2026-12-09", event: "FOMC decision" });
    expect(c.missing).toEqual([]);
  });

  test("a release with no upcoming date is named as missing, not filled", async () => {
    mockFred({ dates: { ...DATES, 53: [] } });
    await cal.refresh({ now: NOW });
    const c = cal.getCalendar({ daysAhead: 90, now: NOW });
    expect(c.events.some(e => e.key === "gdp")).toBe(false);
    expect(c.missing.find(m => m.key === "gdp").reason).toMatch(/no upcoming date/);
  });

  test("one failing date lookup loses only that event", async () => {
    mockFred({ failDates: [54] });
    await cal.refresh({ now: NOW });
    const c = cal.getCalendar({ daysAhead: 90, now: NOW });
    expect(c.events.some(e => e.key === "pce")).toBe(false);
    expect(c.events.some(e => e.key === "cpi")).toBe(true);
    expect(c.missing.find(m => m.key === "pce").reason).toMatch(/lookup failed/);
  });
});

describe("previous reading", () => {
  test("only the NEXT date of an event carries it (later dates will follow newer data)", async () => {
    mockFred();
    await cal.refresh({ now: NOW });
    const cpi = cal.getCalendar({ daysAhead: 90, now: NOW }).events.filter(e => e.key === "cpi");
    expect(cpi.map(e => e.previous.length > 0)).toEqual([true, false, false]);
  });

  test("it is a real FRED figure with its period: CPI YoY computed from the observations", async () => {
    mockFred();
    await cal.refresh({ now: NOW });
    const next = cal.getCalendar({ daysAhead: 90, now: NOW }).events.find(e => e.key === "cpi");
    const cpiYoy = next.previous.find(p => /^CPI inflation/.test(p.label));
    // last 106.25 vs 12 months earlier 103.25  ->  (106.25 / 103.25 - 1) * 100 = 2.9%
    expect(cpiYoy.text).toBe("CPI inflation (YoY) 2.9% (2026-09)");
    expect(cpiYoy.sourceUrl).toMatch(/fred\.stlouisfed\.org\/series\/CPIAUCSL/);
    expect(next.previous.length).toBe(2);                           // CPI and core CPI
  });

  test("a reading that cannot be fetched is left out; the event stays", async () => {
    const calls = mockFred();
    const real = global.fetch;
    global.fetch = jest.fn(async (url) =>
      String(url).includes("series/observations") ? { ok: false, status: 500, json: async () => ({}) } : real(url));
    await cal.refresh({ now: NOW });
    const next = cal.getCalendar({ daysAhead: 90, now: NOW }).events.find(e => e.key === "cpi");
    expect(next.previous).toEqual([]);
    expect(next.date).toBe("2026-10-24");
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("getCalendar: reads the stored copy, never fetches", () => {
  test("nothing stored → unavailable with the reason; no fetch", () => {
    global.fetch = jest.fn();
    const c = cal.getCalendar({ now: NOW });
    expect(c.available).toBe(false);
    expect(c.reason).toMatch(/unavailable/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("past dates are dropped and the window is honoured", async () => {
    mockFred();
    await cal.refresh({ now: NOW });
    const later = new Date("2026-11-07T10:00:00Z");
    const c = cal.getCalendar({ daysAhead: 10, now: later });
    expect(c.events.map(e => e.date)).toEqual(["2026-11-13"]);       // 24 Oct–6 Nov are past; 25 Nov is beyond 10 days
  });

  test("a copy older than 3 days is shown but flagged stale", async () => {
    mockFred();
    await cal.refresh({ now: NOW });
    expect(cal.getCalendar({ daysAhead: 90, now: NOW }).stale).toBe(false);
    expect(cal.getCalendar({ daysAhead: 90, now: new Date("2026-10-25T10:00:00Z") }).stale).toBe(true);
  });

  test("a failed refresh keeps the last good copy", async () => {
    mockFred();
    await cal.refresh({ now: NOW });
    mockFred({ failAll: true });
    const r = await cal.refresh({ now: new Date("2026-10-22T10:00:00Z") });
    expect(r.ok).toBe(false);
    const c = cal.getCalendar({ daysAhead: 90, now: new Date("2026-10-22T10:00:00Z") });
    expect(c.available).toBe(true);
    expect(c.events.length).toBeGreaterThan(0);
    expect(c.generatedAt).toBe(NOW.toISOString());
  });

  test("no FRED key → refresh says why and nothing is stored", async () => {
    delete process.env.FRED_API_KEY;
    global.fetch = jest.fn();
    const r = await cal.refresh({ now: NOW });
    expect(r).toEqual({ ok: false, reason: "FRED_API_KEY is not set" });
    expect(cal.getCalendar({ now: NOW })).toMatchObject({ available: false, reason: expect.stringMatching(/FRED_API_KEY/) });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("it rides along with the Markets refresh", () => {
  test("refreshMarkets refreshes the calendar, and a calendar failure never fails the refresh", async () => {
    jest.doMock("../server/markets/service", () => ({ refresh: jest.fn(async () => ({ ok: true })) }));
    jest.doMock("../server/journal/tracker", () => ({ updateAll: jest.fn(async () => {}) }));
    const calendar = require("../server/markets/calendar");
    const spy = jest.spyOn(calendar, "refresh").mockRejectedValue(new Error("boom"));
    const { refreshMarkets } = require("../server/jobs/refreshMarkets");
    await expect(refreshMarkets("manual")).resolves.toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(1);
    jest.dontMock("../server/markets/service");
    jest.dontMock("../server/journal/tracker");
  });
});

describe("the News calendar routes serve the stored FRED calendar", () => {
  function app() {
    jest.doMock("../server/providers/finnhub", () => ({
      getMarketNews: jest.fn().mockResolvedValue([]),
      getEarningsCalendar: jest.fn().mockResolvedValue([]),
      getEconomicCalendar: jest.fn(() => { throw new Error("Finnhub's economic calendar must not be used"); }),
      getCompanyNews: jest.fn(), getNewsSentiment: jest.fn(),
      isConfigured: jest.fn().mockReturnValue(true),
      TTL_NEWS_MS: 1, TTL_CALENDAR_MS: 1,
    }));
    require("../server/cache").clear();
    const a = express();
    a.use("/api/news", require("../server/routes/news"));
    return a;
  }

  test("events, source and what FRED does not list", async () => {
    mockFred();
    await require("../server/markets/calendar").refresh({ now: new Date() });
    const res = await request(app()).get("/api/news/calendar?days=90");
    const d = res.body.data;
    expect(d.economicSource).toBe("live");
    expect(d.economic.length).toBeGreaterThan(0);
    expect(d.economic.every(e => e.source === "FRED")).toBe(true);
    expect(d.economicMissing).toEqual(["FOMC decision"]);
  });

  test("nothing stored → unavailable, with the reason, and no events", async () => {
    const res = await request(app()).get("/api/news/calendar");
    expect(res.body.data.economic).toEqual([]);
    expect(res.body.data.economicSource).toBe("unavailable");
    expect(res.body.data.economicNote).toMatch(/unavailable/);
  });
});

describe("D-02 guard: no typed-in dates or schedule in the calendar code", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server", "markets", "calendar.js"), "utf8");
  test("calendar.js contains no date literal and no month names", () => {
    expect(src).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
    expect(src).not.toMatch(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/);
  });
  test("it does not claim a release time or a consensus", () => {
    expect(src).not.toMatch(/08:30|8:30|13:30|consensus\s*[:=]/i);
  });
});
