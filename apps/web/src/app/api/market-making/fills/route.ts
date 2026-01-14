import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [fills, count] = await Promise.all([
      prisma.marketMakerFill.findMany({
        where: {
          filledAt: { gte: since24h },
          side: "SELL",
        },
        include: {
          marketMaker: {
            include: {
              market: {
                select: {
                  slug: true,
                  question: true,
                },
              },
            },
          },
        },
        orderBy: { filledAt: "desc" },
      }),
      prisma.marketMakerFill.count({
        where: {
          filledAt: { gte: since24h },
          side: "SELL",
        },
      }),
    ]);

    return NextResponse.json({
      count,
      fills: fills.map((fill) => ({
        id: fill.id,
        orderId: fill.orderId,
        marketSlug: fill.marketMaker.market?.slug ?? "unknown",
        marketQuestion: fill.marketMaker.market?.question ?? "",
        outcome: fill.outcome,
        side: fill.side,
        size: Number(fill.size),
        price: Number(fill.price),
        filledAt: fill.filledAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error("Failed to fetch market maker fills:", error);
    return NextResponse.json(
      { error: "Failed to fetch fills" },
      { status: 500 }
    );
  }
}
