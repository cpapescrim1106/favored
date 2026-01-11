import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import {
  initializeClobClient,
  isCLOBConfigured,
  placeOrder,
  getMakerPrice,
} from "@favored/shared/polymarket";

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

interface ExecutionResult {
  itemId: string;
  marketSlug: string;
  side: string;
  success: boolean;
  orderId?: string;
  price?: number;
  size?: number;
  status?: string;
  error?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { basketId, dryRun = true } = body;

    if (!basketId) {
      return NextResponse.json({ error: "basketId required" }, { status: 400 });
    }

    // Check kill switch
    const config = await prisma.config.findUnique({
      where: { id: "singleton" },
    });

    if (config?.killSwitchActive) {
      return NextResponse.json(
        { error: "Kill switch is active" },
        { status: 403 }
      );
    }

    // Get basket
    const basket = await prisma.basket.findUnique({
      where: { id: basketId },
      include: {
        items: {
          include: { market: true },
        },
      },
    });

    if (!basket) {
      return NextResponse.json({ error: "Basket not found" }, { status: 404 });
    }

    if (basket.status !== "DRAFT") {
      return NextResponse.json(
        { error: `Basket is ${basket.status}, not DRAFT` },
        { status: 400 }
      );
    }

    // Update basket status
    await prisma.basket.update({
      where: { id: basketId },
      data: { status: "EXECUTING" },
    });

    const results: ExecutionResult[] = [];
    const errors: string[] = [];

    // Initialize CLOB client if not dry run
    let clobClient: Awaited<ReturnType<typeof initializeClobClient>>["client"] | null = null;

    if (!dryRun && isCLOBConfigured()) {
      try {
        const { client } = await initializeClobClient();
        clobClient = client;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        await prisma.basket.update({
          where: { id: basketId },
          data: { status: "FAILED" },
        });
        return NextResponse.json({
          success: false,
          error: `Failed to initialize CLOB: ${errorMsg}`,
        }, { status: 500 });
      }
    }

