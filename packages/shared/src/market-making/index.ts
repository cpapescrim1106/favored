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

export type QuotingPolicy = "touch" | "inside" | "back";

export interface QuoteParams {
  midPrice: number;
  targetSpread: number; // e.g., 0.02 = 2%
  inventory: number; // Net position in shares (+ = long YES)
  skewFactor: number; // Max spread adjustment at full inventory
  orderSize: number; // Shares per side
  maxInventory: number; // Max shares exposure
  quotingPolicy?: QuotingPolicy; // Where to place quotes
  bestBid?: number; // Current best bid (for policy)
  bestAsk?: number; // Current best ask (for policy)
}

export interface Quote {
  bidPrice: number;
  askPrice: number;
  bidSize: number;
  askSize: number;
  reduceOnly: boolean; // True if near inventory cap
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

  const halfSpread = targetSpread / 2;

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
    // Improve by one tick inside the spread
    bidPrice = Math.max(bidPrice, bestBid + TICK_SIZE);
    askPrice = Math.min(askPrice, bestAsk - TICK_SIZE);
  }
  // "back" policy: use calculated prices as-is (back of the book)

  // Round to tick size and clamp to valid range
  bidPrice = roundToTick(clampPrice(bidPrice));
  askPrice = roundToTick(clampPrice(askPrice));

  // Ensure ask > bid (maintain valid spread)
  if (askPrice <= bidPrice) {
    askPrice = bidPrice + TICK_SIZE;
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
 * Clamp price to valid Polymarket range [MIN_PRICE, MAX_PRICE]
 */
function clampPrice(price: number): number {
  return Math.max(MIN_PRICE, Math.min(MAX_PRICE, price));
}

/**
 * Round price to valid Polymarket tick size ($0.01)
 */
export function roundToTick(price: number): number {
  return Math.round(price / TICK_SIZE) * TICK_SIZE;
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
