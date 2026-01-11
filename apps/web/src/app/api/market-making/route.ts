import { prisma } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { getBalance } from "@favored/shared";

/**
 * GET /api/market-making
 * List all market makers with current state
 */
export async function GET() {
  try {
    // Get config for MM enabled status
    const config = await prisma.config.findUnique({
      where: { id: "singleton" },
    });

    const marketMakers = await prisma.marketMaker.findMany({
      include: {
        market: {
          select: {
            slug: true,
            question: true,
            category: true,
            yesPrice: true,
            noPrice: true,
            endDate: true,
          },
        },
        orders: true,
        _count: {
          select: { fills: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // Calculate unrealized P&L for each market maker
    // Unrealized = (currentPrice - avgCost) × inventory
    const calculateUnrealizedPnl = (mm: typeof marketMakers[0]) => {
      const yesPrice = mm.market?.yesPrice ? Number(mm.market.yesPrice) : 0;
      const noPrice = mm.market?.noPrice ? Number(mm.market.noPrice) : 0;
      const yesInventory = Number(mm.yesInventory);
      const noInventory = Number(mm.noInventory);
      const avgYesCost = Number(mm.avgYesCost);
      const avgNoCost = Number(mm.avgNoCost);

      const yesUnrealized = yesInventory > 0 ? (yesPrice - avgYesCost) * yesInventory : 0;
      const noUnrealized = noInventory > 0 ? (noPrice - avgNoCost) * noInventory : 0;

      return yesUnrealized + noUnrealized;
    };

    // Calculate totals
    const activeMakers = marketMakers.filter((mm) => mm.active && !mm.paused);
    const totalRealizedPnl = marketMakers.reduce(
      (sum, mm) => sum + Number(mm.realizedPnl),
      0
    );
    const totalUnrealizedPnl = marketMakers.reduce(
      (sum, mm) => sum + calculateUnrealizedPnl(mm),
      0
    );
    const totalOpenOrders = marketMakers.reduce(
      (sum, mm) => sum + mm.orders.length,
      0
    );
    // Markets at risk: near max inventory (>80%) or volatility paused
    const marketsAtRisk = marketMakers.filter((mm) => {
      const maxInv = Number(mm.maxInventory);
      const yesInvRatio = maxInv > 0 ? Number(mm.yesInventory) / maxInv : 0;
      const noInvRatio = maxInv > 0 ? Number(mm.noInventory) / maxInv : 0;
      const nearMaxInventory = yesInvRatio > 0.8 || noInvRatio > 0.8;
      const volatilityPaused = mm.volatilityPauseUntil && new Date(mm.volatilityPauseUntil) > new Date();
      return nearMaxInventory || volatilityPaused;
    }).length;

    // Total at risk: net loss after offsetting inventory at $1 payout
    const totalAtRisk = marketMakers.reduce((sum, mm) => {
      const yesInv = Number(mm.yesInventory);
      const noInv = Number(mm.noInventory);
      const yesCost = yesInv * Number(mm.avgYesCost);
      const noCost = noInv * Number(mm.avgNoCost);
      const totalCost = yesCost + noCost;
      const minShares = Math.min(yesInv, noInv);
      const netRisk = Math.max(0, totalCost - minShares);
      return sum + netRisk;
    }, 0);

    // Fetch cash balance
    let cashAvailable: number | null = null;
    try {
      const balanceData = await getBalance();
      cashAvailable = balanceData?.balance ?? null;
    } catch (e) {
      // Silently fail - will show "—" in UI
    }

    return NextResponse.json({
      mmEnabled: config?.mmEnabled ?? false,
      summary: {
        total: marketMakers.length,
        active: activeMakers.length,
        totalOpenOrders,
        marketsAtRisk,
        totalRealizedPnl,
        totalUnrealizedPnl,
        totalPnl: totalRealizedPnl + totalUnrealizedPnl,
        totalAtRisk,
        cashAvailable,
      },
      marketMakers: marketMakers.map((mm) => ({
        id: mm.id,
        marketId: mm.marketId,
        market: mm.market
          ? {
              slug: mm.market.slug,
              question: mm.market.question,
              category: mm.market.category,
              yesPrice: mm.market.yesPrice ? Number(mm.market.yesPrice) : null,
              noPrice: mm.market.noPrice ? Number(mm.market.noPrice) : null,
              endDate: mm.market.endDate?.toISOString() || null,
            }
          : null,
        active: mm.active,
        paused: mm.paused,
        targetSpread: Number(mm.targetSpread),
        orderSize: Number(mm.orderSize),
        maxInventory: Number(mm.maxInventory),
        skewFactor: Number(mm.skewFactor),
        quotingPolicy: mm.quotingPolicy,
        yesInventory: Number(mm.yesInventory),
        noInventory: Number(mm.noInventory),
        avgYesCost: Number(mm.avgYesCost),
        avgNoCost: Number(mm.avgNoCost),
        realizedPnl: Number(mm.realizedPnl),
        unrealizedPnl: calculateUnrealizedPnl(mm),
        totalPnl: Number(mm.realizedPnl) + calculateUnrealizedPnl(mm),
        minTimeToResolution: mm.minTimeToResolution,
        volatilityPauseUntil: mm.volatilityPauseUntil?.toISOString() || null,
        orders: mm.orders.map((o) => ({
          outcome: o.outcome,
          side: o.side,
          orderId: o.orderId,
          price: Number(o.price),
          size: Number(o.size),
        })),
        fillCount: mm._count.fills,
        lastQuoteAt: mm.lastQuoteAt?.toISOString() || null,
        createdAt: mm.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error("Failed to fetch market makers:", error);
    return NextResponse.json(
      { error: "Failed to fetch market makers" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/market-making
 * Start making on a market (create new market maker)
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const {
      marketId,
      targetSpread,
      orderSize,
      maxInventory,
      skewFactor,
      quotingPolicy,
      minTimeToResolution,
    } = body;

    if (!marketId) {
      return NextResponse.json(
        { error: "marketId is required" },
        { status: 400 }
      );
    }

    // Check if market exists
    const market = await prisma.market.findUnique({
      where: { id: marketId },
    });

    if (!market) {
      return NextResponse.json({ error: "Market not found" }, { status: 404 });
    }

    // Check if market maker already exists
    const existing = await prisma.marketMaker.findUnique({
      where: { marketId },
    });

    if (existing) {
      return NextResponse.json(
        { error: "Market maker already exists for this market" },
        { status: 409 }
      );
    }

    // Get config for defaults
    const config = await prisma.config.findUnique({
      where: { id: "singleton" },
    });

    // Create market maker with provided values or defaults
    const marketMaker = await prisma.marketMaker.create({
      data: {
        marketId,
        targetSpread: targetSpread ?? Number(config?.mmDefaultSpread ?? 0.04),
        orderSize: orderSize ?? Number(config?.mmDefaultOrderSize ?? 100),
        maxInventory: maxInventory ?? Number(config?.mmDefaultMaxInventory ?? 500),
        skewFactor: skewFactor ?? Number(config?.mmDefaultSkewFactor ?? 0.04),
        quotingPolicy: quotingPolicy ?? config?.mmDefaultQuotingPolicy ?? "touch",
        minTimeToResolution: minTimeToResolution ?? config?.mmMinTimeToResolution ?? 24,
        active: true,
        paused: false,
        yesInventory: 0,
        noInventory: 0,
        avgYesCost: 0,
        avgNoCost: 0,
        realizedPnl: 0,
      },
      include: {
        market: {
          select: {
            slug: true,
            question: true,
            category: true,
          },
        },
      },
    });

    // Log the action
    await prisma.log.create({
      data: {
        level: "INFO",
        category: "SYSTEM",
        message: `Market maker created for ${market.slug}`,
        metadata: {
          marketMakerId: marketMaker.id,
          marketId,
          targetSpread: Number(marketMaker.targetSpread),
          orderSize: Number(marketMaker.orderSize),
        },
      },
    });

    return NextResponse.json({
      success: true,
      marketMaker: {
        id: marketMaker.id,
        marketId: marketMaker.marketId,
        market: marketMaker.market,
        active: marketMaker.active,
        paused: marketMaker.paused,
        targetSpread: Number(marketMaker.targetSpread),
        orderSize: Number(marketMaker.orderSize),
        maxInventory: Number(marketMaker.maxInventory),
        skewFactor: Number(marketMaker.skewFactor),
        quotingPolicy: marketMaker.quotingPolicy,
        yesInventory: Number(marketMaker.yesInventory),
        noInventory: Number(marketMaker.noInventory),
        realizedPnl: Number(marketMaker.realizedPnl),
        createdAt: marketMaker.createdAt.toISOString(),
      },
    });
  } catch (error) {
    console.error("Failed to create market maker:", error);
    return NextResponse.json(
      { error: "Failed to create market maker" },
      { status: 500 }
    );
  }
}
