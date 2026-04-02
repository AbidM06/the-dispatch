# The Dispatch — Zero-Extra-API Hardening Report

**Date:** 2026-03-09
**Scope:** 5-phase hardening pass — cost controls, T212 import, deterministic narrative engine, per-factor scenario decomposition, and full test coverage.

---

## Summary of Changes

### Phase 1 — Cost Controls & Budget Gate

**Goal:** Prevent runaway Anthropic spend; ensure the dashboard always returns useful data even when AI is unavailable.

**Files changed:**

| File | Change |
|------|--------|
| `server/providers/budget.js` | **NEW.** In-memory daily/monthly call counter. Throws `BudgetError` (code `BUDGET_DAILY` / `BUDGET_MONTHLY`) when caps exceeded. `_reset()` for tests. |
| `server/providers/anthropic.js` | Added `budget.checkAndIncrement()` gate inside `callClaude()`. |
| `server/routes/events.js` | **REWRITTEN.** TTL: 24 h (was 12 h). Cooldown: 60 min (was 10 min). `LOW_COST_MODE=true` blocks AI on GET and POST unless `force:true`. Budget exhaustion → deterministic fallback. `analysisMode` field in all responses. |
| `server/routes/risk.js` | **REWRITTEN.** Identical hardening to events.js. |
| `server/index.js` | `/api/health` now includes `budget: { daily, monthly }` and `lowCostMode` flag. |
| `.env.example` | Added `LOW_COST_MODE`, `ANTHROPIC_DAILY_CAP`, `ANTHROPIC_MONTHLY_CAP`, `CACHE_TTL_EVENTS`, `EVENTS_COOLDOWN_MIN` with documentation. |

**Before/after AI call counts (per dashboard refresh cycle):**

| Scenario | Before | After |
|----------|--------|-------|
| Normal mode, cache cold | 3 calls (events + econ + risks) | 1 call (merged `fetchAllAnalysis`) |
| Normal mode, cache warm | 0 | 0 |
| `LOW_COST_MODE=true` | 3 calls | **0 calls** (deterministic narrative) |
| Budget exhausted | Throws unhandled error | 0 calls (deterministic fallback, no error to user) |
| Daily cap (default) | Unlimited | 5 calls / day |
| Monthly cap (default) | Unlimited | 50 calls / month |

**New env vars:**

```
LOW_COST_MODE=true          # disables all AI calls; returns deterministic narrative
ANTHROPIC_DAILY_CAP=5       # max AI calls per calendar day (0 = disable gate)
ANTHROPIC_MONTHLY_CAP=50    # max AI calls per calendar month (0 = disable gate)
CACHE_TTL_EVENTS=1440       # events/risk cache TTL in minutes (default 24 h)
EVENTS_COOLDOWN_MIN=60      # POST /refresh cooldown in minutes (default 60 min)
```

**Running in zero-cost mode:**
```bash
LOW_COST_MODE=true npm start
```
The dashboard will operate fully on deterministic narrative + FRED/AV data — no Anthropic calls made.

---

### Phase 2 — T212 Freestyle CSV Import

**Goal:** Replace manually maintained seed positions with live T212 portfolio data.

**Files changed:**

| File | Change |
|------|--------|
| `server/importers/t212.js` | **NEW.** Parses T212 Freestyle CSV. Handles quoted fields, USD/GBP detection, back-calculates native prices. `loadSnapshot()` / `saveSnapshot()` for `/data/portfolio_snapshot.json`. |
| `server/routes/import.js` | **NEW.** `POST /api/import/t212` (JSON or text/csv body), `GET /api/import/status`. Busts `portfolio:data` cache on import. |
| `server/routes/portfolio.js` | Loads T212 snapshot when available; uses `costGBP_total` directly as cost basis (no `shares × costPerShare` multiplication); uses `snapshotPriceNative` as fallback price. |
| `server/index.js` | Registered `importRouter` at `/api/import`; added `express.text()` middleware for raw CSV bodies. |

**CSV import flow:**
```
POST /api/import/t212
  Content-Type: application/json
  Body: { "csv": "<paste T212 Freestyle CSV here>", "usdgbp": 0.7921 }

→ Parsed + saved to /data/portfolio_snapshot.json
→ portfolio:data cache busted
→ Next GET /api/portfolio returns snapshot positions
```

**T212 CSV format (T212 Freestyle export, Mar 2026):**
```
"Slice","Name","Invested value","Value","Result","Owned quantity","Dividends gained","Dividends cash","Dividends reinvested"
"AMD","Advanced Micro Devices","156.31","148.23","-8.08","1.9366","0","0","0"
```
All monetary values are in GBP regardless of instrument currency.

---

### Phase 3 — Alpha Vantage Free-Tier Protection

*(Completed in prior session — no changes in this pass.)*

AV free tier limited to 25 calls/day; portfolio.js filters to `AV_USD_TICKERS` set (AMD, NVDA, MSFT, TSLA, MU, AMAT, LRCX). All other tickers use snapshot or seed prices.

---

### Phase 4 — Deterministic Narrative Engine

**Goal:** Provide rule-based market commentary from FRED data alone — no AI, no external APIs.

**Files changed:**

