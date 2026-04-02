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

// ── Rate observation ──────────────────────────────────────────────────────────
const RateObs = z.object({
  value:    z.number(),
  seriesId: z.string(),
  date:     z.string(),
  source:   z.string(),
});

// ── Watchlist item ────────────────────────────────────────────────────────────
const WatchlistItem = z.object({
  sym:    z.string(),
  price:  z.number(),
  chg:    z.number(),
  note:   z.string(),
  source: z.string(),
  date:   z.string(),
});

// ── International watchlist item ──────────────────────────────────────────────
const IntlItem = z.object({
  sym:    z.string(),
  name:   z.string(),
  price:  z.string(),
  chg:    z.string(),
  note:   z.string(),
  source: z.string(),
  date:   z.string(),
});

// ── FX rate ───────────────────────────────────────────────────────────────────
const FxRate = z.object({
  value:  z.number(),
  pair:   z.string(),
  date:   z.string(),
  source: z.string(),
});

// ── Chart history points ──────────────────────────────────────────────────────
// real/bei are nullable: DFII10 and T10YIE sometimes lag DGS10 by a day.
// snapshot.js now filters to only fully-populated rows, but nullable here
// ensures a schema warning never blocks the response if one slips through.
const RatesHistoryPoint = z.object({
  m:    z.string(),
  y10:  z.number(),
  real: z.number().nullable(),
  bei:  z.number().nullable(),
});

const HyHistoryPoint = z.object({
  m:   z.string(),
  oas: z.number(),
});

const RsiHistoryPoint = z.object({
  d:   z.string(),
  rsi: z.number(),
});

// ── /api/snapshot ─────────────────────────────────────────────────────────────
const SnapshotPayload = z.object({
  rates: z.object({
    dgs10:     RateObs.nullable(),
    dfii10:    RateObs.nullable(),
    t10yie:    RateObs.nullable(),
    hy_spread: RateObs.nullable(),
    t10y2y:    RateObs.nullable(),
  }),
  fx: z.object({
    usdgbp: FxRate,
  }),
  watchlist:    z.array(WatchlistItem),
  intl:         z.array(IntlItem),
  ratesHistory: z.array(RatesHistoryPoint),
  hyHistory:    z.array(HyHistoryPoint),
  rsiHistory:   z.array(RsiHistoryPoint),
});

const SnapshotResponse = Envelope.extend({
  data: SnapshotPayload,
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
});

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
});

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

// ── /api/ideas ────────────────────────────────────────────────────────────────
const RiskCheckItem = z.object({
  name:   z.string(),
  status: z.enum(["OK", "WARN", "BLOCK"]),
  detail: z.string(),
});

const RiskCheckResult = z.object({
  pass:   z.boolean(),
  level:  z.enum(["OK", "WARN", "BLOCK"]),
  checks: z.array(RiskCheckItem),
});

const IdeaItem = z.object({
  id:           z.string(),
  ticker:       z.string(),
  direction:    z.enum(["LONG", "SHORT"]),
  thesis:       z.string(),
  catalyst:     z.string(),
  entry:        z.number(),
  stop:         z.number(),
  target:       z.number(),
  invalidation: z.string(),
  horizon:      z.string(),
  confidence:   z.number().int().min(0).max(100),
  sizePct:      z.number().positive(),
  status:       z.enum(["OPEN", "CLOSED", "CANCELLED"]),
  outcome:      z.enum(["HIT", "STOPPED", "CANCELLED"]).nullable(),
  openedAt:     z.string(),
  closedAt:     z.string().nullable(),
  actualPnLPct: z.number().nullable(),
  notes:        z.string(),
  riskCheck:    RiskCheckResult.optional(),
});

const IdeaStats = z.object({
  total:             z.number(),
  open:              z.number(),
  closed:            z.number(),
  cancelled:         z.number(),
  hitRate:           z.number().nullable(),
  stopRate:          z.number().nullable(),
  avgConfidenceWin:  z.number().nullable(),
  avgConfidenceLoss: z.number().nullable(),
  avgRMultiple:      z.number().nullable(),
  avgHoldDays:       z.number().nullable(),
});

