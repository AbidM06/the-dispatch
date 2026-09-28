# The Dispatch — Project Brief for AI Coding Agents

This file is the single source of truth for **every** AI model working on this repo —
Claude (via `CLAUDE.md`, which imports this file), OpenAI Codex / GPT models, and any
future agent. Keep it current; do not fork a model-specific copy.

## Start here — every session, every model
1. Read this file, then **`docs/HANDOFF.md`** (where the work stands right now), then
   **`docs/DECISIONS.md`** (what was decided and why — do not re-litigate these without
   asking the owner).
2. Run `git log --oneline -15` and `npm test` to confirm the state HANDOFF describes.
3. Tell the owner, in a few lines, where things stand and what you propose to do next —
   **before** changing anything.

## Working protocol (agreed with the owner, Sep 2026)
- **Propose before you commit.** Describe the change and why, ask the owner's clarifying
  questions, and wait for approval. The owner wants to be questioned about what they want
  and why before anything is built. Then implement, commit and push.
- **Branches and PRs.** Never push to `main`. One branch and one pull request per task.
  Name branches by agent: `claude/<topic>`, `codex/<topic>` (or `gpt/<topic>`). Open PRs
  as drafts; the owner merges.
- **Cross-review.** A PR written by one model is reviewed by the other before the owner
  merges it. The reviewer leaves GitHub review comments; the author addresses each one or
  replies why not. The PR description and review thread are how the models communicate.
  **The author requests the review itself** — the owner does not: after opening a PR, and
  again after pushing fixes for review findings, post a PR comment `@codex review` (Claude's
  PRs) so Codex reviews the current head. Codex, on its PRs, asks the owner to relay a
  review request to Claude, or tags it in the PR description.
- **Claim work.** Put the task, your agent name and branch under "In progress" in
  `docs/HANDOFF.md` so two models never edit the same thing at once.
