/**
 * server/engine/ideaEngine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Core idea engine orchestrator.
 *
 * generateIdeas(ctx, opts) → EngineTicket[]
 *
 * ctx shape:
 *   {
 *     rates:     { dgs10, dfii10, t10yie, hy_spread, t10y2y },
 *     deltas:    { dgs10_d, dfii10_d, t10yie_d, hy_spread_d, t10y2y_d },
 *     portfolio: { rows, totalGBP, weights, hhi, usdPct },
 *     watchlist: { AMD: { price, chg }, NVDA: { price, chg }, ... },
 *     regime:    string,
 *     signals:   { maSignal, maConviction, momentumSignal, momentumConviction, reversionSignal, reversionConviction },
 *     today:     Date,
 *   }
 *
 * opts:
 *   { maxIdeas: 5, allowedCategories: ["macro","structure","portfolio"] }
 *
 * Each ticket is a fully-formed EngineTicket:
 *   { id, generatedAt, regime, playbook, strategyType, ticker, direction,
 *     horizon, entryLogic, stopLogic, targetLogic, sizingRule, invalidation,
 *     rationale, confidence, riskFlags, engineDecision, engineReasons,
 *     expectedDrivers, requiredDataFreshness, sourceMode, learning }
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const crypto      = require("crypto");
const { PLAYBOOKS } = require("./playbooks");
const { computeSignals } = require("./strategies");
const { gateIdea }  = require("./riskGate");
const { buildLearning } = require("./learningLayer");
const { getShariahStatus, isTransactionPermitted } = require("./shariahFilter");
const { scanUniverse } = require("./universeScanner");
const seeds = require("../../seeds/fallback");

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Produce a short deterministic ID from a string.
 * Used for reproducible idea IDs (same ctx + playbook + day = same ID).
 */
function deterministicHash(str) {
  return crypto.createHash("sha256").update(str).digest("hex").slice(0, 12);
}

/**
 * Map a playbook category → strategyType label for the ticket.
 */
function categoryToStrategyType(category, playbookId) {
  if (category === "macro") {
    if (["trend-continuation"].includes(playbookId)) return "trend";
    return "macro";
  }
  if (category === "structure") {
    if (playbookId === "mean-reversion")    return "mean-reversion";
    if (playbookId === "correlation-break") return "momentum";
    return "momentum";
  }
  if (category === "portfolio") return "portfolio";
  return "macro";
}

/**
 * Augment confidence with strategy signal confirmation.
 * If the dominant signal aligns with the ticket direction → +10 conviction.
 * If it conflicts → -10 conviction.
 */
function augmentConfidence(baseConfidence, direction, signals) {
  const { maSignal, momentumSignal, reversionSignal } = signals;
  const dir = direction.toLowerCase(); // "long" or "short"

  let boost = 0;
  const sigList = [maSignal, momentumSignal, reversionSignal];
  for (const sig of sigList) {
    if (sig === dir)        boost += 5;
    else if (sig !== "flat" && sig !== dir) boost -= 5;
  }

  return Math.min(Math.max(baseConfidence + boost, 10), 95);
}

// ── Build context helpers ─────────────────────────────────────────────────────

/**
 * Build a standardised ctx from raw cached/seeded data.
 * Exported so routes/tests can use it without duplicating logic.
 *
 * @param {object} rawRates   Raw rates object (from cache or seeds)
 * @param {object} portfolioData  { rows, totalGBP, usdgbp } or null
 * @param {object} watchlistData  Raw watchlist array or null
 * @returns {object} ctx
 */
