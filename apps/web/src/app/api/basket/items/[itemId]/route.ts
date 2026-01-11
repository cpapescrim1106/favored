import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

const MAX_BATCH_SIZE = 15;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string }> }
) {
  try {
    const { itemId } = await params;
    const body = await request.json();
    const { size } = body;

    if (typeof size !== "number" || size < 0) {
      return NextResponse.json({ error: "Invalid size" }, { status: 400 });
    }

    // Find the item
    const item = await prisma.basketItem.findUnique({
      where: { id: itemId },
    });

    if (!item) {
      return NextResponse.json({ error: "Item not found" }, { status: 404 });
    }

    // Calculate new stake from size × snapshotPrice
    const snapshotPrice = Number(item.snapshotPrice);
    const newStake = size * snapshotPrice;

    // Update the item
    await prisma.basketItem.update({
      where: { id: itemId },
      data: { stake: newStake },
    });

    // Update basket totals
    const items = await prisma.basketItem.findMany({
      where: { basketId: item.basketId },
    });

    const totalStake = items.reduce((sum, i) => sum + Number(i.stake), 0);

    await prisma.basket.update({
      where: { id: item.basketId },
      data: { totalStake },
    });

    return NextResponse.json({
      success: true,
      item: {
        id: itemId,
        stake: newStake,
        size,
      },
    });
  } catch (error) {
    console.error("Failed to update basket item:", error);
    return NextResponse.json(
      { error: "Failed to update item" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string }> }
) {
  try {
    const { itemId } = await params;

    // Find the item first to get its basket
    const item = await prisma.basketItem.findUnique({
      where: { id: itemId },
    });

    if (!item) {
      return NextResponse.json({ error: "Item not found" }, { status: 404 });
    }

    // Delete the item
    await prisma.basketItem.delete({
      where: { id: itemId },
    });

    // Update basket totals
    const remainingItems = await prisma.basketItem.findMany({
      where: { basketId: item.basketId },
    });

    const totalStake = remainingItems.reduce((sum, i) => sum + Number(i.stake), 0);
    const batchCount = Math.ceil(remainingItems.length / MAX_BATCH_SIZE);

    await prisma.basket.update({
      where: { id: item.basketId },
      data: {
        totalStake,
        itemCount: remainingItems.length,
        batchCount,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete basket item:", error);
    return NextResponse.json(
      { error: "Failed to delete item" },
      { status: 500 }
    );
  }
}
