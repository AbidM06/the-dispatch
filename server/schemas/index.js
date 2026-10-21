/**
 * server/schemas/index.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Zod schemas for all API response envelopes and payloads.
 * Every route validates its outbound payload before responding.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { z } = require("zod");

// ── Shared envelope ───────────────────────────────────────────────────────────
const Envelope = z.object({
  source:    z.enum(["live", "cache", "seeded", "computed"]),
  fetchedAt: z.string().datetime({ offset: true }).or(z.string()),
  stale:     z.boolean(),
});

// ── /api/portfolio ────────────────────────────────────────────────────────────
const PositionRow = z.object({
  ticker:   z.string(),
  shares:   z.number(),
  currency: z.enum(["USD", "GBP"]),
  costUSD:  z.number().optional(),
  costGBP:  z.number().optional(),
  priceUSD: z.number().optional(),
  priceGBP: z.number().optional(),
  chg:      z.number(),
  valGBP:   z.number(),
  costGBP_: z.number(),
  pnlGBP:   z.number(),
  pnlPct:   z.number(),
  source:   z.string(),
  date:     z.string(),
});

// Analyst metrics added to portfolio payload (replaces Unrealised PnL summary)
const ScenarioSensItem = z.object({
  id:        z.string().or(z.number()),
  label:     z.string(),
  prob:      z.number(),
  impactGBP: z.number(),
  impactPct: z.number(),
});

const AnalystMetrics = z.object({
  weightedBeta:       z.number(),
  hhi:                z.number(),
  usdExposurePct:     z.number(),
  scenarioSensitivity: z.array(ScenarioSensItem),
  expectedImpactPct:  z.number(),
});

const PortfolioPayload = z.object({
  rows:           z.array(PositionRow),
  totalGBP:       z.number(),
  totalCostGBP:   z.number(),
  totalPnL:       z.number(),
  totalPnLPct:    z.number(),
  usdgbp:         z.number(),
  betas:          z.record(z.string(), z.number()),
  ccyExp:         z.record(z.string(), z.record(z.string(), z.number())),
  scenarios:      z.array(z.any()),
  earningsCal:    z.array(z.any()),
  macroCal:       z.array(z.any()),
  analystMetrics: AnalystMetrics,
});

const PortfolioResponse = Envelope.extend({
  data: PortfolioPayload,
});

// ── /api/risk ─────────────────────────────────────────────────────────────────
const RiskItem = z.object({
  id:      z.number(),
  title:   z.string(),
  level:   z.enum(["HIGH", "MEDIUM", "LOW"]),
  score:   z.number().int().min(0).max(100),
  detail:  z.string(),
  affects: z.string(),
  date:    z.string().optional(),
}).passthrough();   // keep server-added provenance such as `basis` (validate() used to strip it)

const RiskPayload = z.object({
  risks: z.array(RiskItem).length(7),
});

const RiskResponse = Envelope.extend({
  data: RiskPayload,
});

// ── /api/events ───────────────────────────────────────────────────────────────
const EventItem = z.object({
  headline: z.string(),
  impact:   z.enum(["BULLISH", "BEARISH", "NEUTRAL"]),
  ticker:   z.string(),
  detail:   z.string(),
  date:     z.string().optional(),
}).passthrough();   // keep server-added provenance such as `basis` (validate() used to strip it)

const EventsPayload = z.object({
  events: z.array(EventItem),
  econ:   z.array(z.any()),
});

const EventsResponse = Envelope.extend({
  data: EventsPayload,
});

// ── /api/explain/:ticker ──────────────────────────────────────────────────────
const ExplainPayload = z.object({
  ticker:     z.string(),
  what:       z.string(),
  now:        z.string(),
  portfolio:  z.string(),
  confidence: z.number().min(0).max(100),
});

const ExplainResponse = Envelope.extend({
  data: ExplainPayload,
});

// ── /api/pitch/:ticker ────────────────────────────────────────────────────────
const PitchRiskItem = z.object({
  risk:       z.string(),
  mitigation: z.string(),
});

const PitchPayload = z.object({
  ticker:       z.string(),
  companyName:  z.string(),
  direction:    z.enum(["OVERWEIGHT", "UNDERWEIGHT"]),
  priceTarget:  z.number().nullable(),
  currentPrice: z.number().nullable(),
  timeframe:    z.string(),
  upsidePct:    z.number().nullable(),
  conclusion:   z.string(),
  scene:        z.string(),
  thesis:       z.string(),
  catalyst:     z.string(),
  risks:        z.array(PitchRiskItem),
  hedge:        z.string(),
  confidence:   z.number().min(0).max(100),
});

const PitchResponse = Envelope.extend({
  data: PitchPayload,
});

// ── /api/brief ────────────────────────────────────────────────────────────────
const WhatChangedItem = z.object({
  series:    z.string(),
  label:     z.string(),
  available: z.boolean(),
  current:   z.number().nullable(),
  prev:      z.number().nullable(),
  deltaBps:  z.number().nullable(),
  signal:    z.enum(["BULLISH", "BEARISH", "NEUTRAL"]).nullable(),
  asOf:       z.string().nullable().optional(),
  source:     z.string().nullable().optional(),
  sourceUrl:  z.string().nullable().optional(),
  stale:      z.boolean().optional(),
  staleSince: z.string().nullable().optional(),
  freshness:  z.string().nullable().optional(),
});

const BriefPayload = z.object({
  date:          z.string(),
  oldestAsOf:    z.string().nullable(),
  regime:        z.string().nullable(),
  regimeDrivers: z.array(z.string()),
  whatChanged:   z.array(WhatChangedItem),
  missing:       z.array(z.string()),
  whyItMatters:  z.string().nullable(),
  nextEvent: z.object({
    available: z.literal(false),
    reason:    z.string(),
  }),
});

const BriefResponse = Envelope.extend({ data: BriefPayload });

// ── Validation helper ─────────────────────────────────────────────────────────
function validate(schema, payload) {
  const result = schema.safeParse(payload);
  if (result.success) return { ok: true, data: result.data };
  const errors = result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`);
  return { ok: false, errors };
}

module.exports = {
  schemas: {
    PortfolioResponse,
    RiskResponse,
    EventsResponse,
    ExplainResponse,
    PitchResponse,
    BriefResponse,
  },
  validate,
};
