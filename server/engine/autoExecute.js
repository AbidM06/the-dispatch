/**
 * server/engine/autoExecute.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared auto-execution logic — called by both:
 *   - POST /api/ideas/generate  (manual trigger from ENGINE tab)
 *   - ideaScheduler.js          (08:00 + 15:30 weekday runs)
 *
 * Takes a list of engine-generated tickets + execution context, runs each
 * through the Alpaca paper-trading pipeline:
 *   1. Rates freshness gate (FRED observation dates)
 *   2. executionGate.prepareOrder: executable price → account → positions →
 *      FX → sizing → policy (see executionGate.js)
 *   3. Alpaca order placement (LONG only)
 *   4. Execution log + policy counter update
 *   5. Webhook fire-and-forget
 *
 * Returns: { orders: AlpacaOrder[], skipped: SkippedOrder[], freshness: object }
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const alpaca          = require("../providers/alpaca");
const executionPolicy = require("../analytics/executionPolicy");
const { prepareOrder } = require("./executionGate");
const { appendExecutionLog } = require("../importers/ideaLog");
const { fireWebhook } = require("../providers/webhook");
const cache           = require("../cache");

const MAX_ORDERS_PER_RUN  = 3;

/**
 * Check if snapshot data is fresh enough for auto-execution.
 * @returns {{ dataFresh: boolean, warning: string|null }}
 */
function checkFreshness() {
  const MAX_AGE_MIN   = parseInt(process.env.TRADING_DATA_MAX_AGE_MIN, 10) || 20;
  const MAX_OBS_DAYS  = parseInt(process.env.TRADING_DATA_MAX_OBS_AGE_DAYS, 10) || 4;
  const snapshotMeta  = cache.getWithMeta("snapshot:rates");

  if (!snapshotMeta) {
    return { dataFresh: false, warning: "Snapshot rates cache empty — skipping auto-execution." };
  }
  if (snapshotMeta.stale) {
    return { dataFresh: false, warning: "Snapshot rates cache is stale — skipping auto-execution." };
  }

  const ageMin = (Date.now() - new Date(snapshotMeta.fetchedAt).getTime()) / 60_000;
  if (ageMin > MAX_AGE_MIN) {
    return { dataFresh: false, warning: `Snapshot data is ${ageMin.toFixed(0)} min old (max ${MAX_AGE_MIN} min) — skipping auto-execution.` };
  }

  // `fetchedAt` is when we WROTE the cache, not when the market measured the
  // figure. Re-caching a 2020 observation one second ago satisfied the 20-minute
  // rule, so the advertised freshness safeguard could pass on six-year-old data.
  // Check the observation dates too. FRED series are daily, so the window is in
  // days (weekends and holidays) rather than minutes.
  const obsDates = [];
  const value = snapshotMeta.value;
  if (value && typeof value === "object") {
    for (const fact of Object.values(value)) {
      if (fact && typeof fact === "object" && typeof fact.date === "string") obsDates.push(fact.date);
    }
  }
  if (obsDates.length) {
    const newest = obsDates.sort()[obsDates.length - 1];
    const obsAgeDays = (Date.now() - new Date(`${newest}T00:00:00Z`).getTime()) / 86_400_000;
    if (!Number.isFinite(obsAgeDays)) {
      return { dataFresh: false, warning: `Snapshot observation date unparseable (${newest}) — skipping auto-execution.` };
    }
    if (obsAgeDays > MAX_OBS_DAYS) {
      return {
        dataFresh: false,
        warning: `Newest observation is ${obsAgeDays.toFixed(0)} days old (${newest}, max ${MAX_OBS_DAYS}d) — skipping auto-execution.`,
      };
    }
  }

  return { dataFresh: true, warning: null };
}

/**
 * Determine if auto-execution should run for this set of conditions.
 */
function shouldAutoExecute(dataFresh) {
  return (
    alpaca.isAutoExecuteEnabled() &&
    executionPolicy.getConfig().tradingEnabled &&
    executionPolicy.getConfig().autoApprovePaper &&
    dataFresh
  );
}

