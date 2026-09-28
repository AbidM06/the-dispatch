# The Dispatch — Market Intelligence Dashboard

A personal market intelligence dashboard built by an economics student, looking to develop a deeper understanding of the markets. Express API backend + single-file React SPA, no build step required.

Live macro rates, AI-powered analysis, a free multi-source markets panel, on-demand trade idea cards, correlation models, sell-side research reports, and an interview prep module — all in one place.

---

## Features

| Tab | What it does |
|-----|-------------|
| **Markets** | FX, rates & credit, equities, commodities, crypto, macro and Polymarket odds from free sources (Yahoo Finance, FRED, Finnhub, ECB, Polymarket). Every value shows its source (linked), release time, fetch time and a measured freshness badge. Table ↔ chart grid (candles / area, High-Low lines, daily or hourly), click any row for its chart. Auto-refresh weekdays 14:45 UK + Refresh now. AI equity pitch button on single stocks |
| **Risk** | AI-scored risk monitor across 7 channels, refreshable with live news via Claude |
| **Analytics** | Cross-asset correlation engine, MA crossover backtester, momentum scanner, model builder with IS/OOS split, a 7-strategy technical backtester (SMA/EMA crossover, RSI reversal, MACD, Bollinger Bands, mean-reversion, momentum) with walk-forward validation and buy-and-hold benchmarking, AI narrative |
| **Desk** | Daily brief — market regime, what changed, why it matters, next key event |
| **Sales** | S&T macro view — morning note, scenario grid, cross-asset matrix, central bank reaction functions, institutional client impact map |
| **News** | Live Finnhub headlines, economic + earnings calendar, company news + sentiment, on-demand **trade idea cards** (whole feed or one headline, cited to the inputs used), AI morning bulletin with 1-min pitch script (optionally cross-checked against verified live X/Twitter sentiment — see [Provider Notes](#provider-notes)) |
| **Research** | Institutional research platform — a five-agent pipeline (Lead Analyst → independent Data Auditor + Red Team + Cross-Asset PM → IC Chair) produces evidence-backed reports (macro, commodities, equity, FX, rates, thematic, sector) with a QA score, claim ledger, source registry, and a non-sycophantic interrogation chat for cross-examining any report, plus an on-demand trade idea card built from the report and its sources |
| **Glossary** | 80+ S&T / AM terms with definitions, interview angles, and term-of-the-day |
| **Interview** | Flashcard system for S&T / AM interview prep — behavioural, markets, investment, product |

---

## Architecture

```
client/index.html          Single-file React 18 SPA (createElement, no JSX build step)
server/index.js            Express entry point — mounts all routes
server/routes/             One file per API domain
server/providers/          Thin adapters for each external API
server/engine/             Correlation engine, technical strategies, glossary
server/analytics/          Deterministic narrative fallback
server/markets/            Free multi-source Markets data with provenance
server/ideas/              On-demand trade idea cards
server/importers/          Persistent log readers/writers (bulletin, models, T212)
server/jobs/               Background tasks (Markets 14:45 UK refresh, AI refresh, bulletin)
server/middleware/         Write-auth guard
server/research/           Five-agent research pipeline (orchestrator, agents, claim ledger,
                           source registry, quality gate, report store, interrogator)
server/engine/tradingStrategies.js  7 technical strategies + long-only backtest runner
server/engine/metrics.js  Sharpe/Sortino/Calmar/drawdown/VaR/CVaR + trade stats
server/schemas/            Zod validation
server/cache.js            In-memory TTL cache singleton
server/retry.js            withRetry, fetchWithTimeout, isRetryable
seeds/fallback.js          Seed data for full graceful degradation
data/                      Runtime JSONL logs (gitignored)
```

### Data flow

```
Request → Check cache (TTL)
               │
          HIT ─┴─ return { source:"cache", stale:bool }
               │
          MISS ─► Live provider fetch
                       │
                  OK ──┴── cache + return { source:"live" }
                       │
                  ERR ─► Stale cache → Seed fallback { source:"seeded" }
```

All API keys live server-side only. The browser makes only `fetch('/api/...')` calls — no key is ever exposed to the client.

---

## Quick Start

### 1. Get API keys (all free tiers)

| Service | Sign-up URL | Free tier |
|---------|-------------|-----------|
| Anthropic | https://console.anthropic.com | Pay-as-you-go (very cheap) |
| Alpha Vantage | https://www.alphavantage.co/support/#api-key | 25 req/day |
| FRED | https://fred.stlouisfed.org/docs/api/api_key.html | Unlimited |
| Finnhub | https://finnhub.io | 60 req/min |
| Polygon.io | https://polygon.io | Unlimited aggs (15-min delay) |
| EIA | https://www.eia.gov/opendata/ | Unlimited (reasonable use) |
| OpenAI *(optional)* | https://platform.openai.com | Pay-as-you-go |

### 2. Configure environment

```bash
cp .env.example .env
# Fill in your API keys
```

### 3. Install and run

```bash
npm install
npm start
# → http://localhost:3001
```

```bash
npm run dev    # auto-restart on file changes
npm test       # Jest test suite (315 tests)
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes* | — | Claude API — events, risk, research, bulletin |
| `ALPHA_VANTAGE_API_KEY` | No | — | No longer used (Markets panel uses free sources) |
| `FRED_API_KEY` | Yes | — | Markets rates/credit/macro (with release times), brief, correlations |
| `POLYGON_API_KEY` | No | — | Price history for the strategy backtester / momentum |
| `FINNHUB_API_KEY` | Yes | — | News, earnings calendar, sentiment; US-stock price fallback |
| `MARKETS_REFRESH_TIME` | No | `14:45` | Daily Markets refresh time (weekdays, `MARKETS_TZ`, default Europe/London); `MARKETS_SCHEDULE=off` disables |
| `IDEAS_MODEL` | No | Sonnet 4.5 | Model for on-demand idea cards (~$0.02–0.05 each) |
| — (Yahoo Finance) | No | — | No key required — strategy backtester falls back to Yahoo for native Asian listings (`.KS`/`.KQ`/`.T`/`.TW`/`.HK`/`.SS`/`.SZ`/`.NS`/`.BO`) |
| `EIA_API_KEY` | No | — | WTI, Brent, Henry Hub price history for commodities report |
| `OPENAI_API_KEY` | No | — | Fallback when Claude is overloaded or fails to parse JSON |
| `PORT` | No | `3001` | HTTP port |
| `LOW_COST_MODE` | No | `false` | Disables all AI calls; returns deterministic narrative |
| `DISABLE_AI` | No | `false` | Hard block on all Anthropic calls |
| `ANTHROPIC_DAILY_CAP` | No | `5` | USD daily spend cap |
| `ANTHROPIC_MONTHLY_CAP` | No | `50` | USD monthly spend cap |
| `DISPATCH_ADMIN_KEY` | No | — | If set, guards all POST/PATCH/DELETE routes |

> **Tip:** The app degrades gracefully at every level. Missing keys = seeded fallback data, not errors. `LOW_COST_MODE=true` disables all AI and is free to run.

*Not required when `LOW_COST_MODE=true`.

---

## Provider Notes

**Markets panel (free)** — Yahoo Finance chart API (unofficial, no key) is the primary source for FX, yields, ETFs, indices, futures, stocks and crypto; FRED supplies rates/credit/macro with each series' release timestamp; Finnhub and the ECB (via Frankfurter) are fallbacks; Polymarket supplies prediction-market odds. Exchange delays apply (futures ≈10 min, LSE ≈15 min) and are measured and shown, not hidden. Real-time CDS/credit indices aren't available for free — credit is shown as FRED OAS (1-day lag) plus HYG/LQD ETFs.

**Polygon** — used only for strategy backtester / momentum price history via `/v2/aggs` (the `/v2/snapshot/` endpoint is paid-only).

**FRED** — no meaningful rate limit. Rates data updates once daily; TTL is 60 min.

**Anthropic** — budget tracked in-process. When the daily/monthly cap is hit, the server enters a 60-min deterministic fallback automatically. The fallback narrative is always available at zero cost.

**OpenAI** — optional fallback for research reports. If not set, the app falls back to a static deterministic narrative.

**EIA** — optional. Used only for the commodities research report type. Free with no daily cap.

**X/Twitter (optional, local-only, no API key)** — The morning bulletin can fold in live X/Twitter chatter related to the day's top story via [`opencli`](https://github.com/jackwener/opencli), which reuses your local Chrome session through a Browser Bridge extension — no Twitter API key, no scraping.

- **Intent**: give the AI bulletin a real-time crowd-sentiment signal alongside the FRED/EIA/Finnhub data it already has, without the model fabricating "what people are saying."
- **Complications**: X has no usable free API, so any integration either pays for access or relies on session reuse (fragile across environments). Raw search results are also full of bot clusters, off-topic noise, and unverifiable claims — feeding that straight into an LLM risks it repeating misinformation as fact.
- **How it's handled**: `server/providers/twitter.js` shells out to `opencli` with a timeout and returns `null` on any failure (not installed, no browser session, daemon down). `server/providers/twitterVerify.js` runs every result through a verification pipeline *before* it reaches the prompt — filtering to financially-relevant and recent posts, deduping/clustering near-identical posts (a bot/coordination signal), unwinding quote-tweets to their original source, cross-referencing numeric claims (oil prices, 10Y yield) against the app's own live FRED/EIA data, and finally a Haiku pass that labels each surviving item `corroborated` / `plausible-unverified` / `contradicted` / `suspicious`. Only non-suspicious, non-contradicted items reach Claude, explicitly framed as sentiment color — never as a source of figures.
- **Graceful degradation**: this is a pure addition. If `opencli` isn't installed or you're not logged into x.com in Chrome, the bulletin generates exactly as it did before — no config, no errors, no missing data.

---

## Caching Strategy

| Data | TTL | Notes |
|------|-----|-------|
| FRED rates | 60 min | Published once daily |
| Markets snapshot | Daily 14:45 UK + manual | Persisted; stale values flagged |
| AI events / risk / research | 24 h | Expensive — refresh on demand |
| News / bulletin | 30 min / daily | Finnhub free tier |

---

## Project Structure

```
the_dispatch/
├── .env.example
├── package.json
├── client/
│   └── index.html                  ← Entire React frontend (no build)
├── server/
│   ├── index.js                    ← Express entry point
│   ├── cache.js                    ← In-memory TTL cache singleton
│   ├── retry.js                    ← withRetry, fetchWithTimeout, isRetryable
│   ├── middleware/
│   │   └── auth.js                 ← Write-auth guard (DISPATCH_ADMIN_KEY)
│   ├── schemas/
│   │   └── index.js                ← Zod validation schemas
│   ├── providers/
│   │   ├── alphaVantage.js         ← (unused since the Markets panel)
│   │   ├── polygon.js              ← Backtester / momentum history via /v2/aggs
│   │   ├── yahoo.js                ← Price history/quotes for tickers outside Polygon (no key)
│   │   ├── fred.js                 ← Macro rates (DGS10, DFII10, T10YIE, etc.)
│   │   ├── fredSeries.js           ← Extended FRED series fetcher
│   │   ├── finnhub.js              ← News, calendars, sentiment
│   │   ├── anthropic.js            ← Claude API + cite-tag stripping
│   │   ├── openai.js               ← OpenAI fallback for research reports
│   │   ├── eia.js                  ← EIA energy price history
│   │   └── budget.js               ← Spend tracking + fallback state machine
│   ├── markets/
│   │   ├── instruments.js          ← Markets universe + per-instrument source fallbacks
│   │   ├── sources.js              ← Yahoo / FRED / Finnhub / ECB / Polymarket adapters
│   │   └── service.js              ← Refresh, provenance, stale carry-forward, persistence
│   ├── ideas/
│   │   ├── generator.js            ← On-demand idea cards (cited to supplied inputs)
│   │   └── store.js                ← Saved idea history
│   ├── routes/
│   │   ├── markets.js              ← GET /api/markets + refresh + history
│   │   ├── events.js               ← GET /api/events + POST /api/events/refresh
│   │   ├── risk.js                 ← GET /api/risk + POST /api/risk/refresh
│   │   ├── explain.js              ← GET /api/explain/:ticker
│   │   ├── pitch.js                ← POST /api/pitch/:ticker (on-demand AI equity pitch)
│   │   ├── strategyBacktest.js     ← GET /api/analytics/strategy-backtest(/strategies)
│   │   ├── bulletin.js             ← GET /api/bulletin
│   │   ├── brief.js                ← GET /api/brief (macro brief)
│   │   ├── news.js                 ← GET /api/news + calendar + sentiment
│   │   ├── glossary.js             ← GET /api/glossary (full term suite)
│   │   ├── ideas.js                ← POST /api/ideas/news|research, GET/DELETE /api/ideas
│   │   ├── research.js             ← GET /api/research/report
│   │   ├── macro.js                ← GET /api/macro
│   │   ├── correlations.js         ← GET /api/correlations
│   │   ├── correlationsCustom.js   ← POST /api/correlations/custom
│   │   ├── momentum.js             ← GET /api/momentum
│   │   └── analyticsNarrative.js  ← GET /api/analytics/narrative
│   ├── engine/
│   │   ├── correlationEngine.js    ← Cross-asset correlation computation
│   │   ├── tradingStrategies.js    ← 7 technical strategies + backtest runner
│   │   ├── metrics.js              ← Sharpe/Sortino/Calmar/drawdown/VaR/CVaR + trade stats
│   │   └── glossary.js             ← 80+ trading terms with definitions
│   ├── analytics/
│   │   └── narrativeEngine.js      ← Deterministic fallback narrative
│   ├── importers/
│   │   ├── bulletinLog.js          ← Bulletin log reader/writer
│   │   └── savedModels.js          ← Saved analytics model persistence
│   └── jobs/
│       ├── marketsScheduler.js     ← Weekday 14:45 UK Markets refresh (+ catch-up)
│       ├── aiRefreshJob.js         ← Scheduled AI refresh (events + risk)
│       └── bulletinScheduler.js    ← Daily bulletin generation
├── seeds/
│   └── fallback.js                 ← Seed data for graceful degradation
├── data/                           ← Runtime logs (gitignored)
└── tests/
    ├── endpoints.test.js
    ├── providers.test.js
    ├── markets.test.js
    ├── ideas.test.js
    ├── brief.test.js
```

---

## Design

Swiss editorial aesthetic — Playfair Display (headers) · IBM Plex Mono (data) · Inter (chrome). Dual day/night theme toggled per-session, persisted to localStorage.

---

## Licence

MIT — built for learning, not for production trading.
