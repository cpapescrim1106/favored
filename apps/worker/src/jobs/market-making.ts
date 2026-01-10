/**
 * Market Making Job
 *
 * Manages two-sided quotes on both YES and NO outcomes with inventory-based skewing.
 *
 * Process:
 * 1. Check if MM is globally enabled
 * 2. Get all active MarketMaker records
 * 3. For each market:
 *    a. Check risk guardrails (time to resolution, volatility pause)
 *    b. Fetch current orderbook for YES and NO tokens
 *    c. Check for fills and update inventory/PnL
 *    d. Calculate new quote prices (with inventory skew)
 *    e. Cancel stale quotes, place new ones
 *    f. Log all actions
 */

import { prisma } from "../lib/db.js";
import {
  getBestPrices,
  getMidpointPrice,
  getSpread,
  placeOrder,
  cancelOrder,
  fetchActiveOrders,
  configureCLOB,
  getOrder,
} from "@favored/shared";
import {
  calculateQuotes,
  calculateMidPrice,
  shouldRefreshQuotes,
  TICK_SIZE,
  type Quote,
  type QuotingPolicy,
} from "@favored/shared";
import { addHours, isBefore } from "date-fns";

// Minimum time between quote refreshes (ms)
const MIN_QUOTE_INTERVAL = 5000;

// ============================================================================
// SANITY CHECK THRESHOLDS
// These guard against placing orders at bad prices due to API issues, stale
// data, or calculation bugs. Failing any check = refuse to quote + log error.
// ============================================================================

// 1. Midpoint bounds - reject nearly-resolved markets
const MIN_VALID_MIDPOINT = 0.05; // 5¢ (tighter than before)
const MAX_VALID_MIDPOINT = 0.95; // 95¢

// 2. CLOB vs stored price deviation
// Dynamic: max(MIN_DEVIATION, DEVIATION_MULTIPLIER × spread)
const MIN_MIDPOINT_DEVIATION = 0.03; // At least 3¢ tolerance
const DEVIATION_MULTIPLIER = 2.0; // Allow 2× the spread as deviation

// 3. Spread sanity - reject if spread is too wide (illiquid/broken book)
const MAX_SPREAD_TICKS = 50; // 50¢ spread = something's wrong

// 4. Staleness - reject if stored price is too old
const MAX_PRICE_AGE_MINUTES = 30; // Market data older than 30 min is suspect

// 5. Quote placement bounds - quotes must be within epsilon of best bid/ask
// This prevents placing quotes way outside the current book
const MAX_QUOTE_IMPROVEMENT = 0.05; // Don't improve best bid/ask by more than 5¢

export interface MarketMakingResult {
  processed: number;
  quotesPlaced: number;
  quotesCancelled: number;
  fillsProcessed: number;
  errors: string[];
}

/**
 * Run the market making job
 */
