import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const positions = await prisma.position.findMany({
      include: {
        market: {
          select: {
            slug: true,
            question: true,
            category: true,
            endDate: true,
            active: true,
          },
        },
      },
      orderBy: [{ status: "asc" }, { openedAt: "desc" }],
    });

    // Calculate summary
    let totalCost = 0;
    let totalValue = 0;
    let unrealizedPnl = 0;
    let openCount = 0;

    const serialized = positions.map((p) => {
      const cost = Number(p.totalCost);
      const mark = p.markPrice ? Number(p.markPrice) : Number(p.avgEntry);
      const size = Number(p.size);
      const value = size * mark;
      const pnl = p.unrealizedPnl ? Number(p.unrealizedPnl) : value - cost;

      if (p.status === "OPEN") {
        totalCost += cost;
        totalValue += value;
        unrealizedPnl += pnl;
        openCount++;
      }

      return {
        id: p.id,
        marketId: p.marketId,
        side: p.side,
        size: Number(p.size),
        avgEntry: Number(p.avgEntry),
        totalCost: cost,
        markPrice: mark,
        unrealizedPnl: pnl,
        takeProfitPrice: p.takeProfitPrice ? Number(p.takeProfitPrice) : null,
        status: p.status,
        openedAt: p.openedAt.toISOString(),
        market: {
          slug: p.market.slug,
          question: p.market.question,
          category: p.market.category,
          endDate: p.market.endDate?.toISOString() || null,
          active: p.market.active,
        },
      };
    });

    return NextResponse.json({
      positions: serialized,
      summary: {
        totalCost: Math.round(totalCost * 100) / 100,
        totalValue: Math.round(totalValue * 100) / 100,
        unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
        openCount,
      },
    });
  } catch (error) {
    console.error("Failed to fetch portfolio:", error);
    return NextResponse.json(
      { error: "Failed to fetch portfolio" },
      { status: 500 }
    );
  }
}
