import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    // Get the current draft basket (or most recent)
    const basket = await prisma.basket.findFirst({
      where: { status: "DRAFT" },
      include: {
        items: {
          include: {
            market: {
              select: {
                slug: true,
                question: true,
                category: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    if (!basket) {
      return NextResponse.json({ basket: null });
    }

    // Serialize
    const serialized = {
      id: basket.id,
      status: basket.status,
      totalStake: Number(basket.totalStake),
      itemCount: basket.itemCount,
      batchCount: basket.batchCount,
      createdAt: basket.createdAt.toISOString(),
      items: basket.items.map((item) => ({
        id: item.id,
        marketId: item.marketId,
        side: item.side,
        stake: Number(item.stake),
        limitPrice: Number(item.limitPrice),
        snapshotPrice: Number(item.snapshotPrice),
        status: item.status,
        market: item.market,
      })),
    };

    return NextResponse.json({ basket: serialized });
  } catch (error) {
    console.error("Failed to fetch basket:", error);
    return NextResponse.json({ error: "Failed to fetch basket" }, { status: 500 });
  }
}

export async function POST() {
  try {
    // Create a new draft basket
    const basket = await prisma.basket.create({
      data: {
        status: "DRAFT",
        totalStake: 0,
        itemCount: 0,
        batchCount: 0,
      },
    });

    return NextResponse.json({
      basket: {
        id: basket.id,
        status: basket.status,
        totalStake: 0,
        itemCount: 0,
        batchCount: 0,
      },
    });
  } catch (error) {
    console.error("Failed to create basket:", error);
    return NextResponse.json({ error: "Failed to create basket" }, { status: 500 });
  }
}
