/**
 * Data Integrity Service
 *
 * Ensures DB state matches external sources of truth:
 * 1. CLOB API - Active orders
 * 2. Data API - On-chain positions
 *
 * Core Principle: External APIs are truth, DB is a cache.
 * Any discrepancy triggers auto-correction.
 */

import { prisma } from "../lib/db.js";
import {
  confirmPendingFillsForMarketMaker,
  recordPendingFillEvent,
} from "../lib/fill-events.js";
import {
  configureCLOB,
  fetchActiveOrders,
  getOrder,
  getPositions,
  cancelOrder,
  type DataAPIPosition,
} from "@favored/shared";

const DEPENDENCY_FAILURE_THRESHOLD = Number(
  process.env.DI_DEPENDENCY_FAILURE_THRESHOLD ?? 3
);
let clobFailureStreak = 0;
let dataApiFailureStreak = 0;

async function getTrackedTokenIds(): Promise<Set<string>> {
  const marketMakers = await prisma.marketMaker.findMany({
    include: { market: { select: { clobTokenIds: true } } },
  });

  const trackedTokenIds = new Set<string>();
  for (const mm of marketMakers) {
    const tokens = mm.market?.clobTokenIds || [];
    for (const token of tokens) {
      if (token) trackedTokenIds.add(token);
    }
  }

  return trackedTokenIds;
}

// ============================================================================
// TYPES
// ============================================================================

export interface SyncResult {
  success: boolean;
  timestamp: Date;
  duration: number;

  // Order sync
  ordersInClob: number;
  ordersInDb: number;
  ordersAdded: number;
  ordersRemoved: number;
  ordersMismatched: number;

  // Position sync
  positionsInChain: number;
  positionsInDb: number;
  positionsCorrected: number;

  // P&L verification
  pnlVerified: boolean;
  pnlDiscrepancy: number | null;

  // Issues found
  issues: SyncIssue[];
}

export interface SyncIssue {
  type:
    | "ORDER_IN_CLOB_NOT_DB"
    | "ORDER_IN_DB_NOT_CLOB"
    | "ORDER_MISMATCH"
    | "POSITION_DRIFT"
    | "POSITION_MISSING"
    | "PNL_MISMATCH"
    | "ORPHAN_ORDER"
    | "UNKNOWN_TOKEN"
    | "DATA_API_UNAVAILABLE"
    | "CLOB_UNAVAILABLE";
  severity: "INFO" | "WARN" | "ERROR" | "CRITICAL";
  marketId?: string;
  marketSlug?: string;
  details: Record<string, unknown>;
  action: "CORRECTED" | "LOGGED" | "REQUIRES_MANUAL";
}

// ============================================================================
// FULL SYNC - Complete reconciliation against external sources
// ============================================================================

/**
 * Perform a full sync of DB against external sources of truth.
 * This is the authoritative reconciliation - it CORRECTS the DB.
 *
 * @param autoCorrect - If true, automatically fix discrepancies. If false, only report.
 * @param verbose - If true, log detailed progress
 */
