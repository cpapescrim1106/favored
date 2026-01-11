import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/market-making/[id]/history
 * Get quote history for a market maker
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const searchParams = request.nextUrl.searchParams;
    const limit = Number(searchParams.get("limit") || 50);
    const offset = Number(searchParams.get("offset") || 0);

    // Check if market maker exists
    const marketMaker = await prisma.marketMaker.findUnique({
      where: { id },
      select: {
        id: true,
        market: {
          select: {
            slug: true,
          },
        },
      },
    });

    if (!marketMaker) {
      return NextResponse.json(
        { error: "Market maker not found" },
        { status: 404 }
      );
    }

    // Get quote history
    const [history, total] = await Promise.all([
      prisma.quoteHistory.findMany({
        where: { marketMakerId: id },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.quoteHistory.count({
        where: { marketMakerId: id },
      }),
    ]);

    return NextResponse.json({
      marketMakerId: id,
      marketSlug: marketMaker.market?.slug,
      total,
      limit,
      offset,
      history: history.map((h) => ({
        id: h.id,
        action: h.action,
        outcome: h.outcome,
        side: h.side,
        price: h.price ? Number(h.price) : null,
        size: h.size ? Number(h.size) : null,
        orderId: h.orderId,
        metadata: h.metadata,
        createdAt: h.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error("Failed to fetch quote history:", error);
    return NextResponse.json(
      { error: "Failed to fetch quote history" },
      { status: 500 }
    );
  }
}
