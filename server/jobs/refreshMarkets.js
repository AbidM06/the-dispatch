/**
 * server/jobs/refreshMarkets.js — the ONE way to refresh Markets prices.
 *
 * Every refresh (scheduled slot, startup, first page load, manual button) goes
 * through here so the Journal is always re-scored on the new prices (stage 2,
 * journal/tracker.js — free data, no AI). A tracking failure is logged and
 * never fails the refresh itself. Do not call markets.refresh() directly.
 */
"use strict";

const markets = require("../markets/service");

async function refreshMarkets(trigger) {
  const snap = await markets.refresh(trigger);
  await require("../journal/tracker").updateAll()
    .catch(err => console.warn("[journal] tracking update failed:", err.message));
  return snap;
}

module.exports = { refreshMarkets };
