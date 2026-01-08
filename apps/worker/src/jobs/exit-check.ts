import { prisma } from "../lib/db.js";

export async function runExitCheckJob(): Promise<void> {
  console.log("[ExitCheck] Checking for exit conditions...");

  try {
    // Get config
    const config = await prisma.config.findUnique({
      where: { id: "singleton" },
    });

    if (!config) {
      console.log("[ExitCheck] No config found, skipping");
      return;
    }

    // Get all open positions with updated marks
    const positions = await prisma.position.findMany({
      where: { status: "OPEN" },
      include: { market: true },
    });

    if (positions.length === 0) {
      console.log("[ExitCheck] No open positions to check");
      return;
    }

    const takeProfitThreshold = Number(config.takeProfitThreshold);
    const exitCandidates: string[] = [];

    for (const position of positions) {
      const markPrice = Number(position.markPrice || 0);

      // Check take-profit condition
      // If we're long YES and price >= threshold, we can exit profitably
      if (markPrice >= takeProfitThreshold) {
        exitCandidates.push(position.id);
        console.log(
          `[ExitCheck] Position ${position.id} (${position.market.slug} ${position.side}) hit take-profit: ${markPrice} >= ${takeProfitThreshold}`
        );
      }

      // Check if market is closed/resolved
      if (!position.market.active) {
        exitCandidates.push(position.id);
        console.log(
          `[ExitCheck] Position ${position.id} (${position.market.slug}) market is no longer active`
        );
      }

      // Check if market end date has passed
      if (position.market.endDate && new Date(position.market.endDate) < new Date()) {
        exitCandidates.push(position.id);
        console.log(
          `[ExitCheck] Position ${position.id} (${position.market.slug}) market has ended`
        );
      }
    }

    if (exitCandidates.length > 0) {
      // Log exit candidates (MVP0 - shadow mode, no actual exits)
      await prisma.log.create({
        data: {
          level: "INFO",
          category: "EXIT",
          message: `Found ${exitCandidates.length} positions eligible for exit (shadow mode - no action taken)`,
          metadata: {
            positionIds: exitCandidates,
            mode: "shadow",
          },
        },
      });

      console.log(
        `[ExitCheck] ${exitCandidates.length} positions would exit (shadow mode)`
      );

      // TODO: MVP1+ - Actually create exit orders
      // for (const positionId of exitCandidates) {
      //   await createExitOrder(positionId);
      // }
    } else {
      console.log("[ExitCheck] No positions need to exit");
    }
  } catch (error) {
    console.error("[ExitCheck] Error:", error);
    await prisma.log.create({
      data: {
        level: "ERROR",
        category: "EXIT",
        message: `Exit check failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { stack: error instanceof Error ? error.stack : undefined },
      },
    });
    throw error;
  }
}
