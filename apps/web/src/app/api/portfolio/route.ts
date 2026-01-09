import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";
import { deriveCategory, initializeClobClient, isCLOBConfigured } from "@favored/shared/polymarket";

const GAMMA_BASE_URL = "https://gamma-api.polymarket.com";

function toSlug(text: string, suffix: string): string {
  const base = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\\s-]/g, "")
    .replace(/[\\s_]+/g, "-")
    .replace(/-+/g, "-");
  return `${base}-${suffix}`;
}

async function fetchGammaMarketBySlug(
  slug?: string
): Promise<{ category?: string | null; endDate?: string | null } | null> {
  if (!slug) {
    return null;
  }

  const response = await fetch(
    `${GAMMA_BASE_URL}/markets?slug=${encodeURIComponent(slug)}`
  );
  if (!response.ok) {
    return null;
  }

  const markets = (await response.json()) as Array<{
    category?: string | null;
    endDate?: string | null;
  }>;
  if (!Array.isArray(markets) || markets.length === 0) {
    return null;
  }

  return {
    category: markets[0].category ?? null,
    endDate: markets[0].endDate ?? null,
  };
}

async function syncPositionsFromClob(): Promise<void> {
  if (!isCLOBConfigured()) {
    return;
  }

  const { client } = await initializeClobClient();
  const makerAddress = process.env.POLYMARKET_FUNDER_ADDRESS;
  const marketCache = new Map<string, { active: boolean }>();

  const trades = await client.getTrades(
    makerAddress ? { maker_address: makerAddress } : undefined
  );

  if (trades.length === 0) {
    return;
  }

  await prisma.$transaction([
    prisma.trade.deleteMany({}),
    prisma.position.deleteMany({}),
  ]);

  const orderedTrades = [...trades].sort((a, b) => {
    const timeA = Number(a.match_time || 0);
    const timeB = Number(b.match_time || 0);
    if (timeA !== timeB) {
      return timeA - timeB;
    }
    return a.id.localeCompare(b.id);
  });

  for (const trade of orderedTrades) {
    const outcome = trade.outcome?.toUpperCase();
    if (outcome !== "YES" && outcome !== "NO") {
      continue;
    }

    const tradeId = trade.id;
    const existingTrade = await prisma.trade.findFirst({
      where: { orderId: tradeId },
    });

    if (existingTrade) {
      continue;
    }

    const marketId = trade.market;
    let market = await prisma.market.findUnique({ where: { id: marketId } });
    let marketActive = market?.active ?? true;

    if (!market) {
      const clobMarket = await client.getMarket(marketId);
      const active = Boolean(clobMarket?.active) && !clobMarket?.closed && !clobMarket?.archived;
      const question = clobMarket?.question || marketId;
      const marketSlug = clobMarket?.market_slug;
      const tagText = Array.isArray(clobMarket?.tags) ? clobMarket.tags.join(" ") : "";
      const derivedCategory = deriveCategory(marketSlug || "", question, tagText);
      const gammaMarket = await fetchGammaMarketBySlug(marketSlug);
      const slug = marketSlug || toSlug(question, marketId.slice(2, 8));
      const yesToken = clobMarket?.tokens?.find((t: { outcome?: string }) => t.outcome === "Yes");
      const noToken = clobMarket?.tokens?.find((t: { outcome?: string }) => t.outcome === "No");

      market = await prisma.market.create({
        data: {
          id: marketId,
          slug,
          question,
          category: gammaMarket?.category ?? derivedCategory,
          endDate: gammaMarket?.endDate
            ? new Date(gammaMarket.endDate)
            : clobMarket?.end_date_iso
              ? new Date(clobMarket.end_date_iso)
              : null,
          active,
          yesPrice: yesToken?.price ?? null,
          noPrice: noToken?.price ?? null,
          lastUpdated: new Date(),
        },
      });
      marketActive = active;
      marketCache.set(marketId, { active });
    } else if (!marketCache.has(marketId)) {
      const clobMarket = await client.getMarket(marketId);
      const active = Boolean(clobMarket?.active) && !clobMarket?.closed && !clobMarket?.archived;
      const marketSlug = clobMarket?.market_slug;
      const tagText = Array.isArray(clobMarket?.tags) ? clobMarket.tags.join(" ") : "";
      const derivedCategory = deriveCategory(marketSlug || "", clobMarket?.question || "", tagText);
      const gammaMarket = await fetchGammaMarketBySlug(marketSlug);
      marketActive = active;
      marketCache.set(marketId, { active });
      const resolvedCategory = gammaMarket?.category ?? (market.category || derivedCategory);
      const needsCategory = !market.category && resolvedCategory;
      const needsSlug = !market.slug && marketSlug;
      const needsEndDate = !market.endDate && (gammaMarket?.endDate || clobMarket?.end_date_iso);
      if (market.active !== active || needsCategory || needsSlug || needsEndDate) {
        await prisma.market.update({
          where: { id: marketId },
          data: {
            active,
            slug: needsSlug ? marketSlug : market.slug,
            category: needsCategory ? resolvedCategory : market.category,
            endDate: needsEndDate
              ? gammaMarket?.endDate
                ? new Date(gammaMarket.endDate)
                : clobMarket?.end_date_iso
                  ? new Date(clobMarket.end_date_iso)
                  : market.endDate
              : market.endDate,
            lastUpdated: new Date(),
          },
        });
      }
    }

    const size = Number(trade.size);
    const price = Number(trade.price);
    const markPrice = outcome === "YES" ? Number(market.yesPrice ?? price) : Number(market.noPrice ?? price);

    const positionKey = { marketId, side: outcome };
    const existingPosition = await prisma.position.findUnique({
      where: { marketId_side: positionKey },
    });

    if (!existingPosition) {
      if (trade.side === "SELL") {
        continue;
      }

      const totalCost = size * price;
      const unrealizedPnl = size * (markPrice - price);

      const status = marketActive ? "OPEN" : "RESOLVED";
      const position = await prisma.position.create({
        data: {
          marketId,
          side: outcome,
          size,
          avgEntry: price,
          totalCost,
          markPrice,
          unrealizedPnl,
          status,
        },
      });

      const executedAt = new Date(Number(trade.match_time) * 1000);

      await prisma.trade.create({
        data: {
          positionId: position.id,
          type: "ENTRY",
          side: trade.side,
          price,
          size,
          value: size * price,
          orderId: tradeId,
          executedAt,
        },
      });

      continue;
    }

    const currentSize = Number(existingPosition.size);
    const currentAvg = Number(existingPosition.avgEntry);
    const currentCost = Number(existingPosition.totalCost);

    let newSize = currentSize;
    let newTotalCost = currentCost;
    let newAvgEntry = currentAvg;
    let newStatus = existingPosition.status;
    let closedAt = existingPosition.closedAt;

    if (trade.side === "BUY") {
      newSize = currentSize + size;
      newTotalCost = currentCost + size * price;
      newAvgEntry = newSize > 0 ? newTotalCost / newSize : currentAvg;
    } else {
      newSize = Math.max(0, currentSize - size);
      newTotalCost = Math.max(0, currentCost - currentAvg * size);
      if (newSize === 0) {
        newStatus = "CLOSED";
        closedAt = new Date(Number(trade.match_time) * 1000);
      }
    }

    const updatedMark = outcome === "YES"
      ? Number(market.yesPrice ?? newAvgEntry)
      : Number(market.noPrice ?? newAvgEntry);

    const updatedUnrealized = newSize * (updatedMark - newAvgEntry);
    const cachedMarket = marketCache.get(marketId);
    if (newSize > 0 && cachedMarket && !cachedMarket.active) {
      newStatus = "RESOLVED";
    }

    await prisma.position.update({
      where: { id: existingPosition.id },
      data: {
        size: newSize,
        avgEntry: newAvgEntry,
        totalCost: newTotalCost,
        markPrice: updatedMark,
        unrealizedPnl: updatedUnrealized,
        status: newStatus,
        closedAt,
      },
    });

    const executedAt = new Date(Number(trade.match_time) * 1000);

    await prisma.trade.create({
      data: {
        positionId: existingPosition.id,
        type: trade.side === "BUY" ? "ENTRY" : "EXIT",
        side: trade.side,
        price,
        size,
        value: size * price,
        orderId: tradeId,
        executedAt,
      },
    });
  }
}

