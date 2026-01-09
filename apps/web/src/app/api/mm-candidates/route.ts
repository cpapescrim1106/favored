import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import {
  getOrderbook,
  screenMarketForMM,
  DEFAULT_MM_SCREENING_PARAMS,
  type MMScreeningParams,
  type MMScreeningResult,
} from "@favored/shared";

// Rate limit orderbook fetches
const ORDERBOOK_DELAY_MS = 50;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET /api/mm-candidates
 * Screen markets for MM viability and return scored candidates
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const limit = Number(searchParams.get("limit") || 50);
    const eligibleOnly = searchParams.get("eligibleOnly") !== "false";
    const minScore = Number(searchParams.get("minScore") || 0);

    // Get custom params if provided
    const params: MMScreeningParams = { ...DEFAULT_MM_SCREENING_PARAMS };
    if (searchParams.has("minVolume24h")) {
      params.minVolume24h = Number(searchParams.get("minVolume24h"));
    }
    if (searchParams.has("maxSpreadTicks")) {
      params.maxSpreadTicks = Number(searchParams.get("maxSpreadTicks"));
    }
    if (searchParams.has("minTimeToEndHours")) {
      params.minTimeToEndHours = Number(searchParams.get("minTimeToEndHours"));
    }

    // Fetch active markets from DB
    // Pre-filter: must have decent volume and not already have a market maker
    const markets = await prisma.market.findMany({
      where: {
        active: true,
        marketMaker: null, // Not already being made
        volume24h: {
          gte: params.minVolume24h * 0.5, // Looser filter, let scoring handle it
        },
        // Must have end date in the future
        OR: [
          { endDate: null },
          { endDate: { gt: new Date() } },
        ],
      },
      orderBy: { volume24h: "desc" },
      take: limit * 2, // Fetch extra since some will be filtered
    });

    console.log(`[MM Candidates] Screening ${markets.length} markets...`);

    const results: MMScreeningResult[] = [];

    // Screen each market
    for (const market of markets) {
      try {
        // Fetch orderbook from CLOB
        const book = await getOrderbook(market.id);

        // Screen the market
        const result = screenMarketForMM(
          {
            id: market.id,
            slug: market.slug,
            question: market.question,
            category: market.category,
            endDate: market.endDate,
            yesPrice: market.yesPrice ? Number(market.yesPrice) : null,
            volume24h: market.volume24h ? Number(market.volume24h) : 0,
          },
          book,
          params
        );

        // Filter based on eligibility and score
        if (eligibleOnly && !result.eligible) continue;
        if (result.totalScore < minScore) continue;

        results.push(result);

        // Stop if we have enough
        if (results.length >= limit) break;

        // Rate limit
        await delay(ORDERBOOK_DELAY_MS);
      } catch (error) {
        console.error(`[MM Candidates] Error screening ${market.slug}:`, error);
        // Continue with other markets
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.totalScore - a.totalScore);

    return NextResponse.json({
      total: results.length,
      params,
      candidates: results.map((r) => ({
        marketId: r.marketId,
        slug: r.slug,
        question: r.question,
        category: r.category,
        endDate: r.endDate,
        midPrice: r.midPrice,
        spreadTicks: r.spreadTicks,
        spreadPercent: r.spreadPercent,
        topDepth: r.topDepthNotional,
        depth3c: r.depth3cTotal,
        bookSlope: r.bookSlope,
        volume24h: r.volume24h,
        hoursToEnd: r.hoursToEnd,
        scores: {
          liquidity: r.liquidityScore,
          flow: r.flowScore,
          time: r.timeScore,
          priceZone: r.priceZoneScore,
          total: r.totalScore,
        },
        flags: r.flags,
        eligible: r.eligible,
        disqualifyReasons: r.disqualifyReasons,
      })),
    });
  } catch (error) {
    console.error("[MM Candidates] Failed to screen markets:", error);
    return NextResponse.json(
      { error: "Failed to screen markets" },
      { status: 500 }
    );
  }
}
