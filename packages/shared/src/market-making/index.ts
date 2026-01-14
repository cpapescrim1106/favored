/**
 * Market Making Quote Calculation Module
 *
 * Provides functions for calculating bid/ask quotes with inventory-based skew
 * and managing quote refresh logic.
 *
 * Units:
 * - inventory: shares (positive = long YES, negative = short YES / long NO)
 * - orderSize: shares per side
 * - maxInventory: max shares exposure
 * - prices: decimal (0.01 - 0.99)
 */

// Polymarket tick size is $0.01
export const TICK_SIZE = 0.01;
export const MIN_PRICE = 0.01;
export const MAX_PRICE = 0.99;

export type QuotingPolicy =
  | "touch"
  | "inside"
  | "back"
  | "defensive"
  | "tiered"
  | "offsets";

export interface QuoteParams {
  midPrice: number;
  targetSpread: number; // e.g., 0.02 = 2%
  inventory: number; // Net position in shares (+ = long YES)
  skewFactor: number; // Max spread adjustment at full inventory
  orderSize: number; // Shares per side
  maxInventory: number; // Max shares exposure
  tickSize?: number; // Optional tick size override (default: 0.01)
  minPrice?: number; // Optional min price override
  maxPrice?: number; // Optional max price override
  quotingPolicy?: QuotingPolicy; // Where to place quotes
  bestBid?: number; // Current best bid (for policy)
  bestAsk?: number; // Current best ask (for policy)
  avgCost?: number; // Average cost of inventory (for aggressive sell sizing)
  bidOffsetTicks?: number; // Ticks behind best bid (if configured)
  askOffsetTicks?: number; // Ticks above best ask (if configured)
}

export interface Quote {
  bidPrice: number;
  askPrice: number;
  bidSize: number;
  askSize: number;
  reduceOnly: boolean; // True if near inventory cap
}

// ============================================================================
// TIERED QUOTING
// ============================================================================

export interface TierConfig {
  bidOffsets: number[]; // Cents behind best bid [1, 2] = 1¢ and 2¢ behind
  askOffsets: number[]; // Cents behind best ask [0, 1] = at best and 1¢ behind
  sizes: number[]; // Size % per tier [0.5, 0.5] = 50% each
}

export interface TieredQuote {
  tier: number;
  side: "BID" | "ASK";
  price: number;
  size: number;
}

/**
 * Calculate bid/ask quotes with inventory-based skew.
 *
 * Inventory skew logic:
 * - When long (positive inventory): shift BOTH prices DOWN
 *   - Lower ask = more attractive to buyers = we sell = reduce long
 *   - Lower bid = less attractive for us to buy = we buy less = prevent adding
 * - When short (negative inventory): shift BOTH prices UP
 *   - Higher bid = more attractive to sellers = we buy = reduce short
 *   - Higher ask = less attractive for us to sell = we sell less = prevent adding
 *
 * Formula:
 *   invNorm = clamp(inventory / maxInventory, -1, 1)
 *   bid = mid - halfSpread - skewFactor * invNorm
 *   ask = mid + halfSpread - skewFactor * invNorm
 */
