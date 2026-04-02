/**
 * server/routes/import.js
 * ─────────────────────────────────────────────────────────────────────────────
 * POST /api/import/t212   — upload a T212 Freestyle CSV; saves snapshot to
 *                           /data/portfolio_snapshot.json so portfolio.js and
 *                           scenario.js use fresh positions instead of seeds.
 * GET  /api/import/status — current snapshot metadata (or null if none saved)
 *
 * Accepted content-types for POST:
 *   text/csv            — raw CSV in request body
 *   text/plain          — same
 *   application/json    — { csv: "<raw csv string>", usdgbp?: number }
 *
 * The route also accepts an optional usdgbp query param / JSON field to
 * provide the exchange rate used for back-calculating USD native prices.
 * If omitted it falls back to the snapshot:fx cache then the seed value.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const { Router } = require("express");
const cache   = require("../cache");
const seeds   = require("../../seeds/fallback");
const { parseCsv, loadSnapshot, saveSnapshot } = require("../importers/t212");
const requireWriteAuth = require("../middleware/auth");

const router = Router();

// ── Helpers ────────────────────────────────────────────────────────────────────

function getCurrentUsdGbp(bodyRate) {
  if (bodyRate && !isNaN(parseFloat(bodyRate))) return parseFloat(bodyRate);
  const fxCache = cache.get("snapshot:fx");
  if (fxCache && typeof fxCache.value === "number") return fxCache.value;
  return seeds.FX_SEED.usdgbp.value;
}

// ── GET /api/import/status ────────────────────────────────────────────────────

router.get("/status", (_req, res) => {
  const snap = loadSnapshot();
  if (!snap) {
    return res.json({
      hasSnapshot: false,
      snapshot:    null,
      message:     "No T212 snapshot on disk. POST /api/import/t212 to import one.",
    });
  }
  res.json({
    hasSnapshot: true,
    snapshot: {
      importedAt:       snap.importedAt,
      positionCount:    snap.positions.length,
      totalInvestedGBP: snap.totalInvestedGBP,
      totalValueGBP:    snap.totalValueGBP,
      usdgbpAtImport:   snap.usdgbpAtImport,
      tickers:          snap.positions.map(p => p.ticker),
    },
  });
});

// ── POST /api/import/t212 ─────────────────────────────────────────────────────

router.post("/t212", requireWriteAuth, (req, res) => {
  let csvText = "";
  let usdgbpOverride;

  const ct = (req.headers["content-type"] || "").toLowerCase();

  if (ct.startsWith("application/json")) {
    // JSON body: { csv: "...", usdgbp: 0.7448 }
    if (!req.body || typeof req.body.csv !== "string") {
      return res.status(400).json({
        error: 'JSON body must include { "csv": "<raw csv string>" }',
      });
    }
    csvText       = req.body.csv;
    usdgbpOverride = req.body.usdgbp;
  } else if (ct.startsWith("text/")) {
    // Raw CSV body
    if (typeof req.body !== "string" || req.body.trim().length === 0) {
      return res.status(400).json({
        error: "Request body must be raw CSV text with Content-Type: text/csv",
      });
    }
    csvText        = req.body;
    usdgbpOverride = req.query.usdgbp;
  } else {
    return res.status(415).json({
      error: "Unsupported Content-Type. Use application/json (with {csv:...}) or text/csv (raw body).",
    });
  }

  const usdgbp = getCurrentUsdGbp(usdgbpOverride);

  try {
    const snapshot = parseCsv(csvText, usdgbp);
    snapshot.usdgbpAtImport = usdgbp;

    saveSnapshot(snapshot);

    // Bust the portfolio cache so the next GET /portfolio re-computes from snapshot
    cache.delete("portfolio:data");

    res.json({
      ok:           true,
      importedAt:   snapshot.importedAt,
      usdgbp,
      positionCount: snapshot.positions.length,
      totalInvestedGBP: snapshot.totalInvestedGBP,
      totalValueGBP:    snapshot.totalValueGBP,
      positions:        snapshot.positions.map(p => ({
        ticker:            p.ticker,
        name:              p.name,
        shares:            p.shares,
        currency:          p.currency,
        costGBP_total:     p.costGBP_total,
        snapshotValueGBP_total: p.snapshotValueGBP_total,
        snapshotPriceNative:    p.snapshotPriceNative,
      })),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
