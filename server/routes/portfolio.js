/**
 * server/routes/portfolio.js
 * ─────────────────────────────────────────────────────────────────────────────
 * GET /api/portfolio
 *
 * Computes portfolio P&L for all positions using live or cached prices.
 *
 * Data priority (positions & cost basis):
 *   1. T212 snapshot  (/data/portfolio_snapshot.json)  — most accurate
 *   2. seeds/fallback.js POSITIONS_SEED               — manual fallback
 *
 * Data priority (prices):
 *   1. Alpha Vantage live price   — USD tickers only
 *   2. T212 snapshot native price — most recent T212 intraday price
 *   3. seeds/fallback.js PRICES_SEED — static fallback
 *
 * Currency convention:
 *   - USD positions (AMD): price in USD → valGBP via FX; costGBP_ = shares × costUSD × usdgbp
 *   - GBP positions (ETFs): price in GBP; costGBP_ = shares × costGBP
 *   - T212 snapshot: costGBP_total stored directly (no × shares needed)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { Router } = require("express");
const cache   = require("../cache");
const { getQuote, getFxRate } = require("../providers/alphaVantage");
const { schemas, validate }   = require("../schemas");
const seeds  = require("../../seeds/fallback");
const { loadSnapshot } = require("../importers/t212");

const router = Router();

// ── Cache keys ────────────────────────────────────────────────────────────────
const KEYS = {
  portfolio: "portfolio:data",
  fx:        "snapshot:fx",   // shared with snapshot route
};

// ── TTLs ─────────────────────────────────────────────────────────────────────
const TTL_MARKET = (parseInt(process.env.CACHE_TTL_MARKET, 10) || 5) * 60_000;

// ── USD-listed tickers supported by Alpha Vantage free tier ──────────────────
const AV_USD_TICKERS = new Set(["AMD", "NVDA", "MSFT", "TSLA", "MU", "AMAT", "LRCX"]);

// ── Fetch live price for a single USD ticker ──────────────────────────────────
async function getLivePrice(ticker) {
  if (!AV_USD_TICKERS.has(ticker)) return null;
  try {
    const q = await getQuote(ticker);
    return { price: q.price, chgPct: q.chgPct, date: q.latestTradingDay, source: q.source };
  } catch (err) {
    console.warn(`[portfolio] AV price failed for ${ticker}:`, err.message);
    return null;
  }
}

// ── Fetch live FX rate ────────────────────────────────────────────────────────
async function getLiveFx() {
  if (cache.has(KEYS.fx)) {
    return cache.get(KEYS.fx);
  }
  try {
    const r = await getFxRate("USD", "GBP");
    const fxData = { value: r.rate, pair: "USDGBP", date: r.lastRefreshed, source: r.source };
    cache.set(KEYS.fx, fxData, TTL_MARKET);
    return fxData;
  } catch (err) {
    console.warn("[portfolio] FX rate failed:", err.message);
    return null;
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    // Check full portfolio cache first
    if (cache.has(KEYS.portfolio)) {
      const meta = cache.getWithMeta(KEYS.portfolio);
      return res.json({
        source:    "cache",
        fetchedAt: meta.fetchedAt,
        stale:     meta.stale,
        data:      meta.value,
      });
    }

    // ── Load positions from T212 snapshot or seeds ────────────────────────────
    const snapshot = loadSnapshot();

    // Build a normalised positions array regardless of source.
    // T212 snapshot positions carry _costGBP_total directly.
    let positions;
    if (snapshot) {
      positions = snapshot.positions.map(p => ({
        ticker:        p.ticker,
        shares:        p.shares,
        currency:      p.currency,
        // Seed-compatible cost fields for rows that don't have a snapshot:
        costUSD:       p.currency === "USD" ? p.snapshotPriceNative : undefined,
        costGBP:       p.currency === "GBP" ? (p.costGBP_total / p.shares) : undefined,
        // Snapshot overrides — used below to bypass the shares×cost formula:
        _costGBP_total:          p.costGBP_total,
        _snapshotPriceNative:    p.snapshotPriceNative,
        _snapshotValueGBP_total: p.snapshotValueGBP_total,
      }));
    } else {
      positions = seeds.POSITIONS_SEED;
    }

    const tickers = [...new Set(positions.map(p => p.ticker))];

    // 1. Get FX rate
    const fxData   = await getLiveFx();
    const usdgbp   = fxData ? fxData.value : seeds.FX_SEED.usdgbp.value;
    let   anyStale = !fxData;

    // 2. Fetch live prices — AV only for USD tickers
    let priceMap = {};

    try {
      const usdTickers = tickers.filter(t => AV_USD_TICKERS.has(t));
      const results = await Promise.allSettled(usdTickers.map(t => getLivePrice(t)));
      results.forEach((r, i) => {
        if (r.status === "fulfilled" && r.value) {
          priceMap[usdTickers[i]] = r.value;
        }
      });
    } catch (err) {
      console.warn("[portfolio] Price fetch failed, using seeds:", err.message);
      anyStale = true;
    }

    // Fall back to T212 snapshot price, then to seeds for any still-missing tickers
    tickers.forEach(t => {
      if (!priceMap[t]) {
        // Try snapshot native price first
        const snapPos = positions.find(p => p.ticker === t);
        if (snapPos && snapPos._snapshotPriceNative) {
          priceMap[t] = {
            price:  snapPos._snapshotPriceNative,
            chgPct: 0,
            date:   snapshot?.importedAt?.slice(0, 10) ?? seeds.SEED_DATE.slice(0, 10),
            source: "snapshot",
          };
        } else {
          const seed = seeds.PRICES_SEED[t];
          if (seed) {
            priceMap[t] = { price: seed.price, chgPct: seed.chg, date: seed.date, source: "seeded" };
          }
        }
        anyStale = true;
      }
    });

    // 3. Compute per-position rows
    const rows = positions.map(pos => {
      const priceInfo = priceMap[pos.ticker];
      const price     = priceInfo ? priceInfo.price : (seeds.PRICES_SEED[pos.ticker]?.price ?? 0);
      const chg       = priceInfo ? (priceInfo.chgPct ?? 0) : 0;
      const src       = priceInfo ? priceInfo.source : "seeded";
      const date      = priceInfo ? priceInfo.date : seeds.SEED_DATE;

      // Value in native currency → GBP
      const valueNative = price * pos.shares;
      const valGBP = pos.currency === "USD" ? valueNative * usdgbp : valueNative;

      // Cost basis in GBP:
      //   T212 snapshot: _costGBP_total is the total already in GBP — use directly.
      //   Seeds:         shares × avg_cost_per_share (in GBP equiv)
      const costGBP_ = pos._costGBP_total !== undefined
        ? pos._costGBP_total
        : (pos.currency === "USD"
            ? pos.shares * pos.costUSD * usdgbp
            : pos.shares * pos.costGBP);

      const pnlGBP = valGBP - costGBP_;
      const pnlPct = costGBP_ > 0 ? (pnlGBP / costGBP_) * 100 : 0;

      // Determine seed cost for schema compat (costUSD / costGBP per-share fields)
      const seedPos = seeds.POSITIONS_SEED.find(s => s.ticker === pos.ticker);

      return {
        ticker:   pos.ticker,
        shares:   pos.shares,
        currency: pos.currency,
        ...(pos.currency === "USD" ? {
          costUSD: seedPos?.costUSD ?? pos.costUSD ?? (costGBP_ / pos.shares / usdgbp),
          priceUSD: price,
        } : {}),
        ...(pos.currency === "GBP" ? {
          costGBP: seedPos?.costGBP ?? pos.costGBP ?? (costGBP_ / pos.shares),
          priceGBP: price,
        } : {}),
        chg,
        valGBP:   Math.round(valGBP   * 100) / 100,
        costGBP_: Math.round(costGBP_ * 100) / 100,
        pnlGBP:   Math.round(pnlGBP   * 100) / 100,
        pnlPct:   Math.round(pnlPct   * 100) / 100,
        source:   src,
        date,
        ...(snapshot ? { positionSource: "snapshot" } : {}),
      };
    });

    // 4. Portfolio-level totals
    const totalGBP     = rows.reduce((s, r) => s + r.valGBP,   0);
    const totalCostGBP = rows.reduce((s, r) => s + r.costGBP_, 0);
    const totalPnL     = totalGBP - totalCostGBP;
    const totalPnLPct  = totalCostGBP > 0 ? (totalPnL / totalCostGBP) * 100 : 0;

    // 5. Analyst metrics
    const weights = rows.reduce((m, r) => {
      m[r.ticker] = totalGBP > 0 ? r.valGBP / totalGBP : 0;
      return m;
    }, {});

    const weightedBeta = Object.entries(weights).reduce((sum, [t, w]) =>
      sum + w * (seeds.BETAS[t] ?? 0), 0);

    const hhi = Math.round(
      Object.values(weights).reduce((sum, w) => sum + w * w, 0) * 10000
    );

    const usdExposurePct = Object.entries(weights).reduce((sum, [t, w]) =>
      sum + w * ((seeds.CCY_EXP[t]?.USD ?? 0) / 100), 0) * 100;

    const scenarioSensitivity = seeds.SCENARIOS.map(sc => {
      const impactGBP = rows.reduce((s, r) => s + r.valGBP * (sc.shocks[r.ticker] ?? 0), 0);
      const impactPct = totalGBP > 0 ? (impactGBP / totalGBP) * 100 : 0;
      return { id: sc.id, label: sc.label, prob: sc.prob,
               impactGBP: Math.round(impactGBP * 100) / 100,
               impactPct: Math.round(impactPct * 100) / 100 };
    });
    const expectedImpactPct = Math.round(
      scenarioSensitivity.reduce((sum, s) => sum + s.impactPct * (s.prob / 100), 0) * 100
    ) / 100;

    // 6. Assemble full portfolio payload
    const portfolioData = {
      rows,
      totalGBP:     Math.round(totalGBP     * 100) / 100,
      totalCostGBP: Math.round(totalCostGBP * 100) / 100,
      totalPnL:     Math.round(totalPnL     * 100) / 100,
      totalPnLPct:  Math.round(totalPnLPct  * 100) / 100,
      usdgbp,
      betas:        seeds.BETAS,
      ccyExp:       seeds.CCY_EXP,
      scenarios:    seeds.SCENARIOS,
      earningsCal:  seeds.EARNINGS_CAL,
      macroCal:     seeds.MACRO_CAL,
      analystMetrics: {
        weightedBeta:    Math.round(weightedBeta * 1000) / 1000,
        hhi,
        usdExposurePct:  Math.round(usdExposurePct * 10) / 10,
        scenarioSensitivity,
        expectedImpactPct,
      },
      ...(snapshot ? {
        snapshotMeta: {
          importedAt:   snapshot.importedAt,
          positionSource: "T212 Freestyle",
        },
      } : {}),
    };

    cache.set(KEYS.portfolio, portfolioData, TTL_MARKET);

    const overallSource = anyStale ? "seeded" : "live";
    const response = {
      source:    overallSource,
      fetchedAt: new Date().toISOString(),
      stale:     anyStale,
      data:      portfolioData,
    };

    const { ok, data, errors } = validate(schemas.PortfolioResponse, response);
    if (!ok) console.warn("[portfolio] Schema validation warnings:", errors);

    res.json(ok ? data : response);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
