/**
 * server/schemas/index.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Zod schemas for all API response envelopes and payloads.
 * Every route validates its outbound payload before responding.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { z } = require("zod");

// ── Shared envelope ───────────────────────────────────────────────────────────
// .passthrough() on every provenance-bearing schema is deliberate. Zod's default
// is to STRIP unknown keys, and validate() returns the parsed copy — so any
// provenance field not listed here (retrievedAt, freshness, kind, components…)
// was silently deleted from the response on its way to the client. A schema
// that removes provenance is worse than no schema.
const Envelope = z.object({
  source:    z.enum(["live", "cache", "seeded", "computed", "demo", "partial", "unavailable"]),
  fetchedAt: z.string().datetime({ offset: true }).or(z.string()).nullable(),
  stale:     z.boolean(),
}).passthrough();

const Freshness = z.object({
  status: z.enum(["current", "lagging", "stale", "unknown", "demo", "unavailable"]),
}).passthrough();

// ── Rate observation (Fact) ───────────────────────────────────────────────────
// value may be null: an unavailable fact is still a fact about what we lack.
const RateObs = z.object({
  value:     z.number().nullable(),
  seriesId:  z.string().optional(),
  date:      z.string().nullable(),
  source:    z.string().optional(),
  kind:      z.enum(["observed", "calculated", "estimate", "unavailable", "demo"]).optional(),
  freshness: Freshness.optional(),
}).passthrough();

// ── Watchlist item ────────────────────────────────────────────────────────────
const WatchlistItem = z.object({
  sym:    z.string(),
  price:  z.number().nullable(),
  chg:    z.number().nullable(),
  note:   z.string(),
  source: z.string().nullable(),
  date:   z.string().nullable(),
}).passthrough();

// ── International watchlist item ──────────────────────────────────────────────
const IntlItem = z.object({
  sym:    z.string(),
  name:   z.string(),
  price:  z.string(),
  chg:    z.string(),
  note:   z.string(),
  source: z.string(),
  date:   z.string(),
}).passthrough();

// ── FX rate ───────────────────────────────────────────────────────────────────
const FxRate = z.object({
  value:  z.number().nullable(),
  pair:   z.string(),
  date:   z.string().nullable(),
  source: z.string().optional(),
}).passthrough();

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
}).passthrough();

const SnapshotResponse = Envelope.extend({
  data: SnapshotPayload,
}).passthrough();

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
}).passthrough();

// Any number of risks. Exactly-7 forced the deterministic generator to pad the
// list with canned scenarios (a war, a tariff package) to satisfy the schema.
const RiskPayload = z.object({
  risks: z.array(RiskItem),
}).passthrough();

const RiskResponse = Envelope.extend({
  data: RiskPayload,
}).passthrough();

// ── /api/events ───────────────────────────────────────────────────────────────
const EventItem = z.object({
  headline: z.string(),
  impact:   z.enum(["BULLISH", "BEARISH", "NEUTRAL"]),
  ticker:   z.string(),
  detail:   z.string(),
  date:     z.string().optional(),
}).passthrough();

const EventsPayload = z.object({
  events: z.array(EventItem),
  econ:   z.array(z.any()),
}).passthrough();

const EventsResponse = Envelope.extend({
  data: EventsPayload,
}).passthrough();

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
// prev/deltaBps are null when no dated prior observation exists. The signal
// describes the RATE's direction, not a market call on it.
const WhatChangedItem = z.object({
  series:   z.string(),
  label:    z.string(),
  current:  z.number().nullable(),
  prev:     z.number().nullable(),
  deltaBps: z.number().nullable(),
  signal:   z.enum(["RISING", "FALLING", "LITTLE CHANGED", "NEUTRAL", "UNAVAILABLE"]),
}).passthrough();

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

// ── Research reports — runtime contract per report type ─────────────────────
// Each schema mirrors the JSON contract its prompt in providers/anthropic.js
// asks for. The prompt ASKS for estimates[] and unverified[]; these schemas are
// what REQUIRE them. A report that omits its disclosures, its scenarios or its
// invalidation conditions is rejected, not rendered as complete.
//
// .passthrough(): every other field the model returns is kept.
const Disclosures = {
  // Figures the model produced itself (forecasts, estimates) rather than read
  // from the verified block or a search result.
  estimates:  z.array(z.any()),
  // Claims it could not confirm. [] is allowed; absence is not.
  unverified: z.array(z.any()),
};
const nonEmpty = z.string().trim().min(1);

const ResearchSchemas = {
  fx: z.object({
    title: nonEmpty,
    pairViews: z.array(z.object({ pair: nonEmpty, direction: nonEmpty }).passthrough()).min(1),
    risks: z.array(z.any()).min(1),
    ...Disclosures,
  }).passthrough(),
  rates: z.object({
    title: nonEmpty,
    thePuzzle: nonEmpty,
    catalysts: z.array(z.any()).min(1),
    ...Disclosures,
  }).passthrough(),
  thematic: z.object({
    title: nonEmpty,
    keyThemes: z.array(z.any()).min(1),
    predictions: z.array(z.any()).min(1),
    ...Disclosures,
  }).passthrough(),
  equity: z.object({
    title: nonEmpty,
    epsOutlook: z.object({}).passthrough(),
    crossAssetContext: z.object({}).passthrough(),
    rateSensitivity: z.object({}).passthrough(),
    scenarios: z.object({}).passthrough().refine(o => Object.keys(o).length >= 2, "scenarios needs at least two cases"),
    risks: z.array(z.any()).min(1),
    invalidation: z.union([nonEmpty, z.object({}).passthrough()]),
    ...Disclosures,
  }).passthrough(),
  commodities: z.object({
    title: nonEmpty,
    keyTakeaways: z.array(z.any()).min(1),
    scenarios: z.object({}).passthrough(),
    ...Disclosures,
  }).passthrough(),
  macro: z.object({
    title: nonEmpty,
    abstract: z.array(z.any()).min(1),
    scenarios: z.object({ baseline: z.object({}).passthrough(), stress: z.object({}).passthrough() }).passthrough(),
    ...Disclosures,
  }).passthrough(),
};

/**
 * validateResearchReport — { ok, errors } for a parsed report of `type`.
 * Unknown types are validated as macro (the default report).
 */
function validateResearchReport(type, data) {
  const schema = ResearchSchemas[type] || ResearchSchemas.macro;
  if (!data || typeof data !== "object") return { ok: false, errors: ["report is not a JSON object"] };
  return validate(schema, data);
}

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
  ResearchSchemas,
  validate,
  validateResearchReport,
};
