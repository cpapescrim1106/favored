import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";

export async function POST() {
  try {
    // Check kill switch
    const config = await prisma.config.findUnique({
      where: { id: "singleton" },
    });

    if (config?.killSwitchActive) {
      return NextResponse.json(
        { error: "Kill switch is active" },
        { status: 403 }
      );
    }

    // Log the reconcile request
    await prisma.log.create({
      data: {
        level: "INFO",
        category: "RECONCILE",
        message: "Manual reconciliation triggered from UI",
      },
    });

    // Get all open positions
    const positions = await prisma.position.findMany({
      where: { status: "OPEN" },
      include: { market: true },
    });

    let updated = 0;

    // Update mark prices from market data
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
        updated++;
      }
    }

    return NextResponse.json({
      success: true,
      message: `Reconciled ${updated} positions`,
      positionsUpdated: updated,
    });
  } catch (error) {
    console.error("Failed to reconcile:", error);
    return NextResponse.json(
      { error: "Failed to reconcile" },
      { status: 500 }
    );
  }
}
