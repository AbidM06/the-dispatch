# The Dispatch — Project Context for Claude Code

## What this is
A personal market intelligence dashboard. Express API server (port 3001) + single-page
React frontend (`client/index.html`). View-only: a free multi-source Markets panel (FX, rates & credit, equities, commodities, crypto,
macro, prediction markets) with provenance on every value, AI analysis, on-demand trade idea
cards (News + Research), research reports and interview prep. **Nothing is executed** — the
Alpaca/auto-execution and rules-based idea engine were removed (Sep 2026; see git history).

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
| `FRED_API_KEY` | Markets panel rates/credit/macro series (+ release timestamps), correlations |
| `FINNHUB_API_KEY` | News, earnings/economic calendar, sentiment; US-stock price fallback |
| `POLYGON_API_KEY` | Strategy backtester / momentum history, vol surface (not used by Markets) |
| `ALPHA_VANTAGE_API_KEY` | No longer used by any route (provider kept, tested) |
| `MARKETS_REFRESH_TIME` / `MARKETS_TZ` / `MARKETS_SCHEDULE` | Daily Markets refresh (default 14:45 Europe/London, weekdays; `off` disables) |
| `POLYMARKET_TAGS` / `POLYMARKET_COUNT` | Prediction markets shown (default economy,geopolitics / 4) |
| `IDEAS_MODEL` | Model for idea cards (default Sonnet 4.5) |
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
  markets.js               GET /api/markets | POST /api/markets/refresh | GET /api/markets/history/:id
  ideas.js                 POST /api/ideas/news | POST /api/ideas/research | GET /api/ideas | DELETE /api/ideas/:id
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
  alphaVantage.js          Unused since the Markets panel (kept + tested)
  polygon.js               Free-tier /v2/aggs — strategy backtester / momentum history, vol surface
  fred.js                  Rates and history — getAllRates(), getRecentHistory()
  anthropic.js             fetchAllAnalysis(), fetchTickerExplain(), callClaude()
  finnhub.js               News, earnings calendar, economic calendar, sentiment
  budget.js                Per-day/month spend tracking + auto API-fallback state machine
server/markets/            instruments.js · sources.js · service.js — free Markets data + provenance
server/ideas/              generator.js · store.js — on-demand idea cards
server/jobs/               marketsScheduler.js (14:45 UK) · bulletinScheduler.js · aiRefreshJob.js
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

## Markets panel — data sources & provenance (`server/markets/`)
- `instruments.js` — the universe; each instrument lists sources in fallback order.
- `sources.js` — adapters, all free: **Yahoo Finance** chart API (unofficial, no key; primary
  for FX, yields ^TNX/^TYX, ETFs, indices, futures, stocks, crypto), **FRED** (daily/monthly
  series + `last_updated` release time), **Finnhub** `/quote` (US-stock fallback), **Frankfurter**
  (ECB reference FX fallback), **Polymarket** Gamma/CLOB (top economy/geopolitics events).
- Every quote: `value, change, changePct, asOf, releasedAt, cadence, source, sourceDetail, sourceUrl`.
- `service.js` — `refresh(trigger)` (dedupes concurrent calls), persists
  `data/markets_snapshot.json`, carries forward the last value **flagged `stale`** if every
  source fails, and writes the legacy `snapshot:rates` / `snapshot:data` cache keys that
  Events/Risk/Brief/AI-refresh read. Freshness is **measured** from the print time
  (≤2 min Real-time, ≤30 min Delayed ~N, else Last trade; FRED = Daily close / Monthly).
- `jobs/marketsScheduler.js` — in-process weekday run at 14:45 London (DST-safe via Intl),
  catch-up if the Mac slept, marks the day done even on failure.
- Routes: `GET /api/markets` (never fetches unless no snapshot exists), `POST /api/markets/refresh`
  (manual; ignored if <60 s since last), `GET /api/markets/history/:id?tf=1d|1h`, `GET /api/markets/status`.
- UI: MARKETS tab (table ↔ chart grid, click a row for its chart; TradingView Lightweight
  Charts 4.2.3 from jsDelivr, Apache-2.0 — keep the attribution logo).

## Trade idea cards (`server/ideas/`, `routes/ideas.js`)
- On-demand only: `POST /api/ideas/news {headlineId?}`, `POST /api/ideas/research {reportId|type}`;
  `GET /api/ideas`, `DELETE /api/ideas/:id`. One `callAgent("ideas")` call, **no web search**.
- The model only sees supplied inputs (headlines N#, market lines M:ID, calendar C#, report +
  SRC-xxx) and must cite them; citations are resolved server-side so links are never invented.
  Level consistency + distance-from-price warnings; long text is clipped, not rejected.
- No direction/universe restrictions (user choice). Saved to `data/idea_cards.json` (gitignored).

## Cache strategy
All data flows through `resolveWithFallback(key, fetchFn, ttl, seedData)`:
1. Warm cache → serve immediately (no fetch)
2. Live fetch → cache it
3. Stale cache (expired but present) → serve with `stale: true`
4. Seed fallback → last resort, always available

