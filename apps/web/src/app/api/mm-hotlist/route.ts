import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { getTickSizeForPrice, type PriceRange } from "@favored/shared";

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;
const DEFAULT_MIN_VOLUME = 250;

type HotMarket = {
  marketId: string;
  question: string;
  category: string | null;
  endDate: string | null;
  venue: "POLYMARKET" | "KALSHI";
  volume24h: number;
  midPrice: number | null;
  spreadTicks: number | null;
  score: number | null;
  scoredAt: string | null;
  reason: string;
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
    const minVolume = Number(searchParams.get("minVolume24h") || DEFAULT_MIN_VOLUME);

    const where = {
      active: true,
      ...(venueFilter === "ALL" ? {} : { venue: venueFilter }),
      volume24h: { gte: minVolume },
      marketMaker: null,
    } as const;

    const markets = await prisma.market.findMany({
      where,
      orderBy: { volume24h: "desc" },
      take: limit,
      select: {
        id: true,
        question: true,
        category: true,
        endDate: true,
        venue: true,
        volume24h: true,
        yesPrice: true,
        noPrice: true,
        spread: true,
        priceRanges: true,
      },
    });

    const marketIds = markets.map((market) => market.id);
    const scores = await prisma.mmCandidate.findMany({
      where: { marketId: { in: marketIds } },
      select: { marketId: true, totalScore: true, scoredAt: true },
    });
    const scoresById = new Map(
      scores.map((score) => [score.marketId, score])
    );

    const hotMarkets: HotMarket[] = markets.map((market) => {
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
      const volume24h = market.volume24h ? Number(market.volume24h) : 0;
      const scoreEntry = scoresById.get(market.id);
      const score =
        scoreEntry && scoreEntry.totalScore !== null
          ? Number(scoreEntry.totalScore)
          : null;
      const scoredAt = scoreEntry?.scoredAt
        ? scoreEntry.scoredAt.toISOString()
        : null;

      const reason =
        volume24h >= 1_000_000
          ? "High 24h volume"
          : volume24h >= 100_000
          ? "Active volume"
          : "Recent flow";

      return {
        marketId: market.id,
        question: market.question,
        category: market.category,
        endDate: market.endDate ? market.endDate.toISOString() : null,
        venue: market.venue,
        volume24h,
        midPrice,
        spreadTicks,
        score,
        scoredAt,
        reason,
      };
    });

    return NextResponse.json({
      total: hotMarkets.length,
      markets: hotMarkets,
    });
  } catch (error) {
    console.error("[MM Hotlist] Failed to fetch hot list:", error);
    return NextResponse.json(
      { error: "Failed to fetch hot list" },
      { status: 500 }
    );
  }
}
