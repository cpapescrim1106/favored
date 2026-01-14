/**
 * Market Making Screening Module
 *
 * Scores markets for MM viability based on:
 * - Liquidity quality (spread, depth, book shape)
 * - Time to resolution
 * - Price zone (avoid extremes)
 * - Volume/activity
 * - Resolution clarity
 *
 * NOTE: Polymarket's CLOB orderbook shows limit orders only. The actual
 * midpoint and spread are calculated differently by their system (likely
 * volume-weighted or based on recent trades). We use the /midpoint and
 * /spread endpoints to get accurate pricing instead of raw book calculation.
 */

// ============================================================================
// TYPES
// ============================================================================

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

// CLOB pricing data from dedicated endpoints (more accurate than raw book)
export interface CLOBPricing {
  midpoint: number | null;  // From /midpoint endpoint
  spread: number | null;    // From /spread endpoint (in decimal, e.g., 0.01)
}

export interface CLOBPricingPair {
  yes: CLOBPricing;
  no?: CLOBPricing;
}

export interface MMScreeningParams {
  // Time filters
  minTimeToEndHours: number; // Exclude if < this (default: 48)
  preferredTimeToEndMinDays: number; // Preferred range start (default: 7)
  preferredTimeToEndMaxDays: number; // Preferred range end (default: 90)

  // Liquidity filters
  maxSpreadTicks: number; // Max spread in ticks (default: 2 = $0.02)
  minTopDepthNotional: number; // Min $ at best bid + ask (default: 300)
  minDepthWithin3cNotional: number; // Min $ within depthRangeCents combined (default: 2000)
  minDepthEachSideWithin3c: number; // Min $ each side within depthRangeCents (default: 800)
  minBookSlope: number; // depth_1c / depth_5c ratio (default: 0.15)
  depthRangeCents: number; // Depth window for liquidity/queue metrics (default: 3)

  // Volume filters
  minVolume24h: number; // Min 24h volume (default: 10000)
  flowVolumeTarget: number; // Volume to reach max flow score (default: 250k)

  // Queue metrics (small MM focus)
  assumedOrderSize: number; // Assumed order size for queue depth ratio (default: 100)
  minQueueSpeed: number; // Minimum turnover ratio to score > 0 (default: 1)
  maxQueueSpeed: number; // Turnover ratio to reach max score (default: 25)
  idealQueueDepthRatio: number; // Ideal top-depth/size ratio (default: 10)
  maxQueueDepthRatio: number; // Disqualify if ratio exceeds this (default: 200)

  // Data quality
  requireBothBooks: boolean; // Require YES and NO books (default: true)
  disqualifyAmbiguous: boolean; // Disqualify ambiguous resolution (default: true)

  // Price zone filters
  excludeMidLt: number; // Exclude if mid < this (default: 0.10)
  excludeMidGt: number; // Exclude if mid > this (default: 0.90)
  preferredMidMin: number; // Preferred zone start (default: 0.20)
  preferredMidMax: number; // Preferred zone end (default: 0.80)

  // Tick size override (optional, defaults to 0.01)
  tickSize?: number;
}

export interface MMScreeningResult {
  marketId: string;
  slug: string;
  question: string;
  category: string | null;
  endDate: string | null;

  // Computed metrics
  midPrice: number;
  spreadTicks: number;
  spreadPercent: number;
  topDepthNotional: number;
  depth3cBid: number;
  depth3cAsk: number;
  depth3cTotal: number;
  bookSlope: number;
  volume24h: number;
  queueSpeed: number;
  queueDepthRatio: number;
  hoursToEnd: number | null;

  // Scores (0-100)
  liquidityScore: number;
  flowScore: number;
  timeScore: number;
  priceZoneScore: number;
  queueSpeedScore: number;
  queueDepthScore: number;
  totalScore: number;

  // Risk flags
  flags: string[];

  // Pass/fail
  eligible: boolean;
  disqualifyReasons: string[];
}

// ============================================================================
// CONSTANTS
// ============================================================================

