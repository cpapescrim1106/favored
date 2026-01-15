import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { getTickSizeForPrice, type PriceRange } from "@favored/shared";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type UniverseMarket = {
  marketId: string;
  slug: string;
  question: string;
  category: string | null;
  endDate: string | null;
  venue: "POLYMARKET" | "KALSHI";
  volume24h: number;
  midPrice: number | null;
  spreadTicks: number | null;
  lastUpdated: string | null;
};

const parsePriceRanges = (value: unknown): PriceRange[] | null => {
  if (!Array.isArray(value)) return null;
  const ranges = value
    .map((range) => ({
      start: Number((range as { start?: number | string }).start),
      end: Number((range as { end?: number | string }).end),
      step: Number((range as { step?: number | string }).step),
    }))
    .filter((range) =>
      Number.isFinite(range.start) &&
      Number.isFinite(range.end) &&
      Number.isFinite(range.step)
    );
  return ranges.length > 0 ? ranges : null;
};

const getMidPrice = (yesPrice: number | null, noPrice: number | null) => {
  if (yesPrice !== null && yesPrice !== undefined) return yesPrice;
  if (noPrice !== null && noPrice !== undefined) return 1 - noPrice;
  return null;
};

const clampLimit = (raw: number) =>
  Math.max(1, Math.min(Number.isFinite(raw) ? raw : DEFAULT_LIMIT, MAX_LIMIT));

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const limit = clampLimit(Number(searchParams.get("limit") || DEFAULT_LIMIT));
    const venueParam = (searchParams.get("venue") || "all").toUpperCase();
    const venueFilter =
      venueParam === "POLYMARKET" || venueParam === "KALSHI"
        ? venueParam
        : "ALL";
    const categoryParam = searchParams.get("category");

    const where = {
      active: true,
      ...(venueFilter === "ALL" ? {} : { venue: venueFilter }),
      ...(categoryParam ? { category: categoryParam } : {}),
      marketMaker: null,
    } as const;

    const [markets, total] = await Promise.all([
      prisma.market.findMany({
        where,
        orderBy: { volume24h: "desc" },
        take: limit,
        select: {
          id: true,
          slug: true,
          question: true,
          category: true,
          endDate: true,
          venue: true,
          volume24h: true,
          yesPrice: true,
          noPrice: true,
          spread: true,
          priceRanges: true,
          lastUpdated: true,
        },
      }),
      prisma.market.count({ where }),
    ]);

    const universeMarkets: UniverseMarket[] = markets.map((market) => {
      const yesPrice = market.yesPrice !== null ? Number(market.yesPrice) : null;
      const noPrice = market.noPrice !== null ? Number(market.noPrice) : null;
      const midPrice = getMidPrice(yesPrice, noPrice);
      const ranges = parsePriceRanges(market.priceRanges ?? null);
      const tickSize = getTickSizeForPrice(midPrice ?? 0.5, ranges);
      const spread =
        market.spread !== null && market.spread !== undefined
          ? Number(market.spread)
          : null;
      const spreadTicks =
        spread !== null && tickSize > 0 ? Math.round(spread / tickSize) : null;

      return {
        marketId: market.id,
        slug: market.slug,
        question: market.question,
        category: market.category,
        endDate: market.endDate ? market.endDate.toISOString() : null,
        venue: market.venue,
        volume24h: market.volume24h ? Number(market.volume24h) : 0,
        midPrice,
        spreadTicks,
        lastUpdated: market.lastUpdated ? market.lastUpdated.toISOString() : null,
      };
    });

    return NextResponse.json({
      total,
      markets: universeMarkets,
    });
  } catch (error) {
    console.error("[MM Universe] Failed to fetch universe markets:", error);
    return NextResponse.json(
      { error: "Failed to fetch universe markets" },
      { status: 500 }
    );
  }
}
