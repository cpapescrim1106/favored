import { prisma } from "../lib/db.js";
import { getPositions } from "@favored/shared";

const INVENTORY_DRIFT_THRESHOLD = Number(
  process.env.MM_INVENTORY_DRIFT_THRESHOLD ?? 1
);

export async function runReconcileJob(): Promise<void> {
  console.log("[Reconcile] Starting reconciliation...");

  try {
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
