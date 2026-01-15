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
  getPositions,
  getBalance,
  type DataAPIPosition,
} from "@favored/shared";
import {
  calculateQuotes,
  calculateTieredQuotes,
  parseTierConfig,
  calculateMidPrice,
  shouldRefreshQuotes,
  TICK_SIZE,
  type Quote,
  type QuotingPolicy,
  type TieredQuote,
  type TierConfig,
} from "@favored/shared";
import { addHours, isBefore } from "date-fns";
import {
  confirmPendingFillsForMarketMaker,
  recordPendingFillEvent,
} from "../lib/fill-events.js";

// Minimum time between quote refreshes (ms)
const MIN_QUOTE_INTERVAL = 5000;

const MIN_PRICE = 0.01;
const MAX_PRICE = 0.99;
const MIN_ORDER_SIZE = (() => {
  const raw = Number(process.env.MM_MIN_ORDER_SIZE ?? 5);
  return Number.isFinite(raw) && raw > 0 ? raw : 5;
})();

const clampPrice = (price: number) => Math.min(MAX_PRICE, Math.max(MIN_PRICE, price));
const roundToTick = (price: number) => Math.round(price / TICK_SIZE) * TICK_SIZE;

type MarketOutcome = "YES" | "NO";
type OrderSide = "BID" | "ASK";
type FillSide = "BUY" | "SELL";
type QuoteSide = OrderSide | FillSide;

const toMarketOutcome = (value: string): MarketOutcome | null =>
  value === "YES" || value === "NO" ? value : null;

const toOrderSide = (value: string): OrderSide | null =>
  value === "BID" || value === "ASK" ? value : null;

// Helper function for delays
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Order verification settings
const ORDER_VERIFICATION_RETRIES = 5;
const ORDER_VERIFICATION_BACKOFF_MS = 300;

const SANITY_ALERT_COOLDOWN_MS = 10 * 60 * 1000;
const sanityAlertLast = new Map<string, number>();

const DEPENDENCY_RETRIES = Number(process.env.MM_DEPENDENCY_RETRIES ?? 3);
const DEPENDENCY_RETRY_DELAY_MS = Number(
  process.env.MM_DEPENDENCY_RETRY_DELAY_MS ?? 500
);
const DEPENDENCY_FAILURE_THRESHOLD = Number(
  process.env.MM_DEPENDENCY_FAILURE_THRESHOLD ?? 3
);
const DEPENDENCY_CACHE_MS = Number(process.env.MM_DEPENDENCY_CACHE_MS ?? 120000);
const DEPENDENCY_COOLDOWN_MS = Number(
  process.env.MM_DEPENDENCY_COOLDOWN_MS ?? 30000
);
type DependencyKey = "balance" | "openOrders" | "positions";
type DependencyState = { failureStreak: number; openUntil: number };
const dependencyState: Record<DependencyKey, DependencyState> = {
  balance: { failureStreak: 0, openUntil: 0 },
  openOrders: { failureStreak: 0, openUntil: 0 },
  positions: { failureStreak: 0, openUntil: 0 },
};
type BalanceResult = NonNullable<Awaited<ReturnType<typeof getBalance>>>;
type OpenOrdersResult = NonNullable<Awaited<ReturnType<typeof fetchActiveOrders>>>;
type PositionsResult = NonNullable<Awaited<ReturnType<typeof getPositions>>>;
type DependencyValueMap = {
  balance: BalanceResult;
  openOrders: OpenOrdersResult;
  positions: PositionsResult;
};
type Cached<T> = { value: T; at: number };
const dependencyCache: Partial<
  Record<DependencyKey, Cached<DependencyValueMap[DependencyKey]>>
> = {};
const getDependencyCache = <K extends DependencyKey>(
  key: K
): Cached<DependencyValueMap[K]> | undefined =>
  dependencyCache[key] as Cached<DependencyValueMap[K]> | undefined;
let lastNonEmptyOpenOrders: Cached<OpenOrdersResult> | null = null;
let openOrdersEmptyStreak = 0;

async function retryDependency<T>(
  label: string,
  fn: () => Promise<T | null>
): Promise<T | null> {
  for (let attempt = 1; attempt <= DEPENDENCY_RETRIES; attempt++) {
    const result = await fn();
    if (result !== null) return result;
    if (attempt < DEPENDENCY_RETRIES) {
      console.warn(
        `[MarketMaking] ${label} unavailable (attempt ${attempt}/${DEPENDENCY_RETRIES}), retrying...`
      );
      await sleep(DEPENDENCY_RETRY_DELAY_MS * attempt);
    }
  }
  return null;
}

async function getDependency<K extends DependencyKey>(
  key: K,
  label: string,
  fn: () => Promise<DependencyValueMap[K] | null>
): Promise<{
  value: DependencyValueMap[K] | null;
  source: "live" | "cache" | "none";
  degraded: boolean;
}> {
  const now = Date.now();
  const state = dependencyState[key];
  const cache = getDependencyCache(key);
  const cacheFresh = cache && now - cache.at <= DEPENDENCY_CACHE_MS;

  if (state.openUntil > now) {
    if (cacheFresh) {
      console.warn(
        `[MarketMaking] ${label} circuit open; using cached value (${now - cache.at}ms old)`
      );
      return { value: cache.value, source: "cache", degraded: true };
    }
    console.error(
      `[MarketMaking] ${label} circuit open with no cache; running degraded`
    );
    return { value: null, source: "none", degraded: true };
  }

  const liveResult = await retryDependency(label, fn);
  if (liveResult !== null) {
    dependencyCache[key] = { value: liveResult, at: now } as Cached<DependencyValueMap[K]>;
    state.failureStreak = 0;
    state.openUntil = 0;
    return { value: liveResult, source: "live", degraded: false };
  }

  state.failureStreak += 1;
  console.error(
    `[MarketMaking] ${label} unavailable (streak ${state.failureStreak}/${DEPENDENCY_FAILURE_THRESHOLD})`
  );
  if (state.failureStreak >= DEPENDENCY_FAILURE_THRESHOLD) {
    state.openUntil = now + DEPENDENCY_COOLDOWN_MS;
    console.error(
      `[MarketMaking] ${label} circuit open for ${DEPENDENCY_COOLDOWN_MS}ms`
    );
  }

  if (cacheFresh) {
    console.warn(
      `[MarketMaking] ${label} using cached value (${now - cache.at}ms old)`
    );
    return { value: cache.value, source: "cache", degraded: true };
  }

  return { value: null, source: "none", degraded: true };
}

// Cached data for the MM cycle - fetch expensive data once at start
interface CycleContext {
  balance: { balance: number; allowance: number } | null;
  openOrders: NonNullable<Awaited<ReturnType<typeof fetchActiveOrders>>>;
  balanceReliable: boolean;
  openOrdersReliable: boolean;
  positions: NonNullable<Awaited<ReturnType<typeof getPositions>>> | null;
  positionsReliable: boolean;
  dependencyDegraded: boolean;
}