function buildCtx(rawRates, portfolioData, watchlistData) {
  // ── Rates scalars ──
  function rv(obs, fallback) {
    if (obs && typeof obs.value === "number") return obs.value;
    if (typeof obs === "number") return obs;
    return fallback;
  }

  const rates = {
    dgs10:     rv(rawRates?.dgs10,     seeds.RATES_SEED.dgs10.value),
    dfii10:    rv(rawRates?.dfii10,    seeds.RATES_SEED.dfii10.value),
    t10yie:    rv(rawRates?.t10yie,    seeds.RATES_SEED.t10yie.value),
    hy_spread: rv(rawRates?.hy_spread, seeds.RATES_SEED.hy_spread.value),
    t10y2y:    rv(rawRates?.t10y2y,    seeds.RATES_SEED.t10y2y.value),
  };

  // ── Rate deltas vs history ──
  const history = seeds.RATES_HISTORY_SEED;
  const prev = history.length >= 2 ? history[history.length - 2] : null;
  const deltas = {
    dgs10_d:     prev ? +(rates.dgs10     - prev.y10) * 100 : 0,   // in bps (×100)
    dfii10_d:    prev ? +(rates.dfii10    - (prev.real ?? rates.dfii10)) * 100 : 0,
    t10yie_d:    prev ? +(rates.t10yie    - (prev.bei  ?? rates.t10yie)) * 100 : 0,
    hy_spread_d: 0,  // HY history not in rates history (only in hyHistory)
    t10y2y_d:    prev ? +(rates.t10y2y   - ((prev.y10 - 2.5) || 0)) * 100 : 0,  // approximate 2Y
  };

  // ── Portfolio ──
  const rows = portfolioData?.rows ?? seeds.POSITIONS_SEED.map(p => ({
    ticker: p.ticker, valGBP: null, chg: null,
  }));
  const totalGBP = portfolioData?.totalGBP ?? 1110;
  const usdgbp   = portfolioData?.usdgbp   ?? seeds.FX_SEED.usdgbp.value;

  const weights = {};
  let usdVal = 0;
  for (const r of rows) {
    if (r.valGBP != null && totalGBP > 0) {
      weights[r.ticker] = r.valGBP / totalGBP;
      const usdFrac = (seeds.CCY_EXP[r.ticker]?.USD ?? 0) / 100;
      usdVal += r.valGBP * usdFrac;
    }
  }

  const hhi = Math.round(
    Object.values(weights).reduce((s, w) => s + w * w, 0) * 10_000
  );
  const usdPct = totalGBP > 0 ? (usdVal / totalGBP) * 100 : 0;

  // ── Watchlist ──
  const watchlist = {};
  const wl = watchlistData ?? seeds.WATCHLIST_SEED;
  for (const item of wl) {
    watchlist[item.sym ?? item.ticker] = { price: item.price, chg: item.chg };
  }

  // ── Signals ──
  const ratesHistory = seeds.RATES_HISTORY_SEED;
  const signals = computeSignals(rates, ratesHistory, watchlist);

  // ── Regime (mirrors classifyRegime from brief.js) ──
  const regimeLabels = [];
  if      (rates.t10y2y < 0)   regimeLabels.push("Inverted curve");
  else if (rates.t10y2y < 0.3) regimeLabels.push("Flat curve");
  else                          regimeLabels.push("Bear steepener");
  if      (rates.dfii10 > 2.0) regimeLabels.push("High real yields");
  else if (rates.dfii10 > 1.5) regimeLabels.push("Elevated real yields");
  if      (rates.hy_spread > 4.5)                            regimeLabels.push("Credit stress");
  else if (rates.hy_spread > 3.5)                            regimeLabels.push("Risk-off");
  else if (rates.hy_spread > 3.0 && rates.dfii10 > 1.5)     regimeLabels.push("Bear flattener");
  if (rates.dgs10 > 4.5) regimeLabels.push("Rates restrictive");
  const regime = regimeLabels.length ? regimeLabels.join(" + ") : "Broadly neutral";

  return {
    rates,
    deltas,
    portfolio: { rows, totalGBP, weights, hhi, usdPct },
    watchlist,
    regime,
    signals,
    today: new Date(),
    _usdgbp: usdgbp,
  };
}

// ── Core engine ───────────────────────────────────────────────────────────────

/**
 * Generate engine-scored trade idea tickets from the given context.
 *
 * @param {object} ctx   Context object (see buildCtx)
 * @param {object} opts  { maxIdeas:5, allowedCategories:["macro","structure","portfolio"] }
 * @returns {EngineTicket[]}
 */