- **Before you stop — including when you are near a usage limit:** tests green, commit and
  push, update `docs/HANDOFF.md` (what changed, what's next, open questions), and add any
  new decision to `docs/DECISIONS.md`. If you might be cut off, write HANDOFF **first**.
- **CI.** `.github/workflows/test.yml` runs `npm test` on every push and PR. Red means
  do not merge.
- **Explain for a beginner.** The owner is learning JavaScript/Node and shell — explain
  commands and changes in plain English, and give copy-paste commands for their Mac
  (`~/Desktop/the_dispatch`, zsh, launchd service `com.thedispatch.server`).
- **Cost.** AI spend is capped (see "Cost transparency" below). Never add anything that
  calls a paid API on a schedule or on page load without the owner's approval.
- **Context pack.** `npm run context-pack` writes `context-pack.md` (gitignored) — one file
  with this brief, HANDOFF, DECISIONS, the file tree and recent commits, for pasting into a
  chat-only model that cannot see the repo.

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
npm test           # Jest, all suites in tests/
npm run test:coverage
```

## Environment variables (copy `.env.example` → `.env`)
| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API — research, idea cards, events/risk, explain, pitch, interrogation |
| `FRED_API_KEY` | Markets panel series + the verified macro facts every research report uses |
| `FINNHUB_API_KEY` | News, earnings/economic calendar, sentiment; US-stock price fallback |
| `EIA_API_KEY` | Commodities report price-history chart |
| `POLYGON_API_KEY` | Strategy backtester / momentum history, vol surface (not used by Markets) |
| `OPENAI_API_KEY` | Optional research fallback tier (no web search → `grounded: false`; UNPRICED on receipts) |
| `ALPHA_VANTAGE_API_KEY` | No longer used by any route (provider kept, tested) |
| `MARKETS_REFRESH_TIMES` / `MARKETS_TZ` / `MARKETS_SCHEDULE` | Markets refresh slots (default `07:45,14:45` Europe/London, weekdays; `off` disables) |
| `POLYMARKET_TAGS` / `POLYMARKET_COUNT` | Prediction markets shown (default economy,geopolitics / 4) |
| `SONNET_MODEL` | The Sonnet every Sonnet job uses — research pipeline, chat, idea cards (default `claude-sonnet-5`; `claude-sonnet-5-5` under evaluation, D-17) |
| `IDEAS_MODEL` | Model for idea cards (default: `SONNET_MODEL`) |
| `PORT` | Default 3001 |
| `LOW_COST_MODE=true` | Disables all AI calls (research returns 503 `available: false`) |
| `ANTHROPIC_DAILY_CAP` | **USD** cap per UTC day, measured from real usage (default $5; 0 = off) |
| `ANTHROPIC_MONTHLY_CAP` / `_MODE` | **USD** cap per UTC month (default $20) — `warn` (default: banner + confirm warning, never blocks) or `block` |
| `RESEARCH_CONFIRM_ABOVE_USD` | Manual refreshes estimated above this need `confirm: true` (default 0 = always) |
| `RESEARCH_BATCH` / `BULLETIN_SCHEDULE` / `AI_REFRESH_SCHEDULE` | Scheduled AI jobs — **all off by default**; `on` to schedule |
| `RESEARCH_BATCH_TIME` / `RESEARCH_BATCH_TYPES` | When `RESEARCH_BATCH=on`: 06:40, all seven types |

---

## Architecture

```
client/index.html          Single-file React app (createElement, no JSX build)
server/index.js            Express entry point — mounts all routes
server/routes/
  markets.js               GET /api/markets | POST /api/markets/refresh | GET /api/markets/history/:id
  ideas.js                 POST /api/ideas/news | POST /api/ideas/research | GET /api/ideas | DELETE /api/ideas/:id
  journal.js               GET /api/journal | GET /api/journal/:id | POST …/:id/{watch,pitch,manual-price} — append-only
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
  claudeTransport.js       THE single exit for Messages API calls — prices every call, records
                           spend, attributes it to the open cost receipt, batch mode
  aiCost.js                USD prices, persistent spend ledger (data/ai_spend.json), receipts,
                           refresh estimates
  anthropicBatch.js        Message Batches API — 50% rate (used by claudeTransport in batch mode)
  alphaVantage.js          Unused since the Markets panel (kept + tested)
  polygon.js               Free-tier /v2/aggs — strategy backtester / momentum history, vol surface
  fred.js                  Rates and history — getAllRates(), getRecentHistory()
  anthropic.js             fetchAllAnalysis(), fetchTickerExplain(), callClaude(), fetchResearchReport()
  finnhub.js               News, earnings calendar, economic calendar, sentiment
  budget.js                USD caps over the spend ledger + auto API-fallback state machine
server/markets/            instruments.js · sources.js · service.js — free Markets data + provenance
server/ideas/              generator.js · store.js — on-demand idea cards (every one logged to the Journal)
server/journal/            store.js · migrate.js — append-only trade Journal (stage 1)
server/research/           five-agent pipeline — see "Institutional Research" below
server/jobs/
  marketsScheduler.js      Markets refresh, weekdays 07:45 + 14:45 UK, one catch-up after sleep
  researchBatchJob.js      opt-in (RESEARCH_BATCH=on): 06:40 full pipeline per type, every call batched
  bulletinScheduler.js · aiRefreshJob.js   opt-in (BULLETIN_SCHEDULE / AI_REFRESH_SCHEDULE=on)
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
seeds/fallback.js          Legacy seed data — still read by brief.js / aiRefreshJob / scenario (see "Known seed usage")
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
- `jobs/marketsScheduler.js` — in-process weekday slots at 07:45 (pre-LSE) and 14:45
  (post-NYSE-open) London, DST-safe via Intl. Each slot runs once, keyed `YYYY-MM-DD@HH:MM`
  in `lastScheduledDate`; asleep through several slots → ONE catch-up for the latest.
  Marks the slot done even on failure. A bare-date marker (pre-slot format) means "day done".
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

## Trade Journal (`server/journal/`, `routes/journal.js`) — stages 1–2 of 3 (D-14, D-16, D-18)
- **Every generated idea is logged automatically** by `ideas/generator.js` before it is
  returned (a failed write adds a warning to the card — never silent). Ideas created before
  the Journal existed are backfilled at server start (`journal/migrate.js`), flagged
  `backfilled`; `DELETE /api/ideas/:id` logs the card first and refuses if it cannot.
- **Append-only** `data/journal.jsonl` (gitignored; memory-only in tests unless
  `JOURNAL_PATH`). Events: `idea_logged` (frozen copy + SHA-256 `ideaHash`; reads report
  `integrity: "intact" | "MODIFIED"`), `watch`, `pitch` (`beforeReveal`), `manual_price`.
  There are **no edit or delete routes**; dismissing an idea card does not touch the Journal.
- **Reference price** = the Markets value on the card at generation, with source, time,
  link and an explicit `status`: `ok` · `stale` (flagged by Markets, or > 5 days old for
  daily/intraday quotes — monthly series are only stale when Markets flags them) ·
  `missing` (instrument not in the snapshot) · `unknown` (backfilled, freshness not recorded).
  A manual price is a separate event and never replaces it.
- **Horizon** bucketed from the card's text by the longest duration named (every
  number–unit pair is read, so "2 weeks to 3 months" is 3 months): tactical ≤14d, swing ≤93d,
  strategic ≤366d, else `undeclared` (never guessed).