type MarketMakerWithOrders = Awaited<ReturnType<typeof prisma.marketMaker.findMany>>[number] & {
  market?: { slug?: string | null; clobTokenIds?: string[] | null } | null;
  orders?: Array<{
    id: string;
    orderId: string;
    outcome: MarketOutcome;
    side: OrderSide;
    price: unknown;
    size: unknown;
    lastMatchedSize: unknown;
  }>;
};

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

    // Get all active market makers (inventory sync includes paused)
    const marketMakers = await prisma.marketMaker.findMany({
      where: { active: true, market: { is: { venue: "POLYMARKET" } } },
      include: { market: true },
    });

    if (marketMakers.length === 0) {
      console.log("[MarketMaking] No active market makers configured");
      return result;
    }

    const refreshThreshold = Number(config.mmRefreshThreshold);

    // CACHE EXPENSIVE API CALLS AT START OF CYCLE
    const [balanceStatus, openOrdersStatus] = await Promise.all([
      getDependency("balance", "CLOB balance", () => getBalance()),
      getDependency("openOrders", "CLOB open orders", () => fetchActiveOrders()),
    ]);

    const balance = balanceStatus.value;
    let openClobOrders = openOrdersStatus.value ?? [];
    const balanceReliable = balanceStatus.source === "live";
    let openOrdersReliable = openOrdersStatus.source === "live";
    let dependencyDegraded = balanceStatus.degraded || openOrdersStatus.degraded;
    const nowMs = Date.now();
    if (openClobOrders.length > 0) {
      lastNonEmptyOpenOrders = { value: openClobOrders, at: nowMs };
    }

    const trackedTokenIds = new Set<string>();
    for (const mm of marketMakers) {
      const tokens = mm.market?.clobTokenIds || [];
      for (const token of tokens) {
        if (token) trackedTokenIds.add(token);
      }
    }

    if (dependencyDegraded) {
      console.warn("[MarketMaking] Dependencies degraded; entering reduce-only mode");
    }

    if (openOrdersReliable && trackedTokenIds.size > 0 && openClobOrders.length > 0) {
      const dbOrderIds = new Set(
        (
          await prisma.marketMakerOrder.findMany({
            select: { orderId: true },
          })
        ).map((o) => o.orderId)
      );

      const orphanOrders = openClobOrders.filter(
        (o) => trackedTokenIds.has(o.asset_id) && !dbOrderIds.has(o.id)
      );

      if (orphanOrders.length > 0) {
        console.warn(
          `[MarketMaking] Cancelling ${orphanOrders.length} orphan CLOB orders before processing`
        );
      }

      for (const orphan of orphanOrders) {
        try {
          await cancelOrder(orphan.id);
          result.quotesCancelled++;
        } catch (error) {
          console.error(
            `[MarketMaking] Failed to cancel orphan order ${orphan.id}:`,
            error
          );
        }
      }
    }

    const trackedOrdersCount = await prisma.marketMakerOrder.count();
    if (openClobOrders.length === 0 && trackedOrdersCount > 0) {
      if (
        lastNonEmptyOpenOrders &&
        nowMs - lastNonEmptyOpenOrders.at <= DEPENDENCY_CACHE_MS
      ) {
        openClobOrders = lastNonEmptyOpenOrders.value;
        dependencyDegraded = true;
        openOrdersReliable = false;
        console.warn(
          `[MarketMaking] Open orders empty; using cached snapshot (${openClobOrders.length} orders)`
        );
        openOrdersEmptyStreak = 0;
      } else {
        openOrdersEmptyStreak += 1;
        dependencyDegraded = true;
        openOrdersReliable = false;
        console.error(
          `[MarketMaking] CLOB open orders empty while DB has tracked orders ` +
          `(streak ${openOrdersEmptyStreak}/${DEPENDENCY_FAILURE_THRESHOLD})`
        );
      }
    } else {
      openOrdersEmptyStreak = 0;
    }

    const positionsStatus = await getDependency("positions", "Data API positions", () =>
      getPositions(undefined, { sizeThreshold: 0, limit: 500 })
    );
    const chainPositions = positionsStatus.value;
    const positionsReliable = positionsStatus.source === "live";
    dependencyDegraded = dependencyDegraded || positionsStatus.degraded;
    if (!chainPositions) {
      dependencyDegraded = true;
      console.warn("[MarketMaking] Data API positions unavailable; skipping inventory sync");
    } else {
      await syncInventoryFromChain(marketMakers, chainPositions);
    }

    const autoUnpauseEnabled = process.env.MM_AUTO_UNPAUSE !== "false";
    if (autoUnpauseEnabled && balanceReliable && openOrdersReliable) {
      const pausedCount = await prisma.marketMaker.count({
        where: { active: true, paused: true },
      });
      if (pausedCount > 0 && pausedCount === marketMakers.length) {
        await prisma.marketMaker.updateMany({
          where: { active: true, paused: true },
          data: { paused: false },
        });
        await prisma.log.create({
          data: {
            level: "INFO",
            category: "SYSTEM",
            message: "Auto-unpaused market makers after dependency recovery",
            metadata: {
              balanceReliable,
              openOrdersReliable,
              positionsReliable,
              pausedCount,
            },
          },
        });
      }
    }

    // Reload market makers with orders after inventory sync
    const marketMakersWithOrders = await prisma.marketMaker.findMany({
      where: {
        active: true,
        paused: false,
        market: { is: { venue: "POLYMARKET" } },
      },
      include: {
        market: true,
        orders: true,
      },
    });

    if (marketMakersWithOrders.length === 0) {
      console.log("[MarketMaking] No active (unpaused) market makers to process");
      return result;
    }

    console.log(
      `[MarketMaking] Processing ${marketMakersWithOrders.length} active market makers`
    );

    const cycleContext: CycleContext = {
      balance,
      openOrders: openClobOrders,
      balanceReliable,
      openOrdersReliable,
      positions: chainPositions ?? null,
      positionsReliable,
      dependencyDegraded,
    };

    const balanceDisplay = balance ? balance.balance.toFixed(2) : "n/a";
    console.log(
      `[MarketMaking] Cycle context: balance=${balanceDisplay} (${balanceReliable ? "live" : "stale"}), ` +
      `openOrders=${openClobOrders.length} (${openOrdersReliable ? "live" : "stale"}), ` +
      `positions=${chainPositions ? chainPositions.length : 0} (${positionsReliable ? "live" : "stale"})`
    );

    // First, check for fills across all market makers
    await checkAllFills(marketMakersWithOrders, result, cycleContext);

    // Refresh open orders after fill reconciliation to avoid stale state
    const refreshedOpenOrdersStatus = await getDependency(
      "openOrders",
      "CLOB open orders refresh",
      () => fetchActiveOrders()
    );
    if (refreshedOpenOrdersStatus.value === null) {
      dependencyDegraded = true;
      openOrdersReliable = false;
      openClobOrders = [];
    } else {
      openClobOrders = refreshedOpenOrdersStatus.value;
      openOrdersReliable = refreshedOpenOrdersStatus.source === "live";
      dependencyDegraded = dependencyDegraded || refreshedOpenOrdersStatus.degraded;
    }
    cycleContext.openOrders = openClobOrders;
    cycleContext.openOrdersReliable = openOrdersReliable;
    cycleContext.dependencyDegraded = dependencyDegraded;
    if (openClobOrders.length > 0) {
      lastNonEmptyOpenOrders = { value: openClobOrders, at: Date.now() };
    }

    // Refresh orders after fill reconciliation
    const refreshedMarketMakers = await prisma.marketMaker.findMany({
      where: {
        active: true,
        paused: false,
        market: { is: { venue: "POLYMARKET" } },
      },
      include: {
        market: true,
        orders: true,
      },
    });

    // Process each market maker
    for (const mm of refreshedMarketMakers) {
      try {
        await processMarketMaker(mm, config, refreshThreshold, result, cycleContext);
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

async function syncInventoryFromChain(
  marketMakers: Array<{
    id: string;
    yesInventory: unknown;
    noInventory: unknown;
    avgYesCost: unknown;
    avgNoCost: unknown;
    realizedPnl: unknown;
    market?: { slug?: string; clobTokenIds?: string[] | null };
  }>,
  chainPositions: DataAPIPosition[]
): Promise<void> {
  const positionMap = new Map(
    chainPositions.map((p) => [p.asset, { size: p.size, avgPrice: p.avgPrice }])
  );

  for (const mm of marketMakers) {
    const yesTokenId = mm.market?.clobTokenIds?.[0];
    const noTokenId = mm.market?.clobTokenIds?.[1];

    if (!yesTokenId || !noTokenId) {
      console.warn(
        `[MarketMaking] Missing clobTokenIds for MM ${mm.id} (${mm.market?.slug ?? "unknown"})`
      );
      continue;
    }

    const yesPos = positionMap.get(yesTokenId);
    const noPos = positionMap.get(noTokenId);

    const nextYes = yesPos?.size ?? 0;
    const nextNo = noPos?.size ?? 0;

    const driftYes = nextYes - Number(mm.yesInventory);
    const driftNo = nextNo - Number(mm.noInventory);
    await confirmPendingFillsForMarketMaker({
      mm,
      driftByOutcome: { YES: driftYes, NO: driftNo },
    });

    // CRITICAL FIX: Only check inventory drift, NOT avgCost
    // avgCost should be computed from our fill history, not from Data API
    const needsUpdate =
      Math.abs(Number(mm.yesInventory) - nextYes) > 0.0001 ||
      Math.abs(Number(mm.noInventory) - nextNo) > 0.0001;

    if (needsUpdate) {
      await prisma.marketMaker.update({
        where: { id: mm.id },
        data: {
          yesInventory: nextYes,
          noInventory: nextNo,
          // CRITICAL FIX: Don't overwrite avgCost from Data API
          // Only reset avgCost to 0 when inventory goes to 0 (position fully closed)
          ...(nextYes === 0 && { avgYesCost: 0 }),
          ...(nextNo === 0 && { avgNoCost: 0 }),
        },
      });
    }
  }
}

/**
 * Check for fills across all active orders
 * IMPORTANT: We must verify actual fills using getOrder, not just assume
 * missing orders were filled (they could be cancelled/expired)
 *
 * Chain verification: Before recording a fill, we verify the chain position
 * matches what we expect. This prevents recording phantom fills that never
 * actually settled on chain.
 */
export function verifyFillAgainstChain(
  chainPositionMap: Map<string, number> | null,
  mm: {
    yesInventory: unknown;
    noInventory: unknown;
    market?: { clobTokenIds?: string[] | null } | null;
  },
  order: { outcome: MarketOutcome; side: OrderSide },
  fillSize: number
): { verified: boolean; reason?: string } {
  if (!chainPositionMap) {
    return { verified: false, reason: "chain_data_unavailable" };
  }

  const tokenId = order.outcome === "YES"
    ? mm.market?.clobTokenIds?.[0]
    : mm.market?.clobTokenIds?.[1];

  if (!tokenId) {
    return { verified: true, reason: "no_token_id" };
  }

  const chainPosition = chainPositionMap.get(tokenId) ?? 0;
  const isBuy = order.side === "BID";
  const dbInventory = order.outcome === "YES"
    ? Number(mm.yesInventory)
    : Number(mm.noInventory);

  // For BUY fills: chain should have at least (dbInventory + fillSize) tokens
  // For SELL fills: chain should have (dbInventory - fillSize) tokens (could be 0)
  const expectedPosition = isBuy
    ? dbInventory + fillSize
    : Math.max(0, dbInventory - fillSize);

  // Allow some tolerance for rounding/timing
  const tolerance = 0.5;

  if (isBuy && chainPosition < expectedPosition - tolerance) {
    return {
      verified: false,
      reason: `BUY fill not on chain: expected >=${expectedPosition.toFixed(2)}, got ${chainPosition.toFixed(2)}`,
    };
  }

  if (!isBuy && chainPosition > expectedPosition + tolerance) {
    return {
      verified: false,
      reason: `SELL fill not on chain: expected <=${expectedPosition.toFixed(2)}, got ${chainPosition.toFixed(2)}`,
    };
  }

  return { verified: true };
}

async function checkAllFills(
  marketMakers: MarketMakerWithOrders[],
  result: MarketMakingResult,
  cycleContext: CycleContext
): Promise<void> {
  try {
    // Use cached open orders from cycle context
    const openOrders = cycleContext.openOrders;
    const openOrderIds = new Set(openOrders.map((o) => o.id));

    // Use cached chain positions for verification (used to verify fills)
    const chainPositions = cycleContext.positions;
    const chainPositionMap = chainPositions ? new Map<string, number>() : null;
    if (chainPositionMap && chainPositions) {
      for (const pos of chainPositions) {
        chainPositionMap.set(pos.asset, pos.size);
      }
    }
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
        if (order.orderId.startsWith("dry-run-")) {
          console.warn(
            `[MarketMaking] Removing dry-run order ${order.orderId} from DB tracking`
          );
          await prisma.marketMakerOrder.deleteMany({ where: { id: order.id } });
          await logQuoteAction(mm.id, "ORDER_STALE", {
            outcome: order.outcome,
            side: order.side,
            orderId: order.orderId,
            error: "Dry-run order ID",
          });
          continue;
        }

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
          await prisma.marketMakerOrder.deleteMany({ where: { id: order.id } });
          await logQuoteAction(mm.id, "ORDER_STALE", {
            outcome: order.outcome,
            side: order.side,
            orderId: order.orderId,
            error: "Order not found in CLOB API",
          });
          continue;
        }

        const orderDetails = orderResult.order;
        const statusRaw = orderDetails.status;
        if (typeof statusRaw !== "string") {
          console.warn(
            `[MarketMaking] Order ${order.orderId} returned non-string status; skipping`
          );
          continue;
        }
        const status = statusRaw.toUpperCase();
        const sizeMatched = Number(orderDetails.size_matched || 0);
        const originalSize = Number(orderDetails.original_size || order.size);
        const clobPrice = Number(orderDetails.price || order.price);
        const dbPrice = Number(order.price);
        const dbSize = Number(order.size);
        const isLive = status === "LIVE" || status === "OPEN";
        const isTerminal = status === "MATCHED" || status === "CANCELLED" || status === "CANCELED" || status === "EXPIRED";
        const previousMatched =
          order.lastMatchedSize === null || order.lastMatchedSize === undefined
            ? null
            : Number(order.lastMatchedSize);

        if (Math.abs(dbPrice - clobPrice) > 0.0001 || Math.abs(dbSize - originalSize) > 0.0001) {
          await prisma.marketMakerOrder.updateMany({
            where: { id: order.id },
            data: {
              price: clobPrice,
              size: originalSize,
            },
          });
        }

        if (previousMatched === null) {
          if (sizeMatched > 0) {
            const verification = verifyFillAgainstChain(chainPositionMap, mm, order, sizeMatched);
            if (!verification.verified && verification.reason !== "chain_data_unavailable") {
              console.warn(
                `[MarketMaking] FILL VERIFICATION FAILED for ${order.orderId}: ${verification.reason}`
              );
                await prisma.log.create({
                  data: {
                    level: "WARN",
                    category: "RECONCILE",
                    message: "Fill verification failed - CLOB reports fill but chain position mismatch",
                    metadata: {
                      orderId: order.orderId,
                      outcome: order.outcome,
                      side: order.side,
                      claimedFillSize: sizeMatched,
                      reason: verification.reason,
                      marketSlug: mm.market?.slug,
                    },
                  },
                });
            }

            const recorded = await recordPendingFillEvent({
              marketMakerId: mm.id,
              orderId: order.orderId,
              outcome: order.outcome === "YES" ? "YES" : "NO",
              side: order.side === "BID" ? "BUY" : "SELL",
              price: clobPrice,
              size: sizeMatched,
              matchedTotal: sizeMatched,
              source: "poller",
              metadata: {
                verification: verification.verified ? "ok" : verification.reason,
                status,
                originalSize,
              },
            });
            if (recorded) {
              result.fillsProcessed++;
            }
          }

          await prisma.marketMakerOrder.updateMany({
            where: { id: order.id },
            data: { lastMatchedSize: sizeMatched },
          });

          if (isTerminal) {
            console.log(
              `[MarketMaking] Order ${order.orderId} ${status.toLowerCase()} before baseline`
            );
            await prisma.marketMakerOrder.deleteMany({ where: { id: order.id } });
            await logQuoteAction(mm.id, "ORDER_CANCELLED", {
              outcome: order.outcome,
              side: order.side,
              orderId: order.orderId,
              status,
              note: "Baseline before processing partial fills",
            });
          }
          continue;
        }

        if (sizeMatched > previousMatched) {
          const deltaMatched = sizeMatched - previousMatched;
          const verification = verifyFillAgainstChain(chainPositionMap, mm, order, deltaMatched);

          const recorded = await recordPendingFillEvent({
            marketMakerId: mm.id,
            orderId: order.orderId,
            outcome: order.outcome === "YES" ? "YES" : "NO",
            side: order.side === "BID" ? "BUY" : "SELL",
            price: clobPrice,
            size: deltaMatched,
            matchedTotal: sizeMatched,
            source: "poller",
            metadata: {
              verification: verification.verified ? "ok" : verification.reason,
              status,
              originalSize,
              previousMatched,
            },
          });
          if (recorded) {
            result.fillsProcessed++;
          }

          if (!verification.verified && verification.reason !== "chain_data_unavailable") {
            console.warn(
              `[MarketMaking] FILL VERIFICATION FAILED for ${order.orderId}: ${verification.reason}`
            );
            await prisma.log.create({
              data: {
                level: "WARN",
                category: "RECONCILE",
                message: "Fill verification failed - CLOB reports fill but chain position mismatch",
                metadata: {
                  orderId: order.orderId,
                  outcome: order.outcome,
                  side: order.side,
                  claimedFillSize: deltaMatched,
                  totalMatched: sizeMatched,
                  previousMatched,
                  reason: verification.reason,
                  marketSlug: mm.market?.slug,
                },
              },
            });
            await prisma.marketMakerOrder.updateMany({
              where: { id: order.id },
              data: { lastMatchedSize: sizeMatched },
            });
          } else {
            console.log(
              `[MarketMaking] Order ${order.orderId} filled: ${deltaMatched}/${originalSize} (total ${sizeMatched})`
            );
            await prisma.marketMakerOrder.updateMany({
              where: { id: order.id },
              data: { lastMatchedSize: sizeMatched },
            });
            if (isLive) {
              await logQuoteAction(mm.id, "PARTIAL_FILL", {
                outcome: order.outcome,
                side: order.side,
                orderId: order.orderId,
                filledSize: deltaMatched,
                totalMatched: sizeMatched,
                originalSize,
              });
            }
          }
        }

        if (isTerminal) {
          // Cancelled/expired/fully matched without any fills - delete record
          if (sizeMatched > 0 && sizeMatched > previousMatched) {
            // Already processed delta above, but keep log context for terminal close
            console.log(
              `[MarketMaking] Order ${order.orderId} ${status.toLowerCase()} after fills`
            );
          } else {
            console.log(`[MarketMaking] Order ${order.orderId} ${status.toLowerCase()} (no fills)`);
          }
          await prisma.marketMakerOrder.deleteMany({ where: { id: order.id } });
          await logQuoteAction(mm.id, "ORDER_CANCELLED", {
            outcome: order.outcome,
            side: order.side,
            orderId: order.orderId,
            status,
          });
          continue;
        }

        if (isLive) {
          if (!openOrderIds.has(order.orderId)) {
            console.warn(
              `[MarketMaking] Order ${order.orderId} reported ${status} but missing from open orders; keeping record`
            );
          }
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
 * @param filledSize - Actual size that was filled (delta for partial fills)
 * @param finalizeOrder - Whether to delete the order record after processing
 */
export async function processFill(
  mm: { id: string; yesInventory: unknown; noInventory: unknown; avgYesCost: unknown; avgNoCost: unknown; realizedPnl: unknown },
  order: { id: string; orderId: string; outcome: MarketOutcome; side: OrderSide; price: unknown; size: unknown },
  result?: MarketMakingResult,
  filledSize?: number,
  finalizeOrder = true,
  updateInventory = false
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
    await prisma.marketMakerOrder.deleteMany({ where: { id: order.id } });
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

  if (updateInventory) {
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
  } else if (!isBuy) {
    // Chain-truth mode: only update realized PnL on sells
    if (isYes && yesInventory > 0) {
      fillRealizedPnl = (price - avgYesCost) * size;
      realizedPnl += fillRealizedPnl;
    } else if (!isYes && noInventory > 0) {
      fillRealizedPnl = (price - avgNoCost) * size;
      realizedPnl += fillRealizedPnl;
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
  if (updateInventory) {
    const updateData: Record<string, unknown> = {
      yesInventory,
      noInventory,
      avgYesCost,
      avgNoCost,
      realizedPnl,
    };
    if (isBuy) {
      updateData.lastQuoteAt = null;
    }
    await prisma.marketMaker.update({
      where: { id: mm.id },
      data: updateData,
    });
  } else {
    await prisma.marketMaker.update({
      where: { id: mm.id },
      data: { realizedPnl },
    });
  }

  if (finalizeOrder) {
    // Delete the filled order
    await prisma.marketMakerOrder.deleteMany({
      where: { id: order.id },
    });
  }

  // Log the fill
  await logQuoteAction(mm.id, "FILL", {
    outcome: order.outcome,
    side: isBuy ? "BUY" : "SELL",
    price,
    size,
    orderId: order.orderId,
    realizedPnl: fillRealizedPnl,
  });

  if (result) {
    result.fillsProcessed++;
  }
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
  result: MarketMakingResult,
  cycleContext: CycleContext
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

  // COMPUTE RESERVED AMOUNTS from CLOB open orders (source of truth)
  // Filter cycleContext.openOrders by this market's token IDs
  // This correctly accounts for orders that may not be in our DB
  const marketClobOrders = cycleContext.openOrders.filter(
    (o) => o.asset_id === yesTokenId || o.asset_id === noTokenId
  );

  // Also keep DB orders reference for comparison and fill tracking
  const existingOrders = mm.orders || [];
  const useDbForReserves =
    !cycleContext.openOrdersReliable && marketClobOrders.length === 0;

  // Reserved buy exposure = sum of (price * size) for all outstanding BUY orders
  // CLOB uses BUY/SELL, not BID/ASK
  const reservedBuyExposure = useDbForReserves
    ? existingOrders
        .filter((o) => o.side === "BID")
        .reduce((sum, o) => sum + Number(o.price) * Number(o.size), 0)
    : marketClobOrders
        .filter((o) => o.side === "BUY")
        .reduce((sum, o) => sum + Number(o.price) * Number(o.size), 0);

  // Reserved sell inventory per outcome = sum of size for all outstanding SELL orders
  const reservedSellYes = useDbForReserves
    ? existingOrders
        .filter((o) => o.side === "ASK" && o.outcome === "YES")
        .reduce((sum, o) => sum + Number(o.size), 0)
    : marketClobOrders
        .filter((o) => o.side === "SELL" && o.asset_id === yesTokenId)
        .reduce((sum, o) => sum + Number(o.size), 0);

  const reservedSellNo = useDbForReserves
    ? existingOrders
        .filter((o) => o.side === "ASK" && o.outcome === "NO")
        .reduce((sum, o) => sum + Number(o.size), 0)
    : marketClobOrders
        .filter((o) => o.side === "SELL" && o.asset_id === noTokenId)
        .reduce((sum, o) => sum + Number(o.size), 0);

  // Log reserved amounts for debugging
  if (reservedSellYes > 0 || reservedSellNo > 0 || reservedBuyExposure > 0) {
    console.log(`[MarketMaking] ${mm.market.slug} reserved: BUY=$${reservedBuyExposure.toFixed(2)}, SELL YES=${reservedSellYes.toFixed(2)}, NO=${reservedSellNo.toFixed(2)} (${marketClobOrders.length} CLOB orders, ${existingOrders.length} DB orders)`);
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

  const hasInventory =
    Number(mm.yesInventory) > 0 || Number(mm.noInventory) > 0;
  let reduceOnlyMode = false;
  if (cycleContext.dependencyDegraded) {
    reduceOnlyMode = true;
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
    await logSanityAlert(mm, "CHECK_1_YES_MIDPOINT", {
      midpoint: yesMidpoint,
      min: MIN_VALID_MIDPOINT,
      max: MAX_VALID_MIDPOINT,
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
    await logSanityAlert(mm, "CHECK_1_NO_MIDPOINT", {
      midpoint: noMidpoint,
      min: MIN_VALID_MIDPOINT,
      max: MAX_VALID_MIDPOINT,
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
    await logSanityAlert(mm, "CHECK_2_YES_CROSSED", {
      bestBid: yesBest.bestBid,
      bestAsk: yesBest.bestAsk,
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
    await logSanityAlert(mm, "CHECK_2_NO_CROSSED", {
      bestBid: noBest.bestBid,
      bestAsk: noBest.bestAsk,
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
    await logSanityAlert(mm, "CHECK_3_YES_SPREAD", {
      spreadTicks: yesSpreadTicks,
      maxSpreadTicks: MAX_SPREAD_TICKS,
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
    await logSanityAlert(mm, "CHECK_3_NO_SPREAD", {
      spreadTicks: noSpreadTicks,
      maxSpreadTicks: MAX_SPREAD_TICKS,
    });
    return;
  }

  // CHECK 4: Staleness - stored price must be recent
  let storedYesPrice = mm.market.yesPrice ? Number(mm.market.yesPrice) : null;
  let storedNoPrice = mm.market.noPrice ? Number(mm.market.noPrice) : null;
  const priceTimestamp = mm.market.lastUpdated ?? mm.market.updatedAt;
  let priceAgeMinutes = priceTimestamp
    ? (Date.now() - priceTimestamp.getTime()) / (1000 * 60)
    : Infinity;
  let storedPriceIsStale = priceAgeMinutes > MAX_PRICE_AGE_MINUTES;
  let skipStoredPriceChecks =
    storedPriceIsStale || storedYesPrice === null || storedNoPrice === null;

  // Refresh stale/missing stored prices using live CLOB midpoints (MM markets only)
  if (skipStoredPriceChecks) {
    try {
      await prisma.market.update({
        where: { id: mm.marketId },
        data: {
          yesPrice: yesMidpoint,
          noPrice: noMidpoint,
          spread: yesClobSpread ?? undefined,
          lastUpdated: new Date(),
        },
      });
      storedYesPrice = yesMidpoint;
      storedNoPrice = noMidpoint;
      priceAgeMinutes = 0;
      storedPriceIsStale = false;
      skipStoredPriceChecks = false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[MarketMaking] Failed to refresh stored prices for ${mm.market.slug}: ${message}`
      );
    }
  }

  if (storedPriceIsStale) {
    console.warn(
      `[MarketMaking] CHECK 4 WARN: ${mm.market.slug} stored price is ${priceAgeMinutes.toFixed(0)} min old (max ${MAX_PRICE_AGE_MINUTES}); quoting off CLOB`
    );
    await logQuoteAction(mm.id, "SANITY_CHECK_WARN", {
      error: `Stored price ${priceAgeMinutes.toFixed(0)} min old (stale data)`,
    });
    await logSanityAlert(mm, "CHECK_4_STALE_PRICE", {
      priceAgeMinutes,
      maxAgeMinutes: MAX_PRICE_AGE_MINUTES,
    });
  }

  // CHECK 5: CLOB midpoint vs stored price deviation (dynamic threshold)
  // Threshold = max(MIN_DEVIATION, 2 × spread)
  const yesDynamicDeviation = Math.max(
    MIN_MIDPOINT_DEVIATION,
    yesClobSpread !== null
      ? DEVIATION_MULTIPLIER * yesClobSpread
      : MIN_MIDPOINT_DEVIATION
  );

  if (!skipStoredPriceChecks) {
    if (storedYesPrice !== null && storedYesPrice > 0) {
      const deviation = Math.abs(yesMidpoint - storedYesPrice);
      if (deviation > yesDynamicDeviation) {
        console.error(
          `[MarketMaking] CHECK 5 FAILED: ${mm.market.slug} YES CLOB mid=${yesMidpoint.toFixed(3)} ` +
            `deviates ${(deviation * 100).toFixed(1)}¢ from stored=${storedYesPrice.toFixed(3)}. ` +
            `Max allowed: ${(yesDynamicDeviation * 100).toFixed(1)}¢ (dynamic). REFUSING TO QUOTE.`
        );
        await logQuoteAction(mm.id, "SANITY_CHECK_FAILED", {
          error: `YES CLOB mid ${yesMidpoint.toFixed(3)} deviates ${(deviation * 100).toFixed(1)}¢ from stored ${storedYesPrice.toFixed(3)} (max ${(yesDynamicDeviation * 100).toFixed(1)}¢)`,
          reduceOnlyBypass: hasInventory,
        });
        await logSanityAlert(mm, "CHECK_5_YES_DEVIATION", {
          clobMid: yesMidpoint,
          storedPrice: storedYesPrice,
          deviation,
          maxDeviation: yesDynamicDeviation,
          reduceOnlyBypass: hasInventory,
        });
        if (!hasInventory) return;
        reduceOnlyMode = true;
      }
      if (deviation > MIN_MIDPOINT_DEVIATION) {
        console.warn(
          `[MarketMaking] Price deviation warning: ${mm.market.slug} YES CLOB=${yesMidpoint.toFixed(3)} stored=${storedYesPrice.toFixed(3)} (${(deviation * 100).toFixed(1)}¢ diff)`
        );
      }
    } else {
      console.error(
        `[MarketMaking] CHECK 5 FAILED: ${mm.market.slug} no stored yesPrice to cross-check CLOB mid=${yesMidpoint.toFixed(3)}`
      );
      await logQuoteAction(mm.id, "SANITY_CHECK_FAILED", {
        error: `No stored YES price to cross-check CLOB midpoint`,
        reduceOnlyBypass: hasInventory,
      });
      await logSanityAlert(mm, "CHECK_5_YES_MISSING_STORED", {
        clobMid: yesMidpoint,
        reduceOnlyBypass: hasInventory,
      });
      if (!hasInventory) return;
      reduceOnlyMode = true;
    }
  }

  const noDynamicDeviation = Math.max(
    MIN_MIDPOINT_DEVIATION,
    noClobSpread !== null
      ? DEVIATION_MULTIPLIER * noClobSpread
      : MIN_MIDPOINT_DEVIATION
  );

  if (!skipStoredPriceChecks) {
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
          reduceOnlyBypass: hasInventory,
        });
        await logSanityAlert(mm, "CHECK_5_NO_DEVIATION", {
          clobMid: noMidpoint,
          storedPrice: storedNoPrice,
          deviation,
          maxDeviation: noDynamicDeviation,
          reduceOnlyBypass: hasInventory,
        });
        if (!hasInventory) return;
        reduceOnlyMode = true;
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
        reduceOnlyBypass: hasInventory,
      });
      await logSanityAlert(mm, "CHECK_5_NO_MISSING_STORED", {
        clobMid: noMidpoint,
        reduceOnlyBypass: hasInventory,
      });
      if (!hasInventory) return;
      reduceOnlyMode = true;
    }
  }

  // Use validated CLOB midpoint
  const currentYesMidPrice = yesMidpoint;
  const currentNoMidPrice = noMidpoint;

  // Check if we need to refresh quotes
  const timeSinceLastQuote = mm.lastQuoteAt
    ? Date.now() - mm.lastQuoteAt.getTime()
    : Infinity;

  // Use CLOB orders (source of truth) to check if we have all expected orders.
  // Count-based checks break for tiered quoting and can hide missing asks.
  const maxInventory = Number(mm.maxInventory);
  const yesInvNorm = maxInventory > 0 ? Number(mm.yesInventory) / maxInventory : 0;
  const noInvNorm = maxInventory > 0 ? Number(mm.noInventory) / maxInventory : 0;
  const orderSize = Number(mm.orderSize);
  const needsYesBid = !reduceOnlyMode && yesInvNorm < 0.9 && orderSize >= MIN_ORDER_SIZE;
  const needsNoBid = !reduceOnlyMode && noInvNorm < 0.9 && orderSize >= MIN_ORDER_SIZE;
  const needsYesAsk = Number(mm.yesInventory) >= MIN_ORDER_SIZE;
  const needsNoAsk = Number(mm.noInventory) >= MIN_ORDER_SIZE;

  const hasYesBidClob = marketClobOrders.some(
    (o) => o.side === "BUY" && o.asset_id === yesTokenId
  );
  const hasYesAskClob = marketClobOrders.some(
    (o) => o.side === "SELL" && o.asset_id === yesTokenId
  );
  const hasNoBidClob = marketClobOrders.some(
    (o) => o.side === "BUY" && o.asset_id === noTokenId
  );
  const hasNoAskClob = marketClobOrders.some(
    (o) => o.side === "SELL" && o.asset_id === noTokenId
  );

  const hasYesBidDb = existingOrders.some(
    (o) => o.outcome === "YES" && o.side === "BID"
  );
  const hasYesAskDb = existingOrders.some(
    (o) => o.outcome === "YES" && o.side === "ASK"
  );
  const hasNoBidDb = existingOrders.some(
    (o) => o.outcome === "NO" && o.side === "BID"
  );
  const hasNoAskDb = existingOrders.some(
    (o) => o.outcome === "NO" && o.side === "ASK"
  );

  const hasAllOrdersClob = cycleContext.openOrdersReliable
    ? (!needsYesBid || hasYesBidClob) &&
      (!needsYesAsk || hasYesAskClob) &&
      (!needsNoBid || hasNoBidClob) &&
      (!needsNoAsk || hasNoAskClob)
    : true;
  const hasAllOrdersDb =
    (!needsYesBid || hasYesBidDb) &&
    (!needsYesAsk || hasYesAskDb) &&
    (!needsNoBid || hasNoBidDb) &&
    (!needsNoAsk || hasNoAskDb);
  const hasAllOrders = hasAllOrdersClob && hasAllOrdersDb;

  if (!hasAllOrders) {
    const missing: string[] = [];
    if (needsYesBid && (!hasYesBidClob || !hasYesBidDb)) {
      missing.push(
        `YES_BID${cycleContext.openOrdersReliable && !hasYesBidClob ? "_CLOB" : ""}` +
        `${hasYesBidDb ? "" : "_DB"}`
      );
    }
    if (needsYesAsk && (!hasYesAskClob || !hasYesAskDb)) {
      missing.push(
        `YES_ASK${cycleContext.openOrdersReliable && !hasYesAskClob ? "_CLOB" : ""}` +
        `${hasYesAskDb ? "" : "_DB"}`
      );
    }
    if (needsNoBid && (!hasNoBidClob || !hasNoBidDb)) {
      missing.push(
        `NO_BID${cycleContext.openOrdersReliable && !hasNoBidClob ? "_CLOB" : ""}` +
        `${hasNoBidDb ? "" : "_DB"}`
      );
    }
    if (needsNoAsk && (!hasNoAskClob || !hasNoAskDb)) {
      missing.push(
        `NO_ASK${cycleContext.openOrdersReliable && !hasNoAskClob ? "_CLOB" : ""}` +
        `${hasNoAskDb ? "" : "_DB"}`
      );
    }
    if (missing.length > 0) {
      console.warn(
        `[MarketMaking] ${mm.market.slug} missing expected orders: ${missing.join(", ")}`
      );
    }
  }

  const previousMidPrice = storedYesPrice ?? 0.5;
  const configChanged =
    mm.updatedAt &&
    (!mm.lastQuoteAt || mm.updatedAt.getTime() > mm.lastQuoteAt.getTime());

  const bidTicksRaw = mm.bidOffsetTicks;
  const bidTicksValue =
    bidTicksRaw === null || bidTicksRaw === undefined ? null : Number(bidTicksRaw);
  const bidTicks = Number.isFinite(bidTicksValue ?? NaN) ? bidTicksValue : null;
  const askTicksRaw = mm.askOffsetTicks;
  const askTicksValue =
    askTicksRaw === null || askTicksRaw === undefined ? null : Number(askTicksRaw);
  const askTicks = Number.isFinite(askTicksValue ?? NaN) ? askTicksValue : null;

  const offsetsConfigured = bidTicks !== null || askTicks !== null;

  const offsetsNeedsRefresh = (() => {
    if (!offsetsConfigured) return false;
    const yesBidExpected =
      bidTicks !== null && yesBest.bestBid !== null
        ? yesBest.bestBid - bidTicks * TICK_SIZE
        : null;
    const noBidExpected =
      bidTicks !== null && noBest.bestBid !== null
        ? noBest.bestBid - bidTicks * TICK_SIZE
        : null;
    const yesAskExpected =
      askTicks !== null && yesBest.bestAsk !== null
        ? yesBest.bestAsk + askTicks * TICK_SIZE
        : null;
    const noAskExpected =
      askTicks !== null && noBest.bestAsk !== null
        ? noBest.bestAsk + askTicks * TICK_SIZE
        : null;

    const yesBidOrder = existingOrders.find(
      (o) => o.outcome === "YES" && o.side === "BID"
    );
    const noBidOrder = existingOrders.find(
      (o) => o.outcome === "NO" && o.side === "BID"
    );
    const yesAskOrder = existingOrders.find(
      (o) => o.outcome === "YES" && o.side === "ASK"
    );
    const noAskOrder = existingOrders.find(
      (o) => o.outcome === "NO" && o.side === "ASK"
    );

    if (yesBidExpected !== null) {
      if (!yesBidOrder) return true;
      if (Math.abs(Number(yesBidOrder.price) - yesBidExpected) > 0.001) return true;
    }
    if (noBidExpected !== null) {
      if (!noBidOrder) return true;
      if (Math.abs(Number(noBidOrder.price) - noBidExpected) > 0.001) return true;
    }
    if (yesAskExpected !== null) {
      if (!yesAskOrder) return true;
      if (Math.abs(Number(yesAskOrder.price) - yesAskExpected) > 0.001) return true;
    }
    if (noAskExpected !== null) {
      if (!noAskOrder) return true;
      if (Math.abs(Number(noAskOrder.price) - noAskExpected) > 0.001) return true;
    }

    return false;
  })();

  const needsRefresh =
    configChanged ||
    offsetsNeedsRefresh ||
    (timeSinceLastQuote >= MIN_QUOTE_INTERVAL &&
      (shouldRefreshQuotes(currentYesMidPrice, previousMidPrice, refreshThreshold) ||
        !hasAllOrders));

  if (!needsRefresh) {
    return;
  }

  console.log(
    `[MarketMaking] Refreshing quotes for ${mm.market.slug}${reduceOnlyMode ? " (reduce-only bypass)" : ""}`
  );

  // Calculate new quotes for YES outcome
  let yesQuote = calculateQuotes({
    midPrice: currentYesMidPrice,
    targetSpread: Number(mm.targetSpread),
    inventory: Number(mm.yesInventory),
    skewFactor: Number(mm.skewFactor),
    orderSize: Number(mm.orderSize),
    maxInventory: Number(mm.maxInventory),
    quotingPolicy: mm.quotingPolicy as QuotingPolicy,
    bidOffsetTicks: bidTicks ?? undefined,
    askOffsetTicks: askTicks ?? undefined,
    bestBid: yesBest.bestBid ?? undefined,
    bestAsk: yesBest.bestAsk ?? undefined,
    avgCost: Number(mm.avgYesCost) || undefined,
  });

  let noQuote = calculateQuotes({
    midPrice: currentNoMidPrice,
    targetSpread: Number(mm.targetSpread),
    inventory: Number(mm.noInventory),
    skewFactor: Number(mm.skewFactor),
    orderSize: Number(mm.orderSize),
    maxInventory: Number(mm.maxInventory),
    quotingPolicy: mm.quotingPolicy as QuotingPolicy,
    bidOffsetTicks: bidTicks ?? undefined,
    askOffsetTicks: askTicks ?? undefined,
    bestBid: noBest.bestBid ?? undefined,
    bestAsk: noBest.bestAsk ?? undefined,
    avgCost: Number(mm.avgNoCost) || undefined,
  });

  if (reduceOnlyMode) {
    yesQuote = { ...yesQuote, bidSize: 0 };
    noQuote = { ...noQuote, bidSize: 0 };
  }

  if (offsetsConfigured) {
    const applyOffsets = (
      quote: Quote,
      bestBid: number | null,
      bestAsk: number | null,
      avgCost?: number
    ): Quote => {
      let bidPrice = quote.bidPrice;
      let askPrice = quote.askPrice;

      if (bidTicks !== null && bestBid !== null && Number.isFinite(bestBid)) {
        bidPrice = bestBid - bidTicks * TICK_SIZE;
      }
      if (askTicks !== null && bestAsk !== null && Number.isFinite(bestAsk)) {
        askPrice = bestAsk + askTicks * TICK_SIZE;
      }
      if (avgCost && avgCost > 0) {
        askPrice = Math.max(askPrice, avgCost + TICK_SIZE);
      }

      bidPrice = roundToTick(clampPrice(bidPrice));
      askPrice = roundToTick(clampPrice(askPrice));
      if (askPrice <= bidPrice) {
        askPrice = roundToTick(clampPrice(bidPrice + TICK_SIZE));
      }

      return { ...quote, bidPrice, askPrice };
    };

    yesQuote = applyOffsets(
      yesQuote,
      yesBest.bestBid,
      yesBest.bestAsk,
      Number(mm.avgYesCost) || undefined
    );
    noQuote = applyOffsets(
      noQuote,
      noBest.bestBid,
      noBest.bestAsk,
      Number(mm.avgNoCost) || undefined
    );
  }

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

  // For tiered quoting, calculate tiered quotes and convert to uniform format
  // For non-tiered, convert single quotes to the same format
  const isTiered = mm.quotingPolicy === "tiered" && config.mmTierCount > 1;
  let allYesQuotes: TieredQuote[] = [];
  let allNoQuotes: TieredQuote[] = [];

  if (isTiered) {
    const tierConfig = parseTierConfig(
      config.mmTierBidOffsets,
      config.mmTierAskOffsets,
      config.mmTierSizes
    );

    console.log(`[MarketMaking] ${mm.market.slug} using tiered quoting:`, tierConfig);

    // For tiered quoting, we need actual best bid/ask values
    // Fall back to mid price if not available
    const yesBestBid = yesBest.bestBid ?? currentYesMidPrice - TICK_SIZE;
    const yesBestAsk = yesBest.bestAsk ?? currentYesMidPrice + TICK_SIZE;
    const noBestBid = noBest.bestBid ?? currentNoMidPrice - TICK_SIZE;
    const noBestAsk = noBest.bestAsk ?? currentNoMidPrice + TICK_SIZE;

    allYesQuotes = calculateTieredQuotes(
      {
        midPrice: currentYesMidPrice,
        targetSpread: Number(mm.targetSpread),
        inventory: Number(mm.yesInventory),
        skewFactor: Number(mm.skewFactor),
        orderSize: Number(mm.orderSize),
        maxInventory: Number(mm.maxInventory),
        bestBid: yesBestBid,
        bestAsk: yesBestAsk,
      },
      tierConfig
    );

    allNoQuotes = calculateTieredQuotes(
      {
        midPrice: currentNoMidPrice,
        targetSpread: Number(mm.targetSpread),
        inventory: Number(mm.noInventory),
        skewFactor: Number(mm.skewFactor),
        orderSize: Number(mm.orderSize),
        maxInventory: Number(mm.maxInventory),
        bestBid: noBestBid,
        bestAsk: noBestAsk,
      },
      tierConfig
    );

    if (reduceOnlyMode) {
      allYesQuotes = allYesQuotes.filter((quote) => quote.side === "ASK");
      allNoQuotes = allNoQuotes.filter((quote) => quote.side === "ASK");
    }

    console.log(`[MarketMaking] ${mm.market.slug} YES tiered quotes:`, allYesQuotes);
    console.log(`[MarketMaking] ${mm.market.slug} NO tiered quotes:`, allNoQuotes);
  } else {
    // Convert single quotes to tiered format for uniform handling
    if (yesQuote.bidSize > 0) {
      allYesQuotes.push({ tier: 0, side: "BID", price: yesQuote.bidPrice, size: yesQuote.bidSize });
    }
    if (yesQuote.askSize > 0) {
      allYesQuotes.push({ tier: 0, side: "ASK", price: yesQuote.askPrice, size: yesQuote.askSize });
    }
    if (noQuote.bidSize > 0) {
      allNoQuotes.push({ tier: 0, side: "BID", price: noQuote.bidPrice, size: noQuote.bidSize });
    }
    if (noQuote.askSize > 0) {
      allNoQuotes.push({ tier: 0, side: "ASK", price: noQuote.askPrice, size: noQuote.askSize });
    }
  }

  // CHECK 6: Quote prices must be reasonable relative to best bid/ask
  // Don't improve the best bid/ask by more than MAX_QUOTE_IMPROVEMENT (prevents runaway quotes)
  if (!reduceOnlyMode && yesQuote.bidSize > 0 && yesBest.bestBid !== null) {
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
      await logSanityAlert(mm, "CHECK_6_YES_BID_IMPROVEMENT", {
        quotePrice: yesQuote.bidPrice,
        bestBid: yesBest.bestBid,
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
      await logSanityAlert(mm, "CHECK_6_YES_ASK_IMPROVEMENT", {
        quotePrice: yesQuote.askPrice,
        bestAsk: yesBest.bestAsk,
      });
      return;
    }
  }

  if (!reduceOnlyMode && noQuote.bidSize > 0 && noBest.bestBid !== null) {
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
      await logSanityAlert(mm, "CHECK_6_NO_BID_IMPROVEMENT", {
        quotePrice: noQuote.bidPrice,
        bestBid: noBest.bestBid,
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
      await logSanityAlert(mm, "CHECK_6_NO_ASK_IMPROVEMENT", {
        quotePrice: noQuote.askPrice,
        bestAsk: noBest.bestAsk,
      });
      return;
    }
  }

  // CHECK 7: Quote prices must be valid (0 < price < 1)
  if (!reduceOnlyMode && yesQuote.bidSize > 0 && (yesQuote.bidPrice <= 0 || yesQuote.bidPrice >= 1)) {
    console.error(
      `[MarketMaking] CHECK 7 FAILED: ${mm.market.slug} invalid bid price ${yesQuote.bidPrice.toFixed(3)}`
    );
    await logQuoteAction(mm.id, "SANITY_CHECK_FAILED", {
      error: `Invalid bid price ${yesQuote.bidPrice.toFixed(3)}`,
      side: "BID",
      price: yesQuote.bidPrice,
    });
    await logSanityAlert(mm, "CHECK_7_YES_BID_INVALID", {
      quotePrice: yesQuote.bidPrice,
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
    await logSanityAlert(mm, "CHECK_7_YES_ASK_INVALID", {
      quotePrice: yesQuote.askPrice,
    });
    return;
  }

  if (!reduceOnlyMode && noQuote.bidSize > 0 && (noQuote.bidPrice <= 0 || noQuote.bidPrice >= 1)) {
    console.error(
      `[MarketMaking] CHECK 7 FAILED: ${mm.market.slug} invalid NO bid price ${noQuote.bidPrice.toFixed(3)}`
    );
    await logQuoteAction(mm.id, "SANITY_CHECK_FAILED", {
      error: `Invalid NO bid price ${noQuote.bidPrice.toFixed(3)}`,
      side: "BID",
      price: noQuote.bidPrice,
    });
    await logSanityAlert(mm, "CHECK_7_NO_BID_INVALID", {
      quotePrice: noQuote.bidPrice,
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
    await logSanityAlert(mm, "CHECK_7_NO_ASK_INVALID", {
      quotePrice: noQuote.askPrice,
    });
    return;
  }
  if (
    !Number.isFinite(yesQuote.bidPrice) ||
    !Number.isFinite(yesQuote.askPrice) ||
    !Number.isFinite(noQuote.bidPrice) ||
    !Number.isFinite(noQuote.askPrice)
  ) {
    console.error(
      `[MarketMaking] CHECK 7 FAILED: ${mm.market.slug} NaN quote price`
    );
    await logQuoteAction(mm.id, "SANITY_CHECK_FAILED", {
      error: "NaN quote price",
    });
    await logSanityAlert(mm, "CHECK_7_NAN_PRICE", {});
    return;
  }

  // Build map of desired quotes: key = "outcome-side-tier", value = {price, size, tokenId, tier}
  const desiredQuotes = new Map<string, { price: number; size: number; tokenId: string; tier: number }>();
  const skippedQuotes: string[] = [];

  for (const quote of allYesQuotes) {
    if (quote.size >= MIN_ORDER_SIZE) {
      const key = `YES-${quote.side}-${quote.tier}`;
      desiredQuotes.set(key, { price: quote.price, size: quote.size, tokenId: yesTokenId, tier: quote.tier });
    } else if (quote.size > 0) {
      skippedQuotes.push(`YES-${quote.side}-${quote.tier}=${quote.size.toFixed(4)}`);
    }
  }
  for (const quote of allNoQuotes) {
    if (quote.size >= MIN_ORDER_SIZE) {
      const key = `NO-${quote.side}-${quote.tier}`;
      desiredQuotes.set(key, { price: quote.price, size: quote.size, tokenId: noTokenId, tier: quote.tier });
    } else if (quote.size > 0) {
      skippedQuotes.push(`NO-${quote.side}-${quote.tier}=${quote.size.toFixed(4)}`);
    }
  }

  if (skippedQuotes.length > 0) {
    console.warn(
      `[MarketMaking] ${mm.market.slug} skipping quotes below min size ${MIN_ORDER_SIZE}: ${skippedQuotes.join(", ")}`
    );
  }

  // Track which desired quotes are already satisfied by existing orders
  const satisfiedQuotes = new Set<string>();
  const ordersToCancel: typeof existingOrders = [];

  // Check existing orders against desired quotes (now includes tier in key)
  for (const order of existingOrders) {
    const tier = order.tier ?? 0;
    const key = `${order.outcome}-${order.side}-${tier}`;
    const desired = desiredQuotes.get(key);

    if (desired && Math.abs(Number(order.price) - desired.price) < 0.001) {
      // Price matches - check if size is close enough to keep for queue priority
      const sizeDiff = Math.abs(Number(order.size) - desired.size);
      const sizeRatio = desired.size > 0 ? sizeDiff / desired.size : 0;

      if (sizeRatio < 0.2) {
        // Size within 20% - keep order for queue priority
        satisfiedQuotes.add(key);
        console.log(`[MarketMaking] Keeping ${key} order at ${order.price} x ${order.size} (queue priority)`);
      } else {
        // Size changed significantly - replace order
        console.log(`[MarketMaking] Replacing ${key}: size ${order.size} → ${desired.size}`);
        ordersToCancel.push(order);
      }
    } else {
      // Price changed or quote no longer needed - cancel it
      ordersToCancel.push(order);
    }
  }

  // Cancel orders that need to be replaced
  for (const order of ordersToCancel) {
    try {
      await cancelOrder(order.orderId);
      await prisma.marketMakerOrder.deleteMany({ where: { id: order.id } });
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

  // Sync live CLOB orders into DB to prevent duplicate placements
  if (cycleContext.openOrdersReliable) {
    const existingOrderIds = new Set(existingOrders.map((order) => order.orderId));
    const clobOrdersForMarket = marketClobOrders
      .map((o) => {
        const outcome =
          o.asset_id === yesTokenId ? "YES" : o.asset_id === noTokenId ? "NO" : null;
        if (!outcome) return null;
        const side = o.side === "BUY" ? "BID" : "ASK";
        return {
          orderId: o.id,
          outcome,
          side,
          price: Number(o.price),
          size: Number(o.size),
          createdAt: o.created_at,
        };
      })
      .filter(
        (
          o
        ): o is {
          orderId: string;
          outcome: MarketOutcome;
          side: OrderSide;
          price: number;
          size: number;
          createdAt: string;
        } =>
          o !== null
      );

    const usedClobOrderIds = new Set<string>();
    const clobOrderMatchByKey = new Map<
      string,
      {
        orderId: string;
        outcome: MarketOutcome;
        side: OrderSide;
        price: number;
        size: number;
        createdAt: string;
      }
    >();
    const duplicateClobOrders: {
      orderId: string;
      outcome: MarketOutcome;
      side: OrderSide;
      price: number;
      size: number;
      createdAt: string;
    }[] = [];

    for (const [key, desired] of desiredQuotes) {
      const [outcomeRaw, sideRaw] = key.split("-");
      const outcome = toMarketOutcome(outcomeRaw);
      const side = toOrderSide(sideRaw);
      if (!outcome || !side) {
        console.warn(
          `[MarketMaking] Skipping malformed quote key ${key} for ${mm.market.slug}`
        );
        continue;
      }
      const matches = clobOrdersForMarket
        .filter(
          (o) => {
            if (usedClobOrderIds.has(o.orderId)) return false;
            if (o.outcome !== outcome || o.side !== side) return false;
            if (Math.abs(o.price - desired.price) >= 0.001) return false;
            const sizeDiff = Math.abs(o.size - desired.size);
            const sizeRatio = desired.size > 0 ? sizeDiff / desired.size : 0;
            return sizeRatio < 0.2;
          }
        )
        .sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );

      if (matches.length === 0) continue;

      const dbMatch = matches.find((o) => existingOrderIds.has(o.orderId));
      const keep = dbMatch ?? matches[0];
      clobOrderMatchByKey.set(key, keep);
      usedClobOrderIds.add(keep.orderId);

      if (matches.length > 1) {
        for (const dup of matches) {
          if (dup.orderId !== keep.orderId) duplicateClobOrders.push(dup);
        }
      }
    }

    for (const duplicate of duplicateClobOrders) {
      try {
        await cancelOrder(duplicate.orderId);
        await logQuoteAction(mm.id, "QUOTE_CANCELLED", {
          outcome: duplicate.outcome,
          side: duplicate.side,
          orderId: duplicate.orderId,
          reason: "duplicate_clob",
        });
        result.quotesCancelled++;
      } catch (e) {
        console.error(
          `[MarketMaking] Failed to cancel duplicate order ${duplicate.orderId}:`,
          e
        );
      }
    }

    const orphanClobOrders = clobOrdersForMarket.filter(
      (o) => !existingOrderIds.has(o.orderId) && !usedClobOrderIds.has(o.orderId)
    );

    if (orphanClobOrders.length > 0) {
      console.warn(
        `[MarketMaking] ${mm.market.slug} cancelling ${orphanClobOrders.length} orphan CLOB orders`
      );
    }

    for (const orphan of orphanClobOrders) {
      try {
        await cancelOrder(orphan.orderId);
        await logQuoteAction(mm.id, "QUOTE_CANCELLED", {
          outcome: orphan.outcome,
          side: orphan.side,
          orderId: orphan.orderId,
          reason: "orphan_clob",
        });
        result.quotesCancelled++;
      } catch (e) {
        console.error(
          `[MarketMaking] Failed to cancel orphan order ${orphan.orderId}:`,
          e
        );
      }
    }

    for (const [key, desired] of desiredQuotes) {
      if (satisfiedQuotes.has(key)) continue;
      const [outcomeRaw, sideRaw, tierStr] = key.split("-");
      const outcome = toMarketOutcome(outcomeRaw);
      const side = toOrderSide(sideRaw);
      if (!outcome || !side) {
        console.warn(
          `[MarketMaking] Skipping malformed quote key ${key} for ${mm.market.slug}`
        );
        continue;
      }
      const tier = Number(tierStr);

      const match = clobOrderMatchByKey.get(key);

      if (!match) continue;

      usedClobOrderIds.add(match.orderId);
      satisfiedQuotes.add(key);

      await prisma.marketMakerOrder.upsert({
        where: {
          marketMakerId_outcome_side_tier: {
            marketMakerId: mm.id,
            outcome,
            side,
            tier,
          },
        },
        update: {
          orderId: match.orderId,
          tokenId: desired.tokenId,
          price: match.price,
          size: match.size,
          lastMatchedSize: null,
          verified: true,
        },
        create: {
          marketMakerId: mm.id,
          outcome,
          side,
          tier,
          orderId: match.orderId,
          tokenId: desired.tokenId,
          price: match.price,
          size: match.size,
          lastMatchedSize: null,
          verified: true,
        },
      });

      await logQuoteAction(mm.id, "ORDER_SYNCED", {
        outcome,
        side,
        tier,
        price: match.price,
        size: match.size,
        orderId: match.orderId,
      });
    }
  }

  // Place new orders for quotes that aren't already satisfied
  for (const [key, desired] of desiredQuotes) {
    if (satisfiedQuotes.has(key)) continue;

    // Parse the key: "OUTCOME-SIDE-TIER" (e.g., "YES-BID-0", "NO-ASK-1")
    const [outcomeRaw, sideRaw, tierStr] = key.split("-");
    const outcome = toMarketOutcome(outcomeRaw);
    const side = toOrderSide(sideRaw);
    if (!outcome || !side) {
      console.warn(
        `[MarketMaking] Skipping malformed quote key ${key} for ${mm.market.slug}`
      );
      continue;
    }
    const tier = parseInt(tierStr, 10);
    const orderSide: FillSide = side === "BID" ? "BUY" : "SELL";
    const isYesOutcome = outcome === "YES";

    // PRE-ORDER GATES: Check balance/position before placing order
    if (orderSide === "BUY") {
      // BALANCE GATE: Check if we have enough USDC (with reserved exposure)
      const requiredUsdc = desired.price * desired.size;
      const totalBalance = cycleContext.balance?.balance ?? 0;
      const availableBalance = totalBalance - reservedBuyExposure;

      if (availableBalance < requiredUsdc) {
        console.warn(
          `[MarketMaking] BALANCE GATE: ${mm.market.slug} ${outcome} BID requires $${requiredUsdc.toFixed(2)}, ` +
          `available=$${availableBalance.toFixed(2)} (total=$${totalBalance.toFixed(2)}, reserved=$${reservedBuyExposure.toFixed(2)})`
        );
        await logQuoteAction(mm.id, "INSUFFICIENT_BALANCE", {
          outcome,
          side,
          tier,
          requiredUsdc,
          totalBalance,
          reserved: reservedBuyExposure,
          available: availableBalance,
        });
        continue;
      }
    } else {
      // POSITION GATE: Check if we have enough inventory to sell (with reserved sells)
      const dbInventory = isYesOutcome ? Number(mm.yesInventory) : Number(mm.noInventory);
      const reserved = isYesOutcome ? reservedSellYes : reservedSellNo;
      const availableInventory = dbInventory - reserved;

      // Allow some tolerance (90%) to account for rounding
      if (availableInventory < desired.size * 0.9) {
        console.warn(
          `[MarketMaking] POSITION GATE: ${mm.market.slug} ${outcome} ASK requires ${desired.size.toFixed(2)}, ` +
          `available=${availableInventory.toFixed(2)} (inventory=${dbInventory.toFixed(2)}, reserved=${reserved.toFixed(2)})`
        );
        await logQuoteAction(mm.id, "INSUFFICIENT_POSITION", {
          outcome,
          side,
          tier,
          required: desired.size,
          dbInventory,
          reserved,
          available: availableInventory,
        });
        continue;
      }
    }

    const orderResult = await placeOrder({
      tokenId: desired.tokenId,
      side: orderSide,
      price: desired.price,
      size: desired.size,
      orderType: "GTC",
      postOnly: true,
    });

    if (orderResult.success && orderResult.orderId) {
      // ORDER PLACEMENT VERIFICATION GATE
      // Verify order exists in CLOB before trusting it
      let verified = false;
      let verificationResult: Awaited<ReturnType<typeof getOrder>> | null = null;
      let lastVerificationStatus: string | null = null;
      let lastVerificationMessage: string | null = null;

      for (let attempt = 0; attempt < ORDER_VERIFICATION_RETRIES; attempt++) {
        if (attempt > 0) {
          await sleep(ORDER_VERIFICATION_BACKOFF_MS * attempt);
        }
        verificationResult = await getOrder(orderResult.orderId);
        lastVerificationStatus = verificationResult.status;
        if (verificationResult.status === "error") {
          lastVerificationMessage = verificationResult.message;
        }
        if (verificationResult.status === "ok") {
          verified = true;
          break;
        }
      }

      if (!verified) {
        console.warn(
          `[MarketMaking] Verification failed for order ${orderResult.orderId} (${mm.market.slug} ${outcome} ${side}) status=${lastVerificationStatus} message=${lastVerificationMessage ?? "n/a"}`
        );
        await logQuoteAction(mm.id, "VERIFICATION_FAILED", {
          gate: "order_placement",
          orderId: orderResult.orderId,
          outcome,
          side,
          tier,
          price: desired.price,
          size: desired.size,
          attempts: ORDER_VERIFICATION_RETRIES,
          status: lastVerificationStatus ?? undefined,
          message: lastVerificationMessage ?? undefined,
        });
        await prisma.marketMakerOrder.upsert({
          where: {
            marketMakerId_outcome_side_tier: {
              marketMakerId: mm.id,
              outcome,
              side,
              tier,
            },
          },
          update: {
            orderId: orderResult.orderId,
            tokenId: desired.tokenId,
            price: desired.price,
            size: desired.size,
            lastMatchedSize: null,
            verified: false,
          },
          create: {
            marketMakerId: mm.id,
            outcome,
            side,
            tier,
            orderId: orderResult.orderId,
            tokenId: desired.tokenId,
            price: desired.price,
            size: desired.size,
            lastMatchedSize: null,
            verified: false,
          },
        });
        result.quotesPlaced++;
        await logQuoteAction(mm.id, "QUOTE_PLACED", {
          outcome,
          side,
          tier,
          price: desired.price,
          size: desired.size,
          orderId: orderResult.orderId,
          verified: false,
          reason: "unverified",
        });
        continue;
      }

      // Verified - use values from CLOB verification
      // Type guard: verified is true only when verificationResult.status === "ok"
      if (verificationResult?.status !== "ok" || !verificationResult.order) {
        // This shouldn't happen, but TypeScript needs the check
        continue;
      }
      const verifiedOrder = verificationResult.order;
      await prisma.marketMakerOrder.upsert({
        where: {
          marketMakerId_outcome_side_tier: {
            marketMakerId: mm.id,
            outcome,
            side,
            tier,
          },
        },
        update: {
          orderId: orderResult.orderId,
          tokenId: desired.tokenId,
          price: Number(verifiedOrder.price),
          size: Number(verifiedOrder.original_size),
          lastMatchedSize: Number(verifiedOrder.size_matched || 0),
          verified: true,
        },
        create: {
          marketMakerId: mm.id,
          outcome,
          side,
          tier,
          orderId: orderResult.orderId,
          tokenId: desired.tokenId,
          price: Number(verifiedOrder.price),
          size: Number(verifiedOrder.original_size),
          lastMatchedSize: Number(verifiedOrder.size_matched || 0),
          verified: true,
        },
      });
      result.quotesPlaced++;
      await logQuoteAction(mm.id, "QUOTE_PLACED", {
        outcome,
        side,
        tier,
        price: Number(verifiedOrder.price),
        size: Number(verifiedOrder.original_size),
        orderId: orderResult.orderId,
        verified: true,
      });
    } else {
      const error = orderResult.error ?? "unknown_error";
      console.warn(
        `[MarketMaking] Order failed for ${mm.market.slug} ${outcome} ${side}: ${error}`
      );
      await logQuoteAction(mm.id, "ORDER_FAILED", {
        outcome,
        side,
        tier,
        price: desired.price,
        size: desired.size,
        error,
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
  orders: Array<{ id: string; orderId: string; outcome: MarketOutcome; side: OrderSide }>,
  result: MarketMakingResult
): Promise<void> {
  for (const order of orders) {
    try {
      await cancelOrder(order.orderId);
      await prisma.marketMakerOrder.deleteMany({ where: { id: order.id } });
      result.quotesCancelled++;
    } catch (e) {
      console.error(`[MarketMaking] Failed to cancel order ${order.orderId}:`, e);
    }
  }
}

/**
 * Log a quote action to the history table
 */
export async function logQuoteAction(
  marketMakerId: string,
  action: string,
  data: {
    outcome?: MarketOutcome;
    side?: QuoteSide;
    tier?: number;
    price?: number;
    size?: number;
    orderId?: string;
    error?: string;
    reason?: string;
    realizedPnl?: number | null;
    status?: string;
    filledSize?: number;
    [key: string]: unknown;
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

async function logSanityAlert(
  mm: { id: string; market?: { slug?: string | null } | null },
  reason: string,
  metadata: Record<string, unknown>
): Promise<void> {
  const key = `${mm.id}:${reason}`;
  const last = sanityAlertLast.get(key) ?? 0;
  const now = Date.now();
  if (now - last < SANITY_ALERT_COOLDOWN_MS) return;
  sanityAlertLast.set(key, now);

  await prisma.log.create({
    data: {
      level: "WARN",
      category: "MARKET_MAKING",
      message: `Sanity check failed for ${mm.market?.slug ?? mm.id}`,
      metadata: {
        reason,
        ...metadata,
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

/**
 * Reconciliation result for a single market
 */
interface ReconciliationDrift {
  marketId: string;
  slug: string;
  outcome: MarketOutcome;
  dbInventory: number;
  chainPosition: number;
  drift: number;
  driftPercent: number;
}

/**
 * Reconcile DB inventory against on-chain positions
 *
 * Compares what we think we have (DB) vs what's actually on-chain (Data API).
 * If drift exceeds threshold, logs warning and optionally pauses MM.
 *
 * @param driftThreshold - Max allowed drift as percentage (default 0.10 = 10%)
 * @param pauseOnDrift - Whether to pause MM if drift exceeds threshold (default true)
 */
export async function reconcileInventory(
  driftThreshold = 0.10,
  pauseOnDrift = true
): Promise<{ drifts: ReconciliationDrift[]; paused: boolean }> {
  console.log("[Reconciliation] Starting inventory reconciliation...");

  const drifts: ReconciliationDrift[] = [];
  let shouldPause = false;

  try {
    // Fetch on-chain positions from Polymarket Data API
    const chainPositions = await getPositions();
    if (!chainPositions) {
      console.error("[Reconciliation] Data API unavailable");
      return { drifts: [], paused: false };
    }

    if (chainPositions.length === 0) {
      console.log("[Reconciliation] No on-chain positions found");
    }

    // Build a map of tokenId -> chain position size
    const chainPositionMap = new Map<string, number>();
    for (const pos of chainPositions) {
      chainPositionMap.set(pos.asset, pos.size);
    }

    // Get all active market makers with their markets
    const marketMakers = await prisma.marketMaker.findMany({
      where: { active: true, market: { is: { venue: "POLYMARKET" } } },
      include: { market: true },
    });

    for (const mm of marketMakers) {
      const yesTokenId = mm.market.clobTokenIds[0];
      const noTokenId = mm.market.clobTokenIds[1];

      // Check YES inventory
      if (yesTokenId) {
        const dbInventory = Number(mm.yesInventory);
        const chainPosition = chainPositionMap.get(yesTokenId) ?? 0;
        const drift = Math.abs(dbInventory - chainPosition);
        const driftPercent = dbInventory > 0 ? drift / dbInventory : (chainPosition > 0 ? 1 : 0);

        if (drift > 0.01 || driftPercent > driftThreshold) {
          drifts.push({
            marketId: mm.marketId,
            slug: mm.market.slug,
            outcome: "YES",
            dbInventory,
            chainPosition,
            drift,
            driftPercent,
          });

          if (driftPercent > driftThreshold) {
            console.error(
              `[Reconciliation] DRIFT DETECTED: ${mm.market.slug} YES - DB: ${dbInventory.toFixed(2)}, Chain: ${chainPosition.toFixed(2)}, Drift: ${(driftPercent * 100).toFixed(1)}%`
            );
            shouldPause = true;
          }
        }
      }

      // Check NO inventory
      if (noTokenId) {
        const dbInventory = Number(mm.noInventory);
        const chainPosition = chainPositionMap.get(noTokenId) ?? 0;
        const drift = Math.abs(dbInventory - chainPosition);
        const driftPercent = dbInventory > 0 ? drift / dbInventory : (chainPosition > 0 ? 1 : 0);

        if (drift > 0.01 || driftPercent > driftThreshold) {
          drifts.push({
            marketId: mm.marketId,
            slug: mm.market.slug,
            outcome: "NO",
            dbInventory,
            chainPosition,
            drift,
            driftPercent,
          });

          if (driftPercent > driftThreshold) {
            console.error(
              `[Reconciliation] DRIFT DETECTED: ${mm.market.slug} NO - DB: ${dbInventory.toFixed(2)}, Chain: ${chainPosition.toFixed(2)}, Drift: ${(driftPercent * 100).toFixed(1)}%`
            );
            shouldPause = true;
          }
        }
      }
    }

    // Pause MM if drift exceeds threshold
    if (shouldPause && pauseOnDrift) {
      console.error("[Reconciliation] Pausing all market makers due to inventory drift");
      await prisma.marketMaker.updateMany({
        where: { active: true },
        data: { paused: true },
      });

      // Log to quote history
      for (const drift of drifts.filter(d => d.driftPercent > driftThreshold)) {
        const mm = marketMakers.find(m => m.marketId === drift.marketId);
        if (mm) {
          await prisma.quoteHistory.create({
            data: {
              marketMakerId: mm.id,
              action: "DRIFT_PAUSE",
              outcome: drift.outcome,
              metadata: {
                dbInventory: drift.dbInventory,
                chainPosition: drift.chainPosition,
                drift: drift.drift,
                driftPercent: drift.driftPercent,
              },
            },
          });
        }
      }
    }

    if (drifts.length === 0) {
      console.log("[Reconciliation] All inventories match on-chain positions");
    } else {
      console.log(`[Reconciliation] Found ${drifts.length} inventory discrepancies`);
    }

    return { drifts, paused: shouldPause && pauseOnDrift };
  } catch (error) {
    console.error("[Reconciliation] Error during reconciliation:", error);
    return { drifts: [], paused: false };
  }
}
