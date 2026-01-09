/**
 * Market Making Screening Module
 *
 * Scores markets for MM viability based on:
 * - Liquidity quality (spread, depth, book shape)
 * - Time to resolution
 * - Price zone (avoid extremes)
 * - Volume/activity
 * - Resolution clarity
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

export interface MMScreeningParams {
  // Time filters
  minTimeToEndHours: number; // Exclude if < this (default: 48)
  preferredTimeToEndMinDays: number; // Preferred range start (default: 7)
  preferredTimeToEndMaxDays: number; // Preferred range end (default: 90)

  // Liquidity filters
  maxSpreadTicks: number; // Max spread in ticks (default: 2 = $0.02)
  minTopDepthNotional: number; // Min $ at best bid + ask (default: 300)
  minDepthWithin3cNotional: number; // Min $ within ±3¢ combined (default: 2000)
  minDepthEachSideWithin3c: number; // Min $ each side within ±3¢ (default: 800)
  minBookSlope: number; // depth_1c / depth_5c ratio (default: 0.15)

  // Volume filters
  minVolume24h: number; // Min 24h volume (default: 10000)

  // Price zone filters
  excludeMidLt: number; // Exclude if mid < this (default: 0.10)
  excludeMidGt: number; // Exclude if mid > this (default: 0.90)
  preferredMidMin: number; // Preferred zone start (default: 0.20)
  preferredMidMax: number; // Preferred zone end (default: 0.80)
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
  hoursToEnd: number | null;

  // Scores (0-100)
  liquidityScore: number;
  flowScore: number;
  timeScore: number;
  priceZoneScore: number;
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
  minTimeToEndHours: 48,
  preferredTimeToEndMinDays: 7,
  preferredTimeToEndMaxDays: 90,
  maxSpreadTicks: 2,
  minTopDepthNotional: 300,
  minDepthWithin3cNotional: 2000,
  minDepthEachSideWithin3c: 800,
  minBookSlope: 0.15,
  minVolume24h: 10000,
  excludeMidLt: 0.10,
  excludeMidGt: 0.90,
  preferredMidMin: 0.20,
  preferredMidMax: 0.80,
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
export function calculateSpreadTicks(book: OrderBook): number | null {
  if (book.bids.length === 0 || book.asks.length === 0) return null;
  const bestBid = book.bids[0].price;
  const bestAsk = book.asks[0].price;
  return Math.round((bestAsk - bestBid) / MM_TICK_SIZE);
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

  // Spread score (0-30): 1 tick = 30, 2 ticks = 20, 3+ = 0
  if (spreadTicks === 1) score += 30;
  else if (spreadTicks === 2) score += 20;
  else if (spreadTicks === 3) score += 5;

  // Top depth score (0-25): scale from min to 2x min
  const topDepthScore = Math.min(25, (topDepth / params.minTopDepthNotional) * 12.5);
  score += topDepthScore;

  // Depth within 3c score (0-30): scale from min to 2x min
  const depth3cScore = Math.min(30, (depth3cTotal / params.minDepthWithin3cNotional) * 15);
  score += depth3cScore;

  // Balance score (0-10): both sides should have decent depth
  const minSide = Math.min(depth3cBid, depth3cAsk);
  const maxSide = Math.max(depth3cBid, depth3cAsk);
  const balance = maxSide > 0 ? minSide / maxSide : 0;
  score += balance * 10;

  // Book slope score (0-5): reward concentrated liquidity
  if (bookSlope >= 0.3) score += 5;
  else if (bookSlope >= 0.2) score += 3;
  else if (bookSlope >= 0.15) score += 1;

  return Math.min(100, Math.round(score));
}

/**
 * Calculate flow/activity score (0-100)
 * Based on: 24h volume
 */
export function calculateFlowScore(volume24h: number, params: MMScreeningParams): number {
  // Scale: min = 0, 50k = 50, 100k+ = 100
  if (volume24h < params.minVolume24h) return 0;

  const score = Math.min(100, (volume24h / 100000) * 100);
  return Math.round(score);
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
}

/**
 * Screen a market for MM viability
 */
export function screenMarketForMM(
  market: MarketData,
  book: OrderBook,
  params: MMScreeningParams = DEFAULT_MM_SCREENING_PARAMS
): MMScreeningResult {
  const flags: string[] = [];
  const disqualifyReasons: string[] = [];

  // Calculate basic metrics
  const midPrice = calculateMidPriceFromBook(book);
  const spreadTicks = calculateSpreadTicks(book);

  // Handle missing data
  if (midPrice === null || spreadTicks === null) {
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
      hoursToEnd: null,
      liquidityScore: 0,
      flowScore: 0,
      timeScore: 0,
      priceZoneScore: 0,
      totalScore: 0,
      flags: ["No liquidity"],
      eligible: false,
      disqualifyReasons: ["No order book liquidity"],
    };
  }

  const spreadPercent = (spreadTicks * MM_TICK_SIZE) / midPrice;
  const topDepth = calculateTopDepth(book);
  const depth3c = calculateDepthWithinRange(book, midPrice, 3);
  const bookSlope = calculateBookSlope(book, midPrice);

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
  if (depth3c.total < params.minDepthWithin3cNotional) {
    disqualifyReasons.push(`Depth within 3c too thin ($${depth3c.total.toFixed(0)} < $${params.minDepthWithin3cNotional})`);
    flags.push("Shallow book");
  }

  // One-sided book
  if (depth3c.bidDepth < params.minDepthEachSideWithin3c) {
    disqualifyReasons.push(`Bid side too thin ($${depth3c.bidDepth.toFixed(0)} < $${params.minDepthEachSideWithin3c})`);
    flags.push("One-sided (no bids)");
  }
  if (depth3c.askDepth < params.minDepthEachSideWithin3c) {
    disqualifyReasons.push(`Ask side too thin ($${depth3c.askDepth.toFixed(0)} < $${params.minDepthEachSideWithin3c})`);
    flags.push("One-sided (no asks)");
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
    // Not a hard disqualify, just a flag
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
    depth3c.total,
    depth3c.bidDepth,
    depth3c.askDepth,
    bookSlope,
    params
  );

  const flowScore = calculateFlowScore(market.volume24h, params);
  const timeScore = calculateTimeScore(hoursToEnd, params);
  const priceZoneScore = calculatePriceZoneScore(midPrice, params);

  // Weighted total: Liquidity 40%, Flow 25%, Time 10%, Price Zone 25%
  const totalScore = Math.round(
    liquidityScore * 0.4 +
    flowScore * 0.25 +
    timeScore * 0.10 +
    priceZoneScore * 0.25
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
    depth3cBid: depth3c.bidDepth,
    depth3cAsk: depth3c.askDepth,
    depth3cTotal: depth3c.total,
    bookSlope,
    volume24h: market.volume24h,
    hoursToEnd,
    liquidityScore,
    flowScore,
    timeScore,
    priceZoneScore,
    totalScore,
    flags,
    eligible: disqualifyReasons.length === 0,
    disqualifyReasons,
  };
}
