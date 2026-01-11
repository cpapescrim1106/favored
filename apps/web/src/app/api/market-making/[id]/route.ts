import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { cancelOrder } from "@favored/shared";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/market-making/[id]
 * Get a single market maker by ID
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    const marketMaker = await prisma.marketMaker.findUnique({
      where: { id },
      include: {
        market: {
          select: {
            slug: true,
            question: true,
            category: true,
            yesPrice: true,
            noPrice: true,
            liquidity: true,
            spread: true,
            endDate: true,
          },
        },
        orders: true,
        fills: {
          orderBy: { filledAt: "desc" },
          take: 20,
        },
      },
    });

    if (!marketMaker) {
      return NextResponse.json(
        { error: "Market maker not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      id: marketMaker.id,
      marketId: marketMaker.marketId,
      market: marketMaker.market
        ? {
            slug: marketMaker.market.slug,
            question: marketMaker.market.question,
            category: marketMaker.market.category,
            yesPrice: marketMaker.market.yesPrice
              ? Number(marketMaker.market.yesPrice)
              : null,
            noPrice: marketMaker.market.noPrice
              ? Number(marketMaker.market.noPrice)
              : null,
            liquidity: marketMaker.market.liquidity
              ? Number(marketMaker.market.liquidity)
              : null,
            spread: marketMaker.market.spread
              ? Number(marketMaker.market.spread)
              : null,
            endDate: marketMaker.market.endDate?.toISOString() || null,
          }
        : null,
      active: marketMaker.active,
      paused: marketMaker.paused,
      targetSpread: Number(marketMaker.targetSpread),
      orderSize: Number(marketMaker.orderSize),
      maxInventory: Number(marketMaker.maxInventory),
      skewFactor: Number(marketMaker.skewFactor),
      quotingPolicy: marketMaker.quotingPolicy,
      yesInventory: Number(marketMaker.yesInventory),
      noInventory: Number(marketMaker.noInventory),
      avgYesCost: Number(marketMaker.avgYesCost),
      avgNoCost: Number(marketMaker.avgNoCost),
      realizedPnl: Number(marketMaker.realizedPnl),
      minTimeToResolution: marketMaker.minTimeToResolution,
      volatilityPauseUntil: marketMaker.volatilityPauseUntil?.toISOString() || null,
      orders: marketMaker.orders.map((o) => ({
        id: o.id,
        outcome: o.outcome,
        side: o.side,
        orderId: o.orderId,
        price: Number(o.price),
        size: Number(o.size),
        placedAt: o.placedAt.toISOString(),
      })),
      recentFills: marketMaker.fills.map((f) => ({
        id: f.id,
        outcome: f.outcome,
        side: f.side,
        price: Number(f.price),
        size: Number(f.size),
        value: Number(f.value),
        realizedPnl: f.realizedPnl ? Number(f.realizedPnl) : null,
        filledAt: f.filledAt.toISOString(),
      })),
      lastQuoteAt: marketMaker.lastQuoteAt?.toISOString() || null,
      createdAt: marketMaker.createdAt.toISOString(),
      updatedAt: marketMaker.updatedAt.toISOString(),
    });
  } catch (error) {
    console.error("Failed to fetch market maker:", error);
    return NextResponse.json(
      { error: "Failed to fetch market maker" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/market-making/[id]
 * Update market maker parameters
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = await request.json();

    const {
      targetSpread,
      orderSize,
      maxInventory,
      skewFactor,
      quotingPolicy,
      minTimeToResolution,
      paused,
      active,
      volatilityPauseUntil,
    } = body;

    // Build update data object with only provided fields
    const updateData: Record<string, unknown> = {};
    if (targetSpread !== undefined) updateData.targetSpread = targetSpread;
    if (orderSize !== undefined) updateData.orderSize = orderSize;
    if (maxInventory !== undefined) updateData.maxInventory = maxInventory;
    if (skewFactor !== undefined) updateData.skewFactor = skewFactor;
    if (quotingPolicy !== undefined) updateData.quotingPolicy = quotingPolicy;
    if (minTimeToResolution !== undefined) updateData.minTimeToResolution = minTimeToResolution;
    if (paused !== undefined) updateData.paused = paused;
    if (active !== undefined) updateData.active = active;
    if (volatilityPauseUntil !== undefined) {
      updateData.volatilityPauseUntil = volatilityPauseUntil
        ? new Date(volatilityPauseUntil)
        : null;
    }

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json(
        { error: "No valid fields to update" },
        { status: 400 }
      );
    }

    const marketMaker = await prisma.marketMaker.update({
      where: { id },
      data: updateData,
      include: {
        market: {
          select: {
            slug: true,
          },
        },
      },
    });

    // Log the update
    await prisma.log.create({
      data: {
        level: "INFO",
        category: "SYSTEM",
        message: `Market maker updated for ${marketMaker.market?.slug}`,
        metadata: {
          marketMakerId: id,
          updates: Object.keys(updateData),
        },
      },
    });

    return NextResponse.json({
      success: true,
      marketMaker: {
        id: marketMaker.id,
        marketId: marketMaker.marketId,
        active: marketMaker.active,
        paused: marketMaker.paused,
        targetSpread: Number(marketMaker.targetSpread),
        orderSize: Number(marketMaker.orderSize),
        maxInventory: Number(marketMaker.maxInventory),
        skewFactor: Number(marketMaker.skewFactor),
        quotingPolicy: marketMaker.quotingPolicy,
        updatedAt: marketMaker.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    console.error("Failed to update market maker:", error);
    return NextResponse.json(
      { error: "Failed to update market maker" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/market-making/[id]
 * Stop making on a market and delete the market maker
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    // Get the market maker with orders
    const marketMaker = await prisma.marketMaker.findUnique({
      where: { id },
      include: {
        market: {
          select: {
            slug: true,
          },
        },
        orders: true,
      },
    });

    if (!marketMaker) {
      return NextResponse.json(
        { error: "Market maker not found" },
        { status: 404 }
      );
    }

    // Cancel any open orders
    let cancelledCount = 0;
    for (const order of marketMaker.orders) {
      try {
        await cancelOrder(order.orderId);
        cancelledCount++;
      } catch (e) {
        console.error(`Failed to cancel order ${order.orderId}:`, e);
      }
    }

    // Delete the market maker (cascades to orders, fills, and history)
    await prisma.marketMaker.delete({
      where: { id },
    });

    // Log the deletion
    await prisma.log.create({
      data: {
        level: "INFO",
        category: "SYSTEM",
        message: `Market maker deleted for ${marketMaker.market?.slug}`,
        metadata: {
          marketMakerId: id,
          marketId: marketMaker.marketId,
          cancelledOrders: cancelledCount,
          finalYesInventory: Number(marketMaker.yesInventory),
          finalNoInventory: Number(marketMaker.noInventory),
          finalPnl: Number(marketMaker.realizedPnl),
        },
      },
    });

    return NextResponse.json({
      success: true,
      cancelledOrders: cancelledCount,
    });
  } catch (error) {
    console.error("Failed to delete market maker:", error);
    return NextResponse.json(
      { error: "Failed to delete market maker" },
      { status: 500 }
    );
  }
}