export const MM_TICK_SIZE = 0.01;

export const DEFAULT_MM_SCREENING_PARAMS: MMScreeningParams = {
  minTimeToEndHours: 24,
  preferredTimeToEndMinDays: 3,
  preferredTimeToEndMaxDays: 120,
  maxSpreadTicks: 4, // 4 ticks = $0.04 max spread for small MM
  minTopDepthNotional: 250, // $250 at top of book
  minDepthWithin3cNotional: 1500, // $1500 within ±3¢
  minDepthEachSideWithin3c: 500, // $500 each side within ±3¢
  minBookSlope: 0.1, // Require some concentration
  depthRangeCents: 3,
  minVolume24h: 25000, // Focus on higher flow markets
  flowVolumeTarget: 250000, // Volume to reach max flow score
  assumedOrderSize: 100,
  minQueueSpeed: 1, // 1x daily turnover vs depth
  maxQueueSpeed: 25, // 25x daily turnover caps the score
  idealQueueDepthRatio: 10, // 10 orders deep is ideal
  maxQueueDepthRatio: 200, // Disqualify if too deep
  requireBothBooks: true,
  disqualifyAmbiguous: true,
  excludeMidLt: 0.1, // Exclude < 10% implied prob
  excludeMidGt: 0.9, // Exclude > 90% implied prob
  preferredMidMin: 0.2, // Preferred 20-80%
  preferredMidMax: 0.8,
};

// Keywords that indicate ambiguous resolution
const AMBIGUITY_KEYWORDS = [
  "significant",
  "significantly",
  "major",
  "likely",
  "probably",
  "substantial",
  "meaningful",
  "notable",
  "considerable",
  "approved by",
  "determined by",
  "discretion",
  "judgment",
  "opinion",
  "believes",
  "thinks",
  "estimates",
];

// ============================================================================
// ORDER BOOK ANALYSIS
// ============================================================================

/**
 * Calculate mid price from order book
 */
export function calculateMidPriceFromBook(book: OrderBook): number | null {
  if (book.bids.length === 0 || book.asks.length === 0) return null;
  const bestBid = book.bids[0].price;
  const bestAsk = book.asks[0].price;
  return (bestBid + bestAsk) / 2;
}

/**
 * Calculate spread in ticks
 */
export function calculateSpreadTicks(book: OrderBook, tickSize: number = MM_TICK_SIZE): number | null {
  if (book.bids.length === 0 || book.asks.length === 0) return null;
  const bestBid = book.bids[0].price;
  const bestAsk = book.asks[0].price;
  return Math.round((bestAsk - bestBid) / tickSize);
}

/**
 * Calculate notional depth at top of book (best bid + best ask)
 */
export function calculateTopDepth(book: OrderBook): number {
  const bidDepth = book.bids.length > 0 ? book.bids[0].price * book.bids[0].size : 0;
  const askDepth = book.asks.length > 0 ? book.asks[0].price * book.asks[0].size : 0;
  return bidDepth + askDepth;
}

/**
 * Calculate notional depth within a price range from mid
 */
export function calculateDepthWithinRange(
  book: OrderBook,
  midPrice: number,
  rangeCents: number
): { bidDepth: number; askDepth: number; total: number } {
  const rangeDecimal = rangeCents / 100;

  // Sum bid depth within range (mid - range to mid)
  let bidDepth = 0;
  for (const level of book.bids) {
    if (level.price >= midPrice - rangeDecimal) {
      bidDepth += level.price * level.size;
    }
  }

  // Sum ask depth within range (mid to mid + range)
  let askDepth = 0;
  for (const level of book.asks) {
    if (level.price <= midPrice + rangeDecimal) {
      askDepth += level.price * level.size;
    }
  }

  return { bidDepth, askDepth, total: bidDepth + askDepth };
}

/**
 * Calculate book slope (concentration check)
 * depth_1c / depth_5c - higher is better (liquidity not all far away)
 */
