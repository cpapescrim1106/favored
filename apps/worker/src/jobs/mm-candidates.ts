import { prisma } from "../lib/db.js";
import {
  DEFAULT_MM_SCREENING_PARAMS,
  calculateMidPriceFromBook,
  getMidpointPrice,
  getOrderbook,
  getSpread,
  getTickSizeForPrice,
  kalshiRequest,
  registerDefaultVenues,
  screenMarketForMM,
  type MMScreeningParams,
  type MMScreeningResult,
  type PriceRange,
} from "@favored/shared";
import { getVenueAdapter } from "@favored/shared/venues";

const ORDERBOOK_DELAY_MS = Number(
  process.env.MM_CANDIDATES_ORDERBOOK_DELAY_MS ?? 50
);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const CANDIDATE_LIMIT = Number(process.env.MM_CANDIDATES_LIMIT ?? 200);
const POLY_STRATIFY_POOL_MULTIPLIER = 6;
const POLY_STRATIFY_MAX_CATEGORIES = 8;
const POLY_STRATIFY_MIN_PER_CATEGORY = 5;
const KALSHI_STRATIFY_POOL_MULTIPLIER = 10;
const KALSHI_STRATIFY_MAX_CATEGORIES = 8;
const KALSHI_STRATIFY_MIN_PER_CATEGORY = 5;
const KALSHI_TRADE_LOOKBACK_SECONDS = 60 * 60;
const KALSHI_TRADE_LIMIT = 25;
const KALSHI_MIN_RECENT_TRADES = 1;
const KALSHI_MIN_VOLUME_24H = 100;
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

type ScoredResult = MMScreeningResult & {
  venue: "POLYMARKET" | "KALSHI";
};

const isKalshiHardReason = (reason: string) =>
  !KALSHI_SOFT_DISQUALIFY_PREFIXES.some((prefix) => reason.startsWith(prefix));

const isKalshiComboMarket = (marketId: string, eventTicker?: string | null) => {
  const normalizedId = marketId.toUpperCase();
  const normalizedEvent = eventTicker ? eventTicker.toUpperCase() : "";
  return normalizedId.startsWith("KXMVE") || normalizedEvent.startsWith("KXMVE");
};

const getCategoryKey = (category: string | null) =>
  (category ?? "Uncategorized").trim() || "Uncategorized";

const stratifyMarkets = (
  markets: Array<{
    id: string;
    category: string | null;
    volume24h: number | null;
  }>,
  targetCount: number,
  options: {
    maxCategories: number;
    minPerCategory: number;
  }
) => {
  if (markets.length <= targetCount) return markets;

  const byCategory = new Map<string, typeof markets>();
  for (const market of markets) {
    const key = getCategoryKey(market.category).toLowerCase();
    const list = byCategory.get(key) ?? [];
    list.push(market);
    byCategory.set(key, list);
  }

  const categories = Array.from(byCategory.entries()).map(([key, list]) => ({
    key,
    totalVolume: list.reduce((sum, item) => sum + (item.volume24h ?? 0), 0),
    items: list,
  }));

  categories.sort((a, b) => b.totalVolume - a.totalVolume);
  const selectedCategories = categories.slice(0, options.maxCategories);
  if (selectedCategories.length === 0) return markets.slice(0, targetCount);

  const perCategoryQuota = Math.max(
    options.minPerCategory,
    Math.ceil(targetCount / selectedCategories.length)
  );

  const selected: typeof markets = [];
  const selectedIds = new Set<string>();

  for (const category of selectedCategories) {
    category.items.sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0));
    for (const market of category.items.slice(0, perCategoryQuota)) {
      if (selectedIds.has(market.id)) continue;
      selected.push(market);
      selectedIds.add(market.id);
    }
  }

  if (selected.length >= targetCount) {
    return selected.slice(0, targetCount);
  }

  for (const market of markets) {
    if (selectedIds.has(market.id)) continue;
    selected.push(market);
    selectedIds.add(market.id);
    if (selected.length >= targetCount) break;
  }

  return selected;
};

