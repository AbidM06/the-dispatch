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
const seeds = require("../../seeds/fallback");   // CCY_EXP assumptions only
const { classifyLevels } = require("../analytics/regime");

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
 * Build a standardised ctx from CACHED LIVE data only.
 *
 * What changed, and why:
 *  - Missing rates used to fall back to seeds.RATES_SEED (March 2026 levels),
 *    so an outage generated trade ideas from numbers nobody had fetched. They
 *    are now null, listed in ctx.dataQuality.missingRates, and macro/structure
 *    playbooks do not run without them (null < 0.3 is TRUE in JavaScript, so a
 *    missing curve would otherwise have read as "flat").
 *  - Rate deltas and the MA/mean-reversion signals compared LIVE levels with
 *    the hand-typed monthly RATES_HISTORY_SEED — a live 10Y minus a February
 *    2026 number typed into a file. They now use the dated FRED history the
 *    snapshot fetched, and state their window. No history → null / flat.
 *  - The watchlist and FX fell back to seed prices and 0.7558.
 *
 * @param {object} rawRates       snapshot:rates cache value (FRED obs objects)
 * @param {object} portfolioData  { rows, totalGBP, usdgbp } or null
 * @param {object} watchlistData  snapshot:watchlist cache value or null
 * @param {object} [opts]         { ratesHistory, hyHistory, fx } — default to the snapshot caches
 * @returns {object} ctx
 */