export function calculateBookSlope(book: OrderBook, midPrice: number): number {
  const depth1c = calculateDepthWithinRange(book, midPrice, 1).total;
  const depth5c = calculateDepthWithinRange(book, midPrice, 5).total;

  if (depth5c === 0) return 0;
  return depth1c / depth5c;
}

export interface BookMetrics {
  midPrice: number | null;
  spreadTicks: number | null;
  topDepthNotional: number;
  depth3cBid: number;
  depth3cAsk: number;
  depth3cTotal: number;
  bookSlope: number;
}

export function analyzeOrderBook(
  book: OrderBook,
  pricing?: CLOBPricing,
  tickSize: number = MM_TICK_SIZE,
  depthRangeCents: number = 3
): BookMetrics {
  const midPrice =
    pricing?.midpoint !== null && pricing?.midpoint !== undefined
      ? pricing.midpoint
      : calculateMidPriceFromBook(book);

  const spreadTicks =
    pricing?.spread !== null && pricing?.spread !== undefined
      ? Math.round(pricing.spread / tickSize)
      : calculateSpreadTicks(book, tickSize);

  const topDepthNotional = calculateTopDepth(book);
  const depth3c = midPrice === null
    ? { bidDepth: 0, askDepth: 0, total: 0 }
    : calculateDepthWithinRange(book, midPrice, depthRangeCents);
  const bookSlope = midPrice === null ? 0 : calculateBookSlope(book, midPrice);

  return {
    midPrice,
    spreadTicks,
    topDepthNotional,
    depth3cBid: depth3c.bidDepth,
    depth3cAsk: depth3c.askDepth,
    depth3cTotal: depth3c.total,
    bookSlope,
  };
}

// ============================================================================
// RESOLUTION AMBIGUITY
// ============================================================================

/**
 * Check if market question contains ambiguous keywords
 */
export function checkResolutionAmbiguity(question: string): {
  isAmbiguous: boolean;
  matchedKeywords: string[];
} {
  const lowerQuestion = question.toLowerCase();
  const matchedKeywords: string[] = [];

  for (const keyword of AMBIGUITY_KEYWORDS) {
    if (lowerQuestion.includes(keyword.toLowerCase())) {
      matchedKeywords.push(keyword);
    }
  }

  return {
    isAmbiguous: matchedKeywords.length > 0,
    matchedKeywords,
  };
}

/**
 * Check if market is binary (YES/NO only)
 */
export function isBinaryMarket(outcomes: string | string[]): boolean {
  let outcomeArray: string[];

  if (typeof outcomes === "string") {
    try {
      outcomeArray = JSON.parse(outcomes);
    } catch {
      return false;
    }
  } else {
    outcomeArray = outcomes;
  }

  return outcomeArray.length === 2;
}

// ============================================================================
// SCORING
// ============================================================================

/**
 * Calculate liquidity score (0-100)
 * Based on: spread, top depth, depth within 3c, book slope
 */
export function calculateLiquidityScore(
  spreadTicks: number,
  topDepth: number,
  depth3cTotal: number,
  depth3cBid: number,
  depth3cAsk: number,
  bookSlope: number,
  params: MMScreeningParams
): number {
  let score = 0;

  // Spread score (0-30): prefer 2-3 ticks for small MM
  if (spreadTicks === 2) score += 30;
  else if (spreadTicks === 3) score += 20;
  else if (spreadTicks === 1) score += 10;

  // Top depth score (0-10): scale from min to 2x min
  const topDepthScore = Math.min(10, (topDepth / params.minTopDepthNotional) * 5);
  score += topDepthScore;

  // Depth within 3c score (0-30): scale from min to 2x min
  const depth3cScore = Math.min(30, (depth3cTotal / params.minDepthWithin3cNotional) * 15);
  score += depth3cScore;

  // Balance score (0-20): both sides should have decent depth
  const minSide = Math.min(depth3cBid, depth3cAsk);
  const maxSide = Math.max(depth3cBid, depth3cAsk);
  const balance = maxSide > 0 ? minSide / maxSide : 0;
  score += balance * 20;

  // Book slope score (0-10): reward concentrated liquidity
  if (bookSlope >= 0.3) score += 10;
  else if (bookSlope >= 0.2) score += 6;
  else if (bookSlope >= 0.15) score += 3;

  return Math.min(100, Math.round(score));
}

