/**
 * server/cache.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Simple TTL in-memory cache with optional disk persistence for AI results.
 * Single-process safe; no Redis dependency needed for a demo deployment.
 *
 * Each entry stores: { value, fetchedAt, expiresAt }
 * Allows callers to inspect age even after expiry (for stale-while-revalidate).
 *
 * Disk persistence: keys matching AI_PREFIXES are saved to .ai-cache.json so
 * AI results (events, risk scores, explain) survive server restarts.
 * Disabled in test environments (NODE_ENV=test) to keep tests deterministic.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const path = require("path");
const fs   = require("fs");

// Keys with these prefixes are persisted to disk
const AI_PREFIXES   = ["events:", "risk:", "explain:"];
const DISK_PATH     = path.join(__dirname, ".ai-cache.json");
const IS_TEST       = process.env.NODE_ENV === "test";

class TTLCache {
  constructor() {
    this._store = new Map();
    if (!IS_TEST) this._loadFromDisk();
  }

  /**
   * Store a value with a TTL.
   * @param {string} key
   * @param {*}      value
   * @param {number} ttlMs  Milliseconds until expiry
   */
  set(key, value, ttlMs) {
    const now = Date.now();
    this._store.set(key, {
      value,
      fetchedAt: new Date(now).toISOString(),
      expiresAt: now + ttlMs,
    });
    if (!IS_TEST && this._isAiKey(key)) this._saveToDisk();
  }

  /**
   * Get a cached value. Returns null if missing OR expired.
   * @param {string} key
   * @returns {*|null}
   */
  get(key) {
    const entry = this._store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this._store.delete(key);
      return null;
    }
    return entry.value;
  }

  /**
   * Get stale entry even if expired (for graceful degradation).
   * Returns { value, fetchedAt, stale: bool } or null if never set.
   * @param {string} key
   * @returns {{ value: *, fetchedAt: string, stale: boolean }|null}
   */
  getWithMeta(key) {
    const entry = this._store.get(key);
    if (!entry) return null;
    return {
      value:     entry.value,
      fetchedAt: entry.fetchedAt,
      stale:     Date.now() > entry.expiresAt,
    };
  }

  /** Returns true if key exists and is not expired. */
  has(key) {
    const entry = this._store.get(key);
    if (!entry) return false;
    return Date.now() <= entry.expiresAt;
  }

  /** Manually invalidate a cache entry. */
  delete(key) {
    this._store.delete(key);
  }

  /** Clear all entries (useful in tests). */
  clear() {
    this._store.clear();
  }

  /** Diagnostic: number of entries (including expired). */
  get size() {
    return this._store.size;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  _isAiKey(key) {
    return AI_PREFIXES.some(p => key.startsWith(p));
  }

  /** Restore AI entries from disk on startup. Skips expired entries. */
  _loadFromDisk() {
    try {
      if (!fs.existsSync(DISK_PATH)) return;
      const raw  = fs.readFileSync(DISK_PATH, "utf8");
      const data = JSON.parse(raw);
      const now  = Date.now();
      let loaded = 0;
      for (const [key, entry] of Object.entries(data)) {
        if (entry.expiresAt > now) {
          this._store.set(key, entry);
          loaded++;
        }
      }
      if (loaded > 0) {
        console.log(`[cache] Restored ${loaded} AI cache entries from disk (.ai-cache.json)`);
      }
    } catch (err) {
      console.warn("[cache] Could not load .ai-cache.json:", err.message);
    }
  }

  /** Persist all AI-prefixed entries to disk (fire-and-forget). */
  _saveToDisk() {
    try {
      const toSave = {};
      for (const [key, entry] of this._store.entries()) {
        if (this._isAiKey(key)) toSave[key] = entry;
      }
      fs.writeFileSync(DISK_PATH, JSON.stringify(toSave, null, 2), "utf8");
    } catch (err) {
      console.warn("[cache] Could not write .ai-cache.json:", err.message);
    }
  }
}

// Export a singleton — shared across all route handlers in the same process
module.exports = new TTLCache();