export async function runMarketMakingJob(): Promise<MarketMakingResult> {
  const result: MarketMakingResult = {
    processed: 0,
    quotesPlaced: 0,
    quotesCancelled: 0,
    fillsProcessed: 0,
    errors: [],
  };

  console.log("[MarketMaking] Starting market making job...");

  try {
    // Get config
    const config = await prisma.config.findUnique({
      where: { id: "singleton" },
    });

    if (!config) {
      console.log("[MarketMaking] No config found, skipping");
      return result;
    }

    // Check global MM enable flag
    if (!config.mmEnabled) {
      console.log("[MarketMaking] Market making is disabled globally");
      return result;
    }

    // Check kill switch
    if (config.killSwitchActive) {
      console.log("[MarketMaking] Kill switch is active, skipping");
      return result;
    }

    // Configure CLOB client for real trading
    configureCLOB({ dryRun: false });

    // Get all active market makers with their orders
    const marketMakers = await prisma.marketMaker.findMany({
      where: {
        active: true,
        paused: false,
      },
      include: {
        market: true,
        orders: true,
      },
    });

    if (marketMakers.length === 0) {
      console.log("[MarketMaking] No active market makers configured");
      return result;
    }

    console.log(`[MarketMaking] Processing ${marketMakers.length} active market makers`);

    const refreshThreshold = Number(config.mmRefreshThreshold);

    // First, check for fills across all market makers
    await checkAllFills(marketMakers, result);

    // Process each market maker
    for (const mm of marketMakers) {
      try {
        await processMarketMaker(mm, config, refreshThreshold, result);
        result.processed++;
      } catch (error) {
        const errorMsg = `Failed to process MM ${mm.id} (${mm.market?.slug}): ${error instanceof Error ? error.message : String(error)}`;
        console.error(`[MarketMaking] ${errorMsg}`);
        result.errors.push(errorMsg);

        await logQuoteAction(mm.id, "ERROR", { error: errorMsg });
      }
    }

    console.log(
      `[MarketMaking] Job complete: ${result.processed} processed, ${result.quotesPlaced} placed, ${result.quotesCancelled} cancelled, ${result.fillsProcessed} fills`
    );

    return result;
  } catch (error) {
    console.error("[MarketMaking] Job failed:", error);
    await prisma.log.create({
      data: {
        level: "ERROR",
        category: "SYSTEM",
        message: `Market making job failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { stack: error instanceof Error ? error.stack : undefined },
      },
    });
    throw error;
  }
}

/**
 * Check for fills across all active orders
 * IMPORTANT: We must verify actual fills using getOrder, not just assume
 * missing orders were filled (they could be cancelled/expired)
 */
async function checkAllFills(
  marketMakers: Awaited<ReturnType<typeof prisma.marketMaker.findMany>>,
  result: MarketMakingResult
): Promise<void> {
  try {
    // Fetch all open orders from CLOB
    const openOrders = await fetchActiveOrders();
    const openOrderIds = new Set(openOrders.map((o) => o.id));
    const trackedOrdersCount = marketMakers.reduce((sum, mm) => {
      if (!("orders" in mm) || !Array.isArray(mm.orders)) return sum;
      return sum + mm.orders.length;
    }, 0);

    // Defensive guard: empty open order list while we have tracked orders
    if (openOrders.length === 0 && trackedOrdersCount > 0) {
      console.warn(
        "[MarketMaking] Open orders returned empty while tracked orders exist; skipping fill reconciliation"
      );
      return;
    }

    // Check each market maker's orders
    for (const mm of marketMakers) {
      if (!("orders" in mm) || !Array.isArray(mm.orders)) continue;

      for (const order of mm.orders) {
        // If order is still open, nothing to do
        if (openOrderIds.has(order.orderId)) continue;

        // Order is not in open orders - check if it was actually filled
        const orderResult = await getOrder(order.orderId);

        if (orderResult.status === "error") {
          console.warn(
            `[MarketMaking] Failed to fetch order ${order.orderId}: ${orderResult.message}`
          );
          continue;
        }

        if (orderResult.status === "not_found") {
          // Likely cancelled/expired or too old - remove stale record
          console.log(`[MarketMaking] Order ${order.orderId} not found - removing stale record`);
          await prisma.marketMakerOrder.delete({ where: { id: order.id } });
          await logQuoteAction(mm.id, "ORDER_STALE", {
            outcome: order.outcome,
            side: order.side,
            orderId: order.orderId,
            error: "Order not found in CLOB API",
          });
          continue;
        }

        const orderDetails = orderResult.order;
        const status = orderDetails.status.toUpperCase();
        const sizeMatched = Number(orderDetails.size_matched || 0);
        const originalSize = Number(orderDetails.original_size || order.size);
        const isLive = status === "LIVE" || status === "OPEN";
        const isTerminal = status === "MATCHED" || status === "CANCELLED" || status === "EXPIRED";

        if (isLive) {
          console.warn(
            `[MarketMaking] Order ${order.orderId} reported ${status} but missing from open orders; keeping record`
          );
          continue;
        }

        if (sizeMatched > 0) {
          // Order was (at least partially) filled - process the fill
          console.log(`[MarketMaking] Order ${order.orderId} filled: ${sizeMatched}/${originalSize}`);
          await processFill(mm, order, result, sizeMatched);
          continue;
        }

        if (isTerminal) {
          // Cancelled/expired/fully matched without any fills - delete record
          console.log(`[MarketMaking] Order ${order.orderId} ${status.toLowerCase()} (no fills)`);
          await prisma.marketMakerOrder.delete({ where: { id: order.id } });
          await logQuoteAction(mm.id, "ORDER_CANCELLED", {
            outcome: order.outcome,
            side: order.side,
            orderId: order.orderId,
            status,
          });
          continue;
        }

        // Unknown status: keep record and retry next cycle
        console.warn(
          `[MarketMaking] Order ${order.orderId} returned unknown status ${status}; keeping record`
        );
      }
    }
  } catch (error) {
    console.error("[MarketMaking] Error checking fills:", error);
  }
}

/**
 * Process a fill for an order
 * @param filledSize - Actual size that was filled (from getOrder size_matched)
 */
async function processFill(
  mm: { id: string; yesInventory: unknown; noInventory: unknown; avgYesCost: unknown; avgNoCost: unknown; realizedPnl: unknown },
  order: { id: string; orderId: string; outcome: string; side: string; price: unknown; size: unknown },
  result: MarketMakingResult,
  filledSize?: number
): Promise<void> {
  const isBuy = order.side === "BID";
  const isYes = order.outcome === "YES";
  const price = Number(order.price);
  // Use actual filled size if provided, otherwise fall back to order size
  let size = filledSize !== undefined ? filledSize : Number(order.size);
  const availableInventory = isYes ? Number(mm.yesInventory) : Number(mm.noInventory);

  if (!isBuy && size > availableInventory) {
    console.warn(
      `[MarketMaking] Clamping sell fill size from ${size} to ${availableInventory} for ${order.orderId}`
    );
    size = availableInventory;
  }

  const value = price * size;

  // Skip if nothing was actually filled
  if (size <= 0) {
    console.log(`[MarketMaking] Skipping fill for ${order.orderId} - no actual fills`);
    await prisma.marketMakerOrder.delete({ where: { id: order.id } });
    return;
  }

  console.log(`[MarketMaking] Processing fill: ${order.outcome} ${order.side} @ ${price} x ${size}`);

  // Calculate inventory update
  let yesInventory = Number(mm.yesInventory);
  let noInventory = Number(mm.noInventory);
  let avgYesCost = Number(mm.avgYesCost);
  let avgNoCost = Number(mm.avgNoCost);
  let realizedPnl = Number(mm.realizedPnl);
  let fillRealizedPnl: number | null = null;

  if (isYes) {
    if (isBuy) {
      // Bought YES tokens - update avg cost
      const totalCost = avgYesCost * yesInventory + value;
      yesInventory += size;
      avgYesCost = yesInventory > 0 ? totalCost / yesInventory : 0;
    } else {
      // Sold YES tokens - realize PnL
      if (yesInventory > 0) {
        fillRealizedPnl = (price - avgYesCost) * size;
        realizedPnl += fillRealizedPnl;
      }
      yesInventory -= size;
      if (yesInventory <= 0) {
        yesInventory = 0;
        avgYesCost = 0;
      }
    }
  } else {
    if (isBuy) {
      // Bought NO tokens - update avg cost
      const totalCost = avgNoCost * noInventory + value;
      noInventory += size;
      avgNoCost = noInventory > 0 ? totalCost / noInventory : 0;
    } else {
      // Sold NO tokens - realize PnL
      if (noInventory > 0) {
        fillRealizedPnl = (price - avgNoCost) * size;
        realizedPnl += fillRealizedPnl;
      }
      noInventory -= size;
      if (noInventory <= 0) {
        noInventory = 0;
        avgNoCost = 0;
      }
    }
  }

  // Record the fill
  await prisma.marketMakerFill.create({
    data: {
      marketMakerId: mm.id,
      outcome: order.outcome,
      side: isBuy ? "BUY" : "SELL",
      orderId: order.orderId,
      price,
      size,
      value,
      realizedPnl: fillRealizedPnl,
    },
  });

  // Update market maker state
  await prisma.marketMaker.update({
    where: { id: mm.id },
    data: {
      yesInventory,
      noInventory,
      avgYesCost,
      avgNoCost,
      realizedPnl,
    },
  });

  // Delete the filled order
  await prisma.marketMakerOrder.delete({
    where: { id: order.id },
  });

  // Log the fill
  await logQuoteAction(mm.id, "FILL", {
    outcome: order.outcome,
    side: isBuy ? "BUY" : "SELL",
    price,
    size,
    orderId: order.orderId,
    realizedPnl: fillRealizedPnl,
  });

  result.fillsProcessed++;
}

/**
 * Process a single market maker
 */
async function processMarketMaker(
  mm: Awaited<ReturnType<typeof prisma.marketMaker.findFirst>> & {
    market: Awaited<ReturnType<typeof prisma.market.findFirst>>;
    orders: Awaited<ReturnType<typeof prisma.marketMakerOrder.findMany>>;
  },
  config: Awaited<ReturnType<typeof prisma.config.findUnique>>,
  refreshThreshold: number,
  result: MarketMakingResult
): Promise<void> {
  if (!mm || !mm.market || !config) return;

  // Check risk guardrails
  const now = new Date();

  // 1. Volatility pause
  if (mm.volatilityPauseUntil && isBefore(now, mm.volatilityPauseUntil)) {
    console.log(`[MarketMaking] ${mm.market.slug} is paused until ${mm.volatilityPauseUntil}`);
    return;
  }

  // 2. Time to resolution
  if (mm.market.endDate) {
    const stopTime = addHours(mm.market.endDate, -mm.minTimeToResolution);
    if (isBefore(stopTime, now)) {
      console.log(`[MarketMaking] ${mm.market.slug} is too close to resolution, stopping`);
      // Cancel all orders and pause
      await cancelAllOrdersForMM(mm.id, mm.orders, result);
      await prisma.marketMaker.update({
        where: { id: mm.id },
        data: { paused: true },
      });
      await logQuoteAction(mm.id, "PAUSE", { reason: "Time to resolution" });
      return;
    }
  }

  // Get token IDs for YES and NO outcomes from clobTokenIds
  // clobTokenIds[0] = YES token, clobTokenIds[1] = NO token
  const clobTokenIds = mm.market.clobTokenIds || [];
  const yesTokenId = clobTokenIds[0];
  const noTokenId = clobTokenIds[1];

  if (!yesTokenId || !noTokenId) {
    console.log(`[MarketMaking] No clobTokenIds for ${mm.market.slug}, skipping`);
    return;
  }

  // Fetch midpoint, spread, and best bid/ask from CLOB (YES + NO)
  const [
    yesMidpoint,
    yesClobSpread,
    yesBest,
    noMidpoint,
    noClobSpread,
    noBest,
  ] = await Promise.all([
    getMidpointPrice(yesTokenId),
    getSpread(yesTokenId),
    getBestPrices(yesTokenId),
    getMidpointPrice(noTokenId),
    getSpread(noTokenId),
    getBestPrices(noTokenId),
  ]);

  if (yesMidpoint === null || noMidpoint === null) {
    console.log(`[MarketMaking] No midpoint for ${mm.market.slug}, skipping`);
    return;
  }

  // ============================================================================
  // SANITY CHECKS - All must pass before placing any quotes
  // ============================================================================

  // CHECK 1: Midpoint within valid bounds (not nearly-resolved)
  if (yesMidpoint < MIN_VALID_MIDPOINT || yesMidpoint > MAX_VALID_MIDPOINT) {
    console.warn(
      `[MarketMaking] CHECK 1 FAILED: ${mm.market.slug} YES midpoint ${yesMidpoint.toFixed(3)} outside [${MIN_VALID_MIDPOINT}, ${MAX_VALID_MIDPOINT}]`
    );
    await logQuoteAction(mm.id, "SANITY_CHECK_FAILED", {
      error: `YES midpoint ${yesMidpoint.toFixed(3)} outside valid range (nearly resolved?)`,
    });
    return;
  }
  if (noMidpoint < MIN_VALID_MIDPOINT || noMidpoint > MAX_VALID_MIDPOINT) {
    console.warn(
      `[MarketMaking] CHECK 1 FAILED: ${mm.market.slug} NO midpoint ${noMidpoint.toFixed(3)} outside [${MIN_VALID_MIDPOINT}, ${MAX_VALID_MIDPOINT}]`
    );
    await logQuoteAction(mm.id, "SANITY_CHECK_FAILED", {
      error: `NO midpoint ${noMidpoint.toFixed(3)} outside valid range (nearly resolved?)`,
    });
    return;
  }

  // CHECK 2: Crossed/locked book detection (bid >= ask = broken book)
  if (
    yesBest.bestBid !== null &&
    yesBest.bestAsk !== null &&
    yesBest.bestBid >= yesBest.bestAsk
  ) {
    console.error(
      `[MarketMaking] CHECK 2 FAILED: ${mm.market.slug} YES crossed/locked book: bid=${yesBest.bestBid.toFixed(3)} >= ask=${yesBest.bestAsk.toFixed(3)}`
    );
    await logQuoteAction(mm.id, "SANITY_CHECK_FAILED", {
      error: `YES crossed book: bid=${yesBest.bestBid.toFixed(3)} >= ask=${yesBest.bestAsk.toFixed(3)}`,
    });
    return;
  }
  if (
    noBest.bestBid !== null &&
    noBest.bestAsk !== null &&
    noBest.bestBid >= noBest.bestAsk
  ) {
    console.error(
      `[MarketMaking] CHECK 2 FAILED: ${mm.market.slug} NO crossed/locked book: bid=${noBest.bestBid.toFixed(3)} >= ask=${noBest.bestAsk.toFixed(3)}`
    );
    await logQuoteAction(mm.id, "SANITY_CHECK_FAILED", {
      error: `NO crossed book: bid=${noBest.bestBid.toFixed(3)} >= ask=${noBest.bestAsk.toFixed(3)}`,
    });
    return;
  }

  // CHECK 3: Spread sanity (too wide = illiquid/broken)
  const yesSpreadTicks =
    yesClobSpread !== null ? Math.round(yesClobSpread / TICK_SIZE) : null;
  if (yesSpreadTicks !== null && yesSpreadTicks > MAX_SPREAD_TICKS) {
    console.warn(
      `[MarketMaking] CHECK 3 FAILED: ${mm.market.slug} YES spread ${yesSpreadTicks} ticks > max ${MAX_SPREAD_TICKS}`
    );
    await logQuoteAction(mm.id, "SANITY_CHECK_FAILED", {
      error: `YES spread ${yesSpreadTicks} ticks exceeds max ${MAX_SPREAD_TICKS} (illiquid book)`,
    });
    return;
  }
  const noSpreadTicks =
    noClobSpread !== null ? Math.round(noClobSpread / TICK_SIZE) : null;
  if (noSpreadTicks !== null && noSpreadTicks > MAX_SPREAD_TICKS) {
    console.warn(
      `[MarketMaking] CHECK 3 FAILED: ${mm.market.slug} NO spread ${noSpreadTicks} ticks > max ${MAX_SPREAD_TICKS}`
    );
    await logQuoteAction(mm.id, "SANITY_CHECK_FAILED", {
      error: `NO spread ${noSpreadTicks} ticks exceeds max ${MAX_SPREAD_TICKS} (illiquid book)`,
    });
    return;
  }

  // CHECK 4: Staleness - stored price must be recent
  const storedPrice = mm.market.yesPrice ? Number(mm.market.yesPrice) : null;
  const priceAgeMinutes = mm.market.updatedAt
    ? (Date.now() - mm.market.updatedAt.getTime()) / (1000 * 60)
    : Infinity;

  if (priceAgeMinutes > MAX_PRICE_AGE_MINUTES) {
    console.warn(
      `[MarketMaking] CHECK 4 FAILED: ${mm.market.slug} stored price is ${priceAgeMinutes.toFixed(0)} min old (max ${MAX_PRICE_AGE_MINUTES})`
    );
    await logQuoteAction(mm.id, "SANITY_CHECK_FAILED", {
      error: `Stored price ${priceAgeMinutes.toFixed(0)} min old (stale data)`,
    });
    return;
  }

  // CHECK 5: CLOB midpoint vs stored price deviation (dynamic threshold)
  // Threshold = max(MIN_DEVIATION, 2 × spread)
  const yesDynamicDeviation = Math.max(
    MIN_MIDPOINT_DEVIATION,
    yesClobSpread !== null
      ? DEVIATION_MULTIPLIER * yesClobSpread
      : MIN_MIDPOINT_DEVIATION
  );

  if (storedPrice !== null && storedPrice > 0) {
    const deviation = Math.abs(yesMidpoint - storedPrice);
    if (deviation > yesDynamicDeviation) {
      console.error(
        `[MarketMaking] CHECK 5 FAILED: ${mm.market.slug} YES CLOB mid=${yesMidpoint.toFixed(3)} ` +
          `deviates ${(deviation * 100).toFixed(1)}¢ from stored=${storedPrice.toFixed(3)}. ` +
          `Max allowed: ${(yesDynamicDeviation * 100).toFixed(1)}¢ (dynamic). REFUSING TO QUOTE.`
      );
      await logQuoteAction(mm.id, "SANITY_CHECK_FAILED", {
        error: `YES CLOB mid ${yesMidpoint.toFixed(3)} deviates ${(deviation * 100).toFixed(1)}¢ from stored ${storedPrice.toFixed(3)} (max ${(yesDynamicDeviation * 100).toFixed(1)}¢)`,
      });
      return;
    }
    if (deviation > MIN_MIDPOINT_DEVIATION) {
      console.warn(
        `[MarketMaking] Price deviation warning: ${mm.market.slug} YES CLOB=${yesMidpoint.toFixed(3)} stored=${storedPrice.toFixed(3)} (${(deviation * 100).toFixed(1)}¢ diff)`
      );
    }
  } else {
    console.error(
      `[MarketMaking] CHECK 5 FAILED: ${mm.market.slug} no stored yesPrice to cross-check CLOB mid=${yesMidpoint.toFixed(3)}`
    );
    await logQuoteAction(mm.id, "SANITY_CHECK_FAILED", {
      error: `No stored YES price to cross-check CLOB midpoint`,
    });
    return;
  }

  const storedNoPrice = mm.market.noPrice ? Number(mm.market.noPrice) : null;
  const noDynamicDeviation = Math.max(
    MIN_MIDPOINT_DEVIATION,
    noClobSpread !== null
      ? DEVIATION_MULTIPLIER * noClobSpread
      : MIN_MIDPOINT_DEVIATION
  );

  if (storedNoPrice !== null && storedNoPrice > 0) {
    const deviation = Math.abs(noMidpoint - storedNoPrice);
    if (deviation > noDynamicDeviation) {
      console.error(
        `[MarketMaking] CHECK 5 FAILED: ${mm.market.slug} NO CLOB mid=${noMidpoint.toFixed(3)} ` +
          `deviates ${(deviation * 100).toFixed(1)}¢ from stored=${storedNoPrice.toFixed(3)}. ` +
          `Max allowed: ${(noDynamicDeviation * 100).toFixed(1)}¢ (dynamic). REFUSING TO QUOTE.`
      );
      await logQuoteAction(mm.id, "SANITY_CHECK_FAILED", {
        error: `NO CLOB mid ${noMidpoint.toFixed(3)} deviates ${(deviation * 100).toFixed(1)}¢ from stored ${storedNoPrice.toFixed(3)} (max ${(noDynamicDeviation * 100).toFixed(1)}¢)`,
      });
      return;
    }
    if (deviation > MIN_MIDPOINT_DEVIATION) {
      console.warn(
        `[MarketMaking] Price deviation warning: ${mm.market.slug} NO CLOB=${noMidpoint.toFixed(3)} stored=${storedNoPrice.toFixed(3)} (${(deviation * 100).toFixed(1)}¢ diff)`
      );
    }
  } else {
    console.error(
      `[MarketMaking] CHECK 5 FAILED: ${mm.market.slug} no stored noPrice to cross-check CLOB mid=${noMidpoint.toFixed(3)}`
    );
    await logQuoteAction(mm.id, "SANITY_CHECK_FAILED", {
      error: `No stored NO price to cross-check CLOB midpoint`,
    });
    return;
  }

  // Use validated CLOB midpoint
  const currentYesMidPrice = yesMidpoint;
  const currentNoMidPrice = noMidpoint;

  // Check if we need to refresh quotes
  const timeSinceLastQuote = mm.lastQuoteAt
    ? Date.now() - mm.lastQuoteAt.getTime()
    : Infinity;

  const existingOrders = mm.orders || [];
  const hasAllOrders = existingOrders.length >= 4; // YES bid/ask + NO bid/ask

  const previousMidPrice = mm.market.yesPrice ? Number(mm.market.yesPrice) : 0.5;
  const needsRefresh =
    timeSinceLastQuote >= MIN_QUOTE_INTERVAL &&
    (shouldRefreshQuotes(currentYesMidPrice, previousMidPrice, refreshThreshold) || !hasAllOrders);

  if (!needsRefresh) {
    return;
  }

  console.log(`[MarketMaking] Refreshing quotes for ${mm.market.slug}`);

  // Calculate new quotes for YES outcome
  const yesQuote = calculateQuotes({
    midPrice: currentYesMidPrice,
    targetSpread: Number(mm.targetSpread),
    inventory: Number(mm.yesInventory),
    skewFactor: Number(mm.skewFactor),
    orderSize: Number(mm.orderSize),
    maxInventory: Number(mm.maxInventory),
    quotingPolicy: mm.quotingPolicy as QuotingPolicy,
    bestBid: yesBest.bestBid,
    bestAsk: yesBest.bestAsk,
  });

  const noQuote = calculateQuotes({
    midPrice: currentNoMidPrice,
    targetSpread: Number(mm.targetSpread),
    inventory: Number(mm.noInventory),
    skewFactor: Number(mm.skewFactor),
    orderSize: Number(mm.orderSize),
    maxInventory: Number(mm.maxInventory),
    quotingPolicy: mm.quotingPolicy as QuotingPolicy,
    bestBid: noBest.bestBid,
    bestAsk: noBest.bestAsk,
  });

  console.log(`[MarketMaking] ${mm.market.slug} YES quotes:`, {
    midPrice: currentYesMidPrice.toFixed(3),
    bidPrice: yesQuote.bidPrice.toFixed(3),
    askPrice: yesQuote.askPrice.toFixed(3),
    bidSize: yesQuote.bidSize,
    askSize: yesQuote.askSize,
    reduceOnly: yesQuote.reduceOnly,
    inventory: Number(mm.yesInventory).toFixed(2),
  });
  console.log(`[MarketMaking] ${mm.market.slug} NO quotes:`, {
    midPrice: currentNoMidPrice.toFixed(3),
    bidPrice: noQuote.bidPrice.toFixed(3),
    askPrice: noQuote.askPrice.toFixed(3),
    bidSize: noQuote.bidSize,
    askSize: noQuote.askSize,
    reduceOnly: noQuote.reduceOnly,
    inventory: Number(mm.noInventory).toFixed(2),
  });

  // CHECK 6: Quote prices must be reasonable relative to best bid/ask
  // Don't improve the best bid/ask by more than MAX_QUOTE_IMPROVEMENT (prevents runaway quotes)
  if (yesQuote.bidSize > 0 && yesBest.bestBid !== null) {
    const bidImprovement = yesQuote.bidPrice - yesBest.bestBid;
    if (bidImprovement > MAX_QUOTE_IMPROVEMENT) {
      console.error(
        `[MarketMaking] CHECK 6 FAILED: ${mm.market.slug} bid ${yesQuote.bidPrice.toFixed(3)} ` +
          `improves best bid ${yesBest.bestBid.toFixed(3)} by ${(bidImprovement * 100).toFixed(1)}¢ (max ${(MAX_QUOTE_IMPROVEMENT * 100).toFixed(0)}¢)`
      );
      await logQuoteAction(mm.id, "SANITY_CHECK_FAILED", {
        error: `YES bid ${yesQuote.bidPrice.toFixed(3)} improves best ${yesBest.bestBid.toFixed(3)} by too much`,
        side: "BID",
        price: yesQuote.bidPrice,
      });
      return;
    }
  }

  if (yesQuote.askSize > 0 && yesBest.bestAsk !== null) {
    const askImprovement = yesBest.bestAsk - yesQuote.askPrice;
    if (askImprovement > MAX_QUOTE_IMPROVEMENT) {
      console.error(
        `[MarketMaking] CHECK 6 FAILED: ${mm.market.slug} ask ${yesQuote.askPrice.toFixed(3)} ` +
          `improves best ask ${yesBest.bestAsk.toFixed(3)} by ${(askImprovement * 100).toFixed(1)}¢ (max ${(MAX_QUOTE_IMPROVEMENT * 100).toFixed(0)}¢)`
      );
      await logQuoteAction(mm.id, "SANITY_CHECK_FAILED", {
        error: `YES ask ${yesQuote.askPrice.toFixed(3)} improves best ${yesBest.bestAsk.toFixed(3)} by too much`,
        side: "ASK",
        price: yesQuote.askPrice,
      });
      return;
    }
  }

  if (noQuote.bidSize > 0 && noBest.bestBid !== null) {
    const bidImprovement = noQuote.bidPrice - noBest.bestBid;
    if (bidImprovement > MAX_QUOTE_IMPROVEMENT) {
      console.error(
        `[MarketMaking] CHECK 6 FAILED: ${mm.market.slug} NO bid ${noQuote.bidPrice.toFixed(3)} ` +
          `improves best bid ${noBest.bestBid.toFixed(3)} by ${(bidImprovement * 100).toFixed(1)}¢ (max ${(MAX_QUOTE_IMPROVEMENT * 100).toFixed(0)}¢)`
      );
      await logQuoteAction(mm.id, "SANITY_CHECK_FAILED", {
        error: `NO bid ${noQuote.bidPrice.toFixed(3)} improves best ${noBest.bestBid.toFixed(3)} by too much`,
        side: "BID",
        price: noQuote.bidPrice,
      });
      return;
    }
  }

  if (noQuote.askSize > 0 && noBest.bestAsk !== null) {
    const askImprovement = noBest.bestAsk - noQuote.askPrice;
    if (askImprovement > MAX_QUOTE_IMPROVEMENT) {
      console.error(
        `[MarketMaking] CHECK 6 FAILED: ${mm.market.slug} NO ask ${noQuote.askPrice.toFixed(3)} ` +
          `improves best ask ${noBest.bestAsk.toFixed(3)} by ${(askImprovement * 100).toFixed(1)}¢ (max ${(MAX_QUOTE_IMPROVEMENT * 100).toFixed(0)}¢)`
      );
      await logQuoteAction(mm.id, "SANITY_CHECK_FAILED", {
        error: `NO ask ${noQuote.askPrice.toFixed(3)} improves best ${noBest.bestAsk.toFixed(3)} by too much`,
        side: "ASK",
        price: noQuote.askPrice,
      });
      return;
    }
  }

  // CHECK 7: Quote prices must be valid (0 < price < 1)
  if (yesQuote.bidSize > 0 && (yesQuote.bidPrice <= 0 || yesQuote.bidPrice >= 1)) {
    console.error(
      `[MarketMaking] CHECK 7 FAILED: ${mm.market.slug} invalid bid price ${yesQuote.bidPrice.toFixed(3)}`
    );
    await logQuoteAction(mm.id, "SANITY_CHECK_FAILED", {
      error: `Invalid bid price ${yesQuote.bidPrice.toFixed(3)}`,
      side: "BID",
      price: yesQuote.bidPrice,
    });
    return;
  }

  if (yesQuote.askSize > 0 && (yesQuote.askPrice <= 0 || yesQuote.askPrice >= 1)) {
    console.error(
      `[MarketMaking] CHECK 7 FAILED: ${mm.market.slug} invalid ask price ${yesQuote.askPrice.toFixed(3)}`
    );
    await logQuoteAction(mm.id, "SANITY_CHECK_FAILED", {
      error: `Invalid ask price ${yesQuote.askPrice.toFixed(3)}`,
      side: "ASK",
      price: yesQuote.askPrice,
    });
    return;
  }

  if (noQuote.bidSize > 0 && (noQuote.bidPrice <= 0 || noQuote.bidPrice >= 1)) {
    console.error(
      `[MarketMaking] CHECK 7 FAILED: ${mm.market.slug} invalid NO bid price ${noQuote.bidPrice.toFixed(3)}`
    );
    await logQuoteAction(mm.id, "SANITY_CHECK_FAILED", {
      error: `Invalid NO bid price ${noQuote.bidPrice.toFixed(3)}`,
      side: "BID",
      price: noQuote.bidPrice,
    });
    return;
  }

  if (noQuote.askSize > 0 && (noQuote.askPrice <= 0 || noQuote.askPrice >= 1)) {
    console.error(
      `[MarketMaking] CHECK 7 FAILED: ${mm.market.slug} invalid NO ask price ${noQuote.askPrice.toFixed(3)}`
    );
    await logQuoteAction(mm.id, "SANITY_CHECK_FAILED", {
      error: `Invalid NO ask price ${noQuote.askPrice.toFixed(3)}`,
      side: "ASK",
      price: noQuote.askPrice,
    });
    return;
  }

  // Build map of desired quotes: key = "outcome-side", value = {price, size, tokenId}
  const desiredQuotes = new Map<string, { price: number; size: number; tokenId: string }>();

  if (yesQuote.bidSize > 0) {
    desiredQuotes.set("YES-BID", { price: yesQuote.bidPrice, size: yesQuote.bidSize, tokenId: yesTokenId });
  }
  if (yesQuote.askSize > 0) {
    desiredQuotes.set("YES-ASK", { price: yesQuote.askPrice, size: yesQuote.askSize, tokenId: yesTokenId });
  }
  if (noQuote.bidSize > 0) {
    desiredQuotes.set("NO-BID", { price: noQuote.bidPrice, size: noQuote.bidSize, tokenId: noTokenId });
  }
  if (noQuote.askSize > 0) {
    desiredQuotes.set("NO-ASK", { price: noQuote.askPrice, size: noQuote.askSize, tokenId: noTokenId });
  }

  // Track which desired quotes are already satisfied by existing orders
  const satisfiedQuotes = new Set<string>();
  const ordersToCancel: typeof existingOrders = [];

  // Check existing orders against desired quotes
  for (const order of existingOrders) {
    const key = `${order.outcome}-${order.side}`;
    const desired = desiredQuotes.get(key);

    if (desired && Math.abs(Number(order.price) - desired.price) < 0.001) {
      // Order is at the correct price - keep it to maintain queue priority
      satisfiedQuotes.add(key);
      console.log(`[MarketMaking] Keeping ${key} order at ${order.price} (queue priority)`);
    } else {
      // Price changed or quote no longer needed - cancel it
      ordersToCancel.push(order);
    }
  }

  // Cancel orders that need to be replaced
  for (const order of ordersToCancel) {
    try {
      await cancelOrder(order.orderId);
      await prisma.marketMakerOrder.delete({ where: { id: order.id } });
      result.quotesCancelled++;
      await logQuoteAction(mm.id, "QUOTE_CANCELLED", {
        outcome: order.outcome,
        side: order.side,
        orderId: order.orderId,
        reason: "price_changed",
      });
    } catch (e) {
      console.error(`[MarketMaking] Failed to cancel order ${order.orderId}:`, e);
    }
  }

  // Place new orders only for quotes that aren't already satisfied
  if (yesQuote.bidSize > 0 && !satisfiedQuotes.has("YES-BID")) {
    const bidResult = await placeOrder({
      tokenId: yesTokenId,
      side: "BUY",
      price: yesQuote.bidPrice,
      size: yesQuote.bidSize,
      orderType: "GTC",
      postOnly: true,
    });

    if (bidResult.success && bidResult.orderId) {
      await prisma.marketMakerOrder.create({
        data: {
          marketMakerId: mm.id,
          outcome: "YES",
          side: "BID",
          orderId: bidResult.orderId,
          tokenId: yesTokenId,
          price: yesQuote.bidPrice,
          size: yesQuote.bidSize,
        },
      });
      result.quotesPlaced++;
      await logQuoteAction(mm.id, "QUOTE_PLACED", {
        outcome: "YES",
        side: "BID",
        price: yesQuote.bidPrice,
        size: yesQuote.bidSize,
        orderId: bidResult.orderId,
      });
    }
  }

  if (yesQuote.askSize > 0 && !satisfiedQuotes.has("YES-ASK")) {
    const askResult = await placeOrder({
      tokenId: yesTokenId,
      side: "SELL",
      price: yesQuote.askPrice,
      size: yesQuote.askSize,
      orderType: "GTC",
      postOnly: true,
    });

    if (askResult.success && askResult.orderId) {
      await prisma.marketMakerOrder.create({
        data: {
          marketMakerId: mm.id,
          outcome: "YES",
          side: "ASK",
          orderId: askResult.orderId,
          tokenId: yesTokenId,
          price: yesQuote.askPrice,
          size: yesQuote.askSize,
        },
      });
      result.quotesPlaced++;
      await logQuoteAction(mm.id, "QUOTE_PLACED", {
        outcome: "YES",
        side: "ASK",
        price: yesQuote.askPrice,
        size: yesQuote.askSize,
        orderId: askResult.orderId,
      });
    }
  }

  // Place new NO quotes only if not already satisfied
  if (noQuote.bidSize > 0 && !satisfiedQuotes.has("NO-BID")) {
    const bidResult = await placeOrder({
      tokenId: noTokenId,
      side: "BUY",
      price: noQuote.bidPrice,
      size: noQuote.bidSize,
      orderType: "GTC",
      postOnly: true,
    });

    if (bidResult.success && bidResult.orderId) {
      await prisma.marketMakerOrder.create({
        data: {
          marketMakerId: mm.id,
          outcome: "NO",
          side: "BID",
          orderId: bidResult.orderId,
          tokenId: noTokenId,
          price: noQuote.bidPrice,
          size: noQuote.bidSize,
        },
      });
      result.quotesPlaced++;
      await logQuoteAction(mm.id, "QUOTE_PLACED", {
        outcome: "NO",
        side: "BID",
        price: noQuote.bidPrice,
        size: noQuote.bidSize,
        orderId: bidResult.orderId,
      });
    }
  }

  if (noQuote.askSize > 0 && !satisfiedQuotes.has("NO-ASK")) {
    const askResult = await placeOrder({
      tokenId: noTokenId,
      side: "SELL",
      price: noQuote.askPrice,
      size: noQuote.askSize,
      orderType: "GTC",
      postOnly: true,
    });

    if (askResult.success && askResult.orderId) {
      await prisma.marketMakerOrder.create({
        data: {
          marketMakerId: mm.id,
          outcome: "NO",
          side: "ASK",
          orderId: askResult.orderId,
          tokenId: noTokenId,
          price: noQuote.askPrice,
          size: noQuote.askSize,
        },
      });
      result.quotesPlaced++;
      await logQuoteAction(mm.id, "QUOTE_PLACED", {
        outcome: "NO",
        side: "ASK",
        price: noQuote.askPrice,
        size: noQuote.askSize,
        orderId: askResult.orderId,
      });
    }
  }

  // Update last quote time
  await prisma.marketMaker.update({
    where: { id: mm.id },
    data: { lastQuoteAt: new Date() },
  });
}

/**
 * Cancel all orders for a market maker
 */
async function cancelAllOrdersForMM(
  mmId: string,
  orders: Array<{ id: string; orderId: string; outcome: string; side: string }>,
  result: MarketMakingResult
): Promise<void> {
  for (const order of orders) {
    try {
      await cancelOrder(order.orderId);
      await prisma.marketMakerOrder.delete({ where: { id: order.id } });
      result.quotesCancelled++;
    } catch (e) {
      console.error(`[MarketMaking] Failed to cancel order ${order.orderId}:`, e);
    }
  }
}

/**
 * Log a quote action to the history table
 */
async function logQuoteAction(
  marketMakerId: string,
  action: string,
  data: {
    outcome?: string;
    side?: string;
    price?: number;
    size?: number;
    orderId?: string;
    error?: string;
    reason?: string;
    realizedPnl?: number | null;
  }
): Promise<void> {
  await prisma.quoteHistory.create({
    data: {
      marketMakerId,
      action,
      outcome: data.outcome,
      side: data.side,
      price: data.price,
      size: data.size,
      orderId: data.orderId,
      metadata: {
        error: data.error,
        reason: data.reason,
        realizedPnl: data.realizedPnl,
      },
    },
  });
}

/**
 * Stop all market making activity
 */
export async function stopAllMarketMaking(): Promise<{ cancelled: number }> {
  console.log("[MarketMaking] Stopping all market making activity...");

  let cancelled = 0;

  try {
    const orders = await prisma.marketMakerOrder.findMany();

    for (const order of orders) {
      try {
        await cancelOrder(order.orderId);
        cancelled++;
      } catch (e) {
        console.error(`[MarketMaking] Failed to cancel order ${order.orderId}:`, e);
      }
    }

    // Delete all orders and pause all MMs
    await prisma.marketMakerOrder.deleteMany();
    await prisma.marketMaker.updateMany({
      data: { paused: true },
    });

    console.log(`[MarketMaking] Stopped all MM activity, cancelled ${cancelled} orders`);
    return { cancelled };
  } catch (error) {
    console.error("[MarketMaking] Error stopping MM:", error);
    throw error;
  }
}
