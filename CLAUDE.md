# The Dispatch — Project Context for Claude Code

## What this is
A personal market intelligence dashboard. Express API server (port 3001) + single-page
React frontend (`client/index.html`). Tracks a watchlist of equity positions, overlaid with macro rates, AI-generated analysis, and a scenario/stress-test engine.

## How to run
```bash
npm start          # production
npm run dev        # nodemon-style watch (node --watch)
npm test           # Jest, 94 tests, ~2s
npm run test:coverage
```

## Environment variables (copy `.env.example` → `.env`)
| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API — events, risk, economic analysis, thesis, explain |
| `ALPHA_VANTAGE_API_KEY` | AMD quote + USD/GBP FX rate (2 calls/refresh) |
| `FRED_API_KEY` | Rates: DGS10, DFII10, T10YIE, BAMLH0A0HYM2, T10Y2Y |
| `POLYGON_API_KEY` | 6 watchlist peers: NVDA, MSFT, TSLA, MU, AMAT, LRCX |
| `FINNHUB_API_KEY` | News headlines, earnings/economic calendar, sentiment |
| `PORT` | Default 3001 |
| `LOW_COST_MODE=true` | Disables all AI calls; returns deterministic narrative |
| `ANTHROPIC_DAILY_CAP` | USD budget cap per day (default $5) |
| `ANTHROPIC_MONTHLY_CAP` | USD budget cap per month (default $50) |

---

## Architecture

```
client/index.html          Single-file React app (createElement, no JSX build)
server/index.js            Express entry point — mounts all routes
server/routes/
  snapshot.js              GET /api/snapshot  — rates + FX + watchlist + history
                           POST /api/snapshot/prefetch  — daily cache-bust job
  portfolio.js             GET /api/portfolio — T212 holdings + P&L computation
  events.js                GET /api/events  |  POST /api/events/refresh
  risk.js                  GET /api/risk    |  POST /api/risk/refresh
  explain.js               GET /api/explain/:ticker — per-ticker AI narrative
  thesis.js                POST /api/thesis — thesis evaluation
  scenario.js              GET /api/scenario — seeded P&L scenarios
                           POST /api/scenario/custom — custom shock with factor decomp
  import.js                POST /api/import/t212  — Trading 212 CSV → portfolio_snapshot.json
                           GET  /api/import/status
  news.js                  GET /api/news — market headlines + economic calendar
                           GET /api/news/calendar — earnings + economic events
                           GET /api/news/:ticker — company news + sentiment
server/providers/
  alphaVantage.js          AV_SUPPORTED = ["AMD"] only (peers moved to Polygon)
  polygon.js               Free-tier /v2/aggs endpoint — 6 peers, parallel calls
  fred.js                  Rates and history — getAllRates(), getRecentHistory()
  anthropic.js             fetchAllAnalysis(), fetchTickerExplain(), callClaude()
  finnhub.js               News, earnings calendar, economic calendar, sentiment
  budget.js                Per-day/month spend tracking + auto API-fallback state machine
server/cache.js            In-memory TTL cache singleton
server/retry.js            withRetry(), fetchWithTimeout(), isRetryable()
server/schemas/index.js    Zod schemas — validate() wrapper
server/analytics/
  narrativeEngine.js       Deterministic fallback narrative (no AI)
server/importers/
  t212.js                  Trading 212 CSV parser
server/engine/
  glossary.js              80+ trading terms across 7 categories with definitions,
                           examples, Islamic notes, and S&T interview angles
  universeScanner.js       Scans all 33 Shariah-compliant tickers against macro regime
server/routes/
  glossary.js              GET /api/glossary — full glossary
                           GET /api/glossary/term-of-the-day
                           GET /api/glossary/categories
                           GET /api/glossary/category/:cat
                           GET /api/glossary/search?q=
                           GET /api/glossary/:slug
seeds/fallback.js          Seed data for graceful degradation when all providers fail
data/                      portfolio_snapshot.json lives here (gitignored)
```