export function calculateQuotes(params: QuoteParams): Quote {
  const {
    midPrice,
    targetSpread,
    inventory,
    skewFactor,
    orderSize,
    maxInventory,
    quotingPolicy = "touch",
    bestBid,
    bestAsk,
  } = params;

  const tickSize = params.tickSize ?? TICK_SIZE;
  const minPrice = params.minPrice ?? MIN_PRICE;
  const maxPrice = params.maxPrice ?? MAX_PRICE;
  const halfSpread = targetSpread / 2;
  const profitFloor =
    params.avgCost !== undefined && params.avgCost > 0 ? params.avgCost + tickSize : null;

  // Normalize inventory to [-1, 1] range
  const invNorm = Math.max(-1, Math.min(1, inventory / maxInventory));

  // Calculate skew adjustment (positive when long, negative when short)
  // This shifts BOTH prices down when long, up when short
  const skewAdjustment = skewFactor * invNorm;

  // Base prices before policy adjustment
  let bidPrice = midPrice - halfSpread - skewAdjustment;
  let askPrice = midPrice + halfSpread - skewAdjustment;

  // Apply quoting policy
  if (quotingPolicy === "touch" && bestBid !== undefined && bestAsk !== undefined) {
    // Join the best bid/ask
    bidPrice = Math.min(bidPrice, bestBid);
    askPrice = Math.max(askPrice, bestAsk);
  } else if (quotingPolicy === "inside" && bestBid !== undefined && bestAsk !== undefined) {
    // Check if spread is wide enough to go inside (need > 1 tick)
    const currentSpread = bestAsk - bestBid;
    if (currentSpread > tickSize) {
      // Improve by one tick inside the spread
      bidPrice = Math.max(bidPrice, bestBid + tickSize);
      askPrice = Math.min(askPrice, bestAsk - tickSize);
    } else {
      // Spread too tight (1 tick or less), fall back to touch
      bidPrice = Math.min(bidPrice, bestBid);
      askPrice = Math.max(askPrice, bestAsk);
    }
  } else if (
    quotingPolicy === "offsets" ||
    params.bidOffsetTicks !== undefined ||
    params.askOffsetTicks !== undefined
  ) {
    const avgCost = params.avgCost ?? 0;

    if (params.bidOffsetTicks !== undefined && bestBid !== undefined) {
      bidPrice = bestBid - params.bidOffsetTicks * tickSize;
    }
    if (params.askOffsetTicks !== undefined && bestAsk !== undefined) {
      askPrice = bestAsk + params.askOffsetTicks * tickSize;
    }
    if (profitFloor !== null) {
      askPrice = Math.max(askPrice, profitFloor);
    }
  } else if (quotingPolicy === "defensive" && bestBid !== undefined && bestAsk !== undefined) {
    // Defensive policy: simple spread capture
    // - BUY: back of book (use calculated price, don't chase)
    // - SELL: touch (join best ask) but only above cost basis

    const avgCost = params.avgCost ?? 0;

    // BUY SIDE: back of book (calculated price already set, just cap at bestBid)
    bidPrice = Math.min(bidPrice, bestBid);

    // SELL SIDE: touch at best ask, but floor at cost basis
    askPrice = bestAsk;
    if (profitFloor !== null) {
      askPrice = Math.max(askPrice, profitFloor);
    }
  }
  // "back" policy: use calculated prices as-is (back of the book)

  if (profitFloor !== null) {
    askPrice = Math.max(askPrice, profitFloor);
  }

  // Round to tick size and clamp to valid range
  bidPrice = roundToTick(clampPrice(bidPrice, minPrice, maxPrice), tickSize);
  askPrice = roundToTick(clampPrice(askPrice, minPrice, maxPrice), tickSize);

  // Ensure ask > bid (maintain valid spread)
  if (askPrice <= bidPrice) {
    askPrice = bidPrice + tickSize;
  }

  // Determine if we're in reduce-only mode (near inventory cap)
  const reduceOnly = Math.abs(invNorm) >= 0.9;

  // Calculate sizes based on inventory position
  let bidSize = orderSize;
  let askSize = orderSize;

  // IMPORTANT: Can only SELL (askSize > 0) if we have inventory to sell
  // Polymarket doesn't allow selling tokens you don't own
  if (inventory <= 0) {
    askSize = 0; // No inventory = no selling
  } else {
    // Always use larger sell size to build queue priority
    // Rest larger orders to gain time priority for when market comes back
    const aggressiveSize = Math.max(orderSize * 3, inventory * 0.5);
    askSize = Math.min(inventory, aggressiveSize);
  }

  if (reduceOnly) {
    // Near max long: only allow selling (ask), no buying (bid)
    // Near max short: only allow buying (bid), no selling (ask)
    if (invNorm >= 0.9) {
      bidSize = 0; // Don't buy when at max long
    } else if (invNorm <= -0.9) {
      askSize = 0; // Don't sell when at max short
    }
  }

  return { bidPrice, askPrice, bidSize, askSize, reduceOnly };
}