TTLs:
- FRED data (Brief/correlations): 60 min (`CACHE_TTL_FRED` env override)
- Markets snapshot: persisted; refreshed daily 14:45 UK or manually. Chart history cached
  60 min (daily) / 15 min (hourly) server-side, and per session client-side.

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
npm test   # all suites in tests/
```

Key conventions:
- `jest.resetModules()` in `beforeEach` — required because providers read `process.env`
  at module load time
- `global.fetch = mockFetch` — all HTTP mocked via Jest, no real network calls
- `tests/markets.test.js` mocks fetch by URL (Yahoo/FRED/Finnhub/Frankfurter/Polymarket);
  `tests/ideas.test.js` mocks `research/llm.callAgent` and spies `markets.getSnapshot`.

Current status: **203/203 tests passing**

---

## Write-auth middleware
`server/middleware/auth.js` guards all mutating (POST/PATCH/DELETE) routes.
- If `DISPATCH_ADMIN_KEY` env var is **not set**: no-op (dev mode, open access).
- If set: requires `x-dispatch-key` header matching exactly.
- Applied per-route (not globally) in: ideas.js, markets.js, import.js, events.js, risk.js, research.js.

## Institutional Research — five-agent pipeline + interrogation

### Architecture (`server/research/`)
```
orchestrator.js        Pipeline: draft → extract → parallel(auditor, redTeam, PM) → chair → gate → bounded revision
llm.js                 Role-based Anthropic adapter (budget-gated, per-role model env vars, optional web_search)
claimLedger.js         Claim normalization, audit merge, hard-fail detection (CLM-xxx ids)
sourceRegistry.js      Source validation/dedup/tier inference (SRC-xxx ids) — never invents URLs
qualityGate.js         15-dimension weighted score + deterministic hard fails (prob sums, unsupported claims, dangling sources)
reportStore.js         Versioned report persistence (data/research_reports/, gitignored; memory-only in tests)
interrogator.js        Truth-over-agreement chat pinned to a reportId; corrections append with audit trail
agents/                leadAnalyst (draft reuses fetchResearchReport + extraction + revision), dataAuditor,
                       redTeam, portfolioTranslator, icChair
```

### Key behaviours
- **Report types**: macro, fx, rates, thematic, equity, commodities + **sector** (new).
- **Lead draft reuses `fetchResearchReport`** so all existing report shapes/renderers are unchanged.
  QA metadata is attached to the research payload (`reportId`, `institutionalQA`, `claimsCount`, `sourcesCount`).
- Base pipeline = 6 calls (draft, extract, audit, red-team, PM, chair); each revision round +2.
  All calls pass through `budget.checkAndIncrement()` — raise `ANTHROPIC_DAILY_CAP` (e.g. 15+) for regular use.
- Reviewer failure → verdict `NOT_RUN`, disclosed in QA; never fake a passed review (seeded fallback ⇒ `QA: NOT_RUN`).
- Chair's `REVISION_REQUIRED` stands even if the numeric score passes the threshold (gate never overrides adjudication upward).
- Interrogation conversations are pinned to their reportId — a newer report sets `newerReportAvailable: true` but never swaps context.
- Corrections: `store.addCorrection()` appends `COR-xxx` entries + marks claims `CORRECTED` — history is never silently mutated.

### Endpoints
- `GET  /api/research/report?type=` (cached 24h) · `POST /api/research/report/refresh` (auth)
- `GET  /api/research/report/progress?type=` — live stage labels during generation
- `GET  /api/research/report/versions?type=`
- `GET  /api/research/report/:reportId/qa` · `GET /api/research/report/:reportId/sources`
- `POST /api/research/interrogate` `{reportId, question ≤2000ch, conversationId?}` (auth; 503 + `aiStatus: UNAVAILABLE` when AI off)

### Env vars
`RESEARCH_MULTI_AGENT` (default true), `RESEARCH_MIN_QA_SCORE` (85), `RESEARCH_MAX_VALIDATION_ROUNDS` (2),
`RESEARCH_MAX_AGENT_CALLS` (8), per-role models: `RESEARCH_{LEAD,EXTRACT,AUDITOR,REDTEAM,PORTFOLIO,CHAIR,CHAT}_MODEL`.

### Frontend (client/index.html)
QA strip (score/status/claims/sources) + expandable QA panel (agent verdicts, disagreements, claim ledger,
corrections log) + source registry viewer + interrogation chat (`.interro-*`, `.qa-*`, `.claim-*`, `.src-*` CSS).
Progress polling replaces time-guessed phase messages when the orchestrator reports a real stage.

## Scheduled refresh
The Markets refresh runs **inside the server** (`jobs/marketsScheduler.js`), weekdays 14:45
Europe/London with catch-up after sleep. The old Cowork scheduled task was removed — it ran in
a cloud sandbox and could never reach `localhost:3001`. Auto-start at login:
`bash install-autostart.sh` (launchd agent `com.thedispatch.server`).

---

## Key decisions already made — do not revisit without good reason
1. **View-only** — no order execution, no rules-based idea engine (removed; git history has it).
2. **Markets data is free-only** (budget £0). Yahoo is unofficial — keep fallbacks per instrument.
3. **Freshness is measured, not assumed** — never label a value "live" without its print time.
4. **Stale values are shown flagged**, never silently reused or replaced by seeds.
5. **One scheduled refresh per weekday** (14:45 UK) + manual button; `GET /api/markets` never fetches.
6. **Idea cards cite only supplied inputs**; server resolves links — the model cannot invent URLs.
7. **Cite-tag stripping is server-side** — React renderer cannot parse HTML in string nodes.
8. **Budget fallback is 60 min** after an Anthropic billing error.
9. **Polygon free tier** uses `/v2/aggs` not `/v2/snapshot` (403 on free tier) — backtester/momentum only.
10. **Scenario uses T212 snapshot** — falls back to seeded positions when no snapshot.
