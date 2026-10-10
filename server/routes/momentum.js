/**
 * server/routes/momentum.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GET /api/analytics/momentum
 *   Fetches 252 calendar days of daily price history from Polygon for
 *   AMD + 6 peers, then computes multi-period momentum returns:
 *     1M  (~21 trading days / 30 calendar days)
 *     3M  (~63 trading days / 90 calendar days)
 *     6M  (~126 trading days / 180 calendar days)
 *     12M (~252 trading days / 365 calendar days)
 *
 *   Also computes 20-day realised volatility (annualised) and a composite
 *   momentum score (equal-weighted average of 1M/3M/6M returns, vol-normalised).
 *
 *   Returns tickers ranked by composite score descending.
 *
 * Cache: 30 min (matches market data TTL — Polygon free tier has ~15 min delay).
 * ?refresh=true — bust cache.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const { Router }  = require("express");
const cache       = require("../cache");
const polygon     = require("../providers/polygon");

const router  = Router();
const TTL_30M = 30 * 60 * 1000;

const TICKERS = ["AMD", "NVDA", "MSFT", "TSLA", "MU", "AMAT", "LRCX"];

// Calendar day lookback → the Polygon window covers these periods comfortably.
// We use 365 calendar days to guarantee we get 252 trading days of data.
const LOOKBACK_DAYS = 370;

// Calendar day offsets for each momentum period (will map to closest trading day)
const PERIODS = [
  { label: "1M",  calDays: 30  },
  { label: "3M",  calDays: 91  },
  { label: "6M",  calDays: 182 },
  { label: "12M", calDays: 365 },
];

function now() { return new Date().toISOString(); }

/**
 * Find the bar closest to `targetDate` (ISO string) from a sorted bars array.
 * Returns the bar's close price, or null if data doesn't reach that far back.
 */
function closestClose(bars, targetDate) {
  if (!bars.length) return null;
  // bars are ascending by date — find the first bar on or after targetDate
  // If the exact date is a weekend/holiday, use the next available bar.
  const idx = bars.findIndex(b => b.date >= targetDate);
  if (idx === -1) return null;        // no data on or after that date
  if (idx === 0)  return null;        // targetDate is before our history starts
  // Use bar immediately before or at idx to get the "as of" price
  return bars[idx - 1]?.close ?? bars[idx]?.close ?? null;
}

/**
 * Compute 20-day realised vol from the last 21 closes.
 * Returns annualised vol as a decimal (e.g. 0.35 = 35%).
 */
function realisedVol(bars) {
  if (bars.length < 22) return null;
  const slice = bars.slice(-22);
  const rets  = [];
  for (let i = 1; i < slice.length; i++) {
    if (slice[i - 1].close && slice[i].close) {
      rets.push(Math.log(slice[i].close / slice[i - 1].close));
    }
  }
  if (rets.length < 5) return null;
  const mean    = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance * 252); // annualised
}

/**
 * Compute momentum for one ticker given its bars.
 */
function computeMomentum(sym, bars) {
  if (!bars.length) return { sym, error: "No price data" };

  const latestClose = bars[bars.length - 1].close;
  const today       = bars[bars.length - 1].date;

  const returns = {};
  for (const { label, calDays } of PERIODS) {
    const targetDate = new Date(today);
    targetDate.setDate(targetDate.getDate() - calDays);
    const targetStr  = targetDate.toISOString().slice(0, 10);
    const pastClose  = closestClose(bars, targetStr);
    if (pastClose && pastClose !== 0) {
      returns[label] = +((latestClose / pastClose - 1) * 100).toFixed(2); // %
    } else {
      returns[label] = null;
    }
  }

  const vol = realisedVol(bars);

  // Composite score: equal-weight of 1M/3M/6M (skip 12M — too much drift)
  // Vol-adjust: divide raw return by realised vol so high-vol stocks don't dominate
  const weights    = ["1M", "3M", "6M"];
  const rawScores  = weights.map(k => returns[k]).filter(v => v != null);
  let compositeRaw = null;
  if (rawScores.length >= 2) {
    compositeRaw = rawScores.reduce((s, v) => s + v, 0) / rawScores.length;
  }

  // Vol-adjust the composite (optional — use raw if vol unavailable)
  const composite = compositeRaw != null
    ? (vol ? +(compositeRaw / (vol * 100)).toFixed(3) : +(compositeRaw / 30).toFixed(3))
    : null;

  return {
    sym,
    latestClose:   +latestClose.toFixed(2),
    latestDate:    today,
    returns,
    volAnn:        vol != null ? +(vol * 100).toFixed(1) : null,  // as %
    composite,
    bars252:       bars.length,
  };
}

// GET /api/analytics/momentum
router.get("/momentum", async (req, res) => {
  const force = req.query.refresh === "true";
  const tickers = req.query.tickers
    ? req.query.tickers.split(",").map(s => s.trim().toUpperCase()).filter(Boolean)
    : TICKERS;

  const cacheKey = `analytics:momentum:${tickers.join(",")}`;

  if (!force) {
    const cached = cache.getWithMeta(cacheKey);
    if (cached && !cached.stale) {
      return res.json({ source: "cache", fetchedAt: now(), data: cached.value });
    }
  }

  if (!process.env.POLYGON_API_KEY) {
    return res.status(503).json({
      error:  "POLYGON_API_KEY not configured",
      source: "error",
    });
  }

  // Stagger calls: 7 tickers × 700ms = 4.9s total — stays within Polygon's 5 req/min free tier.
  const settled = await Promise.allSettled(
    tickers.map((sym, i) =>
      new Promise(r => setTimeout(r, i * 700)).then(() =>
        polygon.getHistory(sym, LOOKBACK_DAYS)
      )
    )
  );

  const results = tickers.map((sym, i) => {
    const r = settled[i];
    if (r.status === "rejected") {
      console.warn(`[momentum] ${sym} failed:`, r.reason?.message);
      return { sym, error: r.reason?.message || "fetch failed" };
    }
    return computeMomentum(sym, r.value);
  });

  // Sort by composite descending (nulls last)
  const ranked = [...results].sort((a, b) => {
    if (a.composite == null && b.composite == null) return 0;
    if (a.composite == null) return 1;
    if (b.composite == null) return -1;
    return b.composite - a.composite;
  });

  const payload = {
    ranked,
    generatedAt: now(),
    periods:     PERIODS.map(p => p.label),
    methodology: "Polygon /v2/aggs 1-day bars, ~15min delayed. Momentum = price return over period. Composite = equal-weighted avg of 1M/3M/6M returns, vol-normalised by 20-day realised vol (annualised).",
  };

  cache.set(cacheKey, payload, TTL_30M);
  res.json({ source: "live", fetchedAt: now(), data: payload });
});

module.exports = router;
