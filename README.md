# The Dispatch — Market Intelligence Dashboard

A production-grade market intelligence and portfolio analytics dashboard, built for an economics student learning markets deeply and suitable for a demo to a JP Morgan trading desk.

---

## Architecture

```
Browser (client/index.html)
        │  fetch('/api/...')
        ▼
┌───────────────────────────────────┐
│  Express  :3001                   │
│                                   │
│  GET  /api/snapshot  ────────┐    │
│  GET  /api/portfolio ────────┤    │
│  GET  /api/risk      ────────┤    │
│  POST /api/risk/refresh      │    │
│  GET  /api/events    ────────┤    │
│  POST /api/events/refresh    │    │
│  GET  /api/explain/:ticker   │    │
│  GET  /api/health            │    │
│                              │    │
│  server/cache.js  (TTL)      │    │
│  server/retry.js  (backoff)  │    │
│                              │    │
└──────────────────────────────┘    │
         │                          │
    ┌────┴──────────────────────┐   │
    │  Provider adapters        │   │
    │  providers/fred.js        │   │
    │  providers/alphaVantage.js│   │
    │  providers/anthropic.js   │   │
    └────┬──────────────────────┘   │
         │                          │
    ┌────▼──────────────────────┐   │
    │  External APIs (server-   │   │
    │  side only — keys never   │   │
    │  reach the browser)       │   │
    │                           │   │
    │  api.stlouisfed.org/fred  │   │
    │  alphavantage.co/query    │   │
    │  api.anthropic.com/v1/... │   │
    └───────────────────────────┘   │
```

### Data flow

```
Request → Check cache (TTLCache)
               │
          HIT ─┤─ return { source:"cache", stale: bool }
               │
          MISS ─► Fetch from live provider
                      │
                 OK ──┤── cache result, return { source:"live" }
                      │
                 ERR ─┤── Check stale cache
                           │
                      HIT ─┤── return { source:"cache", stale:true }
                           │
                      MISS ─► return seed fallback { source:"seeded", stale:true }
```

---

## Quick Start

### 1. Get API keys (all free tiers)