/**
 * Execute a list of engine tickets against Alpaca paper trading.
 *
 * @param {object[]} tickets     Engine tickets from generateIdeas()
 * @param {object}   ctx         Engine context (used for watchlist prices + usdgbp)
 * @param {object}   [playbookPerf]  Optional backtest evidence per playbook ID
 * @returns {Promise<{ orders, skipped, freshness, enabled }>}
 */
/**
 * defaultPriceFeed — the executable price for a ticker, from the data this app
 * has. Watchlist entries are DAILY CLOSES (executable:false), so with the free
 * feeds this returns non-executable facts and the gate blocks. A caller with a
 * real quote source injects `deps.getExecutablePrice`.
 */
function defaultPriceFeed(ctx) {
  return async (ticker) => {
    const q = ctx?.watchlist?.[ticker];
    if (!q || !Number.isFinite(q.price)) return null;
    return { value: q.price, executable: false, priceType: "daily close", observedAt: q.date || null,
             observedAtPrecision: "date", source: q.source || null };
  };
}

function logSkip(ticket, decision, reasons, freshness) {
  appendExecutionLog({
    ideaId: ticket.id, ticker: ticket.ticker, direction: ticket.direction,
    decision, reasons,
    freshnessSnapshot: { dataFresh: freshness.dataFresh },
    orderPayload: null, result: null, error: decision === "FAILED" ? reasons.join("; ") : null,
  });
}

/**
 * Execute a list of engine tickets against Alpaca paper trading.
 *
 * Every ticket passes through executionGate.prepareOrder — the same gate the
 * manual approve route uses. Broker (alpaca) and price feed are boundaries;
 * tests mock them while exercising the real sizing and policy logic.
 *
 * @param {object[]} tickets
 * @param {object}   ctx            engine context (watchlist, _usdgbp)
 * @param {object}   [playbookPerf] trigger-frequency counts on demo data
 * @param {object}   [deps]         { getExecutablePrice(ticker), fx, now }
 * @returns {Promise<{ enabled, freshness, orders, skipped }>}
 */