export async function fullSync(
  autoCorrect = true,
  verbose = true
): Promise<SyncResult> {
  const startTime = Date.now();
  const issues: SyncIssue[] = [];

  const result: SyncResult = {
    success: false,
    timestamp: new Date(),
    duration: 0,
    ordersInClob: 0,
    ordersInDb: 0,
    ordersAdded: 0,
    ordersRemoved: 0,
    ordersMismatched: 0,
    positionsInChain: 0,
    positionsInDb: 0,
    positionsCorrected: 0,
    pnlVerified: false,
    pnlDiscrepancy: null,
    issues: [],
  };

  try {
    if (verbose) console.log("[DataIntegrity] Starting full sync...");
    configureCLOB({ dryRun: false });

    // Step 1: Sync orders (CLOB → DB)
    await syncOrders(result, issues, autoCorrect, verbose);

    // Step 2: Sync positions (Data API → DB)
    await syncPositions(result, issues, autoCorrect, verbose);

    // Step 3: Verify P&L calculations
    await verifyPnL(result, issues, verbose);

    result.success = true;
  } catch (error) {
    console.error("[DataIntegrity] Full sync failed:", error);
    issues.push({
      type: "ORPHAN_ORDER",
      severity: "CRITICAL",
      details: {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      action: "LOGGED",
    });
  }

  result.duration = Date.now() - startTime;
  result.issues = issues;

  // Log summary
  if (verbose) {
    console.log("[DataIntegrity] Sync complete:", {
      duration: `${result.duration}ms`,
      ordersInClob: result.ordersInClob,
      ordersInDb: result.ordersInDb,
      ordersAdded: result.ordersAdded,
      ordersRemoved: result.ordersRemoved,
      positionsCorrected: result.positionsCorrected,
      issues: issues.length,
    });
  }

  // Persist sync result to logs
  await prisma.log.create({
    data: {
      level: result.success ? "INFO" : "ERROR",
      category: "RECONCILE",
      message: `Full sync completed: ${issues.length} issues found`,
      metadata: {
        duration: result.duration,
        ordersInClob: result.ordersInClob,
        ordersInDb: result.ordersInDb,
        ordersRemoved: result.ordersRemoved,
        ordersMismatched: result.ordersMismatched,
        positionsCorrected: result.positionsCorrected,
        issueCount: issues.length,
        // Store issues as serializable array
        issues: issues.slice(0, 20).map((i) => ({
          type: i.type,
          severity: i.severity,
          marketSlug: i.marketSlug,
          action: i.action,
        })),
      },
    },
  });

  return result;
}

// ============================================================================
// ORDER SYNC - CLOB is source of truth for orders
// ============================================================================

async function syncOrders(
  result: SyncResult,
  issues: SyncIssue[],
  autoCorrect: boolean,
  verbose: boolean
): Promise<void> {
  if (verbose) console.log("[DataIntegrity] Syncing orders from CLOB...");

  // 1. Fetch ALL open orders from CLOB
  const clobOrdersResult = await fetchActiveOrders();
  if (!clobOrdersResult) {
    clobFailureStreak += 1;
    issues.push({
      type: "CLOB_UNAVAILABLE",
      severity: "CRITICAL",
      details: { reason: "fetchActiveOrders_failed" },
      action: "REQUIRES_MANUAL",
    });
    console.error(
      `[DataIntegrity] CLOB open orders unavailable ` +
      `(streak ${clobFailureStreak}/${DEPENDENCY_FAILURE_THRESHOLD})`
    );
    if (clobFailureStreak >= DEPENDENCY_FAILURE_THRESHOLD) {
      console.error(
        "[DataIntegrity] CLOB open orders unavailable; skipping sync without pausing"
      );
    }
    return;
  }
  clobFailureStreak = 0;

  const trackedTokenIds = await getTrackedTokenIds();
  const clobOrders = clobOrdersResult.filter((o) =>
    trackedTokenIds.has(o.asset_id)
  );
  result.ordersInClob = clobOrders.length;

  if (verbose) console.log(`[DataIntegrity] Found ${clobOrders.length} orders in CLOB`);

  // 2. Fetch all tracked orders from DB
  const dbOrders = await prisma.marketMakerOrder.findMany({
    include: {
      marketMaker: {
        include: {
          market: {
            select: { slug: true, clobTokenIds: true },
          },
        },
      },
    },
  });
  result.ordersInDb = dbOrders.length;

  if (verbose) console.log(`[DataIntegrity] Found ${dbOrders.length} orders in DB`);

  // Build maps for comparison
  const clobOrderMap = new Map(clobOrders.map((o) => [o.id, o]));
  const dbOrderMap = new Map(dbOrders.map((o) => [o.orderId, o]));

  // 3. Check for orders in CLOB but not in DB (orphan orders)
  for (const [orderId, clobOrder] of clobOrderMap) {
    if (!dbOrderMap.has(orderId)) {
      // This order exists in CLOB but we're not tracking it
      // Could be from manual trading or a DB write failure
      issues.push({
        type: "ORDER_IN_CLOB_NOT_DB",
        severity: "WARN",
        details: {
          orderId,
          tokenId: clobOrder.asset_id,
          side: clobOrder.side,
          price: clobOrder.price,
          size: clobOrder.size,
        },
        action: "LOGGED",
      });

      // For now, we don't auto-add orphan orders to tracking
      // They could be from other systems/manual trades
      if (verbose) {
        console.warn(`[DataIntegrity] ORPHAN ORDER in CLOB: ${orderId}`);
      }
    }
  }

  // 4. Check for orders in DB but not in CLOB (stale records)
  for (const dbOrder of dbOrders) {
    const clobOrder = clobOrderMap.get(dbOrder.orderId);

    if (!clobOrder) {
      // Order is in DB but not in CLOB - could be filled, cancelled, or expired
      // Verify with getOrder to check status
      if (dbOrder.orderId.startsWith("dry-run-")) {
        issues.push({
          type: "ORDER_IN_DB_NOT_CLOB",
          severity: "INFO",
          marketSlug: dbOrder.marketMaker?.market?.slug,
          details: {
            orderId: dbOrder.orderId,
            outcome: dbOrder.outcome,
            side: dbOrder.side,
            price: Number(dbOrder.price),
            size: Number(dbOrder.size),
            reason: "dry_run_order_id",
          },
          action: autoCorrect ? "CORRECTED" : "LOGGED",
        });

        if (autoCorrect) {
          const removed = await prisma.marketMakerOrder.deleteMany({
            where: { id: dbOrder.id },
          });
          if (removed.count > 0) {
            result.ordersRemoved += removed.count;
          }
        }
        continue;
      }

      const orderStatus = await getOrder(dbOrder.orderId);

      if (orderStatus.status === "not_found") {
        // Order truly doesn't exist - remove from DB
        issues.push({
          type: "ORDER_IN_DB_NOT_CLOB",
          severity: "WARN",
          marketSlug: dbOrder.marketMaker?.market?.slug,
          details: {
            orderId: dbOrder.orderId,
            outcome: dbOrder.outcome,
            side: dbOrder.side,
            price: Number(dbOrder.price),
            size: Number(dbOrder.size),
            reason: "not_found_in_clob",
          },
          action: autoCorrect ? "CORRECTED" : "LOGGED",
        });

        if (autoCorrect) {
          const removed = await prisma.marketMakerOrder.deleteMany({
            where: { id: dbOrder.id },
          });
          if (removed.count > 0) {
            result.ordersRemoved += removed.count;
            if (verbose) {
              console.log(`[DataIntegrity] Removed stale order ${dbOrder.orderId}`);
            }
          }
        }
      } else if (orderStatus.status === "ok" && orderStatus.order) {
        const statusRaw = orderStatus.order.status;
        if (typeof statusRaw !== "string") {
          console.warn(
            `[DataIntegrity] Order ${dbOrder.orderId} returned non-string status; skipping`
          );
          continue;
        }

        const status = statusRaw.toUpperCase();
        const sizeMatched = Number(orderStatus.order.size_matched || 0);

        if (status === "MATCHED" || status === "CANCELLED" || status === "CANCELED" || status === "EXPIRED") {
          // Terminal state - process any final fills and remove
          issues.push({
            type: "ORDER_IN_DB_NOT_CLOB",
            severity: "INFO",
            marketSlug: dbOrder.marketMaker?.market?.slug,
            details: {
              orderId: dbOrder.orderId,
              status,
              sizeMatched,
              reason: `terminal_status_${status.toLowerCase()}`,
            },
            action: autoCorrect ? "CORRECTED" : "LOGGED",
          });

          if (autoCorrect) {
            // Check if there are fills to process
            const lastMatched = dbOrder.lastMatchedSize
              ? Number(dbOrder.lastMatchedSize)
              : 0;
            if (sizeMatched > lastMatched) {
              // Process remaining fills
              await processUnrecordedFill(
                dbOrder.marketMaker.id,
                dbOrder,
                sizeMatched - lastMatched,
                Number(dbOrder.price),
                sizeMatched
              );
            }
            const removed = await prisma.marketMakerOrder.deleteMany({
              where: { id: dbOrder.id },
            });
            if (removed.count > 0) {
              result.ordersRemoved += removed.count;
            }
          }
        }
      }
    } else {
      // Order exists in both - get detailed status to check for fills
      const orderStatus = await getOrder(dbOrder.orderId);

      if (orderStatus.status === "ok" && orderStatus.order) {
        const details = orderStatus.order;
        const sizeMatched = Number(details.size_matched || 0);
        const originalSize = Number(details.original_size || dbOrder.size);
        const lastMatched = dbOrder.lastMatchedSize
          ? Number(dbOrder.lastMatchedSize)
          : 0;

        // Check for price mismatch
        const priceMismatch =
          Math.abs(Number(dbOrder.price) - Number(details.price)) > 0.001;

        if (priceMismatch) {
          issues.push({
            type: "ORDER_MISMATCH",
            severity: "WARN",
            marketSlug: dbOrder.marketMaker?.market?.slug,
            details: {
              orderId: dbOrder.orderId,
              dbPrice: Number(dbOrder.price),
              clobPrice: Number(details.price),
            },
            action: autoCorrect ? "CORRECTED" : "LOGGED",
          });

          if (autoCorrect) {
            await prisma.marketMakerOrder.updateMany({
              where: { id: dbOrder.id },
              data: { price: Number(details.price) },
            });
            result.ordersMismatched++;
          }
        }

        // Check for unrecorded fills
        if (sizeMatched > lastMatched) {
          const unrecordedFill = sizeMatched - lastMatched;
          issues.push({
            type: "ORDER_MISMATCH",
            severity: "WARN",
            marketSlug: dbOrder.marketMaker?.market?.slug,
            details: {
              orderId: dbOrder.orderId,
              unrecordedFill,
              clobSizeMatched: sizeMatched,
              dbLastMatched: lastMatched,
            },
            action: autoCorrect ? "CORRECTED" : "LOGGED",
          });

          if (autoCorrect) {
            await processUnrecordedFill(
              dbOrder.marketMaker.id,
              dbOrder,
              unrecordedFill,
              Number(dbOrder.price),
              sizeMatched
            );
            await prisma.marketMakerOrder.updateMany({
              where: { id: dbOrder.id },
              data: { lastMatchedSize: sizeMatched },
            });
          }
        }
      }
    }
  }
}

/**
 * Process a fill that wasn't properly recorded
 */
async function processUnrecordedFill(
  marketMakerId: string,
  order: {
    orderId: string;
    outcome: string;
    side: string;
    price: unknown;
  },
  fillSize: number,
  fillPrice: number,
  matchedTotal: number
): Promise<void> {
  const side = order.side === "BID" ? "BUY" : "SELL";
  const recorded = await recordPendingFillEvent({
    marketMakerId,
    orderId: order.orderId,
    outcome: order.outcome === "YES" ? "YES" : "NO",
    side,
    price: fillPrice,
    size: fillSize,
    matchedTotal,
    source: "sync",
    metadata: {
      reason: "unrecorded_fill",
      originalPrice: Number(order.price),
    },
  });

  if (recorded) {
    console.log(
      `[DataIntegrity] Recorded pending fill: ${order.outcome} ${side} @ ${fillPrice} x ${fillSize}`
    );
  }
}

// ============================================================================
// POSITION SYNC - Data API is source of truth for positions
// ============================================================================

async function syncPositions(
  result: SyncResult,
  issues: SyncIssue[],
  _autoCorrect: boolean,
  verbose: boolean
): Promise<void> {
  if (verbose) console.log("[DataIntegrity] Syncing positions from Data API...");

  // 1. Get all market makers with their token IDs FIRST
  const marketMakers = await prisma.marketMaker.findMany({
    include: {
      market: {
        select: { slug: true, clobTokenIds: true },
      },
    },
  });
  result.positionsInDb = marketMakers.length;

  // 2. Fetch on-chain positions
  const chainPositions = await getPositions(undefined, {
    sizeThreshold: 0,
    limit: 500,
  });
  if (!chainPositions) {
    dataApiFailureStreak += 1;
    issues.push({
      type: "DATA_API_UNAVAILABLE",
      severity: "CRITICAL",
      details: { reason: "getPositions_failed" },
      action: "REQUIRES_MANUAL",
    });
    console.error(
      `[DataIntegrity] Data API unavailable ` +
      `(streak ${dataApiFailureStreak}/${DEPENDENCY_FAILURE_THRESHOLD})`
    );
    if (dataApiFailureStreak >= DEPENDENCY_FAILURE_THRESHOLD) {
      console.error(
        "[DataIntegrity] Data API unavailable; skipping sync without pausing"
      );
    }
    return;
  }
  dataApiFailureStreak = 0;
  result.positionsInChain = chainPositions.length;

  if (verbose)
    console.log(`[DataIntegrity] Found ${chainPositions.length} on-chain positions`);

  // Build position map by token ID
  const chainPositionMap = new Map(
    chainPositions.map((p) => [
      p.asset,
      { size: p.size, avgPrice: p.avgPrice, value: p.currentValue },
    ])
  );

  // 3. Compare DB inventory against chain positions
  // Data API is authoritative for full-wallet positions. Overwrite DB values.
  for (const mm of marketMakers) {
    const yesTokenId = mm.market?.clobTokenIds?.[0];
    const noTokenId = mm.market?.clobTokenIds?.[1];

    if (!yesTokenId || !noTokenId) {
      if (verbose) {
        console.warn(
          `[DataIntegrity] Missing clobTokenIds for ${mm.market?.slug ?? "unknown"}`
        );
      }
      continue;
    }

    const yesPos = chainPositionMap.get(yesTokenId);
    const noPos = chainPositionMap.get(noTokenId);

    const dbYes = Number(mm.yesInventory);
    const dbNo = Number(mm.noInventory);
    const dbAvgYes = Number(mm.avgYesCost);
    const dbAvgNo = Number(mm.avgNoCost);

    const nextYes = yesPos?.size ?? 0;
    const nextNo = noPos?.size ?? 0;
    const nextAvgYes = yesPos?.avgPrice ?? 0;
    const nextAvgNo = noPos?.avgPrice ?? 0;

    const driftYesValue = nextYes - dbYes;
    const driftNoValue = nextNo - dbNo;
    await confirmPendingFillsForMarketMaker({
      mm,
      driftByOutcome: { YES: driftYesValue, NO: driftNoValue },
    });

    const yesDrift = Math.abs(dbYes - nextYes);
    const noDrift = Math.abs(dbNo - nextNo);
    const yesAvgDrift = Math.abs(dbAvgYes - nextAvgYes);
    const noAvgDrift = Math.abs(dbAvgNo - nextAvgNo);

    if (yesDrift > 0.1 || yesAvgDrift > 0.0001) {
      issues.push({
        type: "POSITION_DRIFT",
        severity: yesDrift > 0.1 ? "ERROR" : "WARN",
        marketSlug: mm.market?.slug,
        details: {
          outcome: "YES",
          dbInventory: dbYes,
          chainSize: nextYes,
          drift: yesDrift,
          chainAvgPrice: nextAvgYes,
          dbAvgCost: dbAvgYes,
        },
        action: "CORRECTED",
      });
    }

    if (noDrift > 0.1 || noAvgDrift > 0.0001) {
      issues.push({
        type: "POSITION_DRIFT",
        severity: noDrift > 0.1 ? "ERROR" : "WARN",
        marketSlug: mm.market?.slug,
        details: {
          outcome: "NO",
          dbInventory: dbNo,
          chainSize: nextNo,
          drift: noDrift,
          chainAvgPrice: nextAvgNo,
          dbAvgCost: dbAvgNo,
        },
        action: "CORRECTED",
      });
    }

    if (yesDrift > 0.0001 || noDrift > 0.0001 || yesAvgDrift > 0.0001 || noAvgDrift > 0.0001) {
      await prisma.marketMaker.update({
        where: { id: mm.id },
        data: {
          yesInventory: nextYes,
          noInventory: nextNo,
          avgYesCost: nextAvgYes,
          avgNoCost: nextAvgNo,
        },
      });
      result.positionsCorrected++;
    }
  }

  // 4. Check for positions on chain with no corresponding MM (orphan positions)
  const allTokenIds = new Set(
    marketMakers.flatMap((mm) => mm.market?.clobTokenIds || [])
  );

  for (const [tokenId, chainPos] of chainPositionMap) {
    if (!allTokenIds.has(tokenId) && chainPos.size > 0.1) {
      issues.push({
        type: "POSITION_MISSING",
        severity: "WARN",
        details: {
          tokenId,
          chainSize: chainPos.size,
          chainValue: chainPos.value,
          note: "Position on chain with no MM tracking",
        },
        action: "LOGGED",
      });

      if (verbose) {
        console.warn(
          `[DataIntegrity] ORPHAN POSITION: ${tokenId} with ${chainPos.size} shares`
        );
      }
    }
  }
}

// ============================================================================
// P&L VERIFICATION - Cross-check P&L calculations
// ============================================================================

async function verifyPnL(
  result: SyncResult,
  issues: SyncIssue[],
  verbose: boolean
): Promise<void> {
  if (verbose) console.log("[DataIntegrity] Verifying P&L calculations...");

  // For each MM, verify realizedPnL matches sum of fill records
  const marketMakers = await prisma.marketMaker.findMany({
    include: {
      market: { select: { slug: true } },
      fills: true,
    },
  });

  for (const mm of marketMakers) {
    const storedPnl = Number(mm.realizedPnl);
    const calculatedPnl = mm.fills.reduce((sum, fill) => {
      return sum + (fill.realizedPnl ? Number(fill.realizedPnl) : 0);
    }, 0);

    const discrepancy = Math.abs(storedPnl - calculatedPnl);

    if (discrepancy > 0.01) {
      issues.push({
        type: "PNL_MISMATCH",
        severity: discrepancy > 1 ? "ERROR" : "WARN",
        marketSlug: mm.market?.slug,
        details: {
          storedPnl,
          calculatedPnl,
          discrepancy,
          fillCount: mm.fills.length,
        },
        action: "LOGGED",
      });

      if (verbose) {
        console.warn(
          `[DataIntegrity] P&L mismatch for ${mm.market?.slug}: stored=${storedPnl.toFixed(4)}, calculated=${calculatedPnl.toFixed(4)}`
        );
      }

      result.pnlDiscrepancy = (result.pnlDiscrepancy ?? 0) + discrepancy;
    }
  }

  result.pnlVerified = true;
}

// ============================================================================
// QUICK SYNC - Fast verification without full reconciliation
// ============================================================================

/**
 * Quick sync - verify critical data without full correction.
 * Use this for frequent checks (e.g., every minute).
 */
export async function quickSync(): Promise<{
  ordersMatch: boolean;
  positionsMatch: boolean;
  issues: number;
}> {
  const issues: SyncIssue[] = [];
  configureCLOB({ dryRun: false });

  // Check order count matches
  const clobOrdersResult = await fetchActiveOrders();
  if (!clobOrdersResult) {
    issues.push({
      type: "CLOB_UNAVAILABLE",
      severity: "CRITICAL",
      details: { reason: "fetchActiveOrders_failed" },
      action: "REQUIRES_MANUAL",
    });
    return { ordersMatch: false, positionsMatch: false, issues: issues.length };
  }

  const trackedTokenIds = await getTrackedTokenIds();
  const clobOrders = clobOrdersResult.filter((o) =>
    trackedTokenIds.has(o.asset_id)
  );

  const dbOrderCount = await prisma.marketMakerOrder.count();
  const ordersMatch = clobOrders.length === dbOrderCount;

  // Get market makers for DB totals
  const marketMakers = await prisma.marketMaker.findMany({
    include: {
      market: {
        select: { clobTokenIds: true },
      },
    },
  });

  // Check total inventory matches (only for tracked tokens)
  const chainPositions = await getPositions(undefined, {
    sizeThreshold: 0,
    limit: 500,
  });
  if (!chainPositions) {
    issues.push({
      type: "DATA_API_UNAVAILABLE",
      severity: "CRITICAL",
      details: { reason: "getPositions_failed" },
      action: "REQUIRES_MANUAL",
    });
    return { ordersMatch, positionsMatch: false, issues: issues.length };
  }

  // Only sum positions for MM-tracked tokens
  // NOTE: Drift may still occur from manual trades in same tokens
  // Without dedicated wallet, this is unavoidable
  const chainTotal = chainPositions
    .filter((p) => trackedTokenIds.has(p.asset))
    .reduce((sum, p) => sum + p.size, 0);

  const dbTotal = marketMakers.reduce(
    (sum, mm) => sum + Number(mm.yesInventory) + Number(mm.noInventory),
    0
  );

  const positionsMatch = Math.abs(chainTotal - dbTotal) < 1;

  if (!ordersMatch) {
    issues.push({
      type: "ORDER_MISMATCH",
      severity: "WARN",
      details: { clobCount: clobOrders.length, dbCount: dbOrderCount },
      action: "LOGGED",
    });
  }

  if (!positionsMatch) {
    issues.push({
      type: "POSITION_DRIFT",
      severity: "WARN",
      details: { chainTotal, dbTotal, drift: chainTotal - dbTotal },
      action: "LOGGED",
    });
  }

  return { ordersMatch, positionsMatch, issues: issues.length };
}

// ============================================================================
// INVENTORY SYNC - Independent sync of inventory from chain
// ============================================================================

/**
 * Sync all market maker inventory from chain positions.
 * This runs independently of the MM job to catch drift faster.
 *
 * @returns Number of positions corrected
 */
export async function syncInventoryFromChain(options?: {
  positions?: DataAPIPosition[];
}): Promise<{
  synced: number;
  corrected: number;
  driftDetails: Array<{
    marketSlug: string;
    outcome: "YES" | "NO";
    dbValue: number;
    chainValue: number;
    drift: number;
  }>;
}> {
  const result = {
    synced: 0,
    corrected: 0,
    driftDetails: [] as Array<{
      marketSlug: string;
      outcome: "YES" | "NO";
      dbValue: number;
      chainValue: number;
      drift: number;
    }>,
  };

  try {
    // Fetch chain positions
    const chainPositions =
      options?.positions ??
      (await getPositions(undefined, {
        sizeThreshold: 0,
        limit: 500,
      }));

    if (!chainPositions) {
      console.warn("[InventorySync] Chain positions unavailable");
      return result;
    }

    const positionMap = new Map(
      chainPositions.map((p) => [p.asset, { size: p.size, avgPrice: p.avgPrice }])
    );

    // Get all market makers
    const marketMakers = await prisma.marketMaker.findMany({
      include: { market: { select: { slug: true, clobTokenIds: true } } },
    });

    for (const mm of marketMakers) {
      const yesTokenId = mm.market?.clobTokenIds?.[0];
      const noTokenId = mm.market?.clobTokenIds?.[1];

      if (!yesTokenId || !noTokenId) continue;

      const yesPos = positionMap.get(yesTokenId);
      const noPos = positionMap.get(noTokenId);

      const dbYes = Number(mm.yesInventory);
      const dbNo = Number(mm.noInventory);
      const chainYes = yesPos?.size ?? 0;
      const chainNo = noPos?.size ?? 0;
      const chainAvgYes = yesPos?.avgPrice ?? 0;
      const chainAvgNo = noPos?.avgPrice ?? 0;

      await confirmPendingFillsForMarketMaker({
        mm,
        driftByOutcome: { YES: chainYes - dbYes, NO: chainNo - dbNo },
      });

      const yesDrift = Math.abs(dbYes - chainYes);
      const noDrift = Math.abs(dbNo - chainNo);
      const yesAvgDrift = Math.abs(Number(mm.avgYesCost) - chainAvgYes);
      const noAvgDrift = Math.abs(Number(mm.avgNoCost) - chainAvgNo);

      // Track drift for logging
      if (yesDrift > 0.1) {
        result.driftDetails.push({
          marketSlug: mm.market?.slug ?? "unknown",
          outcome: "YES",
          dbValue: dbYes,
          chainValue: chainYes,
          drift: yesDrift,
        });
      }
      if (noDrift > 0.1) {
        result.driftDetails.push({
          marketSlug: mm.market?.slug ?? "unknown",
          outcome: "NO",
          dbValue: dbNo,
          chainValue: chainNo,
          drift: noDrift,
        });
      }

      // Update if any drift detected
      if (yesDrift > 0.0001 || noDrift > 0.0001 || yesAvgDrift > 0.0001 || noAvgDrift > 0.0001) {
        await prisma.marketMaker.update({
          where: { id: mm.id },
          data: {
            yesInventory: chainYes,
            noInventory: chainNo,
            avgYesCost: chainAvgYes,
            avgNoCost: chainAvgNo,
          },
        });
        result.corrected++;
      }

      result.synced++;
    }

    // Log if any significant drift was detected and corrected
    if (result.driftDetails.length > 0) {
      await prisma.log.create({
        data: {
          level: "WARN",
          category: "RECONCILE",
          message: `Inventory sync corrected ${result.driftDetails.length} drift(s)`,
          metadata: {
            corrected: result.corrected,
            drifts: result.driftDetails,
          },
        },
      });
    }

    return result;
  } catch (error) {
    console.error("[InventorySync] Error:", error);
    return result;
  }
}

// ============================================================================
// CLEANUP - Remove stale data
// ============================================================================

/**
 * Clean up orphan orders that exist in CLOB but aren't tracked.
 * Use with caution - only if you're sure these orders aren't from other systems.
 */
export async function cancelOrphanOrders(): Promise<{ cancelled: number }> {
  console.log("[DataIntegrity] Looking for orphan orders to cancel...");

  const clobOrders = await fetchActiveOrders();
  if (!clobOrders) {
    console.error("[DataIntegrity] CLOB unavailable - cannot cancel orphans");
    return { cancelled: 0 };
  }
  const trackedTokenIds = await getTrackedTokenIds();
  const trackedClobOrders = clobOrders.filter((o) =>
    trackedTokenIds.has(o.asset_id)
  );
  const dbOrderIds = new Set(
    (await prisma.marketMakerOrder.findMany({ select: { orderId: true } })).map(
      (o) => o.orderId
    )
  );

  let cancelled = 0;

  for (const clobOrder of trackedClobOrders) {
    if (!dbOrderIds.has(clobOrder.id)) {
      try {
        await cancelOrder(clobOrder.id);
        cancelled++;
        console.log(`[DataIntegrity] Cancelled orphan order ${clobOrder.id}`);
      } catch (e) {
        console.error(`[DataIntegrity] Failed to cancel ${clobOrder.id}:`, e);
      }
    }
  }

  console.log(`[DataIntegrity] Cancelled ${cancelled} orphan orders`);
  return { cancelled };
}

// ============================================================================
// RESET - Nuclear option: reset DB to match chain
// ============================================================================

/**
 * Reset all MM inventory to match on-chain positions.
 * This is the nuclear option - use when DB is completely out of sync.
 * Does NOT affect order tracking - use cancelOrphanOrders for that.
 */
export async function resetToChain(): Promise<{
  marketsReset: number;
  ordersCleared: number;
}> {
  console.log("[DataIntegrity] RESETTING ALL MM INVENTORY TO CHAIN STATE...");

  // 1. Get chain positions
  const chainPositions = await getPositions(undefined, {
    sizeThreshold: 0,
    limit: 500,
  });
  if (!chainPositions) {
    throw new Error("[DataIntegrity] Data API unavailable - aborting reset");
  }

  const positionMap = new Map(
    chainPositions.map((p) => [
      p.asset,
      { size: p.size, avgPrice: p.avgPrice },
    ])
  );

  // 2. Get all MMs
  const marketMakers = await prisma.marketMaker.findMany({
    include: { market: { select: { clobTokenIds: true, slug: true } } },
  });

  let marketsReset = 0;

  for (const mm of marketMakers) {
    const yesTokenId = mm.market?.clobTokenIds?.[0];
    const noTokenId = mm.market?.clobTokenIds?.[1];

    const yesPos = yesTokenId ? positionMap.get(yesTokenId) : null;
    const noPos = noTokenId ? positionMap.get(noTokenId) : null;

    await prisma.marketMaker.update({
      where: { id: mm.id },
      data: {
        yesInventory: yesPos?.size ?? 0,
        noInventory: noPos?.size ?? 0,
        avgYesCost: yesPos?.avgPrice ?? 0,
        avgNoCost: noPos?.avgPrice ?? 0,
        // NOTE: We don't reset realizedPnl - that's historical
      },
    });

    console.log(
      `[DataIntegrity] Reset ${mm.market?.slug}: YES=${yesPos?.size ?? 0}, NO=${noPos?.size ?? 0}`
    );
    marketsReset++;
  }

  // 3. Clear all order tracking (they'll be re-verified on next MM cycle)
  const { count: ordersCleared } = await prisma.marketMakerOrder.deleteMany();

  // 4. Log the reset
  await prisma.log.create({
    data: {
      level: "WARN",
      category: "RECONCILE",
      message: `RESET TO CHAIN: ${marketsReset} markets reset, ${ordersCleared} orders cleared`,
      metadata: { marketsReset, ordersCleared },
    },
  });

  console.log(
    `[DataIntegrity] RESET COMPLETE: ${marketsReset} markets, ${ordersCleared} orders`
  );

  return { marketsReset, ordersCleared };
}