/**
 * Calculate tiered quotes - multiple price levels per side.
 *
 * Places orders at multiple price levels to:
 * - Build queue priority at different levels
 * - Capture flow at various price points
 * - Average into/out of positions more gradually
 *
 * @param params Base quote parameters (same as calculateQuotes)
 * @param tierConfig Configuration for tier offsets and sizes
 * @returns Array of tiered quotes for both BID and ASK sides
 */
export function calculateTieredQuotes(
  params: QuoteParams & { bestBid: number; bestAsk: number },
  tierConfig: TierConfig
): TieredQuote[] {
  const { bestBid, bestAsk, orderSize, inventory, maxInventory } = params;
  const tickSize = params.tickSize ?? TICK_SIZE;
  const minPrice = params.minPrice ?? MIN_PRICE;
  const maxPrice = params.maxPrice ?? MAX_PRICE;

  const quotes: TieredQuote[] = [];
  const invNorm = Math.max(-1, Math.min(1, inventory / maxInventory));
  const reduceOnly = Math.abs(invNorm) >= 0.9;

  // Calculate total bid size (same as single quote logic)
  let totalBidSize = orderSize;
  if (reduceOnly && invNorm >= 0.9) {
    totalBidSize = 0; // Don't buy when at max long
  }

  // Calculate total ask size (same as single quote logic)
  let totalAskSize = orderSize;
  if (inventory <= 0) {
    totalAskSize = 0; // No inventory = no selling
  } else {
    // Aggressive sizing for sells
    const aggressiveSize = Math.max(orderSize * 3, inventory * 0.5);
    totalAskSize = Math.min(inventory, aggressiveSize);
  }
  if (reduceOnly && invNorm <= -0.9) {
    totalAskSize = 0; // Don't sell when at max short
  }

  // Generate BID tiers
  if (totalBidSize > 0) {
    for (let i = 0; i < tierConfig.bidOffsets.length; i++) {
      const offset = tierConfig.bidOffsets[i];
      const sizePercent = tierConfig.sizes[i] ?? (1 / tierConfig.bidOffsets.length);

      // Price = bestBid - offset (in cents, so multiply by TICK_SIZE)
      let price = bestBid - offset * tickSize;
      price = roundToTick(clampPrice(price, minPrice, maxPrice), tickSize);

      const size = Math.round(totalBidSize * sizePercent * 100) / 100; // Round to 2 decimals

      if (size > 0 && price > 0) {
        quotes.push({
          tier: i,
          side: "BID",
          price,
          size,
        });
      }
    }
  }

  // Generate ASK tiers
  if (totalAskSize > 0) {
    for (let i = 0; i < tierConfig.askOffsets.length; i++) {
      const offset = tierConfig.askOffsets[i];
      const sizePercent = tierConfig.sizes[i] ?? (1 / tierConfig.askOffsets.length);

      // Price = bestAsk + offset (behind the best ask)
      let price = bestAsk + offset * tickSize;
      price = roundToTick(clampPrice(price, minPrice, maxPrice), tickSize);

      const size = Math.round(totalAskSize * sizePercent * 100) / 100;

      if (size > 0 && price > 0) {
        quotes.push({
          tier: i,
          side: "ASK",
          price,
          size,
        });
      }
    }
  }

  return quotes;
}

/**
 * Parse tier config from comma-separated strings (as stored in DB)
 */
export function parseTierConfig(
  bidOffsetsStr: string,
  askOffsetsStr: string,
  sizesStr: string
): TierConfig {
  return {
    bidOffsets: bidOffsetsStr.split(",").map((s) => parseInt(s.trim(), 10)),
    askOffsets: askOffsetsStr.split(",").map((s) => parseInt(s.trim(), 10)),
    sizes: sizesStr.split(",").map((s) => parseFloat(s.trim())),
  };
}

/**
 * Clamp price to valid Polymarket range [MIN_PRICE, MAX_PRICE]
 */
