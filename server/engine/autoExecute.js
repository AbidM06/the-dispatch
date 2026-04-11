/**
 * server/engine/autoExecute.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared auto-execution logic — called by both:
 *   - POST /api/ideas/generate  (manual trigger from ENGINE tab)
 *   - ideaScheduler.js          (08:00 + 15:30 weekday runs)
 *
 * Takes a list of engine-generated tickets + execution context, runs each
 * through the Alpaca paper-trading pipeline:
 *   1. Freshness gate (data age check)
 *   2. Policy check (daily limits, notional cap, open positions)
 *   3. Risk-based position sizing
 *   4. Alpaca order placement
 *   5. Execution log + policy counter update
 *   6. Webhook fire-and-forget
 *
 * Returns: { orders: AlpacaOrder[], skipped: SkippedOrder[], freshness: object }
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

const alpaca          = require("../providers/alpaca");
const executionPolicy = require("../analytics/executionPolicy");
const { computeSize } = require("./positionSizing");
const { appendExecutionLog } = require("../importers/ideaLog");
const { fireWebhook } = require("../providers/webhook");
const cache           = require("../cache");

const DEFAULT_USDGBP      = 0.7558;
const MAX_ORDERS_PER_RUN  = 3;

/**
 * Check if snapshot data is fresh enough for auto-execution.
 * @returns {{ dataFresh: boolean, warning: string|null }}
 */
function checkFreshness() {
  const MAX_AGE_MIN  = parseInt(process.env.TRADING_DATA_MAX_AGE_MIN || "20", 10);
  const snapshotMeta = cache.getWithMeta("snapshot:rates");

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
async function autoExecuteIdeas(tickets, ctx, playbookPerf = {}) {
  const freshness = checkFreshness();

  if (!shouldAutoExecute(freshness.dataFresh)) {
    return {
      enabled:  false,
      freshness,
      orders:   [],
      skipped:  [],
    };
  }

  const usdgbp       = ctx._usdgbp ?? DEFAULT_USDGBP;
  const maxOrders    = alpaca.getMaxOrdersPerRun
    ? alpaca.getMaxOrdersPerRun()
    : MAX_ORDERS_PER_RUN;

  // Fetch account equity for position sizing (fail gracefully)
  let accountEquityGBP = 75_000;
  try {
    const acct = await alpaca.getAccount();
    accountEquityGBP = parseFloat(acct.portfolio_value) * usdgbp;
  } catch (err) {
    console.warn("[autoExecute] Could not fetch Alpaca account for sizing:", err.message);
  }

  const orders  = [];
  const skipped = [];

  for (const ticket of tickets.slice(0, maxOrders)) {
    const executableDecision =
      ticket.engineDecision === "allowed" || ticket.engineDecision === "caution";

    if (!executableDecision || !alpaca.isSupported(ticket.ticker)) {
      const reason = !executableDecision
        ? `Engine decision: ${ticket.engineDecision}`
        : `${ticket.ticker} not in ALPACA_SUPPORTED`;
      skipped.push({ ticker: ticket.ticker, reason });
      appendExecutionLog({
        ideaId:    ticket.id,
        ticker:    ticket.ticker,
        direction: ticket.direction,
        decision:  "FAILED",
        reasons:   [reason],
        freshnessSnapshot: { dataFresh: freshness.dataFresh },
        orderPayload: null, result: null, error: reason,
      });
      continue;
    }

    const policyCheck = executionPolicy.checkPolicy({ ticker: ticket.ticker, notionalGBP: 100 });
    if (!policyCheck.allowed) {
      skipped.push({ ticker: ticket.ticker, reason: policyCheck.reasons.join("; ") });
      appendExecutionLog({
        ideaId:    ticket.id,
        ticker:    ticket.ticker,
        direction: ticket.direction,
        decision:  "SKIPPED",
        reasons:   policyCheck.reasons,
        freshnessSnapshot: { dataFresh: freshness.dataFresh },
        orderPayload: null, result: null, error: null,
      });
      continue;
    }

    try {
      const priceUSD   = ticket.entry ?? ctx.watchlist?.[ticket.ticker]?.price ?? null;
      const priceGBP   = priceUSD ? priceUSD * usdgbp : null;
      const sizing     = computeSize(ticket.entry, ticket.stop, accountEquityGBP, priceGBP);
      const qty        = (!sizing.blocked && sizing.qty > 0) ? sizing.qty : 1;
      const notionalGBP = priceGBP ? +(qty * priceGBP).toFixed(2) : null;

      const dateStr       = new Date().toISOString().slice(0, 10);
      const clientOrderId = `dispatch-${ticket.ticker.toLowerCase()}-${dateStr}`;
      const side          = ticket.direction === "LONG" ? "buy" : "sell";

      const order = await alpaca.placeOrder(ticket.ticker, side, qty, "market", clientOrderId);

      executionPolicy.recordTrade(ticket.ticker, notionalGBP ?? 100);

      const btEvidence = playbookPerf[ticket.playbook] ?? null;

      orders.push({
        ticker:        ticket.ticker,
        direction:     ticket.direction,
        orderId:       order.id,
        qty,
        notionalGBP,
        accountEquityGBP: +accountEquityGBP.toFixed(0),
        playbook:      ticket.playbook,
        rationale:     ticket.rationale,
        confidence:    ticket.confidence,
        regime:        ticket.regime,
        entry:         ticket.entry,
        stop:          ticket.stop,
        target:        ticket.target,
        riskPerShare:  sizing.riskPerShare,
        riskGBP:       sizing.riskGBP,
        sizingReason:  sizing.sizingReason,
        caution:       ticket.engineDecision === "caution" ? ticket.engineReasons : [],
        backtestEvidence: btEvidence ? {
          triggerRate:    btEvidence.triggerRate,
          avgConfidence:  btEvidence.avgConfidence,
          timesTriggered: btEvidence.timesTriggered,
        } : null,
      });

      appendExecutionLog({
        ideaId:    ticket.id,
        ticker:    ticket.ticker,
        direction: ticket.direction,
        decision:  "EXECUTED",
        reasons:   [],
        freshnessSnapshot: { dataFresh: freshness.dataFresh },
        orderPayload: { ticker: ticket.ticker, side, qty },
        result:    { orderId: order.id },
        error:     null,
      });

      // Webhook — fire and forget
      fireWebhook("idea.executed", {
        ticker:     ticket.ticker,
        direction:  ticket.direction,
        orderId:    order.id,
        qty,
        notionalGBP,
        playbook:   ticket.playbook,
        confidence: ticket.confidence,
      }).catch(() => {});

      console.log(`[autoExecute] ✓ ${side.toUpperCase()} ${qty}×${ticket.ticker} — orderId=${order.id}`);

    } catch (err) {
      console.error(`[autoExecute] ${ticket.ticker} failed:`, err.message);
      skipped.push({ ticker: ticket.ticker, reason: err.message });
      appendExecutionLog({
        ideaId:    ticket.id,
        ticker:    ticket.ticker,
        direction: ticket.direction,
        decision:  "FAILED",
        reasons:   [err.message],
        freshnessSnapshot: { dataFresh: freshness.dataFresh },
        orderPayload: null, result: null, error: err.message,
      });
    }
  }

  return { enabled: true, freshness, orders, skipped };
}

module.exports = { autoExecuteIdeas, checkFreshness, shouldAutoExecute };