/**
 * Calculate flow/activity score (0-100)
 * Based on: 24h volume
 */
export function calculateFlowScore(volume24h: number, params: MMScreeningParams): number {
  if (volume24h < params.minVolume24h) return 0;

  const minVol = Math.max(params.minVolume24h, 1);
  const maxVol = Math.max(params.flowVolumeTarget, minVol * 2);
  const logMin = Math.log10(minVol);
  const logMax = Math.log10(maxVol);
  const logVal = Math.log10(Math.max(volume24h, minVol));

  const normalized = (logVal - logMin) / (logMax - logMin);
  return Math.max(0, Math.min(100, Math.round(normalized * 100)));
}

/**
 * Calculate queue speed score (0-100)
 * Based on: volume24h / depth3cTotal (turnover)
 */
export function calculateQueueSpeedScore(queueSpeed: number, params: MMScreeningParams): number {
  const minSpeed = Math.max(params.minQueueSpeed, 0.0001);
  const maxSpeed = Math.max(params.maxQueueSpeed, minSpeed * 2);

  if (queueSpeed <= minSpeed) return 0;
  if (queueSpeed >= maxSpeed) return 100;

  const logMin = Math.log10(minSpeed);
  const logMax = Math.log10(maxSpeed);
  const logVal = Math.log10(queueSpeed);
  const normalized = (logVal - logMin) / (logMax - logMin);
  return Math.max(0, Math.min(100, Math.round(normalized * 100)));
}

/**
 * Calculate queue depth score (0-100)
 * Based on: topDepthShares / assumedOrderSize (lower is better)
 */
export function calculateQueueDepthScore(queueDepthRatio: number, params: MMScreeningParams): number {
  const ideal = Math.max(params.idealQueueDepthRatio, 1);
  const maxRatio = Math.max(params.maxQueueDepthRatio, ideal * 2);

  if (queueDepthRatio <= ideal) return 100;
  if (queueDepthRatio >= maxRatio) return 0;

  const logIdeal = Math.log10(ideal);
  const logMax = Math.log10(maxRatio);
  const logVal = Math.log10(queueDepthRatio);
  const normalized = (logVal - logIdeal) / (logMax - logIdeal);
  return Math.max(0, Math.min(100, Math.round((1 - normalized) * 100)));
}

/**
 * Calculate time score (0-100)
 * Based on: hours to end
 */
export function calculateTimeScore(hoursToEnd: number | null, params: MMScreeningParams): number {
  if (hoursToEnd === null) return 50; // Unknown end date - neutral

  // Too close = 0
  if (hoursToEnd < params.minTimeToEndHours) return 0;

  const daysToEnd = hoursToEnd / 24;
  const minDays = params.preferredTimeToEndMinDays;
  const maxDays = params.preferredTimeToEndMaxDays;

  // In preferred range = 100
  if (daysToEnd >= minDays && daysToEnd <= maxDays) return 100;

  // Before preferred range (too far) - score decreases
  if (daysToEnd > maxDays) {
    const excess = daysToEnd - maxDays;
    return Math.max(50, 100 - excess * 0.5);
  }

  // After min but before preferred - ramp up
  const progress = (daysToEnd - params.minTimeToEndHours / 24) / (minDays - params.minTimeToEndHours / 24);
  return Math.round(50 + progress * 50);
}

/**
 * Calculate price zone score (0-100)
 * Based on: mid price distance from extremes
 */
