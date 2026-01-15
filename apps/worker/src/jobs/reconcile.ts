import { prisma } from "../lib/db.js";
import { configureCLOB, getPositions, fetchActiveOrders } from "@favored/shared";

// CRITICAL FIX: Lowered from 1 to 0.1 to catch smaller drifts earlier
// 1 share threshold was too high and allowed drift to accumulate unnoticed
const INVENTORY_DRIFT_THRESHOLD = Number(
  process.env.MM_INVENTORY_DRIFT_THRESHOLD ?? 0.1
);

/**
 * Analyze the likely cause of inventory drift
 */
async function analyzeDriftCause(
  mm: {
    id: string;
    yesInventory: unknown;
    noInventory: unknown;
    market?: { slug?: string; clobTokenIds?: string[] } | null;
  },
  outcome: "YES" | "NO",
  dbValue: number,
  chainValue: number
): Promise<{
  likelyCause: string;
  details: Record<string, unknown>;
}> {
  const drift = dbValue - chainValue;
  const isDecrease = chainValue < dbValue;
  const details: Record<string, unknown> = {
    outcome,
    dbInventory: dbValue,
    chainPosition: chainValue,
    drift,
  };

  try {
    // Check recent fills for this market maker
    const recentFills = await prisma.marketMakerFill.findMany({
      where: {
        marketMakerId: mm.id,
        outcome,
        filledAt: { gte: new Date(Date.now() - 60 * 60 * 1000) }, // Last hour
      },
      orderBy: { filledAt: "desc" },
      take: 10,
    });

    details.recentFillCount = recentFills.length;

    // Check if we have tracked orders for this market
    const trackedOrders = await prisma.marketMakerOrder.findMany({
      where: { marketMakerId: mm.id, outcome },
    });
    details.trackedOrderCount = trackedOrders.length;

    // Fetch active CLOB orders to check for orphan orders
    const clobOrders = await fetchActiveOrders();
    const tokenId = outcome === "YES"
      ? mm.market?.clobTokenIds?.[0]
      : mm.market?.clobTokenIds?.[1];

    if (clobOrders && tokenId) {
      const matchingOrders = clobOrders.filter((o) => o.asset_id === tokenId);
      details.activeClobOrders = matchingOrders.length;
    }

    // Analyze the situation
    if (chainValue === 0 && dbValue > 0) {
      // Position completely gone from chain
      if (recentFills.some((f) => f.side === "SELL")) {
        return {
          likelyCause: "EXTERNAL_SALE",
          details: {
            ...details,
            explanation: "Position sold outside of MM system (possibly via Polymarket.com UI)",
          },
        };
      }

      // Check if this could be a merge (YES + NO = USDC)
      const otherOutcome = outcome === "YES" ? "NO" : "YES";
      const otherDbValue = outcome === "YES" ? Number(mm.noInventory) : Number(mm.yesInventory);
      if (otherDbValue === 0) {
        return {
          likelyCause: "POSITION_MERGED",
          details: {
            ...details,
            explanation: "Both YES and NO positions gone - likely merged to USDC",
          },
        };
      }

      return {
        likelyCause: "POSITION_DISAPPEARED",
        details: {
          ...details,
          explanation: "Position vanished from chain without tracked sale",
          possibleReasons: ["External sale", "Market resolution", "Position merge", "API data lag"],
        },
      };
    }

    if (isDecrease) {
      // Chain has less than DB - something reduced our position
      const recentSells = recentFills.filter((f) => f.side === "SELL");
      if (recentSells.length > 0) {
        const sellTotal = recentSells.reduce((sum, f) => sum + Number(f.size), 0);
        if (Math.abs(sellTotal - Math.abs(drift)) < 1) {
          return {
            likelyCause: "TRACKED_SELLS_NOT_SYNCED",
            details: {
              ...details,
              explanation: "Recent sells match drift - DB likely just needs sync",
              recentSellTotal: sellTotal,
            },
          };
        }
      }

      return {
        likelyCause: "UNTRACKED_REDUCTION",
        details: {
          ...details,
          explanation: "Position reduced but no matching tracked activity",
          possibleReasons: ["External sale on Polymarket.com", "Partial merge", "Order filled without tracking"],
        },
      };
    } else {
      // Chain has MORE than DB - we got tokens we didn't track
      return {
        likelyCause: "UNTRACKED_INCREASE",
        details: {
          ...details,
          explanation: "Position increased but no matching tracked buy",
          possibleReasons: ["External purchase", "Fill recorded late", "DB sync issue"],
        },
      };
    }
  } catch (error) {
    return {
      likelyCause: "ANALYSIS_ERROR",
      details: {
        ...details,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function runReconcileJob(): Promise<void> {
  console.log("[Reconcile] Starting reconciliation...");

  try {
    configureCLOB({ dryRun: false });

    // Get all open positions
    const positions = await prisma.position.findMany({
      where: { status: "OPEN" },
      include: { market: true },
    });

    if (positions.length === 0) {
      console.log("[Reconcile] No open positions to reconcile");
    } else {
      console.log(`[Reconcile] Reconciling ${positions.length} open positions`);

      // TODO: MVP1 - Fetch actual positions from CLOB API
      // const clobPositions = await fetchPositions();

      // For MVP0, just update mark prices from market data
      for (const position of positions) {
        const markPrice =
          position.side === "YES"
            ? position.market.yesPrice
            : position.market.noPrice;

        if (markPrice !== null) {
          const size = Number(position.size);
          const avgEntry = Number(position.avgEntry);
          const unrealizedPnl = size * (Number(markPrice) - avgEntry);

          await prisma.position.update({
            where: { id: position.id },
            data: {
              markPrice,
              unrealizedPnl,
            },
          });
        }
      }

      await prisma.log.create({
        data: {
          level: "INFO",
          category: "RECONCILE",
          message: `Reconciled ${positions.length} positions`,
          metadata: { positionCount: positions.length },
        },
      });

      console.log(`[Reconcile] Completed for ${positions.length} positions`);
    }

    // Market maker inventory reconciliation against on-chain positions
    const marketMakers = await prisma.marketMaker.findMany({
      include: {
        market: {
          select: {
            slug: true,
            clobTokenIds: true,
          },
        },
      },
    });

    if (marketMakers.length === 0) {
      console.log("[Reconcile] No market makers to reconcile");
      return;
    }

    const trackedInventoryTotal = marketMakers.reduce((sum, mm) => {
      return (
        sum +
        Math.abs(Number(mm.yesInventory)) +
        Math.abs(Number(mm.noInventory))
      );
    }, 0);

    const dataApiPositions = await getPositions(undefined, {
      sizeThreshold: 0,
      limit: 500,
    });
    if (!dataApiPositions) {
      console.warn("[Reconcile] Data API unavailable; skipping MM reconciliation");
      await prisma.log.create({
        data: {
          level: "WARN",
          category: "RECONCILE",
          message: "Data API unavailable during MM reconciliation",
        },
      });
      return;
    }

    if (dataApiPositions.length === 0 && trackedInventoryTotal > 0) {
      console.warn(
        "[Reconcile] No Data API positions returned while MM inventory exists; skipping MM reconciliation"
      );
      await prisma.log.create({
        data: {
          level: "WARN",
          category: "RECONCILE",
          message: "No Data API positions returned while MM inventory exists",
          metadata: { trackedInventoryTotal },
        },
      });
      return;
    }

    const positionsByAsset = new Map<string, number>();
    for (const position of dataApiPositions) {
      positionsByAsset.set(position.asset, position.size);
    }

    let driftCount = 0;

    for (const mm of marketMakers) {
      const tokenIds = mm.market?.clobTokenIds || [];
      const yesTokenId = tokenIds[0];
      const noTokenId = tokenIds[1];

      if (!yesTokenId || !noTokenId) {
        console.warn(
          `[Reconcile] Missing clobTokenIds for MM ${mm.id} (${mm.market?.slug || "unknown"})`
        );
        continue;
      }

      const trackedYes = Number(mm.yesInventory);
      const trackedNo = Number(mm.noInventory);
      const actualYes = positionsByAsset.get(yesTokenId) ?? 0;
      const actualNo = positionsByAsset.get(noTokenId) ?? 0;
      const yesDrift = trackedYes - actualYes;
      const noDrift = trackedNo - actualNo;

      if (
        Math.abs(yesDrift) >= INVENTORY_DRIFT_THRESHOLD ||
        Math.abs(noDrift) >= INVENTORY_DRIFT_THRESHOLD
      ) {
        driftCount++;

        // Analyze the cause of drift for each outcome with significant drift
        const driftAnalysis: Record<string, unknown> = {};

        if (Math.abs(yesDrift) >= INVENTORY_DRIFT_THRESHOLD) {
          const yesAnalysis = await analyzeDriftCause(mm, "YES", trackedYes, actualYes);
          driftAnalysis.yesCause = yesAnalysis.likelyCause;
          driftAnalysis.yesDetails = yesAnalysis.details;
          console.log(
            `[Reconcile] YES drift for ${mm.market?.slug}: ${yesAnalysis.likelyCause} - ${yesAnalysis.details.explanation || ""}`
          );
        }

        if (Math.abs(noDrift) >= INVENTORY_DRIFT_THRESHOLD) {
          const noAnalysis = await analyzeDriftCause(mm, "NO", trackedNo, actualNo);
          driftAnalysis.noCause = noAnalysis.likelyCause;
          driftAnalysis.noDetails = noAnalysis.details;
          console.log(
            `[Reconcile] NO drift for ${mm.market?.slug}: ${noAnalysis.likelyCause} - ${noAnalysis.details.explanation || ""}`
          );
        }

        await prisma.log.create({
          data: {
            level: "WARN",
            category: "RECONCILE",
            message: "Market maker inventory drift detected",
            metadata: {
              marketMakerId: mm.id,
              marketSlug: mm.market?.slug,
              yesTokenId,
              noTokenId,
              trackedYes,
              trackedNo,
              actualYes,
              actualNo,
              yesDrift,
              noDrift,
              threshold: INVENTORY_DRIFT_THRESHOLD,
              ...driftAnalysis,
            },
          },
        });
      }
    }

    if (driftCount > 0) {
      await prisma.log.create({
        data: {
          level: "WARN",
          category: "RECONCILE",
          message: `Market maker inventory drift detected in ${driftCount} markets`,
          metadata: {
            driftCount,
            threshold: INVENTORY_DRIFT_THRESHOLD,
          },
        },
      });
    }
  } catch (error) {
    console.error("[Reconcile] Error:", error);
    await prisma.log.create({
      data: {
        level: "ERROR",
        category: "RECONCILE",
        message: `Reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { stack: error instanceof Error ? error.stack : undefined },
      },
    });
    throw error;
  }
}
