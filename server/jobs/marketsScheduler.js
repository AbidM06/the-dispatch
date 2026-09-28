/**
 * server/jobs/marketsScheduler.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Automatic Markets refreshes on weekdays, run inside the server process
 * (replaces the old Cowork scheduled task, which could not reach localhost).
 *
 * Default slots, Europe/London, Mon–Fri:
 *   07:45 — before the LSE open: yesterday's US close, overnight Asia, and the
 *           latest FRED prints. The morning-note snapshot.
 *   14:45 — 15 min after the NYSE open: the US open move plus Europe's morning,
 *           London/NY FX overlap.
 * Markets data is free-source only (no AI), so an extra slot costs nothing.
 * The manual Refresh button works at any time.
 *
 * Catch-up: the check runs every minute. Each slot runs at most once per day,
 * keyed "YYYY-MM-DD@HH:MM". If the Mac was asleep through one or more slots,
 * ONE refresh runs when it wakes (for the latest missed slot) — never a burst.
 *
 * Env: MARKETS_REFRESH_TIMES (comma list of HH:MM, default "07:45,14:45"),
 *      MARKETS_REFRESH_TIME (legacy single slot), MARKETS_TZ (default
 *      Europe/London), MARKETS_SCHEDULE=off to disable.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const markets = require("../markets/service");

const TICK_MS = 60_000;
const DEFAULT_TIMES = ["07:45", "14:45"];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const status = { intervalId: null, lastRunAt: null, lastError: null, running: false };

function parseTimes(raw) {
  const times = String(raw || "").split(",").map(t => t.trim()).filter(t => HHMM.test(t));
  return [...new Set(times)].sort();
}

function cfg() {
  const multi  = parseTimes(process.env.MARKETS_REFRESH_TIMES);
  const legacy = parseTimes(process.env.MARKETS_REFRESH_TIME);
  return {
    times: multi.length ? multi : legacy.length ? legacy : DEFAULT_TIMES,
    tz:    process.env.MARKETS_TZ || "Europe/London",
  };
}

/** Accept { times } or the legacy { time } shape. */
function slotsOf(c) {
  return c.times ? c.times : [c.time];
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

/**
 * A stored marker from before per-slot scheduling is a bare date meaning
 * "today's run is done" — treat it as past every slot that day.
 */
function normaliseKey(key) {
  if (!key) return "";
  return key.includes("@") ? key : `${key}@99:99`;
}

/** The latest slot that has passed today, as a key, or null. */
function dueSlotKey(now, c) {
  const z = zonedParts(now, c.tz);
  if (!isWeekday(z.weekday)) return null;
  const passed = slotsOf(c).filter(t => z.hhmm >= t);
  return passed.length ? `${z.date}@${passed[passed.length - 1]}` : null;
}

/** Pure decision function — exported for tests. Returns the slot key to run, or false. */
function shouldRun(now, lastScheduledKey, c = cfg()) {
  const due = dueSlotKey(now, c);
  return due && due > normaliseKey(lastScheduledKey) ? due : false;
}

/** Next scheduled run as ISO (approximate to the minute; DST-safe). */
function nextRunAt(now = new Date(), lastScheduledKey = null, c = cfg()) {
  if (shouldRun(now, lastScheduledKey, c)) return now.toISOString();
  const slots = slotsOf(c);
  const last = normaliseKey(lastScheduledKey);
  const t = new Date(now.getTime());
  t.setSeconds(0, 0);
  for (let i = 0; i < 8 * 24 * 60; i++) {           // scan up to 8 days, minute steps
    t.setTime(t.getTime() + 60_000);
    const z = zonedParts(t, c.tz);
    if (isWeekday(z.weekday) && slots.includes(z.hhmm) && `${z.date}@${z.hhmm}` > last) return t.toISOString();
  }
  return null;
}

async function tick() {
  if (status.running || markets.isRefreshing()) return;
  const snap = markets.getSnapshot();
  const slotKey = shouldRun(new Date(), snap?.lastScheduledDate || null);
  if (!slotKey) return;

  status.running = true;
  try {
    await markets.refresh("schedule");
    await require("../journal/tracker").updateAll().catch(err => console.warn("[journal] tracking update failed:", err.message));
    status.lastRunAt = new Date().toISOString();
    status.lastError = null;
  } catch (err) {
    status.lastError = err.message;
    console.error("[marketsScheduler] refresh failed:", err.message);
  } finally {
    // Mark the slot done even on failure so a broken provider can't cause a
    // refresh every minute; the manual Refresh button is always available.
    markets.markScheduledRun(slotKey);
    status.running = false;
  }
}

function start() {
  if (process.env.MARKETS_SCHEDULE === "off" || status.intervalId) return;
  // First-ever run: no snapshot on disk → fetch once so the panel isn't empty.
  if (!markets.getSnapshot()) markets.refresh("startup").catch(err => console.error("[marketsScheduler] startup refresh failed:", err.message));
  status.intervalId = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  setTimeout(() => { tick().catch(() => {}); }, 5_000);
  const { times, tz } = cfg();
  console.log(`[marketsScheduler] started — weekdays ${times.join(" & ")} ${tz} (+ catch-up after sleep). Next: ${nextRunAt(new Date(), markets.getSnapshot()?.lastScheduledDate)}`);
}

function stop() {
  if (status.intervalId) clearInterval(status.intervalId);
  status.intervalId = null;
}

function getStatus() {
  const { times, tz } = cfg();
  const snap = markets.getSnapshot();
  return {
    enabled: process.env.MARKETS_SCHEDULE !== "off",
    times, tz,
    time: times.join(" & "),   // display string (kept for the existing client label)
    lastScheduledDate: snap?.lastScheduledDate || null,
    lastRunAt: status.lastRunAt,
    lastError: status.lastError,
    nextRunAt: nextRunAt(new Date(), snap?.lastScheduledDate || null),
  };
}

module.exports = { start, stop, getStatus, tick, _internal: { shouldRun, nextRunAt, zonedParts, parseTimes, cfg } };