const toPriceRanges = (value: unknown): PriceRange[] | null => {
  if (!Array.isArray(value)) return null;
  const ranges = value
    .map((range) => ({
      start: Number((range as { start?: number | string }).start),
      end: Number((range as { end?: number | string }).end),
      step: Number((range as { step?: number | string }).step),
    }))
    .filter(
      (range) =>
        Number.isFinite(range.start) &&
        Number.isFinite(range.end) &&
        Number.isFinite(range.step)
    );
  return ranges.length > 0 ? ranges : null;
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

async function screenPolymarketMarket(
  market: {
    id: string;
    slug: string;
    question: string;
    category: string | null;
    endDate: Date | null;
    yesPrice: number | null;
    volume24h: number | null;
    clobTokenIds: string[];
  },
  params: MMScreeningParams
): Promise<ScoredResult | null> {
  const yesTokenId = market.clobTokenIds?.[0];
  const noTokenId = market.clobTokenIds?.[1];
  if (!yesTokenId) return null;

  const [yesBook, yesMidpoint, yesSpread] = await Promise.all([
    getOrderbook(yesTokenId),
    getMidpointPrice(yesTokenId),
    getSpread(yesTokenId),
  ]);

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

  const result = screenMarketForMM(
    {
      id: market.id,
      slug: market.slug,
      question: market.question,
      category: market.category,
      endDate: market.endDate,
      yesPrice: market.yesPrice,
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

  return { ...result, venue: "POLYMARKET" };
}

async function screenKalshiMarket(
  market: {
    id: string;
    slug: string;
    question: string;
    category: string | null;
    endDate: Date | null;
    yesPrice: number | null;
    volume24h: number | null;
    priceRanges: unknown;
    eventTicker: string | null;
  },
  params: MMScreeningParams
): Promise<ScoredResult | null> {
  if (isKalshiComboMarket(market.id, market.eventTicker)) {
    return null;
  }

  registerDefaultVenues();
  const adapter = getVenueAdapter("kalshi");
  const orderbook = await adapter.getOrderbookSnapshot(market.id);
  const priceRanges = toPriceRanges(market.priceRanges);
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
    params,
    undefined,
    orderbook.no
  );

  const hardReasons = result.disqualifyReasons.filter(isKalshiHardReason);
  let eligible = hardReasons.length === 0;

  if (eligible) {
    let activityOk =
      (market.volume24h ? Number(market.volume24h) : 0) >= KALSHI_MIN_VOLUME_24H;
    if (!activityOk) {
      const tradeStats = await fetchKalshiRecentTrades(market.id);
      activityOk = tradeStats.tradeCount >= KALSHI_MIN_RECENT_TRADES;
    }
    if (!activityOk) {
      hardReasons.push("Insufficient recent trade activity");
    }
    eligible = activityOk;
  }

  return {
    ...result,
    venue: "KALSHI",
    eligible,
    disqualifyReasons: hardReasons,
  };
}

const toMmCandidateData = (result: ScoredResult, scoredAt: Date) => ({
  marketId: result.marketId,
  venue: result.venue,
  midPrice: result.midPrice,
  spreadTicks: result.spreadTicks,
  spreadPercent: result.spreadPercent,
  topDepthNotional: result.topDepthNotional,
  depth3cBid: result.depth3cBid,
  depth3cAsk: result.depth3cAsk,
  depth3cTotal: result.depth3cTotal,
  bookSlope: result.bookSlope,
  volume24h: result.volume24h,
  queueSpeed: result.queueSpeed,
  queueDepthRatio: result.queueDepthRatio,
  hoursToEnd: result.hoursToEnd,
  liquidityScore: result.liquidityScore,
  flowScore: result.flowScore,
  timeScore: result.timeScore,
  priceZoneScore: result.priceZoneScore,
  queueSpeedScore: result.queueSpeedScore,
  queueDepthScore: result.queueDepthScore,
  totalScore: result.totalScore,
  eligible: result.eligible,
  flags: result.flags ?? [],
  disqualifyReasons: result.disqualifyReasons ?? [],
  scoredAt,
});

export async function runMmCandidatesJob(): Promise<void> {
  const startTime = Date.now();
  const scoredAt = new Date();
  const limit = Math.max(10, CANDIDATE_LIMIT);
  const takeCount = limit * 3;

  console.log(`[MM Candidates] Starting refresh (limit ${limit})...`);

  const params: MMScreeningParams = { ...DEFAULT_MM_SCREENING_PARAMS };

  const results: ScoredResult[] = [];

  // Polymarket scan
  const polyPoolCount = takeCount * POLY_STRATIFY_POOL_MULTIPLIER;
  const polyMarkets = await prisma.market.findMany({
    where: {
      active: true,
      venue: "POLYMARKET",
      marketMaker: null,
      volume24h: {
        gte: params.minVolume24h * 0.5,
      },
      yesPrice: {
        gte: params.excludeMidLt,
        lte: params.excludeMidGt,
      },
      clobTokenIds: {
        isEmpty: false,
      },
      OR: [{ endDate: null }, { endDate: { gt: new Date() } }],
    },
    orderBy: { volume24h: "desc" },
    take: polyPoolCount,
  });

  const polyPoolById = new Map(polyMarkets.map((market) => [market.id, market]));
  const polyStratified = stratifyMarkets(
    polyMarkets.map((market) => ({
      id: market.id,
      category: market.category,
      volume24h: market.volume24h ? Number(market.volume24h) : 0,
    })),
    takeCount,
    {
      maxCategories: POLY_STRATIFY_MAX_CATEGORIES,
      minPerCategory: POLY_STRATIFY_MIN_PER_CATEGORY,
    }
  )
    .map(({ id }) => polyPoolById.get(id))
    .filter(Boolean);

  console.log(
    `[MM Candidates] Screening ${polyStratified.length} Polymarket markets (stratified)...`
  );

  for (const market of polyStratified) {
    try {
      const scored = await screenPolymarketMarket(
        {
          id: market.id,
          slug: market.slug,
          question: market.question,
          category: market.category,
          endDate: market.endDate,
          yesPrice: market.yesPrice ? Number(market.yesPrice) : null,
          volume24h: market.volume24h ? Number(market.volume24h) : 0,
          clobTokenIds: market.clobTokenIds ?? [],
        },
        params
      );

      if (scored) {
        results.push(scored);
      }

      await delay(ORDERBOOK_DELAY_MS);
    } catch (error) {
      console.error(`[MM Candidates] Error screening ${market.slug}:`, error);
    }
  }

  // Kalshi scan
  registerDefaultVenues();
  const kalshiParams: MMScreeningParams = {
    ...params,
    minVolume24h: Math.min(params.minVolume24h, KALSHI_MIN_VOLUME_24H),
    minQueueSpeed: Math.min(params.minQueueSpeed, 0.25),
    minTopDepthNotional: Math.min(params.minTopDepthNotional, 100),
    minDepthWithin3cNotional: Math.min(params.minDepthWithin3cNotional, 500),
    minDepthEachSideWithin3c: Math.min(params.minDepthEachSideWithin3c, 150),
    depthRangeCents: 2,
  };

  const kalshiPoolCount = takeCount * KALSHI_STRATIFY_POOL_MULTIPLIER;
  const kalshiMarkets = await prisma.market.findMany({
    where: {
      active: true,
      venue: "KALSHI",
      marketMaker: null,
      OR: [{ endDate: null }, { endDate: { gt: new Date() } }],
    },
    orderBy: { volume24h: "desc" },
    take: kalshiPoolCount,
  });

  const kalshiPoolById = new Map(
    kalshiMarkets.map((market) => [market.id, market])
  );
  const kalshiStratified = stratifyMarkets(
    kalshiMarkets.map((market) => ({
      id: market.id,
      category: market.category,
      volume24h: market.volume24h ? Number(market.volume24h) : 0,
    })),
    takeCount,
    {
      maxCategories: KALSHI_STRATIFY_MAX_CATEGORIES,
      minPerCategory: KALSHI_STRATIFY_MIN_PER_CATEGORY,
    }
  )
    .map(({ id }) => kalshiPoolById.get(id))
    .filter(Boolean);

  console.log(
    `[MM Candidates] Screening ${kalshiStratified.length} Kalshi markets (stratified)...`
  );

  for (const market of kalshiStratified) {
    if (isKalshiComboMarket(market.id, market.eventTicker)) {
      continue;
    }
    try {
      const scored = await screenKalshiMarket(
        {
          id: market.id,
          slug: market.slug,
          question: market.question,
          category: market.category,
          endDate: market.endDate,
          yesPrice: market.yesPrice ? Number(market.yesPrice) : null,
          volume24h: market.volume24h ? Number(market.volume24h) : 0,
          priceRanges: market.priceRanges,
          eventTicker: market.eventTicker,
        },
        kalshiParams
      );

      if (scored) {
        results.push(scored);
      }

      await delay(ORDERBOOK_DELAY_MS);
    } catch (error) {
      console.error(`[MM Candidates] Error screening ${market.slug}:`, error);
    }
  }

  if (results.length === 0) {
    console.log("[MM Candidates] No candidates scored.");
    return;
  }

  // Upsert scored candidates
  let upserts = 0;
  for (const result of results) {
    const data = toMmCandidateData(result, scoredAt);
    const { marketId, ...payload } = data;
    await prisma.mmCandidate.upsert({
      where: { marketId },
      create: { marketId, ...payload },
      update: payload,
    });
    upserts++;
  }

  const duration = Date.now() - startTime;
  console.log(
    `[MM Candidates] Updated ${upserts} candidates in ${duration}ms`
  );
}