// ── /api/brief ────────────────────────────────────────────────────────────────
const WhatChangedItem = z.object({
  series:   z.string(),
  label:    z.string(),
  current:  z.number(),
  prev:     z.number(),
  deltaBps: z.number(),
  signal:   z.enum(["BULLISH", "BEARISH", "NEUTRAL"]),
});

const ActionableSetupItem = z.object({
  ticker:    z.string(),
  direction: z.string(),
  rationale: z.string(),
});

const BriefPayload = z.object({
  date:            z.string(),
  regime:          z.string(),
  regimeDrivers:   z.array(z.string()),
  whatChanged:     z.array(WhatChangedItem),
  whyItMatters:    z.string(),
  actionableSetup: z.array(ActionableSetupItem),
  openIdeas:       z.number(),
  nextEvent: z.object({
    date:       z.string(),
    event:      z.string(),
    ticker:     z.string(),
    importance: z.string(),
  }).nullable(),
});

const BriefResponse = Envelope.extend({ data: BriefPayload });

// ── /api/ideas engine tickets ─────────────────────────────────────────────────
const LearningContent = z.object({
  traderInterpretation:    z.string(),
  economicsInterpretation: z.string(),
  keyTerms:  z.array(z.object({ term: z.string(), definition: z.string() })),
  falsification: z.array(z.string()),
});

const EngineTicket = z.object({
  id:                    z.string(),
  generatedAt:           z.string(),
  regime:                z.string(),
  playbook:              z.string(),
  strategyType:          z.string(),
  ticker:                z.string(),
  direction:             z.enum(["LONG", "SHORT"]),
  horizon:               z.string(),
  entryLogic:            z.string(),
  stopLogic:             z.string(),
  targetLogic:           z.string(),
  sizingRule:            z.string(),
  invalidation:          z.string(),
  rationale:             z.string(),
  confidence:            z.number().int().min(0).max(100),
  riskFlags:             z.array(z.any()),
  engineDecision:        z.enum(["allowed", "blocked", "caution"]),
  engineReasons:         z.array(z.string()),
  expectedDrivers:       z.array(z.string()),
  requiredDataFreshness: z.string(),
  sourceMode:            z.enum(["deterministic", "ai-enriched"]),
  learning:              LearningContent.nullable(),
});

// ── PaperMetrics ──────────────────────────────────────────────────────────────
const TickerStat = z.object({
  count:   z.number(),
  hitRate: z.number().nullable(),
  avgPnL:  z.number().nullable(),
});

const DirectionStat = z.object({
  count:   z.number(),
  hitRate: z.number().nullable(),
  avgPnL:  z.number().nullable(),
});

const PaperMetrics = z.object({
  total:        z.number(),
  open:         z.number(),
  closed:       z.number(),
  cancelled:    z.number(),
  hitRate:      z.number().nullable(),
  stopRate:     z.number().nullable(),
  avgPnLPct:    z.number().nullable(),
  avgWinPct:    z.number().nullable(),
  avgLossPct:   z.number().nullable(),
  expectancy:   z.number().nullable(),
  avgRMultiple: z.number().nullable(),
  avgHoldDays:  z.number().nullable(),
  mfe:          z.number().nullable(),
  mae:          z.number().nullable(),
  byTicker:     z.record(z.string(), TickerStat),
  byDirection:  z.object({
    LONG:  DirectionStat,
    SHORT: DirectionStat,
  }),
});

// ── Validation helper ─────────────────────────────────────────────────────────
function validate(schema, payload) {
  const result = schema.safeParse(payload);
  if (result.success) return { ok: true, data: result.data };
  const errors = result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`);
  return { ok: false, errors };
}

module.exports = {
  schemas: {
    SnapshotResponse,
    PortfolioResponse,
    RiskResponse,
    EventsResponse,
    ExplainResponse,
    BriefResponse,
    IdeaItem,
    IdeaStats,
    EngineTicket,
    PaperMetrics,
  },
  validate,
};
