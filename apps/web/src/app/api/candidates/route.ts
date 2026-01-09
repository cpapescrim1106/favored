import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const minScore = Number(searchParams.get("minScore") || 0);
    const limit = Number(searchParams.get("limit") || 1000);

    // Get the most recent scan ID
    const latestScan = await prisma.candidate.findFirst({
      orderBy: { scannedAt: "desc" },
      select: { scanId: true, scannedAt: true },
    });

    if (!latestScan) {
      return NextResponse.json({
        candidates: [],
        lastScan: null,
      });
    }

    // Get candidates from the latest scan
    const candidates = await prisma.candidate.findMany({
      where: {
        scanId: latestScan.scanId,
        score: { gte: minScore },
      },
      include: {
        market: {
          select: {
            slug: true,
            question: true,
            category: true,
            endDate: true,
            yesPrice: true,
            noPrice: true,
            liquidity: true,
            spread: true,
          },
        },
      },
      orderBy: { score: "desc" },
      take: limit,
    });

    // Convert Decimals to numbers for JSON serialization
    const serialized = candidates.map((c) => ({
      id: c.id,
      marketId: c.marketId,
      side: c.side,
      outcomeName: c.outcomeName || c.side, // Fallback to side for old data
      impliedProb: Number(c.impliedProb),
      score: Number(c.score),
      spreadOk: c.spreadOk,
      liquidityOk: c.liquidityOk,
      scannedAt: c.scannedAt.toISOString(),
      market: {
        slug: c.market.slug,
        question: c.market.question,
        category: c.market.category,
        endDate: c.market.endDate?.toISOString() || null,
        yesPrice: c.market.yesPrice ? Number(c.market.yesPrice) : null,
        noPrice: c.market.noPrice ? Number(c.market.noPrice) : null,
        liquidity: c.market.liquidity ? Number(c.market.liquidity) : null,
        spread: c.market.spread ? Number(c.market.spread) : null,
      },
    }));

    return NextResponse.json({
      candidates: serialized,
      lastScan: latestScan.scannedAt.toISOString(),
    });
  } catch (error) {
    console.error("Failed to fetch candidates:", error);
    return NextResponse.json(
      { error: "Failed to fetch candidates" },
      { status: 500 }
    );
  }
}