function clampPrice(
  price: number,
  minPrice: number = MIN_PRICE,
  maxPrice: number = MAX_PRICE
): number {
  return Math.max(minPrice, Math.min(maxPrice, price));
}

/**
 * Round price to valid Polymarket tick size ($0.01)
 */
export function roundToTick(price: number, tickSize: number = TICK_SIZE): number {
  return Math.round(price / tickSize) * tickSize;
}

/**
 * Check if quotes need to be refreshed based on price movement
 */
export function shouldRefreshQuotes(
  currentMidPrice: number,
  quotedMidPrice: number,
  refreshThreshold: number
): boolean {
  if (quotedMidPrice === 0) return true; // No previous quote

  const priceChange = Math.abs(currentMidPrice - quotedMidPrice) / quotedMidPrice;
  return priceChange >= refreshThreshold;
}

/**
 * Calculate mid price from best bid and ask
 */
export function calculateMidPrice(bestBid: number, bestAsk: number): number {
  if (bestBid === 0 && bestAsk === 0) return 0.5; // No liquidity, assume 50/50
  if (bestBid === 0) return bestAsk;
  if (bestAsk === 0) return bestBid;
  return (bestBid + bestAsk) / 2;
}

/**
 * Calculate spread percentage
 */
export function calculateSpread(bestBid: number, bestAsk: number): number {
  if (bestBid === 0 || bestAsk === 0) return 1; // No liquidity
  return (bestAsk - bestBid) / ((bestAsk + bestBid) / 2);
}

export interface InventoryUpdate {
  newInventory: number;
  realizedPnl: number;
}

/**
 * Update inventory and calculate realized P&L from a fill
 *
 * @param currentInventory Current net position (+ = long YES, - = short YES / long NO)
 * @param fillSide Which side was filled: "BID" (we bought YES) or "ASK" (we sold YES)
 * @param fillAmount Amount filled in $ terms
 * @param fillPrice Price at which the fill occurred
 * @param avgEntryPrice Average entry price of current position (for P&L calc)
 */
export function updateInventoryFromFill(
  currentInventory: number,
  fillSide: "BID" | "ASK",
  fillAmount: number,
  fillPrice: number,
  avgEntryPrice: number
): InventoryUpdate {
  let newInventory: number;
  let realizedPnl = 0;

  if (fillSide === "BID") {
    // We bought YES tokens, inventory increases
    newInventory = currentInventory + fillAmount;
  } else {
    // We sold YES tokens, inventory decreases
    newInventory = currentInventory - fillAmount;

    // If we had positive inventory and sold, realize P&L
    if (currentInventory > 0) {
      const soldAmount = Math.min(fillAmount, currentInventory);
      realizedPnl = soldAmount * (fillPrice - avgEntryPrice);
    }
  }

  return { newInventory, realizedPnl };
}

/**
 * Format price for display (e.g., 0.7500 -> "75.00%")
 */
export function formatPriceAsPercent(price: number): string {
  return `${(price * 100).toFixed(2)}%`;
}

/**
 * Format inventory for display (e.g., 50.123456 -> "$50.12")
 */
export function formatInventory(inventory: number): string {
  const sign = inventory >= 0 ? "+" : "";
  return `${sign}$${Math.abs(inventory).toFixed(2)}`;
}

/**
 * Determine if a market is suitable for market making
 */
export interface MarketSuitability {
  suitable: boolean;
  reasons: string[];
}

export function checkMarketSuitability(
  liquidity: number,
  spread: number,
  minLiquidity: number = 10000,
  maxSpread: number = 0.10
): MarketSuitability {
  const reasons: string[] = [];

  if (liquidity < minLiquidity) {
    reasons.push(`Low liquidity: $${liquidity.toFixed(0)} < $${minLiquidity}`);
  }

  if (spread > maxSpread) {
    reasons.push(`High spread: ${(spread * 100).toFixed(1)}% > ${(maxSpread * 100).toFixed(0)}%`);
  }

  return {
    suitable: reasons.length === 0,
    reasons,
  };
}