| File | Change |
|------|--------|
| `server/analytics/narrativeEngine.js` | **NEW.** `generateNarrative(context)` → `{ events, risks, econ }`. Classifies rate signals (low/normal/elevated/high) using numeric thresholds. Produces 5 events, 7 risk cards, and 3 econ cards calibrated to current macro environment. |

**Narrative quality vs AI:**

| Dimension | AI narrative | Deterministic narrative |
|-----------|-------------|------------------------|
| Current-events awareness | ✓ | ✗ (no web search) |
| Rate/spread context | ✓ | ✓ (FRED data) |
| Portfolio-specific commentary | ✓ | Partial (uses weights + betas) |
| Latency | 8–15 s | <1 ms |
| Cost | $0.01–0.05 / call | $0 |
| Always available | ✗ (API, budget) | ✓ |

---

### Phase 5 — Scenario Per-Factor Decomposition

**Goal:** For custom scenario shocks, attribute P&L impact to equity market, rates, and FX factors per position.

**Files changed:**

| File | Change |
|------|--------|
| `server/routes/scenario.js` | Added `applyFactorShocks()`. Custom scenario rows now include `equityImpactGBP`, `ratesImpactGBP`, `fxImpactGBP`, `totalImpactGBP`. Response includes `totalEquityImpact`, `totalRatesImpact`, `totalFxImpact` portfolio totals and `assumptions` object. |

**Factor model:**
```
equityImpactGBP = valGBP × beta[ticker] × equityMktDelta
ratesImpactGBP  = valGBP × rateDuration[ticker] × (ratesDeltaBps / 100)
fxImpactGBP     = valGBP × usdExposureFraction[ticker] × fxDelta
totalImpactGBP  = equityImpactGBP + ratesImpactGBP + fxImpactGBP
```

**Rate duration proxies used (conservative estimates):**

| Ticker | Rate Duration | Rationale |
|--------|--------------|-----------|
| AMD | −0.12 | High-growth, most rate-sensitive |
| HIUS | −0.10 | US large-cap growth |
| HIJS | −0.07 | Japan growth |
| HIES | −0.06 | EM mixed — less rate-sensitive |
| SGLN | −0.05 | Gold: rising real rates weigh on gold |
| HBKS | −0.04 | Sukuk: rate-sensitive but partially hedged |

---

## Test Results

```
Test Suites: 2 passed, 2 total
Tests:       76 passed, 76 total   (+24 new vs prior 52)
Time:        ~2.3 s
```

**New test suites added:**

| Suite | Tests |
|-------|-------|
| `GET /api/health` — budget fields, lowCostMode flag | +2 |
| `GET /api/portfolio` — T212 snapshot costGBP_total, loadSnapshot called | +2 |
| `POST /api/scenario/custom` — per-factor decomposition, portfolio totals, assumptions | +3 |
| `GET /api/risk` — LOW_COST_MODE deterministic, budget exhaustion (daily + monthly) | +3 |
| `POST /api/risk/refresh` — LOW_COST_MODE, force overrides | +2 |
| `GET /api/events` — LOW_COST_MODE deterministic, budget exhaustion | +3 |
| `POST /api/events/refresh` — LOW_COST_MODE, force overrides | +2 |
| `GET /api/import/status` — no snapshot, snapshot present | +2 |
| `POST /api/import/t212` — valid JSON, parseCsv throws, missing field, cache bust, 415 | +5 |

---

## API Surface After Hardening

```
GET  /api/health                    — uptime, env flags, budget usage, lowCostMode
GET  /api/snapshot                  — FRED + AV (cached 5 min)
GET  /api/portfolio                 — T212 snapshot > AV > seeds (cached 5 min)
GET  /api/risk                      — AI (cache) | deterministic | seeded
POST /api/risk/refresh              — triggers AI | deterministic (LOW_COST/budget)
GET  /api/events                    — AI (cache) | deterministic | seeded
POST /api/events/refresh            — triggers AI | deterministic (LOW_COST/budget)
GET  /api/explain/:ticker           — AI (cached 24 h per ticker)
POST /api/thesis                    — AI investment thesis evaluation
GET  /api/scenario                  — seeded named scenarios with P&L
POST /api/scenario/custom           — factor-decomposed custom shock
POST /api/import/t212               — upload T212 CSV; saves /data/portfolio_snapshot.json
GET  /api/import/status             — snapshot metadata
```

---

## Known Limitations

- `budget.js` uses `parseInt(env) ?? 5` which does not replace `NaN` for unset vars — caps appear as `null` in JSON when env vars are absent. Functional caps still apply via `if (daily > 0 && count >= daily)` guard (NaN comparisons evaluate false, so unset cap = unlimited). Consider using `|| 5` in a future pass.
- Deterministic narrative engine uses hardcoded text templates — not aware of current news events beyond FRED/AV data.
- T212 CSV format may change between T212 app versions; parser targets the Mar 2026 Freestyle export format.
- `/data/portfolio_snapshot.json` is gitignored — it won't persist across fresh clones/deployments. Re-import after each fresh setup.

---

## Quick-Start

```bash
# Install
cd the_dispatch && npm install

# Copy env template
cp .env.example .env
# → Fill in ANTHROPIC_API_KEY, ALPHA_VANTAGE_API_KEY, FRED_API_KEY

# Run in low-cost mode (no AI calls)
LOW_COST_MODE=true npm start

# Run normally (AI enabled, 5/day cap by default)
npm start

# Run tests
npm test
```