- Routes: `GET /api/journal?watched=&origin=`, `GET /api/journal/:entryId`,
  `POST /api/journal/:entryId/{watch,pitch,manual-price}` (auth). No AI, no cost.
- Client: JOURNAL tab (filters, ★ watch, reference badge, frozen idea, pitches, manual
  price). "My pitch first" mode seals each new idea card until the owner writes a pitch
  (saved `beforeReveal: true`) or skips — in the Journal too; mode + sealed ids live in localStorage.
- **Stage 2 — tracking & scoring** (`journal/tracker.js`, D-18). Runs after every Markets
  refresh — all refreshes go through `jobs/refreshMarkets.js` (never call `markets.refresh()`
  directly) — and every Journal response resolves results via `tracker.trackingFor()`. It uses free daily history (Yahoo OHLC; FRED closes-only, labelled).
  No AI. Rules: tracking starts the day AFTER generation; the newest bar of each series is
  not scored while recent (< 4 days — it may still be trading; an older final bar is a
  completed terminal bar and is scored); **entered only when price trades in
  the entry zone** (fill = midpoint), at any time within the horizon, else `never_entered`;
  closes at target / stop (gap → the open) / horizon expiry (that day's close); a day touching
  both levels — or the fill day touching either — is `uncertain`, no R. 1R = |entry − stop|.
  Undeclared horizon → **assumed 91 days**, labelled (a declared one of any length is honoured).
  If the history cannot cover the idea's period (starts too late, a gap > 10 days — 45 for
  closes-only series — or stops before the horizon ends) the result is `unavailable`, never
  asserted. The Journal's `outcome` event wins over the derived file (a lost file is rebuilt
  from it, not recomputed). Dynamic markets (Polymarket) keep their history source on the
  card (`marketHistory`) so they can be priced after leaving the snapshot. Benchmark: S&P 500 index (^GSPC price, no
  dividends) from the fill close (stored as `spxAtFill`, since history only reaches ~6 months)
  to the exit close; if either close is unavailable the outcome waits (`benchmarkPending`). State is incremental in
  `data/journal_tracking.json` (gitignored); a final result is also appended to the Journal as
  one `outcome` event. `GET /api/journal` returns `tracking` per entry and `stats` (win rate
  and R over closed ideas; uncertain, never-entered and fill rate reported separately).
- **horizonDays**: the idea prompt now asks for the holding period as a number of days; the
  Journal uses it (`horizon.source: "declared"`) and only parses the text for older cards.

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

## No fabricated fallbacks — deliberate

`server/routes/research.js` used to carry six hand-written "deterministic" reports served
whenever AI generation failed. They read exactly like live research and every figure was
hardcoded; the commodities seed asserted a Strait of Hormuz closure with a 17mb/d supply
shock that had never happened.

They are gone and must not come back. On failure the route returns HTTP 503 with
`available: false`, the reason, and the timestamp of the last successful run; the client
renders an unavailable panel. A report that invents a crisis is worse than no report.
A test asserts the seed builders stay deleted.

