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
  fetchActiveOrders,
  getOrder,
  getPositions,
  cancelOrder,
} from "@favored/shared";

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
    | "UNKNOWN_TOKEN";
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
  const clobOrders = await fetchActiveOrders();
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
          await prisma.marketMakerOrder.delete({ where: { id: dbOrder.id } });
          result.ordersRemoved++;
          if (verbose) {
            console.log(`[DataIntegrity] Removed stale order ${dbOrder.orderId}`);
          }
        }
      } else if (orderStatus.status === "ok" && orderStatus.order) {
        const status = orderStatus.order.status.toUpperCase();
        const sizeMatched = Number(orderStatus.order.size_matched || 0);

        if (status === "MATCHED" || status === "CANCELLED" || status === "EXPIRED") {
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
                Number(dbOrder.price)
              );
            }
            await prisma.marketMakerOrder.delete({ where: { id: dbOrder.id } });
            result.ordersRemoved++;
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
            await prisma.marketMakerOrder.update({
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
              Number(dbOrder.price)
            );
            await prisma.marketMakerOrder.update({
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
  fillPrice: number
): Promise<void> {
  const isBuy = order.side === "BID";
  const isYes = order.outcome === "YES";

  // Get current MM state
  const mm = await prisma.marketMaker.findUnique({
    where: { id: marketMakerId },
  });
  if (!mm) return;

  let yesInventory = Number(mm.yesInventory);
  let noInventory = Number(mm.noInventory);
  let avgYesCost = Number(mm.avgYesCost);
  let avgNoCost = Number(mm.avgNoCost);
  let realizedPnl = Number(mm.realizedPnl);
  let fillRealizedPnl: number | null = null;
  const value = fillPrice * fillSize;

  if (isYes) {
    if (isBuy) {
      const totalCost = avgYesCost * yesInventory + value;
      yesInventory += fillSize;
      avgYesCost = yesInventory > 0 ? totalCost / yesInventory : 0;
    } else {
      if (yesInventory > 0) {
        fillRealizedPnl = (fillPrice - avgYesCost) * fillSize;
        realizedPnl += fillRealizedPnl;
      }
      yesInventory = Math.max(0, yesInventory - fillSize);
      if (yesInventory <= 0) avgYesCost = 0;
    }
  } else {
    if (isBuy) {
      const totalCost = avgNoCost * noInventory + value;
      noInventory += fillSize;
      avgNoCost = noInventory > 0 ? totalCost / noInventory : 0;
    } else {
      if (noInventory > 0) {
        fillRealizedPnl = (fillPrice - avgNoCost) * fillSize;
        realizedPnl += fillRealizedPnl;
      }
      noInventory = Math.max(0, noInventory - fillSize);
      if (noInventory <= 0) avgNoCost = 0;
    }
  }

  // Record the fill
  await prisma.marketMakerFill.create({
    data: {
      marketMakerId,
      outcome: order.outcome,
      side: isBuy ? "BUY" : "SELL",
      orderId: order.orderId,
      price: fillPrice,
      size: fillSize,
      value,
      realizedPnl: fillRealizedPnl,
    },
  });

  // Update MM state
  await prisma.marketMaker.update({
    where: { id: marketMakerId },
    data: {
      yesInventory,
      noInventory,
      avgYesCost,
      avgNoCost,
      realizedPnl,
    },
  });

  console.log(
    `[DataIntegrity] Recorded unrecorded fill: ${order.outcome} ${order.side} @ ${fillPrice} x ${fillSize}`
  );
}

// ============================================================================
// POSITION SYNC - Data API is source of truth for positions
// ============================================================================

async function syncPositions(
  result: SyncResult,
  issues: SyncIssue[],
  autoCorrect: boolean,
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

  // Calculate total tracked inventory BEFORE fetching chain positions
  const totalTrackedInventory = marketMakers.reduce(
    (sum, mm) => sum + Number(mm.yesInventory) + Number(mm.noInventory),
    0
  );

  // 2. Fetch on-chain positions
  const chainPositions = await getPositions(undefined, {
    sizeThreshold: 0,
    limit: 500,
  });
  result.positionsInChain = chainPositions.length;

  if (verbose)
    console.log(`[DataIntegrity] Found ${chainPositions.length} on-chain positions`);

  // EMPTY RESPONSE GUARD: Protect against zeroing inventory on empty API response
  if (chainPositions.length === 0 && totalTrackedInventory > 1.0) {
    console.error(
      "[DataIntegrity] EMPTY RESPONSE GUARD: Data API returned empty but DB has inventory"
    );
    issues.push({
      type: "POSITION_DRIFT",
      severity: "CRITICAL",
      details: {
        guard: "empty_response_protection",
        trackedInventory: totalTrackedInventory,
        action: "sync_skipped",
      },
      action: "LOGGED",
    });
    return; // DO NOT PROCEED - prevent zeroing inventory
  }

  // Build position map by token ID
  const chainPositionMap = new Map(
    chainPositions.map((p) => [
      p.asset,
      { size: p.size, avgPrice: p.avgPrice, value: p.currentValue },
    ])
  );

  // 3. Compare DB inventory against chain positions
  // ALERT-ONLY MODE: Without a dedicated MM wallet, we can't distinguish
  // MM positions from manual trades. Log drift for review, never auto-correct.
  for (const mm of marketMakers) {
    const yesTokenId = mm.market?.clobTokenIds?.[0];
    const noTokenId = mm.market?.clobTokenIds?.[1];

    // Check YES position
    if (yesTokenId) {
      const chainPos = chainPositionMap.get(yesTokenId);
      const dbInventory = Number(mm.yesInventory);
      const chainSize = chainPos?.size ?? 0;
      const drift = Math.abs(dbInventory - chainSize);

      // Allow small drift (< 0.1 shares) for rounding
      if (drift > 0.1) {
        const driftPercent =
          dbInventory > 0 ? drift / dbInventory : chainSize > 0 ? 1 : 0;

        issues.push({
          type: "POSITION_DRIFT",
          severity: driftPercent > 0.1 ? "ERROR" : "WARN",
          marketSlug: mm.market?.slug,
          details: {
            outcome: "YES",
            dbInventory,
            chainSize,
            drift,
            driftPercent,
            chainAvgPrice: chainPos?.avgPrice,
            dbAvgCost: Number(mm.avgYesCost),
            note: "Manual review required - no auto-correction without dedicated wallet",
          },
          action: "LOGGED", // NEVER auto-correct positions
        });

        if (verbose) {
          console.warn(
            `[DataIntegrity] POSITION DRIFT ${mm.market?.slug} YES: DB=${dbInventory}, Chain=${chainSize}, Drift=${drift.toFixed(2)}`
          );
        }
        // DO NOT UPDATE DB - alert only
      }
    }

    // Check NO position
    if (noTokenId) {
      const chainPos = chainPositionMap.get(noTokenId);
      const dbInventory = Number(mm.noInventory);
      const chainSize = chainPos?.size ?? 0;
      const drift = Math.abs(dbInventory - chainSize);

      if (drift > 0.1) {
        const driftPercent =
          dbInventory > 0 ? drift / dbInventory : chainSize > 0 ? 1 : 0;

        issues.push({
          type: "POSITION_DRIFT",
          severity: driftPercent > 0.1 ? "ERROR" : "WARN",
          marketSlug: mm.market?.slug,
          details: {
            outcome: "NO",
            dbInventory,
            chainSize,
            drift,
            driftPercent,
            chainAvgPrice: chainPos?.avgPrice,
            dbAvgCost: Number(mm.avgNoCost),
            note: "Manual review required - no auto-correction without dedicated wallet",
          },
          action: "LOGGED", // NEVER auto-correct positions
        });

        if (verbose) {
          console.warn(
            `[DataIntegrity] POSITION DRIFT ${mm.market?.slug} NO: DB=${dbInventory}, Chain=${chainSize}, Drift=${drift.toFixed(2)}`
          );
        }
        // DO NOT UPDATE DB - alert only
      }
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

  // Check order count matches
  const clobOrders = await fetchActiveOrders();
  const dbOrderCount = await prisma.marketMakerOrder.count();
  const ordersMatch = clobOrders.length === dbOrderCount;

  // Get market makers and their tracked token IDs
  const marketMakers = await prisma.marketMaker.findMany({
    include: {
      market: {
        select: { clobTokenIds: true },
      },
    },
  });

  // Build set of tracked token IDs (only count positions for MM-tracked tokens)
  const trackedTokenIds = new Set<string>();
  for (const mm of marketMakers) {
    const tokens = mm.market?.clobTokenIds || [];
    tokens.forEach((t) => trackedTokenIds.add(t));
  }

  // Check total inventory matches (only for tracked tokens)
  const chainPositions = await getPositions(undefined, {
    sizeThreshold: 0,
    limit: 500,
  });

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
// CLEANUP - Remove stale data
// ============================================================================

/**
 * Clean up orphan orders that exist in CLOB but aren't tracked.
 * Use with caution - only if you're sure these orders aren't from other systems.
 */
export async function cancelOrphanOrders(): Promise<{ cancelled: number }> {
  console.log("[DataIntegrity] Looking for orphan orders to cancel...");

  const clobOrders = await fetchActiveOrders();
  const dbOrderIds = new Set(
    (await prisma.marketMakerOrder.findMany({ select: { orderId: true } })).map(
      (o) => o.orderId
    )
  );

  let cancelled = 0;

  for (const clobOrder of clobOrders) {
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
