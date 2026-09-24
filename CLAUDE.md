# The Dispatch — Project Context for Claude Code

## What this is
A personal market intelligence dashboard. Express API server (port 3001) + single-page
React frontend (`client/index.html`). Tracks a watchlist of equity positions, overlaid with macro rates, AI-generated analysis, and a scenario/stress-test engine.

## How to run
```bash
npm start          # production
npm run dev        # nodemon-style watch (node --watch)
npm test           # Jest, 342 tests, ~10s
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
| `LOW_COST_MODE=true` | Disables all AI calls; returns deterministic, level-only narrative |
| `DEMO_MODE=true` | Serve hand-entered seed fixtures (tagged `kind:"demo"`) when providers fail. Off by default |
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
  macroContext.js          Cross-asset fact layer — 11 free FRED series with per-fact
                           provenance; feeds EVERY research report. Also derives the
                           labelled Fed policy-path proxy (DGS2 − DFF).
  anthropicBatch.js        Message Batches API — 50% rate for the daily report run
  alphaVantage.js          AV_SUPPORTED = ["AMD"] only (peers moved to Polygon)
  polygon.js               Free-tier /v2/aggs endpoint — 6 peers, parallel calls
  fred.js                  Rates and history — getAllRates(), getRecentHistory()
  anthropic.js             fetchAllAnalysis(), fetchTickerExplain(), callClaude()
  finnhub.js               News, earnings calendar, economic calendar, sentiment
  budget.js                Per-day/month spend tracking + auto API-fallback state machine
server/provenance.js       Fact constructor, KIND vocabulary, per-source freshness rules
server/demoMode.js         DEMO_MODE switch — the only path by which seeds are served
server/cache.js            In-memory TTL cache singleton
server/retry.js            withRetry(), fetchWithTimeout(), isRetryable()
server/schemas/index.js    Zod schemas — validate() wrapper
server/jobs/
  researchBatchJob.js      Daily batched generation of all six research reports
server/analytics/
  narrativeEngine.js       Deterministic, level-only narrative from dated facts (no AI)
  analysisStore.js         events/risk/econ cache that keeps how each item was produced
  regime.js                Level labels + curveMove() (needs both legs' changes)
  eventCalendar.js         Dated event calendar from cached Finnhub data, else unavailable
server/importers/
  t212.js                  Trading 212 CSV parser
server/engine/
  executionGate.js         prepareOrder(): the one fail-closed path to an order
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

## Cross-asset context layer — read this before touching research prompts

`server/providers/macroContext.js` is the single fact source for **every** report type.

The failure it fixes: report types used to fetch only their own data. Commodities got
oil, macro got a rates history, and equity got five spot rates and nothing else. An
equity report therefore could not see crude or the policy path, so it could not reason
about the two channels that drive equities hardest — energy costs into margins, and real
yields into multiples. The model was not ignoring the macro picture; the macro picture
was never in the request.

`getMacroContext()` fetches 11 free FRED series in parallel — rates, credit, Brent, WTI,
VIX, EUR/USD — and returns each as a **Fact** carrying its own `source`, `seriesId` and
`asOf` (the observation date, not the fetch time — a Friday close served on Monday must
read Friday). Per-series failures are tolerated and named in `missing`, so "not fetched"
stays distinguishable from "fetched as zero".

Note FRED's daily oil series (`DCOILBRENTEU`, `DCOILWTICO`) is fresher than the EIA weekly
feed used for the commodities charts, which lags ~1 week.

`toPromptBlock()` renders those facts as a VERIFIED MARKET DATA block and tells the model
not to search for figures it has already been handed. That is both an accuracy win (no
fabricated spot prices) and a cost win (fewer web_search calls).

**Fed policy path is a labelled proxy, not a probability.** There is no free, documented
API for CME FedWatch, so the codebase does not pretend to have one. `derivePolicyPath()`
computes 2Y UST minus effective fed funds (DGS2 − DFF) and reports a DIRECTION with a
±25bp neutral band. Every field says it is a proxy and the prompt forbids restating it as
market-implied odds. Do not relabel this as a probability.

## Provenance model — read this before touching any data path

`server/provenance.js` is the vocabulary. Every displayed number is exactly one KIND:

| kind | meaning |
|---|---|
| `observed` | a provider value for a stated observation date |
| `calculated` | arithmetic on observed inputs; carries `inputs[]` with their dates |
| `estimate` | a model forecast or an assumption (research `estimates[]`) |
| `unavailable` | we do not have it; `reason` says why |
| `demo` | hand-entered fixture, only in `DEMO_MODE` |

Two clocks, never merged: **`observedAt`** (when the market produced it — decides
freshness) and **`retrievedAt`** (when we fetched it — decides nothing). Precision is
never invented: a date-only observation is `observedAtPrecision: "date"`.

Freshness is judged per source by `assessFreshness()` on the OBSERVATION date, at READ
time, in business days (weekends skipped; holidays not modelled): `current` → `lagging`
(normal slack, e.g. a holiday) → `stale` (provider/cache problem). Summaries report the
**oldest** observation (`summariseComponents`), never the newest.

| Source | Actual frequency | Observation date handling | Expected lag | Permitted uses |
|---|---|---|---|---|
| FRED rates, OAS, DFF, VIX | daily | FRED `date`; latest *valid* row of the last 10 (`.` skipped) | 1 business day | display, prompts, signals, regime labels |
| FRED Brent/WTI, EUR/USD (H.10) | daily obs, weekly release | FRED `date` | ~6 business days (normal) | display, prompts |
| EIA petroleum | weekly | period | ~8 business days | commodities charts |
| Polygon `/v2/aggs` (free) | daily bar | bar date | 1 business day | display, idea reference levels — **never execution** |
| Alpha Vantage `GLOBAL_QUOTE` | daily quote | `latest trading day` | 1 business day | display, idea reference levels — **never execution** |
| ExchangeRate-API (keyless) | ~daily reference rate | provider `time_last_update_unix` (not our clock) | 1 business day | GBP conversion, display |
| Alpha Vantage FX (fallback) | provider refresh | `Last Refreshed` + `Time Zone` | — | as above |
| Finnhub calendars | per event | full `YYYY-MM-DD` only; year-less dates rejected | — | event-risk checks, brief |
| Anthropic `web_search` | per report | cited page; `grounding` block | — | research prose only; not verified facts |
| seeds/fallback.js | fixed (Mar 2026) | n/a — `kind:"demo"` | n/a | `DEMO_MODE` display only |

**Executable price:** none of the free feeds provides one. `executionGate` requires a
timestamped quote ≤ `TRADING_PRICE_MAX_AGE_MIN` minutes old; daily closes never qualify,
so execution is blocked by design. Do not relax this to make execution "work".

Zod response schemas use `.passthrough()` on every provenance-bearing object. Zod strips
unknown keys by default and `validate()` returns the parsed copy, so a schema without it
silently deleted provenance fields on the way to the client.

## No fabricated fallbacks — deliberate

`server/routes/research.js` used to carry six hand-written "deterministic" reports served
whenever AI generation failed. They read exactly like live research and every figure was
hardcoded; the commodities seed asserted a Strait of Hormuz closure with a 17mb/d supply
shock that had never happened.

They are gone and must not come back. On failure the route returns HTTP 503 with
`available: false`, the reason, and the timestamp of the last successful run; the client
renders an unavailable panel. A report that invents a crisis is worse than no report.
A test asserts the seed builders stay deleted.

**The same class was still live in the Sales tab, and this file wrongly said it was not.**
`server/routes/macro.js` carried `buildMacroViewFallback()` and `buildClientFallback()`,
which between them asserted a Fed level of "4.25-4.50%", scenario probabilities of
60/20/20, a complete trade idea with entry/stop/target, CPI/FOMC/NFP catalysts dated
April and May 2026, and client talking points claiming real yields were "the highest
since 2007-era". Both are deleted; `/api/macro/view` and `/api/macro/clients` now return
503 with the same contract as research, and the client renders the same unavailable panel.

Worse, the Sales tab never had live data to begin with. `rateVal()` probed for an
`observations` array that `fred.getAllRates()` has never returned, so it fell through to
its hardcoded fallback (4.2 / 1.85 / 2.38 / 3.2 / 0.5) on every single call — and those
constants were passed to the model described as "latest FRED data". Invented data wearing
a source label is worse than no data. `rateVal(fact)` now reads `.value` and has no
fallback parameter; missing means null, and callers say so.

The lesson generalises: **fixing one instance of a failure class is not fixing the class.**
When you delete a fabricated fallback, grep the repo for its siblings before writing here
that the class is gone. The provenance audit found and removed the siblings:

- `narrativeEngine.js` (LOW_COST prose): back-filled missing rates with hardcoded levels,
  dated every card TODAY, and served a war, a tariff package, a GPU order and P/E
  elasticities as current. Rewritten to use only dated facts; items are `kind:"calculated"`.
- `events.js` / `risk.js`: cached the deterministic narrative under the AI keys and read it
  back as `analysisMode:"ai"`. `analytics/analysisStore.js` now stores the mode with the
  items. Seed events/risks are `DEMO_MODE`-only; otherwise `unavailable`.
- `brief.js`: computed "what changed" against a hardcoded `PREV_RATES` forever. Deltas now
  come from dated FRED history.
- `ideas.js` `deterministicIdeas()` (hardcoded entries 192/74/8.65, a 19 Mar FOMC catalyst)
  and a hardcoded "KEY EVENTS" line sent to the AI prompt — deleted.
- Playbooks priced every idea off `priceFmt(ctx, "SGLN", 74.00)` fallbacks. Unpriced ideas
  now carry `entry/stop/target: null` and say so.
- AI prompts presupposed events ("US/Israel-Iran War" as risk #1 every run) and carried
  worked examples with concrete figures. Both removed.

Reports also carry `grounded`. The OpenAI fallback tier has no web_search, so anything it
produces comes from training data — that path sets `grounded: false` and the client shows
a warning rather than presenting the output as searched.

## Equity report schema — why it has a scenarios block

Every other report type had a risk or scenario container; equity had none. Its only risk
surface was a one-sentence `keyRisk` per sector, so the model had nowhere to write a
stress test even when the macro context called for one. Absent fields produce absent
analysis.

The schema now requires `crossAssetContext` (energy / rate / policy / volatility
channels, each with a severity), `rateSensitivity`, `scenarios` (bear/base/bull with EPS
and index outcomes), `risks[]`, `invalidation`, `estimates[]` and `unverified[]`.

Placeholder values in the prompt are type descriptors (`"<percent>"`), never worked
examples. The old template read `"<e.g. 46% of index EPS growth>"` and reports reliably
came back asserting exactly 46%. Do not reintroduce concrete example figures.

`estimates[]` is the model declaring which figures are its own forecasts rather than
measured data; the client renders it as a separate table. `unverified[]` is what it could
not confirm — surfacing that is the point, not a defect.

## Research grounding and citations

Both the synchronous and batch paths exit through `finalizeResearchReport()`, which
validates against `ResearchSchemas` in `server/schemas` (each type's prompt contract,
including `estimates[]` and `unverified[]`) and attaches a `grounding` block:
`{ searchEnabled, tier, sourcesReturned, resolvedCitations, unresolvedCitations, grounded,
meaning }`. A cite marker whose index points at no returned source is kept visibly as
`[citation unresolved]` rather than stripped. `report.dataAsOf` is the OBSERVATION span of
the FRED inputs plus a separate `retrievedAt` — regenerating a report does not make its
data newer.

## Research batching
`server/jobs/researchBatchJob.js` pre-generates all six reports daily via the Message
Batches API at 50% of the synchronous rate (`RESEARCH_BATCH_TIME`, default 06:40).
Prompts come from `buildResearchSpec()` — the same code the synchronous path uses, so the
two cannot drift apart. Anything the batch fails to deliver is regenerated synchronously,
so batching affects cost only, never availability.

Interactive paths (explain, thesis, bulletin) stay synchronous — batch latency is measured
in minutes and would be visible there.

## Execution controls — the callers, not the policy

`executionPolicy.checkPolicy()` was correct. Both of its callers defeated it.

- It was invoked with a **placeholder** `notionalGBP: 100` *before* sizing ran, so the
  £250 daily notional cap was tested against £100 regardless of the real order. A ticket
  sizing to £6,000 passed a £250 cap.
- `const qty = (!sizing.blocked && sizing.qty > 0) ? sizing.qty : 1` turned every sizing
  **rejection** into a one-share order. An entry of 100 against a stop of 110 is an
  invalid LONG; it still submitted.
- `openPositions` and `portfolioGBP` were never passed, and `checkPolicy` treats a missing
  `openPositions` as 0 and skips the single-ticker cap entirely without `portfolioGBP` —
  so two of the four advertised circuit breakers could never fire.
- Account equity defaulted to £75,000 (auto path) and £1,110 (approve path) when the
  fetch failed, sizing real orders against a portfolio that did not exist.

Both callers now go through **`server/engine/executionGate.js` → `prepareOrder()`**, which
fails closed in this order: direction (LONG only) → executable price (timestamped quote,
≤ `TRADING_PRICE_MAX_AGE_MIN`; daily closes rejected) → account equity → open positions →
FX (dated, ≤ `TRADING_FX_MAX_AGE_HOURS`) → sizing (from the executable price, not the
idea's planning `entry`) → policy with final qty, GBP notional, position count, equity and
existing ticker exposure. `checkPolicy()` itself now refuses missing inputs instead of
reading them as zero. **Never reintroduce a placeholder notional, a quantity fallback,
or a default FX/equity.** Tests exercise this with a mocked broker and injected quotes.

`checkFreshness()` also measured the wrong thing: `fetchedAt` is when we wrote the cache,
not when the market measured the figure, so a freshly-cached 2020 observation satisfied
the 20-minute rule. It now additionally bounds the newest observation date
(`TRADING_DATA_MAX_OBS_AGE_DAYS`, default 4 — FRED series are daily, so the window is in
days, not minutes).

## Disclosure is enforced, not requested

`estimates[]` (figures the model produced itself) and `unverified[]` (what it could not
confirm) were prompt-only instructions on one report type out of six. A report that
ignored them validated fine and rendered as though every figure were measured —
`{"title":"Incomplete","epsOutlook":{}}` passed the equity gate.

The disclosure contract now lives in `ACCURACY_RULES`, so every report type is asked for
both arrays, and `REPORT_VALIDATORS` rejects any report that omits them. Equity
additionally requires `crossAssetContext`, `scenarios`, `invalidation` and a non-empty
`risks[]`.

Validation cannot prove a report is truthful. It can refuse one that declines to say
which parts are guesses, and that is the difference between a disclosure mechanism and a
disclosure aspiration.

## Levels are not changes

"Steepener" and "flattener" describe how a curve is **moving**. A level cannot support
either word. `buildCtx()` emitted "Bear steepener" from a curve level and "Bear flattener"
from the HY spread and real yields — two mutually exclusive directions, neither derived
from a curve movement, both able to land in the same string. `t10y2y: 0.8` produced
"Bear steepener + Elevated real yields + Bear flattener".

Regime labels now name shape and level only, from one module: `server/analytics/regime.js`
(`classifyLevels`). `curveMove(d2yBp, d10yBp)` names bull/bear steepener/flattener and
returns `null` unless BOTH legs' changes are supplied. `deltas.t10y2y_d` is `null`: no 2Y
history is fetched. Missing rates are named in `missing`, never compared — `null < 0.3` is
`true` in JavaScript, which once made a missing curve read as "flat".

Deltas and MA/mean-reversion signals use the dated FRED history in the snapshot cache and
state their window. They never compare a live level with `RATES_HISTORY_SEED`.

## Contested instruments

`CONTESTED_INSTRUMENTS` in `server/engine/playbooks.js` lists tickers whose asset class is
asserted inconsistently inside this repo. A playbook naming one will not fire.

HBKS is currently held (breakout-failure AND concentration-hedge): `shariahFilter.js`
catalogues it as "iShares MSCI UK Islamic UCITS ETF" (an equity index name), while
playbooks, the learning layer and the glossary called it a sukuk/duration fund with a
0.62 beta and ~3-year duration. All asset-class claims about it are removed; its Shariah
status carries `identityVerified: false`. Resolve against the fund factsheet by ISIN (the
ticker collides across venues), fix whichever record is wrong, then remove the entry. Do
not guess which one is right.

Shariah screening: the universe is the owner's hand-curated list. No screening date,
index-membership record or ratio is stored, so every status carries `SCREENING_BASIS`
(`kind:"unverified"`). Do not present it as a current screening result, and do not add
new religious-compliance claims.

## Cache strategy
Snapshot data flows through `resolveWithFallback(key, fetchFn, ttl, demoValue)`:
1. Warm cache → serve immediately (no fetch); `retrievedAt` is the ORIGINAL fetch time
2. Live fetch → cache it (only live provider results are ever cached)
3. Expired cache → serve the last value actually fetched, `cacheExpired: true`
4. No value → `DEMO_MODE` fixture tagged `kind:"demo"`, otherwise `unavailable`

Facts (with freshness) are built from cached raw values on every READ, so a value cached
on Friday is judged against Tuesday. An all-empty provider response is a failure, not a
cacheable "live" result. `snapshot:data` carries facts plus the component summary.

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

## AI text pipeline — citations become provenance
Claude's web_search tool emits `<cite index="0-2">text</cite>` markup into JSON string
fields. Both the `<cite` and `(cite` opening forms are accepted defensively —
matching only one would leave the other's opening tag visible on screen.

There are two paths, and the difference matters:

**Non-research surfaces** strip the markup outright. `stripCiteTags(str)` is applied to:
- `fetchAllAnalysis()` — events (headline, detail), risks (title, detail), econ (title, body)
- `fetchTickerExplain()` — what, now, portfolio fields

Do not remove this — the React renderer uses plain string nodes and would display raw tags.

**Research reports resolve the markup instead of deleting it.** `parseCiteTags()` maps each
cite index to the URL web_search actually returned, and `attachProvenance()` walks the
report to produce `citedSources` (pages a claim was attributed to) and `allSources`
(everything searched). The client renders these as footnotes, so a reader can tell a
searched figure from a generated one.

`extractJSON(raw, type, { preserveCitations: true })` is REQUIRED on every research branch.
Without the flag, extractJSON removes the closing `</cite>` unconditionally, which orphans
the opening tag and makes every citation unresolvable — the report then renders as though
nothing was ever sourced. There is a regression test for this.

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

Current status: **342 passing, 0 failing.** `tests/dataProvenance.test.js` covers the eight
provenance defect classes (old observations stay old, seeds never become live, bulletin
Fact handling, batch/sync equivalence, schema rejection, curve-change inputs, blocked
sizing, notional cap) with a mocked broker and real sizing/policy.
`tests/reviewFindings.test.js` carries tests named after the external review's IDs.
The old date-dependent failure in `tests/phase1.test.js` was the year-less seed calendar;
the calendar is now injected with full dates and the test passes all year.

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

### Trigger-frequency counter (`server/engine/backtester.js`)
NOT a backtest of returns. Counts how often each playbook's trigger was true on seven
hand-typed monthly demo points (`kind:"demo"`, `measures:"trigger-frequency"`). No prices,
fills, hit rates or P&L. It used to synthesise the 2Y as `y10 − 2.00`, fill gaps with
constants and use a £1,110 book; missing inputs are now null. Orders carry it as
`triggerFrequencyDemo`, never as performance evidence.

---

## Scheduled task
A daily prefetch task (`dispatch-daily-price-prefetch`) runs at 09:37 AM on weekdays and
calls `POST /api/snapshot/prefetch` to warm the cache before market opens. This uses
exactly 2 AV calls (AMD + FX) + 6 Polygon calls.

---

## Key decisions already made — do not revisit without good reason
1. **Polygon free tier** uses `/v2/aggs` not `/v2/snapshot` (403 on free tier)
1b. **Model ids carry no date suffix** — `claude-sonnet-5`, `claude-haiku-4-5`. Sonnet 5 is
   both cheaper and more capable than the Sonnet 4.5 it replaced. The web_search tool type
   is model-dependent (`web_search_20260209` for Sonnet 5, `web_search_20250305` for Haiku
   4.5); sending the wrong variant is a 400, so use `webSearchTool(model)`.
2. **AV limited to AMD only** — adding more AV symbols will exhaust the 25 calls/day limit
3. **`Promise.allSettled`** in `polygon.js` — partial results are better than total failure
4. **30-min market cache TTL** — short enough for intraday staleness badge, long enough
   to not hammer APIs
5. **Cite-tag stripping is server-side** — React renderer cannot parse HTML in string nodes
6. **Budget fallback is 60 min** — matches AV's rate-limit cooldown window
7. **All execution disabled by default** — requires TRADING_ENABLED + ALPACA_AUTO_EXECUTE + AUTO_APPROVE_PAPER
8. **Freshness gate** — execution requires the traded instrument's executable quote ≤ 20 min
   old and FRED observations ≤ 4 days old; retrieval time never counts as freshness
9. **Alpaca allowed hosts** — only `paper-api.alpaca.markets` by default (configurable via ALPACA_ALLOWED_HOSTS)
10. **SHORT ideas rejected** — Shariah gharar prohibition on manual idea creation
11. **Scenario uses T212 snapshot** — falls back to seeded positions when no snapshot
12. **Bracket orders default off** — `USE_BRACKET_ORDERS=true` required (market orders are simpler)
13. **Webhook is fire-and-forget** — does not block response path; failures logged to console
14. **"Backtester" is a trigger-frequency count on demo data** — not performance evidence
15. **Seeds are demo-only** — outside `DEMO_MODE` a missing provider is `unavailable`
16. **Research reports validate against Zod contracts on BOTH paths** — `finalizeResearchReport`
    is the single exit; `grounded` means "search ran and returned sources", not "verified"