The same rule now covers most surfaces (ported from the external review on
`claude/relaxed-brown-8q5ynd`): `/api/macro/view` and `/api/macro/clients` return 503
`available: false` (their fallbacks invented a Fed level, a trade idea and catalysts, and the
old `rateVal()` fed the live model hardcoded rates labelled as FRED); the no-AI
`narrativeEngine` describes only fetched, dated FRED figures (no events, no back-filled
defaults, no seed rates — with no data it returns empty arrays); the Events/Risk routes
never serve the old seed stories; the economic calendar has no hand-typed dates
(`economicSource: "unavailable"` when Finnhub's paid endpoint refuses); and AI prompts
carry no fixed topic list or event-laden worked examples. `tests/reviewFixes.test.js`
guards all of this, plus the bulletin notification (execFile + argv — AI text never
becomes shell or AppleScript source).

### Known seed usage (not yet compliant with D-02 — being audited)
- `server/routes/brief.js` — falls back to `RATES_SEED` (Mar 2026) when no snapshot is
  cached, compares "what changed" against hardcoded `PREV_RATES`, and builds "next event"
  from the hand-typed `MACRO_CAL` / `EARNINGS_CAL` (year-less dates, year guessed). Loaded
  on every page open.
- `server/jobs/aiRefreshJob.js` — `WATCHLIST_SEED` when no snapshot (opt-in job only).
- `server/routes/scenario.js` — seeded positions when no T212 snapshot (labelled; key decision
  15 at the end of this file).

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

## Research batching
**Off by default** (owner's choice: reports are generated on demand; `RESEARCH_BATCH=on` enables).
`server/jobs/researchBatchJob.js` runs `routes/research.generateReport(type, "", { batch: true })`
for each type in `RESEARCH_BATCH_TYPES` (default all seven) at `RESEARCH_BATCH_TIME` (06:40).
That is the SAME five-agent pipeline the Research tab uses — it used to batch bare drafts
and cache them, so morning reports skipped every reviewer and never reached the report
store the idea button reads. In batch mode `claudeTransport` sends each call as a
one-request Message Batch at 50%; stages still run in order, and any call a batch fails
to deliver is re-sent synchronously. Batching affects cost only, never availability or QA.
Receipts mark batched calls, and estimates ignore batched runs (they'd understate a manual refresh).

Interactive paths (refresh, explain, idea cards, interrogation) stay synchronous — batch
latency is measured in minutes.

**Prompt caching was evaluated and deliberately not added.** A cache entry is readable only
after the first request begins streaming, so the three reviewers — which run in parallel —
cannot read each other's prefix; only the chair runs afterwards. The net saving is well
under a cent per report and parallel writes would pay the 1.25x write premium for nothing.
Revisit only if the reviewers become sequential.

## Cache strategy
Routes that use `resolveWithFallback(key, fetchFn, ttl, fallback)` (currently `news.js`) resolve:
1. Warm cache → serve immediately (no fetch)
2. Live fetch → cache it
3. Stale cache (expired but present) → serve with `stale: true`
4. The route's fallback — for news this is an **empty list**, never invented content.

`seeds/fallback.js` still exists and is **still read** by a few paths — see "Known seed
usage" below. Under D-02 no seed value may be presented as current data; removing the
remaining uses is tracked in `docs/HANDOFF.md` (data-accuracy audit).

TTLs:
- FRED data (Brief/correlations): 60 min (`CACHE_TTL_FRED` env override)
- Markets snapshot: persisted; refreshed 07:45 + 14:45 UK weekdays or manually. Chart history cached
  60 min (daily) / 15 min (hourly) server-side, and per session client-side.

---

## Cost transparency, budget and API fallback
Every Messages API request goes through `providers/claudeTransport.js`. Do not add a second
`fetch` to api.anthropic.com — it would be unpriced, unbudgeted and missing from receipts.
- **Pricing** (`providers/aiCost.js`): USD from the response's own `usage` — input, output,
  cache write (1.25x) / read (0.1x), `server_tool_use.web_search_requests` ($10/1k), batch 50%.
  `PRICES` + `PRICES_CHECKED` are Anthropic list prices; update both together. A model not in
  the table is recorded as UNPRICED (e.g. the OpenAI tier) — counted, never costed at $0.
- **Ledger**: `data/ai_spend.json` (gitignored), per UTC day/month; survives restarts.
- **Receipts**: `transport.runWithContext({ receipt, batch, role }, fn)` uses AsyncLocalStorage,
  so every call inside — including the draft via `anthropic.js` — lands on the receipt under
  its role. The orchestrator stores it as `report.meta.cost`; the client shows it (`RpCostReceipt`).
- **Nothing spends on a schedule.** `server/index.js` starts the three AI jobs only when
  their flag is `on`; every GET that could call AI is read-only or button-triggered.
- **Budget** (`providers/budget.js`): `ANTHROPIC_DAILY_CAP` / `_MONTHLY_CAP` are **dollars**
  checked against the ledger before each call. Daily ($5) is always a hard stop (runaway
  guard); monthly ($20) is `warn` by default — `getStatus().monthly.overCap` drives a banner
  and the refresh confirm warns when a run would cross it. (It used to count calls, and `parseInt(undefined)
  ?? 5` made an unset cap NaN = off.) A budget error never escalates to the OpenAI tier.
  One call can overshoot a cap by its own cost — there is no pre-reservation of a guess.
- **Refresh estimate**: `GET /api/research/report/estimate` averages recent synchronous
  receipts for that type, or states `basis: "assumption"`. `POST /report/refresh` returns 409
  `confirmation_required` unless `confirm: true` or the estimate is under
  `RESEARCH_CONFIRM_ABOVE_USD` (default 0). The client shows the estimate + spend in a confirm.
- Billing error (402 / credit wording) → `setApiFallback()` 60-min window; `getApiFallbackInfo()`
  returns `{ active, expiresAt, retryInMins }`. Route catches in `events.js` / `risk.js` also call it.
- `LOW_COST_MODE=true` disables AI entirely (separate from fallback).

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
npm test   # all suites in tests/
```

Key conventions:
- `jest.resetModules()` in `beforeEach` — required because providers read `process.env`
  at module load time
- `global.fetch = mockFetch` — all HTTP mocked via Jest, no real network calls
- `tests/markets.test.js` mocks fetch by URL (Yahoo/FRED/Finnhub/Frankfurter/Polymarket);
  `tests/ideas.test.js` mocks `research/llm.callAgent` and spies `markets.getSnapshot`.

- `tests/research.test.js` — cross-asset layer, policy proxy, provenance, batch adapter,
  no-fabrication guarantee. `tests/researchPipeline.test.js` — five-agent pipeline, QA gate,
  interrogation, fact check in the pipeline, estimate/confirm, batch job.
  `tests/costTransparency.test.js` — pricing, USD budget, transport receipts + batch mode,
  fact-check rules, red-team log.

Current status: **all suites passing** (run `npm test` for the count).

---

## Write-auth middleware
`server/middleware/auth.js` guards all mutating (POST/PATCH/DELETE) routes.
- If `DISPATCH_ADMIN_KEY` env var is **not set**: no-op (dev mode, open access).
- If set: requires `x-dispatch-key` header matching exactly.
- Applied per-route (not globally) in: ideas.js, markets.js, import.js, events.js, risk.js, research.js.

## Institutional Research — five-agent pipeline + interrogation

### Architecture (`server/research/`)
```
orchestrator.js        Pipeline: draft → extract → FRED fact check → parallel(auditor, redTeam, PM) → chair → gate → bounded revision
llm.js                 Role-based adapter over claudeTransport (budget-gated, per-role models, webSearchTool(model))
factCheck.js           Deterministic claim check against the verified FRED facts — free, sourced, conservative
redTeamLog.js          Append-only log of red-team warnings (data/redteam_log.jsonl) for later scoring
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
  All calls pass through the USD budget gate. Models: `SONNET_MODEL` (default Sonnet 5; `server/providers/models.js`), Haiku 4.5 for extraction.
- **Every agent receives the verified FRED block** (`verifiedBlock`) — reviewers used to judge
  the draft with no market data of their own.
- **Fact check before audit**: `factCheck.checkClaims()` settles FACT claims naming exactly one
  held series with one plausible level (not a change, forecast, other date or earlier year) —
  VERIFIED or CONFLICTING_DATA, with a real `fred.stlouisfed.org/series/...` source. The auditor
  only receives unsettled claims; if none remain it is skipped (QA says why). Keep it conservative:
  a wrong automated verdict is worse than an extra search.
- Red-team warnings are logged per report (`GET /api/research/redteam-log`); outcomes are appended
  later as separate `type: "outcome"` records, never edited in.
- Draft failure → `runPipeline` throws → route returns 503 `available: false`. There is no
  seeded report. Reviewer failure → verdict `NOT_RUN`, disclosed in QA; never fake a passed review.
- `RESEARCH_MULTI_AGENT=false` → one draft call per report (`singleCallReport`), still priced,
  versioned and stored; QA honestly NOT_RUN.
- Chair's `REVISION_REQUIRED` stands even if the numeric score passes the threshold (gate never overrides adjudication upward).
- Interrogation conversations are pinned to their reportId — a newer report sets `newerReportAvailable: true` but never swaps context.
- Corrections: `store.addCorrection()` appends `COR-xxx` entries + marks claims `CORRECTED` — history is never silently mutated.

### Endpoints
- `GET  /api/research/report?type=` (cached 24h) · `POST /api/research/report/refresh` (auth; `confirm: true`)
- `GET  /api/research/report/estimate?type=` · `GET /api/research/spend` · `GET /api/research/redteam-log`
- `GET  /api/research/report/progress?type=` — live stage labels during generation
- `GET  /api/research/report/versions?type=`
- `GET  /api/research/report/:reportId/qa` · `GET /api/research/report/:reportId/sources`
- `POST /api/research/interrogate` `{reportId, question ≤2000ch, conversationId?}` (auth; 503 + `aiStatus: UNAVAILABLE` when AI off)

### Env vars
`RESEARCH_MULTI_AGENT` (default true), `RESEARCH_MIN_QA_SCORE` (85), `RESEARCH_MAX_VALIDATION_ROUNDS` (2),
`RESEARCH_MAX_AGENT_CALLS` (8), per-role models: `RESEARCH_{LEAD,EXTRACT,AUDITOR,REDTEAM,PORTFOLIO,CHAIR,CHAT}_MODEL`,
`RESEARCH_CONFIRM_ABOVE_USD` (0), `RESEARCH_BATCH_TIME` (06:40), `RESEARCH_BATCH_TYPES` (all).

### Frontend (client/index.html)
QA strip (score/status/claims/sources) + cost receipt (`RpCostReceipt`, `.rp-cost-*`) + expandable QA panel
(agent verdicts, disagreements, claim ledger, corrections log) + verified data / policy proxy / estimates /
cited sources (`Rp*`) + source registry viewer + interrogation chat (`.interro-*`, `.qa-*`, `.claim-*`, `.src-*` CSS).
Top bar shows today's AI spend (`.ai-spend-chip`) from `/api/health` budget.
Progress polling replaces time-guessed phase messages when the orchestrator reports a real stage.

## Scheduled refresh
The Markets refresh runs **inside the server** (`jobs/marketsScheduler.js`), weekdays 07:45
and 14:45 Europe/London with one catch-up after sleep. The old Cowork scheduled task was removed — it ran in
a cloud sandbox and could never reach `localhost:3001`. Auto-start at login:
`bash install-autostart.sh` (launchd agent `com.thedispatch.server`).

---

## Key decisions already made — do not revisit without good reason
1. **View-only** — no order execution, no rules-based idea engine, no Shariah gating
   (removed Sep 2026 at the owner's request; git history has them). Ideas may be long or short.
2. **No fabricated fallbacks** — research failure is a 503 `available: false`, never a seeded report.
3. **Every Claude call goes through `claudeTransport`** — priced, recorded, on the receipt.
4. **Budget caps are USD**, measured from real usage and persisted; a budget error never falls
   through to another paid provider. $20/month warn-only, $5/day hard.
4b. **No AI on a schedule by default** — research, bulletin and events/risk are button-driven.
5. **Model ids carry no date suffix** — `claude-sonnet-5`, `claude-sonnet-5-5`, `claude-haiku-4-5`. Never
   hardcode a Sonnet id: use `models.sonnetModel()`. The web_search
   tool type is model-dependent (`web_search_20260209` for Sonnet 5 / 5.5, `web_search_20250305` for
   Haiku 4.5); sending the wrong variant is a 400, so use `webSearchTool(model)`.
6. **Markets data is free-only** (budget £0). Yahoo is unofficial — keep fallbacks per instrument.
7. **Freshness is measured, not assumed** — never label a value "live" without its print time.
8. **Stale values are shown flagged**, never silently reused or replaced by seeds.
9. **Markets refresh slots 07:45 + 14:45 UK** + manual button; `GET /api/markets` never fetches.
10. **Idea cards cite only supplied inputs**; server resolves links — the model cannot invent URLs.
11. **Fed policy path is a labelled proxy** (DGS2 − DFF), never a probability.
12. **Cite-tag stripping is server-side** — React renderer cannot parse HTML in string nodes.
13. **Budget fallback is 60 min** after an Anthropic billing error.
14. **Polygon free tier** uses `/v2/aggs` not `/v2/snapshot` (403 on free tier) — backtester/momentum only.
15. **Scenario uses T212 snapshot** — falls back to seeded positions when no snapshot.
