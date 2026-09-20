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

  // Account equity for position sizing. This used to default to £75,000 and
  // carry on when the fetch failed, so an Alpaca outage sized real orders
  // against an invented portfolio. Risk-per-trade is a percentage of equity; if
  // equity is unknown, every downstream number is meaningless. Abort instead.
  let accountEquityGBP = null;
  try {
    const acct = await alpaca.getAccount();
    const pv = parseFloat(acct.portfolio_value);
    if (Number.isFinite(pv) && pv > 0) accountEquityGBP = pv * usdgbp;
  } catch (err) {
    console.warn("[autoExecute] Could not fetch Alpaca account for sizing:", err.message);
  }
  if (accountEquityGBP == null) {
    const reason = "Account equity unavailable — cannot size positions; skipping execution.";
    console.warn(`[autoExecute] ${reason}`);
    return { executed: false, reason, orders: [], skipped: [] };
  }

  // Open-position count and portfolio value feed the exposure limits below.
  // checkPolicy() treats a missing openPositions as 0 and skips the
  // single-ticker cap entirely when portfolioGBP is absent, so omitting these
  // silently disabled two of the four advertised circuit breakers.
  let openPositions = 0;
  try {
    const positions = await alpaca.getPositions();
    if (Array.isArray(positions)) openPositions = positions.length;
  } catch (err) {
    const reason = `Could not fetch open positions (${err.message}) — cannot enforce exposure limits; skipping execution.`;
    console.warn(`[autoExecute] ${reason}`);
    return { executed: false, reason, orders: [], skipped: [] };
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

    // Size FIRST, then check policy against the real notional.
    //
    // The old order was inverted: checkPolicy ran with a placeholder
    // notionalGBP of 100 and sizing happened afterwards, so the £250 daily
    // notional cap was tested against £100 no matter how large the order
    // turned out to be. A valid ticket sizing to £6,000 passed a £250 cap.
    const priceUSD = ticket.entry ?? ctx.watchlist?.[ticket.ticker]?.price ?? null;
    const priceGBP = priceUSD ? priceUSD * usdgbp : null;
    const sizing   = computeSize(ticket.entry, ticket.stop, accountEquityGBP, priceGBP);

    // Blocked sizing means "do not trade this", not "trade one share of it".
    // `qty = sizing.blocked ? 1 : sizing.qty` turned every rejection into a
    // small order — an entry of 100 against a stop of 110 is an invalid LONG,
    // and it still submitted.
    if (sizing.blocked || !(sizing.qty > 0)) {
      const reason = sizing.blockReason || sizing.sizingReason || "Position sizing returned no quantity.";
      skipped.push({ ticker: ticket.ticker, reason });
      appendExecutionLog({
        ideaId:    ticket.id,
        ticker:    ticket.ticker,
        direction: ticket.direction,
        decision:  "SKIPPED",
        reasons:   [reason],
        freshnessSnapshot: { dataFresh: freshness.dataFresh },
        orderPayload: null, result: null, error: null,
      });
      continue;
    }

    const qty = sizing.qty;
    const notionalGBP = priceGBP ? +(qty * priceGBP).toFixed(2) : null;

    // Without a notional we cannot evaluate the caps, so we do not trade.
    if (notionalGBP == null) {
      const reason = `No price available for ${ticket.ticker} — cannot compute notional; skipping.`;
      skipped.push({ ticker: ticket.ticker, reason });
      appendExecutionLog({
        ideaId:    ticket.id,
        ticker:    ticket.ticker,
        direction: ticket.direction,
        decision:  "SKIPPED",
        reasons:   [reason],
        freshnessSnapshot: { dataFresh: freshness.dataFresh },
        orderPayload: null, result: null, error: null,
      });
      continue;
    }

    const policyCheck = executionPolicy.checkPolicy({
      ticker:       ticket.ticker,
      notionalGBP,                    // the real order size, not a placeholder
      openPositions,                  // enables the max-open-positions cap
      portfolioGBP: accountEquityGBP, // enables the single-ticker exposure cap
    });
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
      const dateStr       = new Date().toISOString().slice(0, 10);
      const clientOrderId = `dispatch-${ticket.ticker.toLowerCase()}-${dateStr}`;
      const side          = ticket.direction === "LONG" ? "buy" : "sell";

      const order = await alpaca.placeOrder(ticket.ticker, side, qty, "market", clientOrderId);

      executionPolicy.recordTrade(ticket.ticker, notionalGBP);

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
