/**
 * Data Integrity Sync API
 *
 * Provides endpoints for:
 * - GET: Quick sync status check
 * - POST: Trigger full sync with auto-correction
 * - DELETE: Reset to chain state (nuclear option)
 */

import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import {
  fetchActiveOrders,
  getOrder,
  getPositions,
  configureCLOB,
} from "@favored/shared";

const STATUS_STALE_MS = Number(process.env.SYNC_STATUS_STALE_MS ?? 120000);

type LastSnapshot = {
  timestamp: number;
  clobOrdersCount: number;
  chainPositionsCount: number;
  chainTotal: number;
};

let lastSnapshot: LastSnapshot | null = null;

async function withRetry<T>(
  fn: () => Promise<T | null>,
  attempts = 2,
  delayMs = 250
): Promise<T | null> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await fn();
    if (result !== null) return result;
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  return null;
}

interface SyncIssue {
  type: string;
  severity: "INFO" | "WARN" | "ERROR" | "CRITICAL";
  marketSlug?: string;
  details: Record<string, unknown>;
  action: "CORRECTED" | "LOGGED";
}

interface SyncResult {
  success: boolean;
  timestamp: string;
  duration: number;

  // Order sync
  ordersInClob: number;
  ordersInDb: number;
  ordersRemoved: number;
  ordersMismatched: number;

  // Position sync
  positionsInChain: number;
  marketMakersInDb: number;
  positionsCorrected: number;

  // Issues
  issues: SyncIssue[];
}

/**
 * GET /api/sync - Quick status check
 */
