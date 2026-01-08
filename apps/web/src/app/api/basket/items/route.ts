import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

const MAX_BATCH_SIZE = 15;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { candidateId } = body;

    if (!candidateId) {
      return NextResponse.json({ error: "candidateId required" }, { status: 400 });
    }

    // Get the candidate
    const candidate = await prisma.candidate.findUnique({
      where: { id: candidateId },
      include: { market: true },
    });

    if (!candidate) {
      return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
    }

    // Get or create draft basket
    let basket = await prisma.basket.findFirst({
      where: { status: "DRAFT" },
      orderBy: { createdAt: "desc" },
    });

    if (!basket) {
      basket = await prisma.basket.create({
        data: {
          status: "DRAFT",
          totalStake: 0,
          itemCount: 0,
          batchCount: 0,
        },
      });
    }

    // Get config for default stake
    const config = await prisma.config.findUnique({
      where: { id: "singleton" },
    });
    const defaultStake = config ? Number(config.defaultStake) : 50;

    // Check if already in basket
    const existing = await prisma.basketItem.findFirst({
      where: {
        basketId: basket.id,
        marketId: candidate.marketId,
        side: candidate.side,
      },
    });

    if (existing) {
      return NextResponse.json(
        { error: "Already in basket" },
        { status: 400 }
      );
    }

    // Add item to basket
    const snapshotPrice =
      candidate.side === "YES"
        ? Number(candidate.market.yesPrice || candidate.impliedProb)
        : Number(candidate.market.noPrice || candidate.impliedProb);

    const item = await prisma.basketItem.create({
      data: {
        basketId: basket.id,
        marketId: candidate.marketId,
        side: candidate.side,
        stake: defaultStake,
        limitPrice: Number(candidate.impliedProb),
        snapshotPrice,
        status: "pending",
      },
    });

    // Update basket totals
    const items = await prisma.basketItem.findMany({
      where: { basketId: basket.id },
    });

    const totalStake = items.reduce((sum, i) => sum + Number(i.stake), 0);
    const batchCount = Math.ceil(items.length / MAX_BATCH_SIZE);

    await prisma.basket.update({
      where: { id: basket.id },
      data: {
        totalStake,
        itemCount: items.length,
        batchCount,
      },
    });

    return NextResponse.json({
      success: true,
      item: {
        id: item.id,
        marketId: item.marketId,
        side: item.side,
        stake: Number(item.stake),
      },
    });
  } catch (error) {
    console.error("Failed to add to basket:", error);
    return NextResponse.json({ error: "Failed to add to basket" }, { status: 500 });
  }
}
