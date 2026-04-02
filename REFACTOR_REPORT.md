# The Dispatch — Refactor Report
**Date:** 9 March 2026
**Scope:** Phases 1–4 (Correctness → Efficiency → Portfolio UI → Tests)

---

## 1. Changed Files

| File | Phase | Change |
|------|-------|--------|
| `seeds/fallback.js` | Pre-work | Fresh T212 positions, prices, FX (Mar 9 2026) |
| `server/routes/portfolio.js` | 1a | Cost-basis fix; analystMetrics added |
| `server/routes/scenario.js` | 1b | Scenario engine fix (use `.price` not `.priceUSD`) |
| `server/routes/snapshot.js` | 1c | ratesHistory filter to require all 3 values |
| `server/schemas/index.js` | 1c | `real`/`bei` nullable; `analystMetrics` schema; `"computed"` source |
| `server/providers/alphaVantage.js` | 2a | Throttle, budget guard, per-symbol cache, AV_SUPPORTED whitelist |
| `server/providers/anthropic.js` | 2b | `fetchAllAnalysis()` merged call; Haiku model; reduced tokens |
| `server/routes/events.js` | 2b | Uses `fetchAllAnalysis`; TTL 12h; 10-min cooldown |
| `server/routes/risk.js` | 2b | Uses `fetchAllAnalysis`; TTL 12h; 10-min cooldown |
| `server/routes/explain.js` | 2b | TTL raised 4h → 24h |
| `client/index.html` | 3 | Portfolio tab: replaced P&L summary cards with analyst metrics |
| `tests/endpoints.test.js` | 4 | 37 → 52 tests; new suites for all changes above |

---

## 2. What Was Fixed

### Phase 1 — Correctness

**Portfolio cost basis (critical):**
`costGBP_` was calculated as `costUSD × usdgbp` — a per-share cost, not a total.
Fix: `costGBP_ = shares × costUSD × usdgbp` (USD) or `shares × costGBP` (GBP).
Effect: AMD cost basis changed from ~£164 (wrong) to ~£291 (correct for 1.77 shares × $220.69 × 0.7448).

**Scenario engine (critical):**
`seedPositionValues()` accessed `price.priceUSD` and `price.priceGBP` — fields that don't exist in `PRICES_SEED`. Both resolved to `undefined ?? 0 = 0`, making every scenario impact £0.
Fix: use `priceEntry.price` (the actual field) with explicit USD→GBP conversion only for USD positions.
Effect: Bear scenario (AMD −25%, HIES −15%, etc.) now correctly shows ~−£130 total impact.

**ratesHistory schema warning:**
Filter only excluded `y10 === null`, allowing `real`/`bei = null` rows through, which failed Zod validation.
Fix: filter requires all three non-null; `real`/`bei` made nullable in schema as additional safety net.

### Phase 2 — Efficiency

**Alpha Vantage (Phase 2a):**
- `AV_SUPPORTED` whitelist prevents wasted calls for LSE ETFs (HIES/HIUS/HIJS/SGLN/HBKS) that always return errors on AV free tier
- Global 1.1 s throttle prevents rate-limit bursts
- Daily budget guard (20 calls/day) throws 429-style error once exhausted, forcing cache/seed fallback
- Per-symbol 5-min cache deduplicates snapshot ↔ portfolio calls for the same ticker

