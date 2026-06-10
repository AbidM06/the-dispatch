# The Dispatch — Market Intelligence Dashboard

A personal market intelligence dashboard built by an economics student, looking to develop a deeper understanding of the markets. Express API backend + single-file React SPA, no build step required.

Live macro rates, AI-powered analysis, watchlist prices, trading ideas, correlation models, sell-side research reports, and an interview prep module — all in one place.

---

## Features

| Tab | What it does |
|-----|-------------|
| **Snapshot** | Live FRED rates (10Y, real yield, breakeven, HY spread, curve), USD/GBP FX, US + international watchlist prices, RSI, interactive charts |
| **Risk** | AI-scored risk monitor across 7 channels, refreshable with live news via Claude |
| **Analytics** | Cross-asset correlation engine, MA crossover backtester, momentum scanner, model builder with IS/OOS split, AI narrative |
| **Desk** | Trade idea tracker with risk/reward checks, AI idea generation, position sizing |
| **Sales** | S&T macro view — morning note, scenario grid, cross-asset matrix, central bank reaction functions, institutional client impact map |
| **News** | Live Finnhub headlines, economic + earnings calendar, company news + sentiment, AI morning bulletin with 1-min pitch script (optionally cross-checked against verified live X/Twitter sentiment — see [Provider Notes](#provider-notes)) |
| **Research** | AI sell-side report generator (macro note, sector deep-dive, thematic, rates, FX) |
| **Glossary** | 80+ S&T / AM terms with definitions, interview angles, and term-of-the-day |
| **Engine** | Automated idea engine with playbooks, Shariah universe scanner, backtester, execution log |
| **Interview** | Flashcard system for S&T / AM interview prep — behavioural, markets, investment, product |

---

## Architecture

```
client/index.html          Single-file React 18 SPA (createElement, no JSX build step)
server/index.js            Express entry point — mounts all routes
server/routes/             One file per API domain
server/providers/          Thin adapters for each external API
server/engine/             Idea engine, correlation engine, backtest, exit logic
server/analytics/          Execution policy, narrative fallback, risk checks
server/importers/          Persistent log readers/writers (ideas, bulletin, models)
server/jobs/               Scheduled background tasks (AI refresh, bulletin, weekly review)
server/middleware/         Write-auth guard
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
npm test       # Jest test suite (227 tests)
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes* | — | Claude API — events, risk, research, bulletin |
| `ALPHA_VANTAGE_API_KEY` | Yes | `demo` | AMD quote + USD/GBP FX (2 calls/refresh) |
| `FRED_API_KEY` | Yes | — | Rates: DGS10, DFII10, T10YIE, HY spread, curve |
| `POLYGON_API_KEY` | Yes | — | Watchlist peers via `/v2/aggs` |
| `FINNHUB_API_KEY` | Yes | — | News, earnings calendar, sentiment |
| `EIA_API_KEY` | No | — | WTI, Brent, Henry Hub price history for commodities report |
| `OPENAI_API_KEY` | No | — | Fallback when Claude is overloaded or fails to parse JSON |
| `PORT` | No | `3001` | HTTP port |
| `LOW_COST_MODE` | No | `false` | Disables all AI calls; returns deterministic narrative |
| `DISABLE_AI` | No | `false` | Hard block on all Anthropic calls |
| `ANTHROPIC_DAILY_CAP` | No | `5` | USD daily spend cap |
| `ANTHROPIC_MONTHLY_CAP` | No | `50` | USD monthly spend cap |
| `DISPATCH_ADMIN_KEY` | No | — | If set, guards all POST/PATCH/DELETE routes |
| `TRADING_ENABLED` | No | `false` | Master switch for paper trading |
| `AUTO_APPROVE_PAPER` | No | `false` | Auto-approve engine ideas for paper execution |
| `ALPACA_API_KEY` | No | — | Alpaca paper trading credentials |
| `ALPACA_API_SECRET` | No | — | Alpaca paper trading credentials |
| `ALPACA_BASE_URL` | No | `https://paper-api.alpaca.markets` | Must contain "paper" |
| `ALPACA_AUTO_EXECUTE` | No | `false` | Auto-post approved ideas to Alpaca |
| `WEBHOOK_URL` | No | — | Webhook endpoint for idea lifecycle events |
| `WEBHOOK_SECRET` | No | — | Optional signing secret for webhook |
| `ENGINE_SCHEDULE` | No | `08:00,15:30` | Comma-separated HH:MM run times (weekdays) |
| `ENGINE_COOLDOWN_MIN` | No | `30` | Minimum minutes between engine runs |

> **Tip:** The app degrades gracefully at every level. Missing keys = seeded fallback data, not errors. `LOW_COST_MODE=true` disables all AI and is free to run.

*Not required when `LOW_COST_MODE=true`.

---

## Provider Notes

**Alpha Vantage** — only used for AMD quote + USD/GBP FX. Free tier is 25 calls/day; the app uses exactly 2 per refresh. Do not add more AV symbols.

**Polygon** — peers (`NVDA MSFT TSLA MU AMAT LRCX`) via `/v2/aggs/ticker/{sym}/range/1/day/...`. The `/v2/snapshot/` endpoint is paid-only (returns 403 on free tier) — this app deliberately avoids it.

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
| Market prices (AV + Polygon) | 30 min | Intraday with staleness badge |
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
│   │   ├── alphaVantage.js         ← AMD quote + USD/GBP FX (2 calls/refresh)
│   │   ├── polygon.js              ← 6 watchlist peers via /v2/aggs
│   │   ├── fred.js                 ← Macro rates (DGS10, DFII10, T10YIE, etc.)
│   │   ├── fredSeries.js           ← Extended FRED series fetcher
│   │   ├── finnhub.js              ← News, calendars, sentiment
│   │   ├── anthropic.js            ← Claude API + cite-tag stripping
│   │   ├── openai.js               ← OpenAI fallback for research reports
│   │   ├── eia.js                  ← EIA energy price history
│   │   ├── alpaca.js               ← Paper trading order placement
│   │   ├── budget.js               ← Spend tracking + fallback state machine
│   │   └── webhook.js              ← Fire-and-forget lifecycle notifications
│   ├── routes/
│   │   ├── snapshot.js             ← GET /api/snapshot + POST /api/snapshot/prefetch
│   │   ├── events.js               ← GET /api/events + POST /api/events/refresh
│   │   ├── risk.js                 ← GET /api/risk + POST /api/risk/refresh
│   │   ├── explain.js              ← GET /api/explain/:ticker
│   │   ├── bulletin.js             ← GET /api/bulletin
│   │   ├── brief.js                ← GET /api/brief (macro brief)
│   │   ├── news.js                 ← GET /api/news + calendar + sentiment
│   │   ├── glossary.js             ← GET /api/glossary (full term suite)
│   │   ├── ideas.js                ← Idea CRUD + approve/reject/exits/backtest
│   │   ├── research.js             ← GET /api/research/report
│   │   ├── macro.js                ← GET /api/macro
│   │   ├── correlations.js         ← GET /api/correlations
│   │   ├── correlationsCustom.js   ← POST /api/correlations/custom
│   │   ├── momentum.js             ← GET /api/momentum
│   │   └── analyticsNarrative.js  ← GET /api/analytics/narrative
│   ├── engine/
│   │   ├── ideaEngine.js           ← AI idea generation with playbooks
│   │   ├── exitEngine.js           ← Exit signal detection
│   │   ├── autoExecute.js          ← Auto-execution flow
│   │   ├── backtester.js           ← Historical backtest on seeded data
│   │   ├── correlationEngine.js    ← Cross-asset correlation computation
│   │   ├── positionSizing.js       ← Risk-based position sizing
│   │   ├── riskGate.js             ← Pre-execution risk checks
│   │   ├── shariahFilter.js        ← Shariah compliance filter
│   │   ├── learningLayer.js        ← Playbook performance tracking
│   │   ├── strategies.js           ← Strategy definitions
│   │   ├── glossary.js             ← 80+ trading terms with definitions
│   │   ├── playbooks.js            ← Entry + exit playbook definitions
│   │   └── universeScanner.js      ← Shariah universe macro regime scan
│   ├── analytics/
│   │   ├── narrativeEngine.js      ← Deterministic fallback narrative
│   │   ├── executionPolicy.js      ← Circuit breakers + daily limits
│   │   ├── paperTrader.js          ← Paper trade state management
│   │   └── riskCheck.js            ← Position-level risk validation
│   ├── importers/
│   │   ├── ideas.js                ← JSONL idea log reader/writer
│   │   ├── ideaLog.js              ← Idea log utilities
│   │   ├── bulletinLog.js          ← Bulletin log reader/writer
│   │   └── savedModels.js          ← Saved analytics model persistence
│   └── jobs/
│       ├── ideaScheduler.js        ← Scheduled idea engine runs (weekdays)
│       ├── aiRefreshJob.js         ← Scheduled AI refresh (events + risk)
│       ├── bulletinScheduler.js    ← Daily bulletin generation
│       └── weeklyReview.js         ← Weekly playbook performance review
├── seeds/
│   └── fallback.js                 ← Seed data for graceful degradation
├── data/                           ← Runtime logs (gitignored)
└── tests/
    ├── endpoints.test.js
    ├── providers.test.js
    ├── ideaEngine.test.js
    └── phase1.test.js
```

---

## Design

Swiss editorial aesthetic — Playfair Display (headers) · IBM Plex Mono (data) · Inter (chrome). Dual day/night theme toggled per-session, persisted to localStorage.

---

## Licence

MIT — built for learning, not for production trading.
