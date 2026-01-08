/**
 * Polymarket CLOB API Client
 *
 * The CLOB API provides trading functionality.
 * Requires L2 authentication for order placement.
 *
 * MVP0: Stub implementation (shadow mode)
 * MVP1: Full implementation with real order placement
 */

import type {
  CLOBOrder,
  CLOBPosition,
  OrderRequest,
  OrderResponse,
  BatchOrderRequest,
  BatchOrderResponse,
} from "./types.js";

const CLOB_BASE_URL = "https://clob.polymarket.com";

// Maximum orders per batch (Polymarket limit)
export const MAX_BATCH_SIZE = 15;

/**
 * CLOB API Client Configuration
 */
export interface CLOBConfig {
  apiKey?: string;
  apiSecret?: string;
  passphrase?: string;
  privateKey?: string;
  dryRun?: boolean;
}

let clobConfig: CLOBConfig = {
  dryRun: true, // Default to dry run mode
};

/**
 * Configure the CLOB client
 */
export function configureCLOB(config: CLOBConfig): void {
  clobConfig = { ...clobConfig, ...config };
}

/**
 * Check if the CLOB client is configured for real trading
 */
export function isCLOBConfigured(): boolean {
  return !!(
    clobConfig.apiKey &&
    clobConfig.apiSecret &&
    clobConfig.passphrase &&
    clobConfig.privateKey
  );
}

/**
 * Fetch current positions
 * MVP0: Returns empty array (no real positions in shadow mode)
 */
export async function fetchPositions(): Promise<CLOBPosition[]> {
  if (clobConfig.dryRun || !isCLOBConfigured()) {
    console.log("[CLOB] Dry run mode - returning empty positions");
    return [];
  }

  // TODO: MVP1 - Implement actual position fetching
  // const response = await authenticatedFetch(`${CLOB_BASE_URL}/positions`);
  // return response.json();

  return [];
}

/**
 * Fetch active orders
 * MVP0: Returns empty array
 */
export async function fetchActiveOrders(): Promise<CLOBOrder[]> {
  if (clobConfig.dryRun || !isCLOBConfigured()) {
    console.log("[CLOB] Dry run mode - returning empty orders");
    return [];
  }

  // TODO: MVP1 - Implement actual order fetching
  return [];
}

/**
 * Place a single order
 * MVP0: Logs order and returns mock success
 */
export async function placeOrder(order: OrderRequest): Promise<OrderResponse> {
  console.log("[CLOB] Order request:", {
    tokenId: order.tokenId.slice(0, 8) + "...",
    side: order.side,
    price: order.price,
    size: order.size,
  });

  if (clobConfig.dryRun || !isCLOBConfigured()) {
    console.log("[CLOB] Dry run mode - order not placed");
    return {
      success: true,
      orderId: `dry-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
  }

  // TODO: MVP1 - Implement actual order placement
  // This requires:
  // 1. Building the order with proper signature
  // 2. Sending to CLOB API with L2 authentication headers
  // 3. Handling response and errors

  return {
    success: false,
    error: "Real order placement not implemented yet",
  };
}

/**
 * Place multiple orders in a batch
 * Splits into chunks of MAX_BATCH_SIZE
 */
export async function placeBatchOrders(
  request: BatchOrderRequest
): Promise<BatchOrderResponse> {
  const results: OrderResponse[] = [];
  const errors: string[] = [];

  // Split orders into batches
  const batches: OrderRequest[][] = [];
  for (let i = 0; i < request.orders.length; i += MAX_BATCH_SIZE) {
    batches.push(request.orders.slice(i, i + MAX_BATCH_SIZE));
  }

  console.log(
    `[CLOB] Placing ${request.orders.length} orders in ${batches.length} batches`
  );

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    console.log(`[CLOB] Processing batch ${batchIndex + 1}/${batches.length}`);

    for (const order of batch) {
      try {
        const result = await placeOrder(order);
        results.push(result);
        if (!result.success && result.error) {
          errors.push(result.error);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        results.push({ success: false, error: errorMessage });
        errors.push(errorMessage);
      }
    }

    // Small delay between batches to avoid rate limiting
    if (batchIndex < batches.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return {
    success: errors.length === 0,
    results,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Cancel an order
 */
export async function cancelOrder(orderId: string): Promise<boolean> {
  console.log(`[CLOB] Cancel order request: ${orderId}`);

  if (clobConfig.dryRun || !isCLOBConfigured()) {
    console.log("[CLOB] Dry run mode - order not cancelled");
    return true;
  }

  // TODO: MVP1 - Implement actual order cancellation
  return false;
}

/**
 * Cancel all orders for a market
 */
export async function cancelAllOrders(marketId?: string): Promise<number> {
  console.log(`[CLOB] Cancel all orders request${marketId ? ` for market ${marketId}` : ""}`);

  if (clobConfig.dryRun || !isCLOBConfigured()) {
    console.log("[CLOB] Dry run mode - orders not cancelled");
    return 0;
  }

  // TODO: MVP1 - Implement actual order cancellation
  return 0;
}

/**
 * Get orderbook for a market
 */
export async function getOrderbook(
  tokenId: string
): Promise<{ bids: Array<{ price: number; size: number }>; asks: Array<{ price: number; size: number }> }> {
  try {
    const response = await fetch(`${CLOB_BASE_URL}/book?token_id=${tokenId}`);

    if (!response.ok) {
      throw new Error(`CLOB API error: ${response.status}`);
    }

    return (await response.json()) as { bids: Array<{ price: number; size: number }>; asks: Array<{ price: number; size: number }> };
  } catch (error) {
    console.error(`Failed to fetch orderbook for ${tokenId}:`, error);
    return { bids: [], asks: [] };
  }
}

/**
 * Get midpoint price for a token
 */
export async function getMidpointPrice(tokenId: string): Promise<number | null> {
  try {
    const response = await fetch(`${CLOB_BASE_URL}/midpoint?token_id=${tokenId}`);

    if (!response.ok) {
      throw new Error(`CLOB API error: ${response.status}`);
    }

    const data = (await response.json()) as { mid?: string };
    return data.mid ? parseFloat(data.mid) : null;
  } catch (error) {
    console.error(`Failed to fetch midpoint for ${tokenId}:`, error);
    return null;
  }
}

/**
 * Get spread for a token
 */
export async function getSpread(tokenId: string): Promise<number | null> {
  try {
    const response = await fetch(`${CLOB_BASE_URL}/spread?token_id=${tokenId}`);

    if (!response.ok) {
      throw new Error(`CLOB API error: ${response.status}`);
    }

    const data = (await response.json()) as { spread?: string };
    return data.spread ? parseFloat(data.spread) : null;
  } catch (error) {
    console.error(`Failed to fetch spread for ${tokenId}:`, error);
    return null;
  }
}