---

## Provider split — critical context

### Alpha Vantage (free tier: 25 calls/day, 5/min)
- **Only 2 calls per refresh**: AMD quote + USD/GBP FX rate
- `AV_SUPPORTED = new Set(["AMD"])` — do not add more symbols here
- Previously served 7+ watchlist symbols; reduced after rate-limit exhaustion

### Polygon.io (free tier: unlimited/day, 5/min, ~15-min delay)
- Serves 6 watchlist peers: `POLYGON_PEERS = new Set(["NVDA","MSFT","TSLA","MU","AMAT","LRCX"])`
- Uses `/v2/aggs/ticker/{sym}/range/1/day/{from}/{to}?adjusted=true&sort=desc&limit=2`
  — **NOT** `/v2/snapshot/...` which is paid-only (returns HTTP 403 on free tier)
- 6 parallel calls via `Promise.allSettled` — per-ticker failures are logged + skipped
- `results[0].c` = latest close; `results[1].c` = prev close → compute `chgPct`
- 14-day lookback window covers weekends and public holidays

### Finnhub (free tier: 60 req/min, no daily cap)
- Market news: `getMarketNews()` — general headlines
- Company news: `getCompanyNews(ticker)` — per-ticker, last 7 days
- Earnings calendar: `getEarningsCalendar()` — 45-day lookahead
- Economic calendar: `getEconomicCalendar()` — FOMC, CPI, NFP events
- News sentiment: `getNewsSentiment(ticker)` — bullish/bearish %
- TTL: 30 min for news, 60 min for calendars
- No-op when FINNHUB_API_KEY not set (graceful degradation to empty arrays)

### FRED (no rate limit for reasonable usage)
- Rates: DGS10 (10Y nominal), DFII10 (10Y real), T10YIE (breakeven inflation),
  BAMLH0A0HYM2 (HY spread), T10Y2Y (yield curve)
- TTL: 60 min (data only updates once daily)
- Transient 504 errors are common — graceful degradation to stale cache / seed handles them

---

## Cache strategy
All data flows through `resolveWithFallback(key, fetchFn, ttl, seedData)`:
1. Warm cache → serve immediately (no fetch)
2. Live fetch → cache it
3. Stale cache (expired but present) → serve with `stale: true`
4. Seed fallback → last resort, always available

TTLs:
- FRED data: 60 min (`CACHE_TTL_FRED` env override)
- Market data (AV + Polygon): 30 min (`CACHE_TTL_MARKET` env override)

---

## Budget / API fallback system
`server/providers/budget.js` tracks Anthropic spend:
- `ANTHROPIC_DAILY_CAP` / `ANTHROPIC_MONTHLY_CAP` — configurable
- When billing error (402/529) detected, `setApiFallback(60_000 * 60)` enters 60-min
  deterministic fallback mode
- `getApiFallbackInfo()` returns `{ active: bool, retryAfter: ISO string }`
- `callClaude()` in `anthropic.js` checks this before every API call
- Route-level catch blocks in `events.js` and `risk.js` also call `setApiFallback()`
  as a safety net (tests mock `fetchAllAnalysis` directly, bypassing `callClaude`)
- `LOW_COST_MODE=true` disables AI entirely (separate from fallback)

---

## Scenario engine — custom scenarios
`POST /api/scenario/custom` uses `applyFactorShocks()` (not `applyShocks()`).
These return different field shapes:

| `applyShocks()` | `applyFactorShocks()` |
|---|---|
| `r.impactGBP` | `r.totalImpactGBP` |
| `r.shockPct` | (compute from `r.totalImpactGBP / r.currentValGBP * 100`) |
| — | `r.equityImpactGBP`, `r.ratesImpactGBP`, `r.fxImpactGBP` |