function buildCtx(rawRates, portfolioData, watchlistData, opts = {}) {
  const cache = require("../cache");

  function rv(obs) {
    if (obs && typeof obs === "object" && Number.isFinite(obs.value)) return obs.value;
    if (Number.isFinite(obs)) return obs;
    return null;
  }
  function od(obs) {
    return (obs && typeof obs === "object") ? (obs.observedAt || obs.date || null) : null;
  }

  const rates = {
    dgs10:     rv(rawRates?.dgs10),
    dfii10:    rv(rawRates?.dfii10),
    t10yie:    rv(rawRates?.t10yie),
    hy_spread: rv(rawRates?.hy_spread),
    t10y2y:    rv(rawRates?.t10y2y),
  };
  const ratesAsOf = Object.fromEntries(Object.keys(rates).map(k => [k, od(rawRates?.[k])]));
  const missingRates = Object.entries(rates).filter(([, v]) => v == null).map(([k]) => k);

  // ── Deltas from REAL dated history ──
  const ratesHistory = opts.ratesHistory !== undefined ? opts.ratesHistory : (cache.getWithMeta("snapshot:ratesHistory")?.value || []);
  const hyHistory    = opts.hyHistory    !== undefined ? opts.hyHistory    : (cache.getWithMeta("snapshot:hyHistory")?.value    || []);

  function windowDelta(points, key) {
    const v = (points || []).filter(p => Number.isFinite(p?.[key]) && p.m);
    if (v.length < 2) return { bp: null, window: null };
    const first = v[0], last = v[v.length - 1];
    return { bp: Math.round((last[key] - first[key]) * 100), window: { from: first.m, to: last.m, observations: v.length } };
  }
  const d10  = windowDelta(ratesHistory, "y10");
  const dRe  = windowDelta(ratesHistory, "real");
  const dBe  = windowDelta(ratesHistory, "bei");
  const dHy  = windowDelta(hyHistory,    "oas");
  const deltas = {
    dgs10_d:     d10.bp,
    dfii10_d:    dRe.bp,
    t10yie_d:    dBe.bp,
    hy_spread_d: dHy.bp,
    // The curve CHANGE needs a 2Y history, which is not fetched. null means
    // "not computable"; no playbook may describe curve direction without it.
    t10y2y_d:    null,
    windows: { dgs10: d10.window, dfii10: dRe.window, t10yie: dBe.window, hy_spread: dHy.window },
  };

  // ── Portfolio ── (owner's own data; unknown stays unknown)
  const rows     = portfolioData?.rows ?? [];
  const totalGBP = Number.isFinite(portfolioData?.totalGBP) ? portfolioData.totalGBP : 0;
  const fxRaw    = opts.fx !== undefined ? opts.fx : cache.getWithMeta("snapshot:fx")?.value;
  const usdgbp   = Number.isFinite(portfolioData?.usdgbp) ? portfolioData.usdgbp
                 : Number.isFinite(fxRaw?.value)          ? fxRaw.value
                 : null;

  const weights = {};
  let usdVal = 0;
  for (const r of rows) {
    if (r.valGBP != null && totalGBP > 0) {
      weights[r.ticker] = r.valGBP / totalGBP;
      // CCY_EXP is a hand-entered look-through ASSUMPTION, not sourced data.
      const usdFrac = (seeds.CCY_EXP[r.ticker]?.USD ?? 0) / 100;
      usdVal += r.valGBP * usdFrac;
    }
  }
  const hhi = Math.round(Object.values(weights).reduce((s, w) => s + w * w, 0) * 10_000);
  const usdPct = totalGBP > 0 ? (usdVal / totalGBP) * 100 : 0;

  // ── Watchlist: daily closes with their dates — never executable prices ──
  const watchlist = {};
  for (const item of (Array.isArray(watchlistData) ? watchlistData : [])) {
    if (!Number.isFinite(item?.price)) continue;
    watchlist[item.sym ?? item.ticker] = {
      price: item.price, chg: Number.isFinite(item.chg) ? item.chg : null,
      date: item.date || null, source: item.source || null, currency: "USD", executable: false,
    };
  }

  // ── Signals (only on real history) ──
  const signals = missingRates.length
    ? { maSignal: "flat", maConviction: 0, momentumSignal: "flat", momentumConviction: 0, reversionSignal: "flat", reversionConviction: 0,
        details: { note: `Signals not computed — missing rates: ${missingRates.join(", ")}.` } }
    : computeSignals(rates, ratesHistory, watchlist);
  const signalsBasis = ratesHistory.length
    ? `FRED DGS10 daily history, ${ratesHistory.length} observations ${ratesHistory[0]?.m} → ${ratesHistory[ratesHistory.length - 1]?.m}. MA windows are observations, not months.`
    : "No rate history available — MA and mean-reversion signals are flat by construction.";

  // ── Regime: shape and level only (see analytics/regime.js) ──
  const levels = classifyLevels(rates);

  return {
    rates,
    ratesAsOf,
    deltas,
    portfolio: { rows, totalGBP, weights, hhi, usdPct },
    watchlist,
    regime: levels.regime,
    signals,
    signalsBasis,
    dataQuality: {
      missingRates,
      ratesComplete: missingRates.length === 0,
      historyObservations: ratesHistory.length,
      fxAvailable: usdgbp != null,
    },
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
  // 0, not £1,110. Sizing rules downstream treat a non-positive total as
  // "weight unknown" rather than computing a percentage of a book that
  // does not exist.
  const totalGBP      = Number.isFinite(ctx.portfolio?.totalGBP) ? ctx.portfolio.totalGBP : 0;
  const usdgbp        = Number.isFinite(ctx._usdgbp) ? ctx._usdgbp : null;
  // Macro and structure playbooks compare rates against thresholds. With a
  // rate missing, `null < 0.3` is true in JavaScript — a missing curve reads
  // as "flat". They do not run on incomplete data.
  const ratesComplete = ctx.dataQuality ? ctx.dataQuality.ratesComplete
                      : ["dgs10", "dfii10", "t10yie", "hy_spread", "t10y2y"].every(k => Number.isFinite(ctx.rates?.[k]));

  const tickets = [];

  for (const playbook of PLAYBOOKS) {
    if (!allowedCategories.includes(playbook.category)) continue;
    if ((playbook.category === "macro" || playbook.category === "structure") && !ratesComplete) continue;

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
      // Where the levels came from. null levels mean no sourced price existed;
      // they are never back-filled. No price here is an executable quote.
      priceBasis:              partial.priceBasis ?? null,
      priced:                  partial.entry != null,
      dataAsOf:                ctx.ratesAsOf ?? null,
      signalsBasis:            ctx.signalsBasis ?? null,
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
    if (!ratesComplete) throw new Error("rates incomplete — universe scan skipped");
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
        priceBasis:            entry != null
          ? { available: true, price: entry, currency: "USD", date: ctx.watchlist?.[candidate.ticker]?.date ?? null,
              source: ctx.watchlist?.[candidate.ticker]?.source ?? null, priceType: "daily close (not an executable quote)" }
          : { available: false, reason: `No price feed for ${candidate.ticker}.` },
        priced:                entry != null,
        dataAsOf:              ctx.ratesAsOf ?? null,
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
