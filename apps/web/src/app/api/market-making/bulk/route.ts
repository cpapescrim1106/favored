import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { applyToAll, ids, updates } = body as {
      applyToAll?: boolean;
      ids?: string[];
      updates?: {
        targetSpread?: number;
        orderSize?: number;
        maxInventory?: number;
        skewFactor?: number;
        bidOffsetTicks?: number | null;
        askOffsetTicks?: number | null;
        minTimeToResolution?: number;
      };
    };

    if (!applyToAll && (!ids || ids.length === 0)) {
      return NextResponse.json(
        { error: "No market makers selected" },
        { status: 400 }
      );
    }

    if (!updates) {
      return NextResponse.json(
        { error: "No updates provided" },
        { status: 400 }
      );
    }

    const updateData: Record<string, unknown> = {};
    if (updates.targetSpread !== undefined) updateData.targetSpread = updates.targetSpread;
    if (updates.orderSize !== undefined) updateData.orderSize = updates.orderSize;
    if (updates.maxInventory !== undefined) updateData.maxInventory = updates.maxInventory;
    if (updates.skewFactor !== undefined) updateData.skewFactor = updates.skewFactor;
    if (updates.bidOffsetTicks !== undefined) updateData.bidOffsetTicks = updates.bidOffsetTicks;
    if (updates.askOffsetTicks !== undefined) updateData.askOffsetTicks = updates.askOffsetTicks;
    if (updates.minTimeToResolution !== undefined) {
      updateData.minTimeToResolution = updates.minTimeToResolution;
    }
    if (
      updates.targetSpread !== undefined ||
      updates.bidOffsetTicks !== undefined ||
      updates.askOffsetTicks !== undefined
    ) {
      updateData.quotingPolicy = "offsets";
    }

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json(
        { error: "No valid fields to update" },
        { status: 400 }
      );
    }

    const result = await prisma.marketMaker.updateMany({
      where: applyToAll ? {} : { id: { in: ids } },
      data: updateData,
    });

    await prisma.log.create({
      data: {
        level: "INFO",
        category: "SYSTEM",
        message: `Bulk update applied to ${result.count} market makers`,
        metadata: {
          applyToAll: Boolean(applyToAll),
          ids: applyToAll ? undefined : ids,
          updates: Object.keys(updateData),
        },
      },
    });

    return NextResponse.json({
      success: true,
      updated: result.count,
    });
  } catch (error) {
    console.error("Failed to bulk update market makers:", error);
    return NextResponse.json(
      { error: "Failed to bulk update market makers" },
      { status: 500 }
    );
  }
}