The React renderer in `client/index.html` uses the `applyFactorShocks` field names.
**Do not** use `r.impactGBP` or `r.shockPct` in the custom scenario path — they are
`undefined` there, causing `.toFixed()` to crash and blank the screen.

---

## AI text pipeline — cite-tag stripping
Claude's web_search tool emits `<cite index="0-2">text</cite>` markup into JSON string
fields. This is stripped server-side before returning to the client.

`stripCiteTags(str)` in `server/providers/anthropic.js` is applied to:
- `fetchAllAnalysis()` — events (headline, detail), risks (title, detail), econ (title, body)
- `fetchTickerExplain()` — what, now, portfolio fields

Do not remove this — the React renderer uses plain string nodes and would display raw tags.

---

## Test patterns
```bash
npm test   # runs tests/endpoints.test.js + tests/providers.test.js
```

Key conventions:
- `jest.resetModules()` in `beforeEach` — required because providers read `process.env`
  at module load time
- `global.fetch = mockFetch` — all HTTP mocked via Jest, no real network calls
- Polygon mock in `endpoints.test.js`:
  ```js
  jest.mock("../server/providers/polygon", () => ({
    getSnapshots: jest.fn(),
    POLYGON_PEERS: new Set(["NVDA","MSFT","TSLA","MU","AMAT","LRCX"])
  }))
  ```
- `providers.test.js` Polygon suite: one `mockFetch` call per ticker (parallel calls),
  using `aggsResponse(sym, bars)` helper with `bar(close, epochMs)` shape

Current status: **213/213 tests passing**

---

## Write-auth middleware
`server/middleware/auth.js` guards all mutating (POST/PATCH/DELETE) routes.
- If `DISPATCH_ADMIN_KEY` env var is **not set**: no-op (dev mode, open access).
- If set: requires `x-dispatch-key` header matching exactly.
- Applied per-route (not globally) in: ideas.js, import.js, events.js, risk.js, snapshot.js.

## Execution framework (safety defaults)
All execution is **disabled by default**. To enable paper trading:
1. `TRADING_ENABLED=true` — master switch
2. `AUTO_APPROVE_PAPER=true` — auto-approve engine ideas
3. `ALPACA_AUTO_EXECUTE=true` — enable Alpaca order placement
4. Configure Alpaca keys

Circuit breakers (`server/analytics/executionPolicy.js`):
- `MAX_TRADES_PER_DAY=3`, `MAX_NOTIONAL_GBP_PER_DAY=250`
- `MAX_OPEN_POSITIONS=5`, `MAX_SINGLE_TICKER_EXPOSURE_PCT=20`
- Freshness gate: `TRADING_DATA_MAX_AGE_MIN=20` (skip execution if data > 20 min old)
- State persisted in `data/execution_state.json` (daily reset)

Position sizing (`server/engine/positionSizing.js`):
- `RISK_PER_TRADE_PCT=0.5`, `MAX_POSITION_PCT=8`, `MIN_ORDER_NOTIONAL_GBP=25`

## Approval workflow
Engine-generated ideas are persisted with `executionStatus: "PENDING_APPROVAL"`.
- `GET /api/ideas/pending` — list pending ideas
- `POST /api/ideas/:id/approve` — approve + optionally execute (checks freshness, policy, sizing)
- `POST /api/ideas/:id/reject` — reject with reason
- `GET /api/ideas/journal` — playbook/regime performance stats
- All execution actions logged to `data/execution_log.jsonl`

## Shariah enforcement
- `POST /api/ideas` rejects `direction: "SHORT"` with 400 + `shariahRule: "gharar"`
- Engine (`ideaEngine.js`) also blocks SHORT via `isTransactionPermitted("shortSelling")`

---

## Phase 3 — Exit engine, backtesting, sync, bracket orders, webhooks

### Exit engine (`server/engine/exitEngine.js`)
Scans OPEN ideas against current watchlist prices and macro context. Returns exit signals
(CLOSE or REVIEW recommendations) with reasons.