export function calculatePriceZoneScore(midPrice: number, params: MMScreeningParams): number {
  // Outside valid range = 0
  if (midPrice < params.excludeMidLt || midPrice > params.excludeMidGt) return 0;

  // In preferred zone = 100
  if (midPrice >= params.preferredMidMin && midPrice <= params.preferredMidMax) return 100;

  // Between exclude and preferred - scale
  if (midPrice < params.preferredMidMin) {
    const range = params.preferredMidMin - params.excludeMidLt;
    const position = midPrice - params.excludeMidLt;
    return Math.round((position / range) * 100);
  } else {
    const range = params.excludeMidGt - params.preferredMidMax;
    const position = params.excludeMidGt - midPrice;
    return Math.round((position / range) * 100);
  }
}

// ============================================================================
// MAIN SCREENING FUNCTION
// ============================================================================

export interface MarketData {
  id: string;
  slug: string;
  question: string;
  category: string | null;
  endDate: Date | string | null;
  yesPrice: number | null;
  volume24h: number;
  outcomes?: string | string[];
  tickSize?: number;
}

/**
 * Screen a market for MM viability
 *
 * @param market - Market data from database
 * @param yesBook - YES order book data (used for depth analysis)
 * @param params - Screening parameters
 * @param clobPricing - Optional pricing from CLOB /midpoint and /spread endpoints
 *                      If provided, these are used instead of calculating from book
 * @param noBook - Optional NO order book data (used for depth analysis)
 */