    // Process each item
    for (const item of basket.items) {
      const result: ExecutionResult = {
        itemId: item.id,
        marketSlug: item.market.slug,
        side: item.side,
        success: false,
      };

      try {
        // Calculate size from stake / snapshotPrice
        const snapshotPrice = Number(item.snapshotPrice);
        const size = Math.round(Number(item.stake) / snapshotPrice);

        if (dryRun || !clobClient) {
          // Dry run - simulate order placement
          const orderId = `dry-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

          // Still fetch orderbook to show what price would be used
          let makerPrice = snapshotPrice;
          try {
            // Get market info from CLOB to get token ID
            const clobMarket = await clobClient?.getMarket(item.marketId) as CLOBMarketInfo | undefined;
            if (clobMarket?.tokens) {
              const token = clobMarket.tokens.find(
                t => t.outcome === (item.side === "YES" ? "Yes" : "No")
              );
              if (token) {
                const { price } = await getMakerPrice(token.token_id, "BUY", snapshotPrice);
                makerPrice = price;
              }
            }
          } catch {
            // Ignore errors fetching price in dry run
          }

          result.success = true;
          result.orderId = orderId;
          result.price = makerPrice;
          result.size = size;
          result.status = "simulated";

          await prisma.basketItem.update({
            where: { id: item.id },
            data: {
              orderId,
              status: "simulated",
            },
          });
        } else {
          // Real execution - fetch token ID and place order
          const clobMarket = await clobClient.getMarket(item.marketId) as CLOBMarketInfo;

          if (!clobMarket || !clobMarket.tokens || clobMarket.tokens.length < 2) {
            throw new Error("Market not found in CLOB or missing tokens");
          }

          // Determine which token to trade
          // For YES side: buy YES token
          // For NO side: buy NO token (which is equivalent to selling YES)
          const token = clobMarket.tokens.find(
            t => t.outcome === (item.side === "YES" ? "Yes" : "No")
          );

          if (!token) {
            throw new Error(`Token for ${item.side} side not found`);
          }

          // Get maker price from orderbook
          const tickSize = clobMarket.minimum_tick_size || 0.01;
          const { price: makerPrice, depth } = await getMakerPrice(
            token.token_id,
            "BUY",  // We're always buying the token (YES or NO)
            snapshotPrice,
            tickSize
          );

          // Check if our size exceeds available depth (warning only)
          if (depth > 0 && size > depth) {
            console.log(`[EXECUTE] Warning: Order size ${size} exceeds best bid depth ${depth} for ${item.market.slug}`);
          }

          // Validate size meets minimum
          const minSize = clobMarket.minimum_order_size || 5;
          if (size < minSize) {
            throw new Error(`Size ${size} below minimum ${minSize}`);
          }

          // Round price to tick size
          const roundedPrice = Math.round(makerPrice / tickSize) * tickSize;

          // Place order with GTC + postOnly (maker strategy)
          const orderResult = await placeOrder({
            tokenId: token.token_id,
            side: "BUY",
            price: roundedPrice,
            size: size,
            orderType: "GTC",
            postOnly: true,  // Reject if would cross spread
          });

          if (orderResult.success) {
            result.success = true;
            result.orderId = orderResult.orderId;
            result.price = roundedPrice;
            result.size = size;
            result.status = orderResult.status || "submitted";

            await prisma.basketItem.update({
              where: { id: item.id },
              data: {
                orderId: orderResult.orderId,
                status: "submitted",
              },
            });
          } else {
            throw new Error(orderResult.error || "Order placement failed");
          }
        }

        // Log the order
        await prisma.log.create({
          data: {
            level: "INFO",
            category: "ORDER",
            message: `${dryRun ? "[DRY RUN] " : ""}Order ${item.side} ${item.market.slug} @ $${result.price?.toFixed(4)} for ${result.size} shares`,
            metadata: {
              orderId: result.orderId,
              marketId: item.marketId,
              side: item.side,
              stake: Number(item.stake),
              price: result.price,
              size: result.size,
              status: result.status,
              dryRun,
              strategy: "maker-postOnly",
            },
          },
        });

        results.push(result);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push(`${item.market.slug}: ${errorMsg}`);
        result.error = errorMsg;
        results.push(result);

        await prisma.basketItem.update({
          where: { id: item.id },
          data: { status: "failed" },
        });

        await prisma.log.create({
          data: {
            level: "ERROR",
            category: "ORDER",
            message: `Order failed: ${item.market.slug} - ${errorMsg}`,
            metadata: {
              marketId: item.marketId,
              side: item.side,
              error: errorMsg,
            },
          },
        });
      }
    }

    // Update basket status
    const successCount = results.filter(r => r.success).length;
    const finalStatus = errors.length === 0
      ? "COMPLETED"
      : errors.length === basket.items.length
        ? "FAILED"
        : "COMPLETED";  // Partial success still marked completed

    await prisma.basket.update({
      where: { id: basketId },
      data: {
        status: finalStatus,
        executedAt: new Date(),
      },
    });

    // Log completion
    await prisma.log.create({
      data: {
        level: errors.length > 0 ? "WARN" : "INFO",
        category: "BASKET",
        message: `Basket ${basketId} execution ${finalStatus.toLowerCase()}: ${successCount}/${basket.items.length} orders placed${errors.length > 0 ? `, ${errors.length} errors` : ""}`,
        metadata: {
          basketId,
          totalItems: basket.items.length,
          successCount,
          errorCount: errors.length,
          errors: errors.length > 0 ? errors : undefined,
          dryRun,
          strategy: "maker-postOnly",
        },
      },
    });

    return NextResponse.json({
      success: errors.length === 0,
      basketId,
      ordersPlaced: successCount,
      totalItems: basket.items.length,
      batches: basket.batchCount,
      results,
      errors: errors.length > 0 ? errors : undefined,
      dryRun,
      strategy: "maker-postOnly",
    });
  } catch (error) {
    console.error("Failed to execute basket:", error);
    return NextResponse.json(
      { error: "Failed to execute basket" },
      { status: 500 }
    );
  }
}