| Service       | URL                              | Notes                      |
|---------------|----------------------------------|----------------------------|
| Anthropic     | https://console.anthropic.com    | claude-sonnet-4-6 + web_search |
| Alpha Vantage | https://www.alphavantage.co/support/#api-key | Free: 25 req/day |
| FRED          | https://fred.stlouisfed.org/docs/api/api_key.html | Free |

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env and add your three API keys
```

### 3. Install dependencies

```bash
cd the_dispatch
npm install
```

### 4. Start the server

```bash
npm start
# → Server running at http://localhost:3001
```

Open http://localhost:3001 in your browser.

---

## Development

```bash
npm run dev   # nodemon auto-restart on file changes
npm test      # run Jest test suite
```

---

## Environment Variables

| Variable              | Required | Default | Description                        |
|-----------------------|----------|---------|------------------------------------|
| `ANTHROPIC_API_KEY`   | ✅       | —       | Anthropic API key (sk-ant-...)      |
| `ALPHA_VANTAGE_API_KEY` | ✅     | demo    | Alpha Vantage API key               |
| `FRED_API_KEY`        | ✅       | —       | FRED API key                        |
| `PORT`                | No       | 3001    | HTTP server port                    |
| `CACHE_TTL_MARKET`    | No       | 5       | Market data cache TTL (minutes)     |
| `CACHE_TTL_FRED`      | No       | 60      | FRED data cache TTL (minutes)       |
| `CACHE_TTL_AI`        | No       | 30      | AI-generated content TTL (minutes)  |

---

## API Reference

### GET /api/snapshot
Returns FRED rates, USD/GBP FX, US watchlist prices, chart history.

**Response envelope** (all endpoints):
```json
{
  "source":    "live | cache | seeded",
  "fetchedAt": "2026-03-08T14:23:01.000Z",
  "stale":     false,
  "data":      { ... }
}
```

### GET /api/portfolio
Computes live portfolio P&L for all 6 positions using live prices and USD/GBP FX.

### GET /api/risk
Returns current risk monitor (7 items). Served from cache or seed fallback.

### POST /api/risk/refresh
Triggers Anthropic AI re-assessment with live web search. Updates cache.

### GET /api/events
Returns market events log + 3 economic analysis cards.

### POST /api/events/refresh
Triggers parallel Anthropic AI calls for events and econ analysis.

### GET /api/explain/:ticker
Returns AI explanation of any ticker or macro concept, grounded in portfolio context.
Results are cached per ticker for 30 minutes.

### GET /api/health
Returns server uptime and API key status flags.

---

## Caching Strategy

| Data type              | TTL          | Notes                                      |
|------------------------|--------------|--------------------------------------------|
| FRED rates             | 60 min       | FRED only publishes once daily             |
| Alpha Vantage prices   | 5 min        | Intraday; AV free tier is 25 req/day       |
| AI events / econ       | 30 min       | Expensive — use POST /refresh on demand    |
| AI risk scores         | 30 min       | Same                                        |
| AI ticker explains     | 30 min       | Cached per ticker                           |

Stale cache is always served in preference to a 500 error. The `stale` flag in the response envelope tells the UI to show a ⚠ badge.

---

## Data Provenance

Every API response includes:
- `source`: `"live"` | `"cache"` | `"seeded"`
- `fetchedAt`: ISO 8601 timestamp of when data was fetched
- `stale`: boolean — true if serving stale/fallback data

The client renders these as colour-coded source badges on each card:
- 🟢 **LIVE** — fresh from the provider
- 🟡 **CACHED** — from TTL cache (may be slightly delayed)
- ⬜ **SEEDED** — hardcoded fallback (server offline / API key missing)

---

## Security

**The original dashboard called Anthropic's API directly from the browser** with `anthropic-dangerous-direct-browser-access: true` and stored the key in localStorage. This Phase 1 rewrite eliminates that completely:

- All API keys are in `.env` (server-side only, gitignored)
- The browser makes only `fetch('/api/...')` calls to the local Express server
- No API key ever appears in browser network requests, localStorage, or JavaScript

---

## Project Structure

```
the_dispatch/
├── .env.example             ← Copy to .env and fill in keys
├── package.json
├── README.md
├── seeds/
│   └── fallback.js          ← All hardcoded seed data with provenance
├── server/
│   ├── index.js             ← Express entry point
│   ├── cache.js             ← TTL in-memory cache
│   ├── retry.js             ← fetchWithTimeout + withRetry + isRetryable
│   ├── schemas/
│   │   └── index.js         ← Zod schemas for all API responses
│   ├── providers/
│   │   ├── alphaVantage.js  ← getQuote, getQuotes, getFxRate
│   │   ├── fred.js          ← getLatestObservation, getAllRates, getRecentHistory
│   │   └── anthropic.js     ← fetchMarketEvents, fetchRiskScores, fetchEconAnalysis,
│   │                            fetchWatchlistPrices, fetchTickerExplain
│   └── routes/
│       ├── snapshot.js      ← GET /api/snapshot
│       ├── portfolio.js     ← GET /api/portfolio
│       ├── risk.js          ← GET /api/risk  POST /api/risk/refresh
│       ├── events.js        ← GET /api/events  POST /api/events/refresh
│       └── explain.js       ← GET /api/explain/:ticker
├── client/
│   └── index.html           ← React 18 UMD SPA — all API calls via fetch('/api/...')
└── tests/
    ├── providers.test.js    ← Unit tests: FRED, AV, cache, retry
    └── endpoints.test.js    ← API contract tests (supertest + jest.mock)
```

---

## Portfolio Holdings

| Ticker | Name                            | Currency | Asset class          |
|--------|---------------------------------|----------|----------------------|
| AMD    | Advanced Micro Devices          | USD      | US equity            |
| HIES   | iShares MSCI EM Semiconductors  | GBP      | EM semi ETF          |
| HIUS   | iShares Core S&P 500 ETF        | GBP      | US large-cap ETF     |
| HIJS   | iShares MSCI Japan Small Cap    | GBP      | Japan small-cap ETF  |
| SGLN   | iShares Physical Gold ETC       | GBP      | Gold ETC             |
| HBKS   | iShares $ Corp Bond ETF (GBP)   | GBP      | Investment grade bonds |

---

## Phase Roadmap

| Phase | Status | Description |
|-------|--------|-------------|
| **1** | ✅ Done | Backend API, server-side keys, caching, fallback, schema validation |
| **2** | Planned | Thesis workflow, scenario engine, attribution panel, Learning Mode |
| **3** | Planned | Morning Note export, Risk Pack PDF, Desk Brief mode, confidence scores |
