import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import {
  getOrderbook,
  getMidpointPrice,
  getSpread,
  screenMarketForMM,
  DEFAULT_MM_SCREENING_PARAMS,
  type MMScreeningParams,
  type MMScreeningResult,
  calculateMidPriceFromBook,
  getTickSizeForPrice,
  getVenueAdapter,
  registerDefaultVenues,
  kalshiRequest,
  type PriceRange,
} from "@favored/shared";

// Rate limit orderbook fetches
const ORDERBOOK_DELAY_MS = 50;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const KALSHI_TRADE_LOOKBACK_SECONDS = 60 * 60;
const KALSHI_MIN_RECENT_TRADES = 1;
const KALSHI_MIN_VOLUME_24H = 100;
const KALSHI_TRADE_LIMIT = 25;
const KALSHI_SOFT_DISQUALIFY_PREFIXES = [
  "Top depth too thin",
  "Depth within 3c too thin",
  "YES bid too thin",
  "YES ask too thin",
  "NO bid too thin",
  "NO ask too thin",
  "Queue too slow",
  "Volume too low",
];

const isKalshiHardReason = (reason: string) =>
  !KALSHI_SOFT_DISQUALIFY_PREFIXES.some((prefix) => reason.startsWith(prefix));
const isKalshiComboMarket = (marketId: string, eventTicker?: string | null) => {
  const normalizedId = marketId.toUpperCase();
  const normalizedEvent = eventTicker ? eventTicker.toUpperCase() : "";
  return normalizedId.startsWith("KXMVE") || normalizedEvent.startsWith("KXMVE");
};

