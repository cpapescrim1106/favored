import { NextResponse } from "next/server";
import {
  getBalance,
  getPositions,
  getKalshiBalance,
  type DataAPIPosition,
} from "@favored/shared";

/**
 * GET /api/portfolio
 * Fetch portfolio positions directly from Polymarket Data API
 * This provides accurate current positions and P&L data
 */
export async function GET() {
  try {
    // Fetch positions from Polymarket Data API
    const positions = await getPositions();
    if (!positions) {
      return NextResponse.json(
        { error: "Data API unavailable" },
        { status: 502 }
      );
    }

    // Fetch cash balances
    const cashByVenue: { polymarket: number | null; kalshi: number | null } = {
      polymarket: null,
      kalshi: null,
    };

    let cashBalance = 0;
    try {
      const balanceData = await getBalance();
      cashByVenue.polymarket = balanceData?.balance ?? null;
    } catch {
      // Silently fail - will show 0
    }

    try {
      const kalshiBalance = await getKalshiBalance();
      cashByVenue.kalshi = kalshiBalance?.balance ?? null;
    } catch {
      // Silently fail - will show 0
    }

    const cashValues = Object.values(cashByVenue).filter(
      (value): value is number => typeof value === "number"
    );
    cashBalance = cashValues.length > 0 ? cashValues.reduce((sum, v) => sum + v, 0) : 0;

    // Separate open positions from resolved (redeemable) ones
    const openPositions: DataAPIPosition[] = [];
    const resolvedPositions: DataAPIPosition[] = [];

    for (const p of positions) {
      if (p.redeemable || p.curPrice === 0) {
        resolvedPositions.push(p);
      } else {
        openPositions.push(p);
      }
    }

    // Calculate open positions summary
    let totalCost = 0;
    let totalValue = 0;
    let unrealizedPnl = 0;

    for (const p of openPositions) {
      totalCost += p.initialValue;
      totalValue += p.currentValue;
      unrealizedPnl += p.cashPnl;
    }

    // Calculate closed positions summary
    let totalInvested = 0;
    let totalReturned = 0;
    let realizedPnl = 0;
    let winCount = 0;

    for (const p of resolvedPositions) {
      totalInvested += p.initialValue;
      // For resolved positions, currentValue is the payout (0 if lost, size if won)
      totalReturned += p.currentValue;
      realizedPnl += p.cashPnl;
      if (p.cashPnl > 0) {
        winCount++;
      }
    }

    // Serialize positions for response
    const serialized = positions.map((p) => ({
      id: p.asset, // Use asset ID as unique identifier
      marketId: p.conditionId,
      side: p.outcome.toUpperCase() as "YES" | "NO",
      size: p.size,
      avgEntry: p.avgPrice,
      totalCost: p.initialValue,
      markPrice: p.curPrice,
      unrealizedPnl: p.cashPnl,
      takeProfitPrice: null,
      status: p.redeemable ? "RESOLVED" : p.curPrice === 0 ? "CLOSED" : "OPEN",
      openedAt: null, // Data API doesn't provide this
      market: {
        slug: p.slug,
        eventSlug: p.eventSlug,
        question: p.title,
        category: null, // Data API doesn't provide category
        endDate: p.endDate,
        active: !p.redeemable && p.curPrice > 0,
      },
    }));

    return NextResponse.json({
      positions: serialized,
      cashBalance: Math.round(cashBalance * 100) / 100,
      cashByVenue: {
        polymarket:
          cashByVenue.polymarket !== null
            ? Math.round(cashByVenue.polymarket * 100) / 100
            : null,
        kalshi:
          cashByVenue.kalshi !== null
            ? Math.round(cashByVenue.kalshi * 100) / 100
            : null,
      },
      summary: {
        totalCost: Math.round(totalCost * 100) / 100,
        totalValue: Math.round(totalValue * 100) / 100,
        unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
        openCount: openPositions.length,
      },
      closedSummary: {
        totalInvested: Math.round(totalInvested * 100) / 100,
        totalReturned: Math.round(totalReturned * 100) / 100,
        realizedPnl: Math.round(realizedPnl * 100) / 100,
        winRate:
          resolvedPositions.length > 0
            ? Math.round((winCount / resolvedPositions.length) * 1000) / 10
            : 0,
        closedCount: resolvedPositions.length,
      },
    });
  } catch (error) {
    console.error("Failed to fetch portfolio:", error);
    return NextResponse.json(
      { error: "Failed to fetch portfolio" },
      { status: 500 }
    );
  }
}
