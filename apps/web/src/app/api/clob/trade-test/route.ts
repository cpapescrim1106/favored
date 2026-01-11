import { NextResponse } from "next/server";
import {
  initializeClobClient,
  isCLOBConfigured,
  getOrderbook,
} from "@favored/shared/polymarket";
import { fetchMarkets } from "@favored/shared/polymarket";

/**
 * Test trade endpoint - places a small limit order on a liquid market
 *
 * GET: Preview what would be traded (dry run info)
 * POST: Actually place a small test order
 */

interface CLOBMarketToken {
  token_id: string;
  outcome: string;
  price: number;
}

interface CLOBMarketInfo {
  condition_id: string;
  question: string;
  tokens: CLOBMarketToken[];
  minimum_order_size: number;
  minimum_tick_size: number;
  active: boolean;
}

async function findTestMarket(): Promise<{
  conditionId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
  yesPrice: number;
  noPrice: number;
  minOrderSize: number;
  minTickSize: number;
} | null> {
  // Get markets from Gamma API (these have liquidity data)
  const gammaMarkets = await fetchMarkets({
    active: true,
    closed: false,
    limit: 100,
    minLiquidity: 50000, // High liquidity = active orderbook
  });

  console.log(`[TEST TRADE] Found ${gammaMarkets.length} high-liquidity markets`);

  // Get the CLOB client
  const { client } = await initializeClobClient();

  // Check each market for a valid orderbook
  for (const market of gammaMarkets) {
    if (!market.conditionId) continue;

    try {
      // Get market details from CLOB
      const clobMarket = await client.getMarket(market.conditionId) as CLOBMarketInfo;
      if (!clobMarket || !clobMarket.tokens || clobMarket.tokens.length < 2) continue;

      const yesToken = clobMarket.tokens.find(t => t.outcome === "Yes");
      const noToken = clobMarket.tokens.find(t => t.outcome === "No");

      if (!yesToken || !noToken) continue;

      // Skip extreme prices
      if (yesToken.price < 0.1 || yesToken.price > 0.9) continue;

      // Verify orderbook exists by fetching it
      const orderbook = await getOrderbook(yesToken.token_id);
      if (orderbook.bids.length === 0 && orderbook.asks.length === 0) {
        console.log(`[TEST TRADE] Skipping ${market.slug} - no orderbook`);
        continue;
      }

      console.log(`[TEST TRADE] Found market with orderbook: ${market.slug}`);
      return {
        conditionId: market.conditionId,
        question: clobMarket.question || market.question,
        yesTokenId: yesToken.token_id,
        noTokenId: noToken.token_id,
        yesPrice: yesToken.price,
        noPrice: noToken.price,
        minOrderSize: clobMarket.minimum_order_size || 5,
        minTickSize: clobMarket.minimum_tick_size || 0.01,
      };
    } catch (error) {
      console.log(`[TEST TRADE] Error checking ${market.slug}:`, error);
      continue;
    }
  }

  return null;
}

export async function GET() {
  try {
    if (!isCLOBConfigured()) {
      return NextResponse.json({
        error: "CLOB not configured",
      }, { status: 400 });
    }

    const market = await findTestMarket();

    if (!market) {
      return NextResponse.json({
        error: "No suitable test market found",
      }, { status: 404 });
    }

    // Get current orderbook for the YES token
    const orderbook = await getOrderbook(market.yesTokenId);

    // Calculate a safe test order:
    // - Buy YES at a price below current market (limit order that won't fill immediately)
    // - Size: minimum or small amount
    const priceOffset = Math.max(0.02, market.minTickSize * 2);
    const testPrice = Math.max(market.minTickSize, market.yesPrice - priceOffset);
    const testSize = Math.max(market.minOrderSize, 5); // At least min or 5 contracts

    return NextResponse.json({
      preview: true,
      market: {
        conditionId: market.conditionId,
        question: market.question,
        yesTokenId: market.yesTokenId,
        noTokenId: market.noTokenId,
        yesPrice: market.yesPrice,
        noPrice: market.noPrice,
        minOrderSize: market.minOrderSize,
        minTickSize: market.minTickSize,
      },
      proposedOrder: {
        side: "BUY",
        outcome: "YES",
        tokenId: market.yesTokenId,
        price: testPrice.toFixed(4),
        size: testSize.toFixed(2),
        totalCost: `$${(testPrice * testSize).toFixed(2)}`,
        note: "This is a limit order below market price - may not fill immediately",
      },
      orderbook: {
        bestBid: orderbook.bids[0]?.price || null,
        bestAsk: orderbook.asks[0]?.price || null,
        bidDepth: orderbook.bids.length,
        askDepth: orderbook.asks.length,
      },
      instructions: "POST to this endpoint to place the order",
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    if (!isCLOBConfigured()) {
      return NextResponse.json({
        error: "CLOB not configured",
      }, { status: 400 });
    }

    // Optional: Accept custom parameters
    const body = await request.json().catch(() => ({}));
    const customTokenId = body.tokenId as string | undefined;
    const customPrice = body.price as number | undefined;
    const customSize = body.size as number | undefined;

    let tokenId: string;
    let price: number;
    let size: number;
    let marketQuestion: string;

    if (customTokenId && customPrice && customSize) {
      // Use custom parameters
      tokenId = customTokenId;
      price = customPrice;
      size = customSize;
      marketQuestion = "Custom order";
    } else {
      // Find a test market
      const market = await findTestMarket();

      if (!market) {
        return NextResponse.json({
          error: "No suitable test market found",
        }, { status: 404 });
      }

      tokenId = market.yesTokenId;
      const priceOffset = Math.max(0.02, market.minTickSize * 2);
      price = Math.max(market.minTickSize, market.yesPrice - priceOffset);
      size = Math.max(market.minOrderSize, 5);
      marketQuestion = market.question;
    }

    // Initialize the CLOB client
    const { client } = await initializeClobClient();

    // Create and sign the order
    console.log(`[TEST TRADE] Placing order: BUY ${size.toFixed(2)} @ ${price.toFixed(4)} on "${marketQuestion}"`);

    const signedOrder = await client.createOrder({
      tokenID: tokenId,
      side: "BUY" as unknown as import("@polymarket/clob-client").Side,
      price,
      size,
    });

    // Post the order
    const response = await client.postOrder(signedOrder);

    return NextResponse.json({
      success: true,
      order: {
        orderId: response.orderID || response.id,
        tokenId,
        side: "BUY",
        price: price.toFixed(4),
        size: size.toFixed(2),
        totalCost: `$${(price * size).toFixed(2)}`,
        market: marketQuestion,
      },
      message: "Test order placed successfully!",
      note: "This is a limit order - check your Polymarket account to see it",
    });
  } catch (error) {
    console.error("[TEST TRADE] Error:", error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}