export async function GET() {
  try {
    // Get counts from DB
    const [dbOrders, marketMakers] = await Promise.all([
      prisma.marketMakerOrder.count(),
      prisma.marketMaker.findMany({
        include: { market: { select: { slug: true, clobTokenIds: true } } },
      }),
    ]);

    // Build set of tracked token IDs (only count positions for MM-tracked tokens)
    const trackedTokenIds = new Set<string>();
    for (const mm of marketMakers) {
      const tokens = mm.market?.clobTokenIds || [];
      tokens.forEach((t) => trackedTokenIds.add(t));
    }

    // Get CLOB orders (with error handling)
    let clobOrdersCount = 0;
    let clobError: string | null = null;
    let clobStale = false;

    configureCLOB({ dryRun: false });
    const clobOrdersResult = await withRetry(() => fetchActiveOrders());
    if (!clobOrdersResult) {
      clobError = "CLOB unavailable";
      if (lastSnapshot) {
        clobStale = true;
        clobOrdersCount = lastSnapshot.clobOrdersCount;
      }
    } else {
      clobOrdersCount = clobOrdersResult.filter((o) =>
        trackedTokenIds.has(o.asset_id)
      ).length;
    }

    // Get chain positions (with error handling)
    let chainPositions: NonNullable<Awaited<ReturnType<typeof getPositions>>> = [];
    let chainPositionsCount = 0;
    let chainError: string | null = null;
    let chainStale = false;

    const chainPositionsResult = await withRetry(() =>
      getPositions(undefined, { sizeThreshold: 0, limit: 500 })
    );
    if (!chainPositionsResult) {
      chainError = "Data API unavailable";
      if (lastSnapshot) {
        chainStale = true;
        chainPositionsCount = lastSnapshot.chainPositionsCount;
      }
    } else {
      chainPositions = chainPositionsResult;
      chainPositionsCount = chainPositions.length;
    }

    // Calculate totals - only for MM-tracked tokens
    let chainTotal = chainPositions
      .filter((p) => trackedTokenIds.has(p.asset))
      .reduce((sum, p) => sum + p.size, 0);
    const dbTotal = marketMakers.reduce(
      (sum, mm) => sum + Number(mm.yesInventory) + Number(mm.noInventory),
      0
    );
    if (chainStale && lastSnapshot) {
      chainTotal = lastSnapshot.chainTotal;
    }

    // Check for drift
    const ordersMatch = !clobError && clobOrdersCount === dbOrders;
    const positionsMatch = !chainError && Math.abs(chainTotal - dbTotal) < 1;
    const degradedReasons: string[] = [];
    if (clobError) degradedReasons.push("CLOB_UNAVAILABLE");
    if (chainError) degradedReasons.push("DATA_API_UNAVAILABLE");

    const now = Date.now();
    const status =
      clobError || chainError
        ? "DEGRADED"
        : ordersMatch && positionsMatch
          ? "SYNCED"
          : "DRIFT_DETECTED";

    if (!clobError && !chainError) {
      lastSnapshot = {
        timestamp: now,
        clobOrdersCount,
        chainPositionsCount,
        chainTotal,
      };
    }

    return NextResponse.json({
      status,
      degradedReasons,
      stale: lastSnapshot ? now - lastSnapshot.timestamp > STATUS_STALE_MS : false,
      orders: {
        clob: clobOrdersCount,
        db: dbOrders,
        match: ordersMatch,
        error: clobError,
        stale: clobStale,
      },
      positions: {
        chain: chainPositionsCount,
        chainTotal: chainTotal.toFixed(2),
        db: marketMakers.length,
        dbTotal: dbTotal.toFixed(2),
        drift: (chainTotal - dbTotal).toFixed(2),
        match: positionsMatch,
        error: chainError,
        stale: chainStale,
      },
      lastSync: await getLastSyncTime(),
    });
  } catch (error) {
    console.error("Sync status check failed:", error);
    return NextResponse.json(
      { error: "Failed to check sync status" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/sync - Trigger full sync with auto-correction
 */
export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const issues: SyncIssue[] = [];

  try {
    const body = await request.json().catch(() => ({}));
    const autoCorrect = body.autoCorrect !== false; // Default true
    const verbose = body.verbose === true;

    const result: SyncResult = {
      success: false,
      timestamp: new Date().toISOString(),
      duration: 0,
      ordersInClob: 0,
      ordersInDb: 0,
      ordersRemoved: 0,
      ordersMismatched: 0,
      positionsInChain: 0,
      marketMakersInDb: 0,
      positionsCorrected: 0,
      issues: [],
    };

    configureCLOB({ dryRun: false });

    // Step 1: Sync orders
    await syncOrders(result, issues, autoCorrect, verbose);

    // Step 2: Sync positions
    await syncPositions(result, issues, autoCorrect, verbose);

    result.success = true;
    result.duration = Date.now() - startTime;
    result.issues = issues;

    // Log to database
    await prisma.log.create({
      data: {
        level: issues.some((i) => i.severity === "ERROR" || i.severity === "CRITICAL")
          ? "WARN"
          : "INFO",
        category: "RECONCILE",
        message: `Full sync completed: ${issues.length} issues, ${result.positionsCorrected} positions corrected`,
        metadata: {
          duration: result.duration,
          ordersRemoved: result.ordersRemoved,
          positionsCorrected: result.positionsCorrected,
          issueCount: issues.length,
        },
      },
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Full sync failed:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
        issues,
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/sync - Reset to chain state (nuclear option)
 * Requires confirmation in body
 */
export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));

    if (body.confirm !== "RESET_TO_CHAIN") {
      return NextResponse.json(
        {
          error: 'Confirmation required. Send {"confirm": "RESET_TO_CHAIN"} to proceed.',
        },
        { status: 400 }
      );
    }

    configureCLOB({ dryRun: false });

    // Get chain positions
    const chainPositions = await getPositions(undefined, {
      sizeThreshold: 0,
      limit: 500,
    });
    if (!chainPositions) {
      return NextResponse.json(
        { error: "Data API unavailable" },
        { status: 502 }
      );
    }

    const positionMap = new Map(
      chainPositions.map((p) => [
        p.asset,
        { size: p.size, avgPrice: p.avgPrice },
      ])
    );

    // Get all MMs
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
          ...((yesPos?.size ?? 0) === 0 ? { avgYesCost: 0 } : {}),
          ...((noPos?.size ?? 0) === 0 ? { avgNoCost: 0 } : {}),
        },
      });

      marketsReset++;
    }

    // Clear all order tracking
    const { count: ordersCleared } = await prisma.marketMakerOrder.deleteMany();

    // Log the reset
    await prisma.log.create({
      data: {
        level: "WARN",
        category: "RECONCILE",
        message: `RESET TO CHAIN: ${marketsReset} markets reset, ${ordersCleared} orders cleared`,
        metadata: { marketsReset, ordersCleared },
      },
    });

    return NextResponse.json({
      success: true,
      marketsReset,
      ordersCleared,
      message: "All MM inventory reset to match on-chain positions",
    });
  } catch (error) {
    console.error("Reset to chain failed:", error);
    return NextResponse.json(
      { error: "Failed to reset to chain" },
      { status: 500 }
    );
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function getLastSyncTime(): Promise<string | null> {
  const lastLog = await prisma.log.findFirst({
    where: {
      category: "RECONCILE",
      message: { contains: "Full sync completed" },
    },
    orderBy: { createdAt: "desc" },
  });
  return lastLog?.createdAt.toISOString() ?? null;
}

async function syncOrders(
  result: SyncResult,
  issues: SyncIssue[],
  autoCorrect: boolean,
  verbose: boolean
): Promise<void> {
  // Fetch CLOB orders
  const clobOrders = await fetchActiveOrders();
  if (!clobOrders) {
    issues.push({
      type: "CLOB_UNAVAILABLE",
      severity: "CRITICAL",
      details: { reason: "fetchActiveOrders_failed" },
      action: "LOGGED",
    });
    return;
  }
  result.ordersInClob = clobOrders.length;

  // Fetch DB orders
  const dbOrders = await prisma.marketMakerOrder.findMany({
    include: {
      marketMaker: {
        include: { market: { select: { slug: true } } },
      },
    },
  });
  result.ordersInDb = dbOrders.length;

  const clobOrderIds = new Set(clobOrders.map((o) => o.id));

  // Check for DB orders not in CLOB
  for (const dbOrder of dbOrders) {
    if (!clobOrderIds.has(dbOrder.orderId)) {
      // Verify with getOrder
      const orderStatus = await getOrder(dbOrder.orderId);

      if (
        orderStatus.status === "not_found" ||
        (orderStatus.status === "ok" &&
          ["MATCHED", "CANCELLED", "CANCELED", "EXPIRED"].includes(
            orderStatus.order?.status?.toUpperCase() || ""
          ))
      ) {
        issues.push({
          type: "ORDER_IN_DB_NOT_CLOB",
          severity: "WARN",
          marketSlug: dbOrder.marketMaker?.market?.slug,
          details: {
            orderId: dbOrder.orderId,
            status: orderStatus.status,
          },
          action: autoCorrect ? "CORRECTED" : "LOGGED",
        });

        if (autoCorrect) {
          // Check for unrecorded fills before deleting
          if (orderStatus.status === "ok" && orderStatus.order) {
            const sizeMatched = Number(orderStatus.order.size_matched || 0);
            const lastMatched = dbOrder.lastMatchedSize
              ? Number(dbOrder.lastMatchedSize)
              : 0;

            if (sizeMatched > lastMatched) {
              await recordFill(
                dbOrder.marketMaker.id,
                dbOrder,
                sizeMatched - lastMatched,
                sizeMatched
              );
            }
          }

          await prisma.marketMakerOrder.delete({ where: { id: dbOrder.id } });
          result.ordersRemoved++;
        }
      }
    }
  }
}

async function syncPositions(
  result: SyncResult,
  issues: SyncIssue[],
  _autoCorrect: boolean,
  _verbose: boolean
): Promise<void> {
  // Get all MMs FIRST to calculate tracked inventory
  const marketMakers = await prisma.marketMaker.findMany({
    include: { market: { select: { slug: true, clobTokenIds: true } } },
  });
  result.marketMakersInDb = marketMakers.length;

  // Fetch chain positions
  const chainPositions = await getPositions(undefined, {
    sizeThreshold: 0,
    limit: 500,
  });
  if (!chainPositions) {
    issues.push({
      type: "DATA_API_UNAVAILABLE",
      severity: "CRITICAL",
      details: { reason: "getPositions_failed" },
      action: "LOGGED",
    });
    return;
  }
  result.positionsInChain = chainPositions.length;

  const positionMap = new Map(
    chainPositions.map((p) => [
      p.asset,
      { size: p.size, avgPrice: p.avgPrice },
    ])
  );

  // Data API is authoritative for full-wallet positions. Overwrite DB.
  for (const mm of marketMakers) {
    const yesTokenId = mm.market?.clobTokenIds?.[0];
    const noTokenId = mm.market?.clobTokenIds?.[1];

    if (!yesTokenId || !noTokenId) {
      continue;
    }

    const yesPos = positionMap.get(yesTokenId);
    const noPos = positionMap.get(noTokenId);

    const dbYes = Number(mm.yesInventory);
    const dbNo = Number(mm.noInventory);
    const dbAvgYes = Number(mm.avgYesCost);
    const dbAvgNo = Number(mm.avgNoCost);

    const nextYes = yesPos?.size ?? 0;
    const nextNo = noPos?.size ?? 0;
    const nextAvgYes = yesPos?.avgPrice ?? 0;
    const nextAvgNo = noPos?.avgPrice ?? 0;

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

    if (yesDrift > 0.0001 || noDrift > 0.0001) {
      await prisma.marketMaker.update({
        where: { id: mm.id },
        data: {
          yesInventory: nextYes,
          noInventory: nextNo,
          ...(nextYes === 0 && { avgYesCost: 0 }),
          ...(nextNo === 0 && { avgNoCost: 0 }),
        },
      });
      result.positionsCorrected++;
    }
  }
}

async function recordFill(
  marketMakerId: string,
  order: {
    orderId: string;
    outcome: "YES" | "NO";
    side: "BID" | "ASK";
    price: unknown;
  },
  fillSize: number,
  matchedTotal: number
): Promise<void> {
  const price = Number(order.price);
  const side = order.side === "BID" ? "BUY" : "SELL";
  const existing = await prisma.marketMakerFillEvent.findUnique({
    where: {
      orderId_matchedTotal: {
        orderId: order.orderId,
        matchedTotal,
      },
    },
    select: { id: true },
  });
  if (existing) return;

  await prisma.marketMakerFillEvent.create({
    data: {
      marketMakerId,
      outcome: order.outcome,
      side,
      orderId: order.orderId,
      price,
      size: fillSize,
      value: price * fillSize,
      matchedTotal,
      source: "api_sync",
      metadata: { reason: "unrecorded_fill" },
    },
  });
}
