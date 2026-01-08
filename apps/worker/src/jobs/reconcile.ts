import { prisma } from "../lib/db.js";
// import { fetchPositions } from "@favored/shared/polymarket";

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
      return;
    }

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
