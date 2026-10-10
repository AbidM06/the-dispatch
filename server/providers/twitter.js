"use strict";

/**
 * server/providers/twitter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin wrapper around the `opencli` CLI (Twitter/X reader, Browser Bridge).
 *
 * Read-only. Reuses the user's logged-in Chrome x.com session — no API keys.
 * If opencli, the daemon, or the browser session is unavailable, every
 * function resolves to `null` so callers can degrade gracefully.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { execFile } = require("child_process");

const TIMEOUT_MS = 30_000;

/**
 * searchTweets — `opencli twitter search "<query>" --filter live --limit N -f json`
 * Returns an array of tweet objects, or null on any failure (not installed,
 * daemon down, no browser session, parse error, timeout).
 */
function searchTweets(query, { limit = 15, filter = "live" } = {}) {
  return new Promise((resolve) => {
    execFile(
      "opencli",
      ["twitter", "search", query, "--filter", filter, "--limit", String(limit), "-f", "json"],
      { timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          console.warn("[twitter] search failed:", err.message);
          return resolve(null);
        }
        try {
          const tweets = JSON.parse(stdout);
          resolve(Array.isArray(tweets) ? tweets : null);
        } catch (e) {
          console.warn("[twitter] search parse error:", e.message);
          resolve(null);
        }
      }
    );
  });
}

module.exports = { searchTweets };
