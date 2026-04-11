# The Dispatch — Market Intelligence Dashboard

A personal market intelligence dashboard built by an economics student targeting S&T / Asset Management. Express API backend + single-file React SPA, no build step required.

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
| **News** | Live Finnhub headlines, economic + earnings calendar, company news + sentiment, AI morning bulletin with 1-min pitch script |
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
server/analytics/          Deterministic narrative fallback
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
| Polygon.io | https://polygon.io | Unlimited aggs (15-min delay) |
| Finnhub | https://finnhub.io | 60 req/min |

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
npm test       # Jest test suite (213 tests)
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | — | Claude API — events, risk, research, bulletin |
| `ALPHA_VANTAGE_API_KEY` | Yes | — | AMD quote + USD/GBP FX (2 calls/refresh) |
| `FRED_API_KEY` | Yes | — | Rates: DGS10, DFII10, T10YIE, HY spread, curve |
| `POLYGON_API_KEY` | Yes | — | Watchlist peers via `/v2/aggs` |
| `FINNHUB_API_KEY` | Yes | — | News, earnings calendar, sentiment |
| `PORT` | No | 3001 | HTTP port |
| `LOW_COST_MODE` | No | false | Disables all AI calls, returns deterministic narrative |
| `ANTHROPIC_DAILY_CAP` | No | 5 | USD daily spend cap |
| `ANTHROPIC_MONTHLY_CAP` | No | 50 | USD monthly spend cap |
| `DISPATCH_ADMIN_KEY` | No | — | If set, guards all POST/PATCH/DELETE routes |
| `TRADING_ENABLED` | No | false | Master switch for paper trading |

> **Tip:** The app degrades gracefully at every level. Missing keys = seeded fallback data, not errors. `LOW_COST_MODE=true` disables all AI and is free to run.

---

## Provider Notes

**Alpha Vantage** — only used for AMD quote + USD/GBP FX. Free tier is 25 calls/day; the app uses exactly 2 per refresh. Do not add more AV symbols.

**Polygon** — peers (`NVDA MSFT TSLA MU AMAT LRCX`) via `/v2/aggs/ticker/{sym}/range/1/day/...`. The `/v2/snapshot/` endpoint is paid-only (returns 403 on free tier) — this app deliberately avoids it.

**FRED** — no meaningful rate limit. Rates data updates once daily; TTL is 60 min.

**Anthropic** — budget tracked in-process. When the daily/monthly cap is hit, the server enters a 60-min deterministic fallback automatically. The fallback narrative is always available at zero cost.

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
│   └── index.html              ← Entire React frontend (no build)
├── server/
│   ├── index.js
│   ├── cache.js
│   ├── retry.js
│   ├── middleware/auth.js
│   ├── schemas/index.js        ← Zod validation
│   ├── providers/
│   │   ├── alphaVantage.js
│   │   ├── polygon.js
│   │   ├── fred.js
│   │   ├── finnhub.js
│   │   ├── anthropic.js
│   │   ├── budget.js           ← Spend tracking + fallback state machine
│   │   └── webhook.js
│   ├── routes/
│   │   ├── snapshot.js
│   │   ├── events.js
│   │   ├── risk.js
│   │   ├── explain.js
│   │   ├── bulletin.js
│   │   ├── news.js
│   │   ├── glossary.js
│   │   ├── ideas.js
│   │   ├── research.js
│   │   ├── macro.js
│   │   ├── correlations.js
│   │   └── analytics.js
│   ├── engine/
│   │   ├── ideaEngine.js
│   │   ├── exitEngine.js
│   │   ├── correlationEngine.js
│   │   ├── backtester.js
│   │   ├── positionSizing.js
│   │   ├── executionPolicy.js
│   │   ├── glossary.js
│   │   ├── playbooks.js
│   │   └── universeScanner.js
│   └── analytics/
│       └── narrativeEngine.js  ← Deterministic fallback narrative
├── seeds/
│   └── fallback.js
├── data/                       ← Runtime logs (gitignored)
└── tests/
    ├── endpoints.test.js
    ├── providers.test.js
    └── ideaEngine.test.js
```

---

## Design

Swiss editorial aesthetic — Playfair Display (headers) · IBM Plex Mono (data) · Inter (chrome). Dual day/night theme toggled per-session, persisted to localStorage.

---

## Licence

MIT — built for learning, not for production trading.