async function autoExecuteIdeas(tickets, ctx, playbookPerf = {}, deps = {}) {
  const freshness = checkFreshness();

  if (!shouldAutoExecute(freshness.dataFresh)) {
    return { enabled: false, freshness, orders: [], skipped: [] };
  }

  const getPrice = deps.getExecutablePrice || defaultPriceFeed(ctx);
  const fx       = deps.fx !== undefined ? deps.fx : (cache.getWithMeta("snapshot:fx")?.value || null);
  const now      = deps.now || new Date();
  const maxOrders = alpaca.getMaxOrdersPerRun ? alpaca.getMaxOrdersPerRun() : MAX_ORDERS_PER_RUN;

  // Broker state. A failure here is not "zero" — it is unknown, and unknown
  // blocks every order below (account equity used to default to £75,000).
  let account = null, positions = null;
  try {
    const acct = await alpaca.getAccount();
    const eq = parseFloat(acct?.equity ?? acct?.portfolio_value);
    account = Number.isFinite(eq) && eq > 0 ? { equity: eq, currency: acct?.currency || "USD" } : null;
  } catch (err) {
    console.warn("[autoExecute] Could not fetch Alpaca account:", err.message);
  }
  try {
    const p = await alpaca.getPositions();
    positions = Array.isArray(p) ? p : null;
  } catch (err) {
    console.warn("[autoExecute] Could not fetch Alpaca positions:", err.message);
  }

  const orders  = [];
  const skipped = [];

  for (const ticket of tickets.slice(0, maxOrders)) {
    const executableDecision = ticket.engineDecision === "allowed" || ticket.engineDecision === "caution";
    if (!executableDecision || !alpaca.isSupported(ticket.ticker)) {
      const reason = !executableDecision ? `Engine decision: ${ticket.engineDecision}` : `${ticket.ticker} not in ALPACA_SUPPORTED`;
      skipped.push({ ticker: ticket.ticker, stage: "eligibility", reason });
      logSkip(ticket, "FAILED", [reason], freshness);
      continue;
    }

    let priceFact = null;
    try { priceFact = await getPrice(ticket.ticker); } catch (err) { priceFact = null; }

    const prep = prepareOrder({ ticket, priceFact, fx, account, positions, now });
    if (!prep.ok) {
      skipped.push({ ticker: ticket.ticker, stage: prep.stage, reason: prep.reasons.join("; ") });
      logSkip(ticket, "SKIPPED", prep.reasons, freshness);
      continue;
    }

    try {
      const dateStr       = now.toISOString().slice(0, 10);
      const clientOrderId = `dispatch-${ticket.ticker.toLowerCase()}-${dateStr}`;
      const order = await alpaca.placeOrder(ticket.ticker, "buy", prep.qty, "market", clientOrderId);

      executionPolicy.recordTrade(ticket.ticker, prep.notionalGBP);
      // Count this order toward the next ticket's position and exposure caps
      // (market_value in the broker's native currency, like Alpaca's own).
      if (Array.isArray(positions)) positions = [...positions, { symbol: ticket.ticker, market_value: prep.qty * prep.price }];

      const btEvidence = playbookPerf[ticket.playbook] ?? null;
      orders.push({
        ticker:        ticket.ticker,
        direction:     ticket.direction,
        orderId:       order.id,
        qty:           prep.qty,
        notionalGBP:   prep.notionalGBP,
        accountEquityGBP: +prep.equityGBP.toFixed(0),
        executionPrice: prep.price,
        priceAgeMin:   prep.priceAgeMin,
        playbook:      ticket.playbook,
        rationale:     ticket.rationale,
        confidence:    ticket.confidence,
        regime:        ticket.regime,
        entry:         ticket.entry,
        stop:          ticket.stop,
        target:        ticket.target,
        riskPerShare:  prep.sizing.riskPerShare,
        riskGBP:       prep.sizing.riskGBP,
        sizingReason:  prep.sizing.sizingReason,
        caution:       ticket.engineDecision === "caution" ? ticket.engineReasons : [],
        // Renamed from `backtestEvidence`: it is a trigger count on demo data,
        // not evidence that the playbook makes money.
        triggerFrequencyDemo: btEvidence ? {
          triggerRate:    btEvidence.triggerRate,
          timesTriggered: btEvidence.timesTriggered,
          note:           "Trigger frequency on hand-entered demo data — not performance evidence.",
        } : null,
      });

      appendExecutionLog({
        ideaId: ticket.id, ticker: ticket.ticker, direction: ticket.direction,
        decision: "EXECUTED", reasons: [],
        freshnessSnapshot: { dataFresh: freshness.dataFresh, priceAgeMin: prep.priceAgeMin },
        orderPayload: { ticker: ticket.ticker, side: "buy", qty: prep.qty, notionalGBP: prep.notionalGBP },
        result: { orderId: order.id }, error: null,
      });

      fireWebhook("idea.executed", {
        ticker: ticket.ticker, direction: ticket.direction, orderId: order.id,
        qty: prep.qty, notionalGBP: prep.notionalGBP, playbook: ticket.playbook, confidence: ticket.confidence,
      }).catch(() => {});

      console.log(`[autoExecute] ✓ BUY ${prep.qty}×${ticket.ticker} — orderId=${order.id}`);
    } catch (err) {
      console.error(`[autoExecute] ${ticket.ticker} failed:`, err.message);
      skipped.push({ ticker: ticket.ticker, stage: "broker", reason: err.message });
      logSkip(ticket, "FAILED", [err.message], freshness);
    }
  }

  return { enabled: true, freshness, orders, skipped };
}

module.exports = { autoExecuteIdeas, checkFreshness, shouldAutoExecute };