function generateIdeas(ctx, opts = {}) {
  const maxIdeas          = opts.maxIdeas ?? 5;
  const allowedCategories = opts.allowedCategories ?? ["macro", "structure", "portfolio"];

  const portfolioRows = ctx.portfolio?.rows ?? [];
  const totalGBP      = ctx.portfolio?.totalGBP ?? 1110;
  const usdgbp        = ctx._usdgbp ?? seeds.FX_SEED.usdgbp.value;

  const tickets = [];

  for (const playbook of PLAYBOOKS) {
    if (!allowedCategories.includes(playbook.category)) continue;

    // Check trigger
    let triggered = false;
    try {
      triggered = playbook.trigger(ctx);
    } catch (err) {
      console.warn(`[ideaEngine] Playbook ${playbook.id} trigger error:`, err.message);
    }
    if (!triggered) continue;

    // Build partial ticket
    let partial = {};
    try {
      partial = playbook.template(ctx);
    } catch (err) {
      console.warn(`[ideaEngine] Playbook ${playbook.id} template error:`, err.message);
      continue;
    }

    // Strategy augmentation
    const confidence = augmentConfidence(
      partial.confidence ?? 55,
      partial.direction ?? "LONG",
      ctx.signals
    );

    // Risk gate
    const gateInput = {
      ticker:    partial.ticker,
      direction: partial.direction,
      sizePct:   partial.sizePct,
      horizon:   partial.horizon,
      entry:     partial.entry  ?? null,
      stop:      partial.stop   ?? null,
      target:    partial.target ?? null,
    };
    let gate = { decision: "allowed", reasons: [], checks: [], riskFlags: [] };
    try {
      gate = gateIdea(gateInput, portfolioRows, totalGBP, usdgbp);
    } catch (err) {
      console.warn(`[ideaEngine] Risk gate error for ${partial.ticker}:`, err.message);
    }

    // Skip hard-blocked ideas
    if (gate.decision === "blocked") {
      console.log(`[ideaEngine] Blocked: ${playbook.id} → ${partial.ticker} (${gate.reasons.join("; ")})`);
      continue;
    }

    // Shariah compliance check — block non-compliant instruments
    const shariahStatus = getShariahStatus(partial.ticker);
    if (!shariahStatus.compliant) {
      console.log(`[ideaEngine] Shariah blocked: ${partial.ticker} — ${shariahStatus.reason}`);
      continue;
    }

    // Block short-selling — prohibited in shariah (gharar)
    if (partial.direction === "SHORT") {
      const txCheck = isTransactionPermitted("shortSelling");
      if (!txCheck.permitted) {
        console.log(`[ideaEngine] Shariah blocked SHORT on ${partial.ticker}: ${txCheck.reason}`);
        continue;
      }
    }

    // Deterministic ID
    const dateStr = ctx.today ? ctx.today.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    const id = deterministicHash(`${dateStr}:${playbook.id}:${partial.ticker}`);

    // Learning layer
    const ticket = {
      id,
      generatedAt:             new Date().toISOString(),
      regime:                  ctx.regime ?? "Unknown",
      playbook:                playbook.id,
      strategyType:            categoryToStrategyType(playbook.category, playbook.id),
      ticker:                  partial.ticker,
      direction:               partial.direction,
      horizon:                 partial.horizon ?? "3 months",
      entry:                   partial.entry  ?? null,
      stop:                    partial.stop   ?? null,
      target:                  partial.target ?? null,
      entryLogic:              partial.entryLogic  ?? "Enter at market on next open.",
      stopLogic:               partial.stopLogic   ?? "Stop below recent support.",
      targetLogic:             partial.targetLogic ?? "Target at next resistance.",
      sizingRule:              partial.sizingRule  ?? "1–3% portfolio allocation.",
      invalidation:            partial.invalidation ?? playbook.invalidation,
      rationale:               partial.rationale   ?? playbook.description,
      confidence,
      riskFlags:               gate.riskFlags,
      engineDecision:          gate.decision,
      engineReasons:           gate.reasons,
      expectedDrivers:         partial.expectedDrivers  ?? [],
      requiredDataFreshness:   partial.requiredDataFreshness ?? "Daily",
      sourceMode:              "deterministic",
      shariahStatus,            // { compliant, status, name, sector, index, note? }
      learning:                null, // filled below
    };

    ticket.learning = buildLearning(ticket);
    tickets.push(ticket);
  }

  // ── Universe scan: fill remaining slots with full-universe candidates ──────
  // Scan all 33 Shariah tickers against macro regime.
  // Only add tickers not already covered by a playbook idea.
  const coveredTickers = new Set(tickets.map(t => t.ticker));
  try {
    const scanCandidates = scanUniverse(ctx, {
      minScore:      1,
      maxResults:    Math.min(maxIdeas * 3, 20),
      excludeTickers: Array.from(coveredTickers),
    });

    for (const candidate of scanCandidates) {
      if (tickets.length >= maxIdeas * 2) break; // cap pre-sort pool

      const shariahStatus = getShariahStatus(candidate.ticker);
      if (!shariahStatus.compliant) continue;

      // Derive numeric entry/stop/target from current price
      const price  = candidate.currentPrice;
      const entry  = price ? +price.toFixed(4) : null;
      const stop   = price ? +(price * 0.92).toFixed(4) : null;   // 8% stop
      const target = price ? +(price * 1.15).toFixed(4) : null;   // 15% target
      const rStr   = (entry && stop && target)
        ? ((target - entry) / (entry - stop)).toFixed(1) + "×"
        : "N/A";

      const gateInput = {
        ticker: candidate.ticker, direction: "LONG",
        sizePct: 3, horizon: "3 months",
        entry, stop, target,
      };
      let gate = { decision: "allowed", reasons: [], checks: [], riskFlags: [] };
      try {
        gate = gateIdea(gateInput, portfolioRows, totalGBP, usdgbp);
      } catch (_) {}
      if (gate.decision === "blocked") continue;

      const dateStr = ctx.today
        ? ctx.today.toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10);
      const id = deterministicHash(`${dateStr}:universe-scan:${candidate.ticker}`);

      const ticket = {
        id,
        generatedAt:           new Date().toISOString(),
        regime:                ctx.regime ?? "Unknown",
        playbook:              "universe-scan",
        strategyType:          "macro",
        ticker:                candidate.ticker,
        direction:             "LONG",
        horizon:               "3 months",
        entry,
        stop,
        target,
        entryLogic:            entry
          ? `Enter ${candidate.ticker} near $${entry} — macro-sector alignment signal.`
          : "Enter at market on next open.",
        stopLogic:             stop
          ? `Stop at $${stop} (8% below entry — structural risk control).`
          : "Stop below recent support.",
        targetLogic:           target
          ? `Target $${target} (15% above entry, R≈${rStr}).`
          : "Target at next resistance.",
        sizingRule:            candidate.inPortfolio
          ? "2% add-on to existing position — sector conviction top-up."
          : "2–3% new position. Size conservatively — first entry in this name.",
        invalidation:          `Macro regime shifts against ${candidate.sector} sector, or ${candidate.ticker} closes below stop on elevated volume.`,
        rationale:             candidate.rationale,
        confidence:            candidate.confidence,
        riskFlags:             gate.riskFlags,
        engineDecision:        gate.decision,
        engineReasons:         gate.reasons,
        expectedDrivers:       candidate.macroAlignment,
        requiredDataFreshness: "Daily",
        sourceMode:            "deterministic",
        shariahStatus,
        learning:              null,
      };
      ticket.learning = buildLearning(ticket);
      tickets.push(ticket);
      coveredTickers.add(candidate.ticker);
    }
  } catch (err) {
    console.warn("[ideaEngine] Universe scan failed:", err.message);
  }

  // Sort by confidence desc, take top N
  tickets.sort((a, b) => b.confidence - a.confidence);
  return tickets.slice(0, maxIdeas);
}

module.exports = { generateIdeas, buildCtx, deterministicHash };
