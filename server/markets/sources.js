/**
 * server/markets/sources.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Free-data adapters for the Markets panel. Every adapter returns a normalised
 * quote so the UI can always show WHERE a number came from and WHEN it was
 * released:
 *
 *   {
 *     value, prevValue, change, changePct,   // numbers (prevValue/change may be null)
 *     currency,                              // "USD" | "GBP" | … | null
 *     asOf,        // ISO — the moment/period the value refers to (exchange print time, observation date)
 *     releasedAt,  // ISO — when the provider published it (== asOf for exchange prints)
 *     cadence,     // "tick" | "daily" | "monthly" | "reference"
 *     source,      // short provider name, e.g. "Yahoo Finance"
 *     sourceDetail,// venue / series detail, e.g. "COMEX via Yahoo Finance"
 *     sourceUrl,   // public page where the number can be checked
 *   }
 *
 * History adapters return { type: "ohlc", bars: [{t,o,h,l,c}] } or
 * { type: "line", points: [{t,v}] } with t in epoch seconds.
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const { fetchWithTimeout, withRetry, isRetryable } = require("../retry");

const UA = { "User-Agent": "Mozilla/5.0 (Macintosh) TheDispatch/1.0" };

async function getJson(url, { headers = {}, timeout = 12_000, attempts = 2 } = {}) {
  return withRetry(async () => {
    const res = await fetchWithTimeout(url, { headers }, timeout);
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} for ${url.replace(/(api_key|token)=[^&]+/g, "$1=***")}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }, { attempts, baseMs: 600, shouldRetry: (e) => isRetryable(e) });
}

const round = (n, d = 6) => (n == null || !isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);

function withChange(value, prevValue) {
  const change    = prevValue != null ? value - prevValue : null;
  const changePct = prevValue ? (change / prevValue) * 100 : null;
  return { value: round(value), prevValue: round(prevValue), change: round(change), changePct: round(changePct, 4) };
}

// ═════════════════════════════════════════════════════════════════════════════
// Yahoo Finance (unofficial chart API — no key)
// ═════════════════════════════════════════════════════════════════════════════
const YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/";

async function yahooChart(symbol, range, interval) {
  const json = await getJson(`${YAHOO}${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`, { headers: UA });
  const r = json?.chart?.result?.[0];
  if (!r?.meta) throw new Error(`Yahoo: no data for ${symbol}`);
  return r;
}

async function yahooQuote({ symbol }) {
  const r    = await yahooChart(symbol, "5d", "1d");
  const m    = r.meta;
  const price = m.regularMarketPrice;
  if (price == null || !m.regularMarketTime) throw new Error(`Yahoo: missing price/time for ${symbol}`);

  // Previous close: prefer Yahoo's own day-change, else the prior daily bar.
  let prev = null;
  if (typeof m.regularMarketChangePercent === "number") {
    prev = price / (1 + m.regularMarketChangePercent / 100);
  } else {
    const closes = (r.indicators?.quote?.[0]?.close || []).filter(v => v != null);
    if (closes.length >= 2) prev = closes[closes.length - 2];
  }
  const asOf  = new Date(m.regularMarketTime * 1000).toISOString();
  const venue = m.fullExchangeName || m.exchangeName || "Yahoo";
  return {
    ...withChange(price, prev),
    currency:     m.currency || null,
    asOf,
    releasedAt:   asOf,
    cadence:      "tick",
    source:       "Yahoo Finance",
    sourceDetail: `${venue} via Yahoo Finance`,
    sourceUrl:    `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`,
    venueTz:      m.exchangeTimezoneName || null,
  };
}

async function yahooHistory({ symbol }, tf) {
  const [range, interval] = tf === "1h" ? ["1mo", "60m"] : ["6mo", "1d"];
  const r  = await yahooChart(symbol, range, interval);
  const q  = r.indicators?.quote?.[0] || {};
  const ts = r.timestamp || [];
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if ([o, h, l, c].some(v => v == null)) continue;
    bars.push({ t: ts[i], o: round(o), h: round(h), l: round(l), c: round(c) });
  }
  if (!bars.length) throw new Error(`Yahoo: empty history for ${symbol}`);
  return { type: "ohlc", bars, source: "Yahoo Finance", sourceUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}` };
}

// ═════════════════════════════════════════════════════════════════════════════
// FRED (free key) — value + publication timestamp
// ═════════════════════════════════════════════════════════════════════════════
const FRED = "https://api.stlouisfed.org/fred";

function fredKey() {
  const k = process.env.FRED_API_KEY;
  if (!k) throw new Error("FRED_API_KEY not set");
  return k;
}

/** "2026-09-25 08:01:03-05" → ISO */
function parseFredTimestamp(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})([+-]\d{2})(\d{2})?$/);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}${m[3]}:${m[4] || "00"}`);
  return isNaN(d) ? null : d.toISOString();
}

async function fredObservations(series, { start, limit, sort = "asc" } = {}) {
  const url = new URL(`${FRED}/series/observations`);
  url.searchParams.set("series_id", series);
  url.searchParams.set("api_key", fredKey());
  url.searchParams.set("file_type", "json");
  url.searchParams.set("sort_order", sort);
  if (start) url.searchParams.set("observation_start", start);
  if (limit) url.searchParams.set("limit", String(limit));
  const json = await getJson(url.toString());
  return (json.observations || [])
    .filter(o => o.value !== "." && o.value !== "")
    .map(o => ({ date: o.date, v: parseFloat(o.value) }));
}

async function fredSeriesInfo(series) {
  const url = `${FRED}/series?series_id=${series}&api_key=${fredKey()}&file_type=json`;
  const json = await getJson(url);
  return json?.seriess?.[0] || {};
}

function applyTransform(obs, { transform, scale }) {
  let out = obs.slice().sort((a, b) => a.date.localeCompare(b.date));
  if (transform === "yoy") {
    const byDate = new Map(out.map(o => [o.date, o.v]));
    out = out.map(o => {
      const d = new Date(o.date + "T00:00:00Z");
      d.setUTCFullYear(d.getUTCFullYear() - 1);
      const prior = byDate.get(d.toISOString().slice(0, 10));
      return prior ? { date: o.date, v: (o.v / prior - 1) * 100 } : null;
    }).filter(Boolean);
  }
  if (scale) out = out.map(o => ({ date: o.date, v: o.v * scale }));
  return out;
}

async function fredQuote(src) {
  const monthlyish = src.transform === "yoy";
  const [obsDesc, info] = await Promise.all([
    fredObservations(src.series, { sort: "desc", limit: monthlyish ? 26 : 5 }),
    fredSeriesInfo(src.series).catch(() => ({})),
  ]);
  const obs = applyTransform(obsDesc, src);
  if (!obs.length) throw new Error(`FRED: no observations for ${src.series}`);
  const last = obs[obs.length - 1];
  const prev = obs.length > 1 ? obs[obs.length - 2] : null;
  const freq = (info.frequency_short || "").toUpperCase(); // D, W, M, Q
  return {
    ...withChange(last.v, prev ? prev.v : null),
    currency:     null,
    asOf:         new Date(last.date + "T00:00:00Z").toISOString(),
    asOfDate:     last.date,
    releasedAt:   parseFredTimestamp(info.last_updated) || null,
    cadence:      freq === "M" || freq === "Q" ? "monthly" : "daily",
    source:       "FRED",
    sourceDetail: `${info.title || src.series} · FRED ${src.series}`,
    sourceUrl:    `https://fred.stlouisfed.org/series/${src.series}`,
  };
}