async function fetchKalshiRecentTrades(ticker: string) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const minTs = nowSeconds - KALSHI_TRADE_LOOKBACK_SECONDS;
  const response = await kalshiRequest<{
    trades?: Array<{ count?: number; created_time?: string }>;
  }>({
    method: "GET",
    path: "/markets/trades",
    query: {
      ticker,
      limit: KALSHI_TRADE_LIMIT,
      min_ts: minTs,
    },
  });
  const trades = Array.isArray(response.trades) ? response.trades : [];
  const recentTradeVolume = trades.reduce(
    (sum, trade) => sum + (typeof trade.count === "number" ? trade.count : 0),
    0
  );
  const lastTradeAt =
    trades.length > 0 && trades[0].created_time
      ? new Date(trades[0].created_time)
      : null;
  return {
    tradeCount: trades.length,
    recentTradeVolume,
    lastTradeAt,
  };
}

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
    const venueParam = (searchParams.get("venue") || "all").toUpperCase();
    const venueFilter =
      venueParam === "POLYMARKET" || venueParam === "KALSHI"
        ? venueParam
        : "ALL";
    const wantsPolymarket = venueFilter === "ALL" || venueFilter === "POLYMARKET";
    const wantsKalshi = venueFilter === "ALL" || venueFilter === "KALSHI";

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

    type ScoredResult = MMScreeningResult & {
      venue: "POLYMARKET" | "KALSHI";
    };
    const results: ScoredResult[] = [];
    const takeCount = limit * 3;

    if (wantsPolymarket) {
      // Fetch active Polymarket markets from DB
      // Pre-filter: must have decent volume, valid price range, clobTokenIds, and no market maker
      const markets = await prisma.market.findMany({
        where: {
          active: true,
          venue: "POLYMARKET",
          marketMaker: null, // Not already being made
          volume24h: {
            gte: params.minVolume24h * 0.5, // Looser filter, let scoring handle it
          },
          // Exclude extreme probabilities (below excludeMidLt or above excludeMidGt)
          yesPrice: {
            gte: params.excludeMidLt,
            lte: params.excludeMidGt,
          },
          // Must have clobTokenIds for orderbook access
          clobTokenIds: {
            isEmpty: false,
          },
          // Must have end date in the future
          OR: [
            { endDate: null },
            { endDate: { gt: new Date() } },
          ],
        },
        orderBy: { volume24h: "desc" },
        take: takeCount, // Fetch extra since some will be filtered
      });

      console.log(`[MM Candidates] Screening ${markets.length} Polymarket markets...`);

      // Screen each market
      for (const market of markets) {
        try {
          // Get YES/NO token IDs from clobTokenIds (YES first, NO second)
          const yesTokenId = market.clobTokenIds?.[0];
          const noTokenId = market.clobTokenIds?.[1];
          if (!yesTokenId) {
            console.log(`[MM Candidates] Skipping ${market.slug} - no clobTokenIds`);
            continue;
          }

          // Fetch YES orderbook, midpoint, and spread from CLOB in parallel
          const [yesBook, yesMidpoint, yesSpread] = await Promise.all([
            getOrderbook(yesTokenId),
            getMidpointPrice(yesTokenId),
            getSpread(yesTokenId),
          ]);

          // Fetch NO book if available
          let noBook = undefined;
          let noMidpoint: number | null = null;
          let noSpread: number | null = null;
          if (noTokenId) {
            [noBook, noMidpoint, noSpread] = await Promise.all([
              getOrderbook(noTokenId),
              getMidpointPrice(noTokenId),
              getSpread(noTokenId),
            ]);
          }

          // Screen the market with CLOB pricing (more accurate than raw book)
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
            yesBook,
            params,
            {
              yes: { midpoint: yesMidpoint, spread: yesSpread },
              no: noTokenId ? { midpoint: noMidpoint, spread: noSpread } : undefined,
            },
            noBook
          );

          // Filter based on eligibility and score
          if (eligibleOnly && !result.eligible) continue;
          if (result.totalScore < minScore) continue;

          results.push({ ...result, venue: "POLYMARKET" });

          // Stop if we have enough (single-venue search)
          if (!wantsKalshi && results.length >= limit) break;

          // Rate limit
          await delay(ORDERBOOK_DELAY_MS);
        } catch (error) {
          console.error(`[MM Candidates] Error screening ${market.slug}:`, error);
          // Continue with other markets
        }
      }
    }

    if (wantsKalshi) {
      registerDefaultVenues();
      const adapter = getVenueAdapter("kalshi");
      const kalshiParams: MMScreeningParams = {
        ...params,
        minVolume24h: Math.min(params.minVolume24h, KALSHI_MIN_VOLUME_24H),
        minQueueSpeed: Math.min(params.minQueueSpeed, 0.25),
        minTopDepthNotional: Math.min(params.minTopDepthNotional, 100),
        minDepthWithin3cNotional: Math.min(params.minDepthWithin3cNotional, 500),
        minDepthEachSideWithin3c: Math.min(params.minDepthEachSideWithin3c, 150),
        depthRangeCents: 2,
      };

      const markets = await prisma.market.findMany({
        where: {
          active: true,
          venue: "KALSHI",
          marketMaker: null,
          OR: [
            { endDate: null },
            { endDate: { gt: new Date() } },
          ],
        },
        orderBy: { volume24h: "desc" },
        take: takeCount,
      });

      console.log(`[MM Candidates] Screening ${markets.length} Kalshi markets...`);

      for (const market of markets) {
        if (isKalshiComboMarket(market.id, market.eventTicker)) {
          continue;
        }
        try {
          const orderbook = await adapter.getOrderbookSnapshot(market.id);
          const priceRanges = Array.isArray(market.priceRanges)
            ? (market.priceRanges as unknown as PriceRange[])
            : null;
          const midReference =
            market.yesPrice !== null && market.yesPrice !== undefined
              ? Number(market.yesPrice)
              : calculateMidPriceFromBook(orderbook.yes) ?? 0.5;
          const tickSize = getTickSizeForPrice(midReference, priceRanges);

          const result = screenMarketForMM(
            {
              id: market.id,
              slug: market.slug,
              question: market.question,
              category: market.category,
              endDate: market.endDate,
              yesPrice: market.yesPrice ? Number(market.yesPrice) : null,
              volume24h: market.volume24h ? Number(market.volume24h) : 0,
              tickSize,
            },
            orderbook.yes,
            kalshiParams,
            undefined,
            orderbook.no
          );

          const hardReasons = result.disqualifyReasons.filter(isKalshiHardReason);
          let eligible = hardReasons.length === 0;

          if (eligible) {
            let activityOk =
              (market.volume24h ? Number(market.volume24h) : 0) >=
              KALSHI_MIN_VOLUME_24H;
            if (!activityOk) {
              const tradeStats = await fetchKalshiRecentTrades(market.id);
              activityOk = tradeStats.tradeCount >= KALSHI_MIN_RECENT_TRADES;
            }
            if (!activityOk) {
              hardReasons.push("Insufficient recent trade activity");
            }
            eligible = activityOk;
          }

          const adjustedResult: MMScreeningResult = {
            ...result,
            eligible,
            disqualifyReasons: hardReasons,
          };

          if (eligibleOnly && !adjustedResult.eligible) continue;
          if (adjustedResult.totalScore < minScore) continue;

          results.push({ ...adjustedResult, venue: "KALSHI" });

          if (!wantsPolymarket && results.length >= limit) break;

          await delay(ORDERBOOK_DELAY_MS);
        } catch (error) {
          console.error(`[MM Candidates] Error screening ${market.slug}:`, error);
        }
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.totalScore - a.totalScore);
    const sliced = results.slice(0, limit);

    if (venueFilter === "ALL" && limit > 1) {
      const hasKalshi = sliced.some((r) => r.venue === "KALSHI");
      const hasPoly = sliced.some((r) => r.venue === "POLYMARKET");
      if (!hasKalshi || !hasPoly) {
        const kalshiResults = results.filter((r) => r.venue === "KALSHI");
        const polyResults = results.filter((r) => r.venue === "POLYMARKET");
        const replacements: Array<"KALSHI" | "POLYMARKET"> = [];
        if (!hasKalshi && kalshiResults.length > 0) replacements.push("KALSHI");
        if (!hasPoly && polyResults.length > 0) replacements.push("POLYMARKET");

        let replaceIndex = sliced.length - 1;
        for (const venue of replacements) {
          const pool = venue === "KALSHI" ? kalshiResults : polyResults;
          const candidate = pool.find(
            (item) => !sliced.some((existing) => existing.marketId === item.marketId)
          );
          if (candidate && replaceIndex >= 0) {
            sliced[replaceIndex] = candidate;
            replaceIndex -= 1;
          }
        }
      }
    }

    return NextResponse.json({
      total: sliced.length,
      params,
      candidates: sliced.map((r) => ({
        marketId: r.marketId,
        slug: r.slug,
        question: r.question,
        category: r.category,
        endDate: r.endDate,
        venue: r.venue,
        midPrice: r.midPrice,
        spreadTicks: r.spreadTicks,
        spreadPercent: r.spreadPercent,
        topDepth: r.topDepthNotional,
        depth3c: r.depth3cTotal,
        bookSlope: r.bookSlope,
        volume24h: r.volume24h,
        queueSpeed: r.queueSpeed,
        queueDepthRatio: r.queueDepthRatio,
        hoursToEnd: r.hoursToEnd,
        scores: {
          liquidity: r.liquidityScore,
          flow: r.flowScore,
          time: r.timeScore,
          priceZone: r.priceZoneScore,
          queueSpeed: r.queueSpeedScore,
          queueDepth: r.queueDepthScore,
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
