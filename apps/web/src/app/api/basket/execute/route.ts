import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

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

    const ordersPlaced: string[] = [];
    const errors: string[] = [];

    // Process each item
    for (const item of basket.items) {
      try {
        // MVP0: Shadow mode - just log, don't actually place orders
        const orderId = `shadow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        await prisma.basketItem.update({
          where: { id: item.id },
          data: {
            orderId,
            status: dryRun ? "simulated" : "submitted",
          },
        });

        ordersPlaced.push(orderId);

        // Log the shadow trade
        await prisma.log.create({
          data: {
            level: "INFO",
            category: "ORDER",
            message: `${dryRun ? "[DRY RUN] " : ""}Order ${item.side} ${item.market.slug} @ $${Number(item.limitPrice).toFixed(2)} for $${Number(item.stake).toFixed(2)}`,
            metadata: {
              orderId,
              marketId: item.marketId,
              side: item.side,
              stake: Number(item.stake),
              limitPrice: Number(item.limitPrice),
              dryRun,
            },
          },
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push(`${item.market.slug}: ${errorMsg}`);

        await prisma.basketItem.update({
          where: { id: item.id },
          data: { status: "failed" },
        });
      }
    }

    // Update basket status
    const finalStatus = errors.length === 0 ? "COMPLETED" : errors.length === basket.items.length ? "FAILED" : "COMPLETED";

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
        message: `Basket ${basketId} execution ${finalStatus.toLowerCase()}: ${ordersPlaced.length} orders placed${errors.length > 0 ? `, ${errors.length} errors` : ""}`,
        metadata: {
          basketId,
          ordersPlaced: ordersPlaced.length,
          errors: errors.length > 0 ? errors : undefined,
          dryRun,
        },
      },
    });

    return NextResponse.json({
      success: errors.length === 0,
      basketId,
      ordersPlaced: ordersPlaced.length,
      batches: basket.batchCount,
      errors: errors.length > 0 ? errors : undefined,
      dryRun,
    });
  } catch (error) {
    console.error("Failed to execute basket:", error);
    return NextResponse.json(
      { error: "Failed to execute basket" },
      { status: 500 }
    );
  }
}
