import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import {
  initializeClobClient,
  isCLOBConfigured,
  fetchActiveOrders,
} from "@favored/shared/polymarket";

interface OpenOrder {
  id: string;
  status: string;
  owner: string;
  maker_address: string;
  market: string;
  asset_id: string;
  side: string;
  original_size: string;
  size_matched: string;
  price: string;
  outcome: string;
  created_at: number;
  expiration: string;
  order_type: string;
}

/**
 * GET /api/orders - Fetch open orders from CLOB
 *
 * Query params:
 * - marketId: Filter by market condition ID
 * - sync: If "true", also update basket item statuses
 */
export async function GET(request: NextRequest) {
  try {
    if (!isCLOBConfigured()) {
      return NextResponse.json({
        error: "CLOB not configured",
        orders: [],
      });
    }

    const { searchParams } = new URL(request.url);
    const marketId = searchParams.get("marketId");
    const sync = searchParams.get("sync") === "true";

    const { client } = await initializeClobClient();

    // Fetch open orders
    const openOrders = await client.getOpenOrders(
      marketId ? { market: marketId } : undefined
    ) as OpenOrder[];

    // If sync requested, update basket item statuses
    if (sync && openOrders.length > 0) {
      // Get basket items that have order IDs
      const basketItems = await prisma.basketItem.findMany({
        where: {
          orderId: { not: null },
          status: { in: ["submitted", "pending"] },
        },
      });

      // Create a map of order IDs to their status
      const orderStatusMap = new Map(
        openOrders.map(o => [o.id, o])
      );

      // Update basket items based on order status
      for (const item of basketItems) {
        if (!item.orderId) continue;

        const order = orderStatusMap.get(item.orderId);

        if (order) {
          // Order still open
          const sizeMatched = parseFloat(order.size_matched || "0");
          const originalSize = parseFloat(order.original_size || "0");

          if (sizeMatched > 0 && sizeMatched < originalSize) {
            // Partially filled
            await prisma.basketItem.update({
              where: { id: item.id },
              data: {
                status: "partial",
                fillAmount: sizeMatched,
                fillPrice: parseFloat(order.price),
              },
            });
          }
        } else {
          // Order not in open orders - might be filled or cancelled
          // Fetch individual order to check
          try {
            const orderDetail = await client.getOrder(item.orderId) as OpenOrder;

            if (orderDetail.status === "matched") {
              await prisma.basketItem.update({
                where: { id: item.id },
                data: {
                  status: "filled",
                  fillAmount: parseFloat(orderDetail.original_size),
                  fillPrice: parseFloat(orderDetail.price),
                },
              });
            } else if (orderDetail.status === "cancelled") {
              await prisma.basketItem.update({
                where: { id: item.id },
                data: { status: "cancelled" },
              });
            }
          } catch {
            // Order not found - might have been filled and removed
            // Mark as potentially filled
            await prisma.basketItem.update({
              where: { id: item.id },
              data: { status: "filled" },
            });
          }
        }
      }
    }

    // Format orders for response
    const formattedOrders = openOrders.map(order => ({
      id: order.id,
      marketId: order.market,
      tokenId: order.asset_id,
      side: order.side,
      outcome: order.outcome,
      price: parseFloat(order.price),
      originalSize: parseFloat(order.original_size),
      sizeMatched: parseFloat(order.size_matched || "0"),
      sizeRemaining: parseFloat(order.original_size) - parseFloat(order.size_matched || "0"),
      status: order.status,
      orderType: order.order_type,
      createdAt: new Date(order.created_at * 1000).toISOString(),
      expiration: order.expiration,
    }));

    return NextResponse.json({
      orders: formattedOrders,
      count: formattedOrders.length,
      synced: sync,
    });
  } catch (error) {
    console.error("Failed to fetch orders:", error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Failed to fetch orders",
      orders: [],
    }, { status: 500 });
  }
}

/**
 * DELETE /api/orders - Cancel orders
 *
 * Body:
 * - orderIds: Array of order IDs to cancel
 * - all: If true, cancel all open orders
 */
export async function DELETE(request: NextRequest) {
  try {
    if (!isCLOBConfigured()) {
      return NextResponse.json({
        error: "CLOB not configured",
      }, { status: 400 });
    }

    const body = await request.json();
    const { orderIds, all } = body;

    const { client } = await initializeClobClient();

    let cancelledCount = 0;
    const errors: string[] = [];

    if (all) {
      // Cancel all open orders
      const result = await client.cancelAll();
      cancelledCount = result?.canceledOrders?.length || 0;

      // Update all submitted basket items to cancelled
      await prisma.basketItem.updateMany({
        where: { status: "submitted" },
        data: { status: "cancelled" },
      });
    } else if (orderIds && Array.isArray(orderIds)) {
      // Cancel specific orders
      for (const orderId of orderIds) {
        try {
          await client.cancelOrder({ orderID: orderId });
          cancelledCount++;

          // Update basket item if exists
          await prisma.basketItem.updateMany({
            where: { orderId },
            data: { status: "cancelled" },
          });
        } catch (error) {
          errors.push(`${orderId}: ${error instanceof Error ? error.message : "Failed"}`);
        }
      }
    } else {
      return NextResponse.json({
        error: "Provide orderIds array or all: true",
      }, { status: 400 });
    }

    // Log cancellation
    await prisma.log.create({
      data: {
        level: errors.length > 0 ? "WARN" : "INFO",
        category: "ORDER",
        message: `Cancelled ${cancelledCount} orders${errors.length > 0 ? `, ${errors.length} errors` : ""}`,
        metadata: {
          cancelledCount,
          errors: errors.length > 0 ? errors : undefined,
          all,
        },
      },
    });

    return NextResponse.json({
      success: errors.length === 0,
      cancelledCount,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error("Failed to cancel orders:", error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Failed to cancel orders",
    }, { status: 500 });
  }
}