export async function GET() {
  try {
    await syncPositionsFromClob();

    const positions = await prisma.position.findMany({
      include: {
        market: {
          select: {
            slug: true,
            eventSlug: true,
            question: true,
            category: true,
            endDate: true,
            active: true,
          },
        },
      },
      orderBy: [{ status: "asc" }, { openedAt: "desc" }],
    });

    // Calculate summary
    let totalCost = 0;
    let totalValue = 0;
    let unrealizedPnl = 0;
    let openCount = 0;
    const closedIds: string[] = [];

    const serialized = positions.map((p) => {
      const cost = Number(p.totalCost);
      const mark = p.markPrice ? Number(p.markPrice) : Number(p.avgEntry);
      const size = Number(p.size);
      const value = size * mark;
      const pnl = p.unrealizedPnl ? Number(p.unrealizedPnl) : value - cost;

      if (p.status === "OPEN") {
        totalCost += cost;
        totalValue += value;
        unrealizedPnl += pnl;
        openCount++;
      } else {
        closedIds.push(p.id);
      }

      return {
        id: p.id,
        marketId: p.marketId,
        side: p.side,
        size: Number(p.size),
        avgEntry: Number(p.avgEntry),
        totalCost: cost,
        markPrice: mark,
        unrealizedPnl: pnl,
        takeProfitPrice: p.takeProfitPrice ? Number(p.takeProfitPrice) : null,
        status: p.status,
        openedAt: p.openedAt.toISOString(),
        market: {
          slug: p.market.slug,
          eventSlug: p.market.eventSlug,
          question: p.market.question,
          category: p.market.category,
          endDate: p.market.endDate?.toISOString() || null,
          active: p.market.active,
        },
      };
    });

    let totalInvested = 0;
    let totalReturned = 0;
    let realizedPnl = 0;
    let winCount = 0;

    if (closedIds.length > 0) {
      // Fetch trades with size to track shares bought/sold
      const trades = await prisma.trade.findMany({
        where: { positionId: { in: closedIds } },
        select: { positionId: true, type: true, value: true, size: true },
      });

      // Build map of position info for determining resolution payouts
      const positionInfo = new Map<string, { side: string; marketId: string }>();
      for (const p of serialized) {
        if (closedIds.includes(p.id)) {
          positionInfo.set(p.id, { side: p.side, marketId: p.marketId });
        }
      }

      // Aggregate trades per position
      const perPosition = new Map<string, {
        entryValue: number;
        exitValue: number;
        entryShares: number;
        exitShares: number;
      }>();

      for (const trade of trades) {
        const data = perPosition.get(trade.positionId) ?? {
          entryValue: 0, exitValue: 0, entryShares: 0, exitShares: 0
        };
        const value = Number(trade.value);
        const size = Number(trade.size);

        if (trade.type === "ENTRY") {
          data.entryValue += value;
          data.entryShares += size;
        } else if (trade.type === "EXIT") {
          data.exitValue += value;
          data.exitShares += size;
        }
        perPosition.set(trade.positionId, data);
      }

      // Calculate P&L including resolution payouts for remaining shares
      for (const [positionId, data] of perPosition.entries()) {
        totalInvested += data.entryValue;
        let positionReturned = data.exitValue;

        // Check for remaining shares that resolved (not sold)
        const remainingShares = data.entryShares - data.exitShares;
        if (remainingShares > 0.001) { // Small threshold for floating point
          const info = positionInfo.get(positionId);
          if (info) {
            // Get market to determine resolution outcome
            const market = await prisma.market.findUnique({
              where: { id: info.marketId },
              select: { yesPrice: true, noPrice: true, active: true }
            });

            if (market && !market.active) {
              // Determine if position won based on final market prices
              // When a market resolves: winning side price → 1, losing side → 0
              const yesPrice = Number(market.yesPrice ?? 0);
              const noPrice = Number(market.noPrice ?? 0);

              let won = false;
              if (info.side === "YES" && yesPrice > 0.9) {
                won = true;
              } else if (info.side === "NO" && noPrice > 0.9) {
                won = true;
              }

              // Resolution payout: $1 per share if won, $0 if lost
              const resolutionPayout = won ? remainingShares : 0;
              positionReturned += resolutionPayout;
            }
          }
        }

        totalReturned += positionReturned;
        const pnl = positionReturned - data.entryValue;
        realizedPnl += pnl;
        if (pnl > 0) {
          winCount++;
        }
      }
    }

    return NextResponse.json({
      positions: serialized,
      summary: {
        totalCost: Math.round(totalCost * 100) / 100,
        totalValue: Math.round(totalValue * 100) / 100,
        unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
        openCount,
      },
      closedSummary: {
        totalInvested: Math.round(totalInvested * 100) / 100,
        totalReturned: Math.round(totalReturned * 100) / 100,
        realizedPnl: Math.round(realizedPnl * 100) / 100,
        winRate:
          closedIds.length > 0
            ? Math.round((winCount / closedIds.length) * 1000) / 10
            : 0,
        closedCount: closedIds.length,
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