async function fredHistory(src, tf) {
  const years = src.transform === "yoy" ? 11 : (src.series === "M2SL" ? 5 : 1);
  const start = new Date();
  start.setUTCFullYear(start.getUTCFullYear() - years);
  const obs = applyTransform(await fredObservations(src.series, { start: start.toISOString().slice(0, 10) }), src);
  if (!obs.length) throw new Error(`FRED: empty history for ${src.series}`);
  return {
    type: "line",
    points: obs.map(o => ({ t: Math.floor(Date.parse(o.date + "T00:00:00Z") / 1000), v: round(o.v, 4) })),
    source: "FRED",
    sourceUrl: `https://fred.stlouisfed.org/series/${src.series}`,
    note: tf === "1h" ? "FRED publishes daily/monthly — no intraday data" : undefined,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Finnhub /quote (free key) — US stocks fallback
// ═════════════════════════════════════════════════════════════════════════════
async function finnhubQuote({ symbol }) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) throw new Error("FINNHUB_API_KEY not set");
  const j = await getJson(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`);
  if (!j || !j.c || !j.t) throw new Error(`Finnhub: no quote for ${symbol}`);
  const asOf = new Date(j.t * 1000).toISOString();
  return {
    ...withChange(j.c, j.pc || null),
    currency: "USD", asOf, releasedAt: asOf, cadence: "tick",
    source: "Finnhub", sourceDetail: "US consolidated via Finnhub",
    sourceUrl: `https://finnhub.io/`,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Frankfurter — ECB reference rates (no key), FX fallback
// ═════════════════════════════════════════════════════════════════════════════
async function frankfurterQuote({ base, quote }) {
  const end = new Date(), start = new Date(Date.now() - 10 * 864e5);
  const j = await getJson(`https://api.frankfurter.app/${start.toISOString().slice(0, 10)}..${end.toISOString().slice(0, 10)}?from=${base}&to=${quote}`);
  const days = Object.keys(j.rates || {}).sort();
  if (!days.length) throw new Error(`Frankfurter: no rate for ${base}${quote}`);
  const last = days[days.length - 1], prev = days[days.length - 2];
  // ECB publishes reference rates at ~16:00 CET on TARGET business days.
  const asOf = new Date(`${last}T14:00:00Z`).toISOString();
  return {
    ...withChange(j.rates[last][quote], prev ? j.rates[prev][quote] : null),
    currency: quote, asOf, asOfDate: last, releasedAt: asOf, cadence: "reference",
    source: "ECB (Frankfurter)", sourceDetail: "ECB euro foreign exchange reference rate",
    sourceUrl: "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/",
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Polymarket (public, no key)
// ═════════════════════════════════════════════════════════════════════════════
function parseArr(v) {
  if (Array.isArray(v)) return v;
  try { return JSON.parse(v || "[]"); } catch { return []; }
}

/**
 * Top open events for the given tags, one headline market each. The market
 * chosen is the event's most-traded market whose odds are still undecided
 * (3–97%), so the panel doesn't fill with already-settled questions.
 */
async function polymarketTop(tags, count) {
  const seen = new Set(), picks = [];
  for (const tag of tags) {
    const events = await getJson(`https://gamma-api.polymarket.com/events?tag_slug=${encodeURIComponent(tag)}&active=true&closed=false&order=volume24hr&ascending=false&limit=${count * 2}`);
    for (const e of events || []) {
      if (seen.has(e.id)) continue;
      const live = (e.markets || [])
        .filter(m => m.active && !m.closed)
        .map(m => ({ m, yes: parseFloat(parseArr(m.outcomePrices)[0]) }))
        .filter(x => isFinite(x.yes) && x.yes >= 0.03 && x.yes <= 0.97)
        .sort((a, b) => (b.m.volume24hr || 0) - (a.m.volume24hr || 0));
      if (!live.length) continue;
      seen.add(e.id);
      picks.push({ event: e, market: live[0].m, yes: live[0].yes, tag });
    }
  }
  picks.sort((a, b) => (b.event.volume24hr || 0) - (a.event.volume24hr || 0));
  return picks.slice(0, count).map(({ event, market, yes, tag }) => {
    const asOf = market.updatedAt ? new Date(market.updatedAt).toISOString() : new Date().toISOString();
    const chg  = typeof market.oneDayPriceChange === "number" ? market.oneDayPriceChange : null;
    const tokenId = parseArr(market.clobTokenIds)[0] || null;
    const outcome = parseArr(market.outcomes)[0] || "Yes";
    return {
      id: `PM:${market.slug}`,
      label: market.question,
      eventTitle: event.title,
      outcome,
      group: "predictions", kind: "prob", unit: "%", decimals: 1,
      history: tokenId ? { provider: "polymarket", tokenId } : null,
      quote: {
        value: round(yes * 100, 2),
        prevValue: chg != null ? round((yes - chg) * 100, 2) : null,
        change: chg != null ? round(chg * 100, 2) : null,
        changePct: null,
        currency: null, asOf, releasedAt: asOf, cadence: "tick",
        source: "Polymarket", sourceDetail: `Polymarket · ${tag} · 24h vol $${Math.round(market.volume24hr || 0).toLocaleString("en-US")}`,
        sourceUrl: `https://polymarket.com/event/${event.slug}`,
      },
    };
  });
}

async function polymarketHistory({ tokenId }, tf) {
  const [interval, fidelity] = tf === "1h" ? ["1w", 60] : ["max", 1440];
  const j = await getJson(`https://clob.polymarket.com/prices-history?market=${tokenId}&interval=${interval}&fidelity=${fidelity}`);
  const points = (j.history || []).map(p => ({ t: p.t, v: round(p.p * 100, 2) }));
  if (!points.length) throw new Error("Polymarket: empty history");
  return { type: "line", points, source: "Polymarket", sourceUrl: "https://polymarket.com" };
}

// ═════════════════════════════════════════════════════════════════════════════
const QUOTE   = { yahoo: yahooQuote, fred: fredQuote, finnhub: finnhubQuote, frankfurter: frankfurterQuote };
const HISTORY = { yahoo: yahooHistory, fred: fredHistory, polymarket: polymarketHistory };

module.exports = {
  QUOTE, HISTORY, polymarketTop,
  // exported for tests
  _internal: { parseFredTimestamp, applyTransform, withChange, yahooQuote, fredQuote, frankfurterQuote, finnhubQuote, polymarketHistory, yahooHistory },
};