**Anthropic (Phase 2b):**
- `fetchAllAnalysis()` replaces three separate calls (events + risk + econ → 1 merged call)
- Model switched from `claude-sonnet-4-6` → `claude-haiku-4-5-20251001` (5–10× cheaper per token for structured JSON)
- 10-min cooldown guard returns cache/seed instead of calling AI again
- `force: true` override available for manual refresh
- events.js refresh also writes risk cache as side-effect (and vice versa) — so one refresh populates both panels
- Explainer TTL raised 4h → 24h (content is stable: "what is AMD" doesn't change hourly)

### Phase 3 — Portfolio Tab UI

Replaced the 4-card summary row:

| Before | After |
|--------|-------|
| Portfolio Value | Portfolio Value (with FX sublabel) |
| Cost Basis | Weighted Portfolio β |
| Unrealised P&L (inaccurate) | HHI Concentration |
| USD/GBP | Unhedged USD Exposure % |

Added Scenario Sensitivity banner below the cards showing Bear / Base / Bull impact in £ and %, plus a probability-weighted expected value with an educational note for the economics student audience.

---

## 3. Before vs After: API Call Volumes

### Alpha Vantage
| Scenario | Before | After |
|----------|--------|-------|
| Cold page load (snapshot + portfolio both need AMD) | 2 AV calls | 1 AV call (5-min cache hit) |
| LSE ETFs (HIES/HIUS/HIJS/SGLN/HBKS) | 5 wasted AV calls → error | 0 (whitelist filter) |
| Daily maximum | ~25 (free tier exhausted) | 20 (budget guard) |
| Rate limit errors | Frequent | Eliminated |

### Anthropic
| Scenario | Before | After |
|----------|--------|-------|
| Full refresh (events + risk + econ) | 3 calls | 1 call (`fetchAllAnalysis`) |
| Model | claude-sonnet-4-6 | claude-haiku-4-5-20251001 |
| Estimated token cost per refresh | ~$0.009 (Sonnet) | ~$0.0008 (Haiku) — ~11× cheaper |
| Cache TTL | 4h | 12h (events/risk/econ), 24h (explainers) |
| Calls per 24h at 12h TTL | up to 6 | 2 (+ manual refreshes) |
| Rate-limit errors | Occasional (burst) | Eliminated (cooldown guard) |

---

## 4. Test Results

```
Test Suites: 2 passed, 2 total
Tests:       52 passed, 52 total  (was: 37 passed)
Time:        2.255 s
```

### New tests added (15 new, across endpoints.test.js):

- `costGBP_ = shares × avg_cost_per_share` — portfolio correctness fix
- `pnlGBP = valGBP − costGBP_` — P&L consistency check
- `analystMetrics` present, HHI in [0, 10000], beta > 0, usdExposurePct in [0, 100]
- Scenario non-zero impacts with seed prices (scenario engine fix)
- Scenario row impacts sum to totalImpactGBP (math consistency)
- Custom scenario returns computed result with non-zero impact for −10% equity shock
- Custom scenario input validation (equityMktDelta > 1 rejected)
- `fetchAllAnalysis` called once per refresh (not `fetchMarketEvents` + `fetchEconAnalysis`)
- POST /risk/refresh populates events cache as side-effect
- POST /events/refresh populates risk cache as side-effect
- Cooldown: second refresh within 10 min returns `_cooldown` without calling AI
- `force: true` bypasses cooldown and calls AI
- Explain: different tickers cached independently (AI called twice for two different tickers)

---

## 5. Remaining Limitations

1. **Watchlist prices are seed-only for LSE ETFs.** HIES/HIUS/HIJS/SGLN/HBKS have no live price feed (AV doesn't support LSE; AI watchlist fallback was removed to conserve tokens). Prices are updated manually in `seeds/fallback.js`.

2. **RSI history is seeded.** No live data source for AMD RSI — updated manually. The 14-period RSI chart will show the last seeded value until the seed is refreshed.

3. **Portfolio cost basis uses T212 average cost.** If positions are adjusted on T212 (additional buys/sells), `seeds/fallback.js` must be updated manually for P&L to remain accurate.

4. **Scenario shocks are static.** The named bear/base/bull shocks in `seeds/fallback.js` are manually maintained. They are directionally correct but not recalculated from live volatility data.

5. **Anthropic `tool_choice: any` requires the model to use web_search.** If Anthropic's web search tool is unavailable or rate-limited, all AI endpoints will fail gracefully to cache/seed but will show stale data.

6. **No authentication.** The API is open — suitable for localhost demo, not for public deployment.
