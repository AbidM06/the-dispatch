/**
 * server/jobs/marketsScheduler.js
 * ─────────────────────────────────────────────────────────────────────────────
 * One automatic Markets refresh per weekday, run inside the server process
 * (replaces the old Cowork scheduled task, which could not reach localhost).
 *
 * Default: 14:45 Europe/London, Mon–Fri — 15 min after the NYSE open, so US
 * stocks have real prices, London is mid-session, FX is in the London/NY
 * overlap and yesterday's FRED credit spreads are published.
 *
 * Catch-up: the check runs every minute and fires if it is a weekday, the
 * target time has passed, and today's scheduled run has not happened yet.
 * So if the Mac was asleep (or the server was off) at 14:45, the refresh runs
 * as soon as it's back — once per day, never twice.
 *
 * Env: MARKETS_REFRESH_TIME (HH:MM, default 14:45), MARKETS_TZ (default
 *      Europe/London), MARKETS_SCHEDULE=off to disable.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const markets = require("../markets/service");

const TICK_MS = 60_000;

const status = { intervalId: null, lastRunAt: null, lastError: null, running: false };

function cfg() {
  return {
    time: process.env.MARKETS_REFRESH_TIME || "14:45",
    tz:   process.env.MARKETS_TZ || "Europe/London",
  };
}

/** Wall-clock parts of `date` in time zone `tz`. */
function zonedParts(date, tz) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}`, weekday: p.weekday };
}

const isWeekday = (wd) => !["Sat", "Sun"].includes(wd);

/** Pure decision function — exported for tests. */
function shouldRun(now, lastScheduledDate, { time, tz } = cfg()) {
  const z = zonedParts(now, tz);
  return isWeekday(z.weekday) && z.hhmm >= time && lastScheduledDate !== z.date;
}

/** Next scheduled run as ISO (approximate to the minute; DST-safe). */
function nextRunAt(now = new Date(), lastScheduledDate = null, { time, tz } = cfg()) {
  if (shouldRun(now, lastScheduledDate, { time, tz })) return now.toISOString();
  const t = new Date(now.getTime());
  t.setSeconds(0, 0);
  for (let i = 0; i < 8 * 24 * 60; i++) {           // scan up to 8 days, minute steps
    t.setTime(t.getTime() + 60_000);
    const z = zonedParts(t, tz);
    if (isWeekday(z.weekday) && z.hhmm === time && z.date !== lastScheduledDate) return t.toISOString();
  }
  return null;
}

async function tick() {
  if (status.running || markets.isRefreshing()) return;
  const snap = markets.getSnapshot();
  const now  = new Date();
  if (!shouldRun(now, snap?.lastScheduledDate || null)) return;

  status.running = true;
  const today = zonedParts(now, cfg().tz).date;
  try {
    await markets.refresh("schedule");
    status.lastRunAt = new Date().toISOString();
    status.lastError = null;
  } catch (err) {
    status.lastError = err.message;
    console.error("[marketsScheduler] refresh failed:", err.message);
  } finally {
    // Mark the day done even on failure so a broken provider can't cause a
    // refresh every minute; the manual Refresh button is always available.
    markets.markScheduledRun(today);
    status.running = false;
  }
}

function start() {
  if (process.env.MARKETS_SCHEDULE === "off" || status.intervalId) return;
  // First-ever run: no snapshot on disk → fetch once so the panel isn't empty.
  if (!markets.getSnapshot()) markets.refresh("startup").catch(err => console.error("[marketsScheduler] startup refresh failed:", err.message));
  status.intervalId = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  setTimeout(() => { tick().catch(() => {}); }, 5_000);
  const { time, tz } = cfg();
  console.log(`[marketsScheduler] started — weekdays ${time} ${tz} (+ catch-up after sleep). Next: ${nextRunAt(new Date(), markets.getSnapshot()?.lastScheduledDate)}`);
}

function stop() {
  if (status.intervalId) clearInterval(status.intervalId);
  status.intervalId = null;
}

function getStatus() {
  const { time, tz } = cfg();
  const snap = markets.getSnapshot();
  return {
    enabled: process.env.MARKETS_SCHEDULE !== "off",
    time, tz,
    lastScheduledDate: snap?.lastScheduledDate || null,
    lastRunAt: status.lastRunAt,
    lastError: status.lastError,
    nextRunAt: nextRunAt(new Date(), snap?.lastScheduledDate || null),
  };
}

module.exports = { start, stop, getStatus, tick, _internal: { shouldRun, nextRunAt, zonedParts } };
