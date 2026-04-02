/**
 * server/providers/webhook.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Fire-and-forget POST webhook for idea lifecycle events.
 * No new dependencies — uses built-in fetch (Node >=18).
 *
 * Events fired:
 *   idea.pending   — new idea awaiting approval
 *   idea.executed  — paper order placed
 *   idea.rejected  — idea rejected
 *   idea.skipped   — idea skipped (policy/freshness)
 *   exit.signal    — exit signal generated
 *
 * Env: WEBHOOK_URL (if not set, no-op)
 *      WEBHOOK_SECRET (optional — added as X-Dispatch-Signature header)
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const { fetchWithTimeout } = require("../retry");

function getWebhookUrl() {
  return process.env.WEBHOOK_URL || null;
}

/**
 * Fire a webhook event (fire-and-forget).
 * Does not throw — logs failures to console.
 *
 * @param {string} event  e.g. "idea.pending"
 * @param {object} payload
 */
async function fireWebhook(event, payload) {
  const url = getWebhookUrl();
  if (!url) return; // no-op

  const body = JSON.stringify({
    event,
    ts:      new Date().toISOString(),
    service: "the-dispatch",
    payload,
  });

  const headers = {
    "Content-Type": "application/json",
    "X-Dispatch-Event": event,
  };
  if (process.env.WEBHOOK_SECRET) {
    headers["X-Dispatch-Signature"] = process.env.WEBHOOK_SECRET;
  }

  try {
    const res = await fetchWithTimeout(url, { method: "POST", headers, body }, 8_000);
    if (!res.ok) {
      console.warn(`[webhook] ${event} -> HTTP ${res.status} at ${url}`);
    } else {
      console.log(`[webhook] ${event} fired -> ${url}`);
    }
  } catch (err) {
    console.warn(`[webhook] ${event} failed:`, err.message);
  }
}

module.exports = { fireWebhook };
