/**
 * server/jobs/bulletinScheduler.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Daily 7:00 AM GMT scheduler for the morning bulletin.
 * No external dependencies — uses setInterval (checks every 60 seconds).
 *
 * Schedule: 07:00 UTC, Mon–Fri only.
 * Cooldown: will not re-run if a bulletin was already generated today.
 *
 * Usage:
 *   const { start, stop, getStatus } = require("./bulletinScheduler");
 *   start();   // called once from server/index.js
 *   stop();    // cleanup
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const { generateBulletin } = require("../routes/bulletin");

const TARGET_TIME_UTC = process.env.BULLETIN_TIME_UTC || "07:00"; // HH:MM in UTC
const TICK_MS         = 60_000; // check every minute

const status = {
  lastRunAt:  null,
  nextRunAt:  null,
  totalRuns:  0,
  lastError:  null,
  intervalId: null,
  running:    false,
};

function utcHHMM(date) {
  const h = String(date.getUTCHours()).padStart(2, "0");
  const m = String(date.getUTCMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function isUTCWeekday(date) {
  const d = date.getUTCDay(); // 0=Sun, 6=Sat
  return d >= 1 && d <= 5;
}

function computeNext() {
  const now  = new Date();
  const [th, tm] = TARGET_TIME_UTC.split(":").map(Number);
  const next = new Date(now);
  next.setUTCHours(th, tm, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1); // tomorrow if past today's window
  // Skip to Monday if next falls on weekend
  while (!isUTCWeekday(next)) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

async function tick() {
  if (status.running) return;

  const now = new Date();
  if (!isUTCWeekday(now))           return;    // skip weekends
  if (utcHHMM(now) !== TARGET_TIME_UTC) return; // not the right minute

  status.running = true;
  status.totalRuns++;
  status.lastRunAt = now.toISOString();
  status.nextRunAt = computeNext();

  console.log(`[bulletinScheduler] 🗞 Running morning bulletin at ${utcHHMM(now)} UTC…`);

  try {
    await generateBulletin();
    status.lastError = null;
    console.log("[bulletinScheduler] ✓ Bulletin generated successfully.");
  } catch (err) {
    status.lastError = err.message;
    console.error("[bulletinScheduler] ✗ Error:", err.message);
  } finally {
    status.running = false;
  }
}

function start() {
  if (status.intervalId) return; // already running
  status.nextRunAt  = computeNext();
  status.intervalId = setInterval(tick, TICK_MS);
  console.log(`[bulletinScheduler] Started — next bulletin at ${status.nextRunAt} (${TARGET_TIME_UTC} UTC, Mon–Fri)`);
}

function stop() {
  if (status.intervalId) {
    clearInterval(status.intervalId);
    status.intervalId = null;
  }
}

function getStatus() {
  return {
    lastRunAt:  status.lastRunAt,
    nextRunAt:  status.nextRunAt,
    totalRuns:  status.totalRuns,
    lastError:  status.lastError,
    running:    status.running,
    targetTime: TARGET_TIME_UTC + " UTC",
  };
}

module.exports = { start, stop, getStatus };