4 exit playbooks added to `server/engine/playbooks.js` (category `"exit"`):
- `exit-target-hit` — current price >= target
- `exit-stop-hit` — current price <= stop
- `exit-regime-change` — macro regime has shifted materially
- `exit-time-expiry` — idea open longer than 120% of stated horizon

Exit playbooks are NOT included in `generateIdeas()` runs (only `macro`/`structure`/`portfolio`
categories are allowed). They are only used by `exitEngine.checkExits()`.

### New endpoints (Phase 3)
- `GET /api/ideas/exits` — run exit check on all open ideas, returns signals
- `GET /api/ideas/backtest?categories=macro,structure` — deterministic historical backtest using RATES_HISTORY_SEED
- `GET /api/ideas/execution-log?days=7` — query execution audit log with summary by decision
- `POST /api/ideas/sync` — sync Alpaca positions with local ideas (auth-required, closes ideas where position is gone)
- `GET /api/ideas/universe-scan` — ranked candidates from full Shariah universe

### Bracket orders (`server/providers/alpaca.js`)
`placeBracketOrder(ticker, side, qty, limitPrice, takeProfitPrice, stopLossPrice)` places
entry + take-profit + stop-loss as a single atomic order. Opt-in via `USE_BRACKET_ORDERS=true`.
Default off — market orders are simpler and more reliable for paper trading.

### Webhook notifications (`server/providers/webhook.js`)
Fire-and-forget POST webhook for idea lifecycle events. Env: `WEBHOOK_URL`, `WEBHOOK_SECRET`.
Events: `idea.pending`, `idea.executed`, `idea.rejected`, `exit.signal`.
No-op when `WEBHOOK_URL` is not set.

### Live price at approval time
`POST /api/ideas/:id/approve` now fetches a fresh price for the idea's ticker before sizing.
Uses AV for AMD, Polygon for peers, falls back to cached `idea.entry` for LSE ETFs.
Response includes `priceSource` and `livePrice` fields.

### Historical backtester (`server/engine/backtester.js`)
Pure computation on seeded data (RATES_HISTORY_SEED + HY_HISTORY_SEED). Tests each playbook
against each historical monthly context. Returns trigger rates, regime distribution, and
top setups. No API calls.

---

## Scheduled task
A daily prefetch task (`dispatch-daily-price-prefetch`) runs at 09:37 AM on weekdays and
calls `POST /api/snapshot/prefetch` to warm the cache before market opens. This uses
exactly 2 AV calls (AMD + FX) + 6 Polygon calls.

---

## Key decisions already made — do not revisit without good reason
1. **Polygon free tier** uses `/v2/aggs` not `/v2/snapshot` (403 on free tier)
2. **AV limited to AMD only** — adding more AV symbols will exhaust the 25 calls/day limit
3. **`Promise.allSettled`** in `polygon.js` — partial results are better than total failure
4. **30-min market cache TTL** — short enough for intraday staleness badge, long enough
   to not hammer APIs
5. **Cite-tag stripping is server-side** — React renderer cannot parse HTML in string nodes
6. **Budget fallback is 60 min** — matches AV's rate-limit cooldown window
7. **All execution disabled by default** — requires TRADING_ENABLED + ALPACA_AUTO_EXECUTE + AUTO_APPROVE_PAPER
8. **Freshness gate** — auto-execution skipped if snapshot data > 20 min old
9. **Alpaca allowed hosts** — only `paper-api.alpaca.markets` by default (configurable via ALPACA_ALLOWED_HOSTS)
10. **SHORT ideas rejected** — Shariah gharar prohibition on manual idea creation
11. **Scenario uses T212 snapshot** — falls back to seeded positions when no snapshot
12. **Bracket orders default off** — `USE_BRACKET_ORDERS=true` required (market orders are simpler)
13. **Webhook is fire-and-forget** — does not block response path; failures logged to console
14. **Backtester uses seeded data only** — no API calls; pure deterministic computation