export function screenMarketForMM(
  market: MarketData,
  yesBook: OrderBook,
  params: MMScreeningParams = DEFAULT_MM_SCREENING_PARAMS,
  clobPricing?: CLOBPricingPair,
  noBook?: OrderBook
): MMScreeningResult {
  const tickSize = market.tickSize ?? params.tickSize ?? MM_TICK_SIZE;
  const flags: string[] = [];
  const disqualifyReasons: string[] = [];

  const depthRangeCents = params.depthRangeCents ?? 3;
  const yesMetrics = analyzeOrderBook(yesBook, clobPricing?.yes, tickSize, depthRangeCents);
  const noMetrics = noBook ? analyzeOrderBook(noBook, clobPricing?.no, tickSize, depthRangeCents) : null;
  const hasNoBook = Boolean(noMetrics && noMetrics.midPrice !== null && noMetrics.spreadTicks !== null);

  // Handle missing data
  if (yesMetrics.midPrice === null || yesMetrics.spreadTicks === null) {
    return {
      marketId: market.id,
      slug: market.slug,
      question: market.question,
      category: market.category,
      endDate: market.endDate ? new Date(market.endDate).toISOString() : null,
      midPrice: market.yesPrice || 0.5,
      spreadTicks: 99,
      spreadPercent: 1,
      topDepthNotional: 0,
      depth3cBid: 0,
      depth3cAsk: 0,
      depth3cTotal: 0,
      bookSlope: 0,
      volume24h: market.volume24h,
      queueSpeed: 0,
      queueDepthRatio: 0,
      hoursToEnd: null,
      liquidityScore: 0,
      flowScore: 0,
      timeScore: 0,
      priceZoneScore: 0,
      queueSpeedScore: 0,
      queueDepthScore: 0,
      totalScore: 0,
      flags: ["No liquidity"],
      eligible: false,
      disqualifyReasons: ["No order book liquidity"],
    };
  }

  if (params.requireBothBooks && !hasNoBook) {
    disqualifyReasons.push("Missing NO order book");
    flags.push("NO book missing");
  }

  const midPrice = yesMetrics.midPrice;
  const spreadTicks = hasNoBook
    ? Math.max(yesMetrics.spreadTicks, noMetrics!.spreadTicks!)
    : yesMetrics.spreadTicks;
  const spreadPercent = (spreadTicks * tickSize) / midPrice;
  const topDepth = hasNoBook
    ? Math.min(yesMetrics.topDepthNotional, noMetrics!.topDepthNotional)
    : yesMetrics.topDepthNotional;
  const depth3cTotal = hasNoBook
    ? Math.min(yesMetrics.depth3cTotal, noMetrics!.depth3cTotal)
    : yesMetrics.depth3cTotal;
  const depth3cBid = hasNoBook
    ? Math.min(yesMetrics.depth3cBid, noMetrics!.depth3cBid)
    : yesMetrics.depth3cBid;
  const depth3cAsk = hasNoBook
    ? Math.min(yesMetrics.depth3cAsk, noMetrics!.depth3cAsk)
    : yesMetrics.depth3cAsk;
  const bookSlope = hasNoBook
    ? Math.min(yesMetrics.bookSlope, noMetrics!.bookSlope)
    : yesMetrics.bookSlope;

  const yesTopDepthShares = yesMetrics.midPrice > 0 ? yesMetrics.topDepthNotional / yesMetrics.midPrice : 0;
  const noTopDepthShares =
    hasNoBook && noMetrics!.midPrice! > 0 ? noMetrics!.topDepthNotional / noMetrics!.midPrice! : 0;
  const worstTopDepthShares = hasNoBook ? Math.max(yesTopDepthShares, noTopDepthShares) : yesTopDepthShares;
  const queueDepthRatio =
    params.assumedOrderSize > 0 ? worstTopDepthShares / params.assumedOrderSize : 0;
  const depthForSpeed = hasNoBook
    ? Math.max(yesMetrics.depth3cTotal, noMetrics!.depth3cTotal)
    : yesMetrics.depth3cTotal;
  const queueSpeed = depthForSpeed > 0 ? market.volume24h / depthForSpeed : 0;

  // Calculate hours to end
  let hoursToEnd: number | null = null;
  if (market.endDate) {
    const endDate = new Date(market.endDate);
    const now = new Date();
    hoursToEnd = (endDate.getTime() - now.getTime()) / (1000 * 60 * 60);
  }

  // ============================================================================
  // HARD DISQUALIFICATIONS
  // ============================================================================

  // Time to resolution
  if (hoursToEnd !== null && hoursToEnd < params.minTimeToEndHours) {
    disqualifyReasons.push(`Too close to resolution (${Math.round(hoursToEnd)}h < ${params.minTimeToEndHours}h)`);
    flags.push("Endgame");
  }

  // Spread too wide
  if (spreadTicks > params.maxSpreadTicks) {
    disqualifyReasons.push(`Spread too wide (${spreadTicks} ticks > ${params.maxSpreadTicks})`);
    flags.push("Wide spread");
  }

  // Top depth too thin
  if (topDepth < params.minTopDepthNotional) {
    disqualifyReasons.push(`Top depth too thin ($${topDepth.toFixed(0)} < $${params.minTopDepthNotional})`);
    flags.push("Thin touch");
  }

  // Depth within 3c too thin
  if (depth3cTotal < params.minDepthWithin3cNotional) {
    disqualifyReasons.push(
      `Depth within ${depthRangeCents}c too thin ($${depth3cTotal.toFixed(0)} < $${params.minDepthWithin3cNotional})`
    );
    flags.push("Shallow book");
  }

  // One-sided book
  if (yesMetrics.depth3cBid < params.minDepthEachSideWithin3c) {
    disqualifyReasons.push(`YES bid too thin ($${yesMetrics.depth3cBid.toFixed(0)} < $${params.minDepthEachSideWithin3c})`);
    flags.push("One-sided (no bids)");
  }
  if (yesMetrics.depth3cAsk < params.minDepthEachSideWithin3c) {
    disqualifyReasons.push(`YES ask too thin ($${yesMetrics.depth3cAsk.toFixed(0)} < $${params.minDepthEachSideWithin3c})`);
    flags.push("One-sided (no asks)");
  }
  if (hasNoBook) {
    if (noMetrics!.depth3cBid < params.minDepthEachSideWithin3c) {
      disqualifyReasons.push(`NO bid too thin ($${noMetrics!.depth3cBid.toFixed(0)} < $${params.minDepthEachSideWithin3c})`);
      flags.push("One-sided (no bids)");
    }
    if (noMetrics!.depth3cAsk < params.minDepthEachSideWithin3c) {
      disqualifyReasons.push(`NO ask too thin ($${noMetrics!.depth3cAsk.toFixed(0)} < $${params.minDepthEachSideWithin3c})`);
      flags.push("One-sided (no asks)");
    }
  }

  // Queue depth too large (warning only; flow is a stronger signal)
  if (queueDepthRatio > params.maxQueueDepthRatio) {
    flags.push("Deep queue");
  }

  // Queue speed too slow
  if (queueSpeed < params.minQueueSpeed) {
    disqualifyReasons.push(`Queue too slow (${queueSpeed.toFixed(2)} < ${params.minQueueSpeed})`);
    flags.push("Slow queue");
  }

  // Book slope (concentration)
  if (bookSlope < params.minBookSlope) {
    flags.push("Dispersed liquidity");
    // Not a hard disqualify, just a flag
  }

  // Volume too low
  if (market.volume24h < params.minVolume24h) {
    disqualifyReasons.push(`Volume too low ($${market.volume24h.toFixed(0)} < $${params.minVolume24h})`);
    flags.push("Low volume");
  }

  // Price zone
  if (midPrice < params.excludeMidLt) {
    disqualifyReasons.push(`Price too low (${(midPrice * 100).toFixed(0)}% < ${params.excludeMidLt * 100}%)`);
    flags.push("Extreme price (low)");
  }
  if (midPrice > params.excludeMidGt) {
    disqualifyReasons.push(`Price too high (${(midPrice * 100).toFixed(0)}% > ${params.excludeMidGt * 100}%)`);
    flags.push("Extreme price (high)");
  }

  // Resolution ambiguity
  const ambiguity = checkResolutionAmbiguity(market.question);
  if (ambiguity.isAmbiguous) {
    flags.push(`Ambiguous (${ambiguity.matchedKeywords.slice(0, 2).join(", ")})`);
    if (params.disqualifyAmbiguous) {
      disqualifyReasons.push("Ambiguous resolution");
    }
  }

  // Binary check
  if (market.outcomes && !isBinaryMarket(market.outcomes)) {
    disqualifyReasons.push("Multi-outcome market (not binary)");
    flags.push("Multi-outcome");
  }

  // ============================================================================
  // SCORING
  // ============================================================================

  const liquidityScore = calculateLiquidityScore(
    spreadTicks,
    topDepth,
    depth3cTotal,
    depth3cBid,
    depth3cAsk,
    bookSlope,
    params
  );

  const queueSpeedScore = calculateQueueSpeedScore(queueSpeed, params);
  const queueDepthScore = calculateQueueDepthScore(queueDepthRatio, params);
  const flowScore = calculateFlowScore(market.volume24h, params);
  const timeScore = calculateTimeScore(hoursToEnd, params);
  const priceZoneScore = calculatePriceZoneScore(midPrice, params);

  // Weighted total: Queue Speed 35%, Liquidity 25%, Flow 15%, Time 10%, Price Zone 10%, Queue Depth 5%
  const totalScore = Math.round(
    queueSpeedScore * 0.35 +
    liquidityScore * 0.25 +
    flowScore * 0.15 +
    timeScore * 0.10 +
    priceZoneScore * 0.10 +
    queueDepthScore * 0.05
  );

  return {
    marketId: market.id,
    slug: market.slug,
    question: market.question,
    category: market.category,
    endDate: market.endDate ? new Date(market.endDate).toISOString() : null,
    midPrice,
    spreadTicks,
    spreadPercent,
    topDepthNotional: topDepth,
    depth3cBid,
    depth3cAsk,
    depth3cTotal,
    bookSlope,
    volume24h: market.volume24h,
    queueSpeed,
    queueDepthRatio,
    hoursToEnd,
    liquidityScore,
    flowScore,
    timeScore,
    priceZoneScore,
    queueSpeedScore,
    queueDepthScore,
    totalScore,
    flags,
    eligible: disqualifyReasons.length === 0,
    disqualifyReasons,
  };
}
