import { prisma } from "../lib/db.js";
import crypto from "crypto";
import {
  calculateQuotes,
  calculateMidPrice,
  shouldRefreshQuotes,
  type Quote,
} from "@favored/shared/market-making";
import {
  getTickSizeForPrice,
  registerDefaultVenues,
  getVenueAdapter,
  type PriceRange,
} from "@favored/shared/venues";
import { addHours, isBefore } from "date-fns";

const MIN_QUOTE_INTERVAL = 5000;
const ORDER_GROUP_ID = process.env.KALSHI_ORDER_GROUP_ID;

const buildClientOrderId = (seed: string): string => {
  const digest = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 24);
  return `mm-${digest}`;
};

export interface KalshiMarketMakingResult {
  processed: number;
  quotesPlaced: number;
  quotesCancelled: number;
  errors: string[];
}

export async function runKalshiMarketMakingJob(): Promise<KalshiMarketMakingResult> {
  const result: KalshiMarketMakingResult = {
    processed: 0,
    quotesPlaced: 0,
    quotesCancelled: 0,
    errors: [],
  };

  const config = await prisma.config.findUnique({
    where: { id: "singleton" },
  });
  if (!config) {
    console.log("[KalshiMM] No config found, skipping");
    return result;
  }

  if (!config.mmEnabled) {
    console.log("[KalshiMM] Market making disabled globally");
    return result;
  }

  if (config.killSwitchActive) {
    console.log("[KalshiMM] Kill switch active, skipping");
    return result;
  }

  registerDefaultVenues();
  const adapter = getVenueAdapter("kalshi");

  const marketMakers = await prisma.marketMaker.findMany({
    where: { active: true, market: { venue: "KALSHI" } },
    include: { market: true, orders: true },
  });

  if (marketMakers.length === 0) {
    return result;
  }

  // Sync inventory from Kalshi positions if available
  try {
    const positions = await adapter.getPositions();
    if (positions.length > 0) {
      const positionMap = new Map<string, { yes?: { size: number; avg: number }; no?: { size: number; avg: number } }>();
      for (const position of positions) {
        const entry = positionMap.get(position.venueMarketId) ?? {};
        if (position.outcome === "YES") {
          entry.yes = { size: position.size, avg: position.avgPrice };
        } else {
          entry.no = { size: position.size, avg: position.avgPrice };
        }
        positionMap.set(position.venueMarketId, entry);
      }

      for (const mm of marketMakers) {
        const position = positionMap.get(mm.marketId);
        if (!position) continue;
        await prisma.marketMaker.update({
          where: { id: mm.id },
          data: {
            yesInventory: position.yes?.size ?? 0,
            noInventory: position.no?.size ?? 0,
            avgYesCost: position.yes?.avg ?? 0,
            avgNoCost: position.no?.avg ?? 0,
          },
        });
      }
    }
  } catch (error) {
    console.warn("[KalshiMM] Positions unavailable; skipping inventory sync", error);
  }

  for (const mm of marketMakers) {
    if (!mm.market) continue;
    result.processed += 1;

    if (mm.paused) {
      continue;
    }

    if (mm.volatilityPauseUntil && new Date(mm.volatilityPauseUntil) > new Date()) {
      console.log(`[KalshiMM] ${mm.market.slug} paused until ${mm.volatilityPauseUntil}`);
      continue;
    }

    if (mm.minTimeToResolution && mm.market.endDate) {
      const stopTime = addHours(new Date(), mm.minTimeToResolution);
      if (isBefore(mm.market.endDate, stopTime)) {
        await prisma.marketMaker.update({
          where: { id: mm.id },
          data: { paused: true },
        });
        continue;
      }
    }

    const orderbook = await adapter.getOrderbookSnapshot(mm.marketId);
    const yesBestBid = orderbook.yes.bids[0]?.price ?? 0;
    const yesBestAsk = orderbook.yes.asks[0]?.price ?? 0;
    const noBestBid = orderbook.no.bids[0]?.price ?? 0;
    const noBestAsk = orderbook.no.asks[0]?.price ?? 0;

    const yesMid = calculateMidPrice(yesBestBid, yesBestAsk);
    const noMid = calculateMidPrice(noBestBid, noBestAsk);

    const priceRanges = (mm.market.priceRanges ?? []) as PriceRange[];
    const yesTick = getTickSizeForPrice(yesMid, priceRanges);
    const noTick = getTickSizeForPrice(noMid, priceRanges);

    const now = Date.now();
    if (mm.lastQuoteAt && now - new Date(mm.lastQuoteAt).getTime() < MIN_QUOTE_INTERVAL) {
      continue;
    }

    const refreshYes = shouldRefreshQuotes(
      yesMid,
      mm.market.yesPrice ? Number(mm.market.yesPrice) : yesMid,
      Number(config.mmRefreshThreshold)
    );

    const refreshNo = shouldRefreshQuotes(
      noMid,
      mm.market.noPrice ? Number(mm.market.noPrice) : noMid,
      Number(config.mmRefreshThreshold)
    );

    if (!refreshYes && !refreshNo) {
      continue;
    }

    const yesQuote = calculateQuotes({
      midPrice: yesMid,
      targetSpread: Number(mm.targetSpread),
      inventory: Number(mm.yesInventory),
      skewFactor: Number(mm.skewFactor),
      orderSize: Number(mm.orderSize),
      maxInventory: Number(mm.maxInventory),
      quotingPolicy: mm.quotingPolicy,
      bestBid: yesBestBid,
      bestAsk: yesBestAsk,
      avgCost: Number(mm.avgYesCost),
      bidOffsetTicks: mm.bidOffsetTicks ?? undefined,
      askOffsetTicks: mm.askOffsetTicks ?? undefined,
      tickSize: yesTick,
    });

    const noQuote = calculateQuotes({
      midPrice: noMid,
      targetSpread: Number(mm.targetSpread),
      inventory: Number(mm.noInventory),
      skewFactor: Number(mm.skewFactor),
      orderSize: Number(mm.orderSize),
      maxInventory: Number(mm.maxInventory),
      quotingPolicy: mm.quotingPolicy,
      bestBid: noBestBid,
      bestAsk: noBestAsk,
      avgCost: Number(mm.avgNoCost),
      bidOffsetTicks: mm.bidOffsetTicks ?? undefined,
      askOffsetTicks: mm.askOffsetTicks ?? undefined,
      tickSize: noTick,
    });

    const desiredOrders: Array<{ outcome: "YES" | "NO"; side: "BID" | "ASK"; quote: Quote; tickSize: number }> = [
      { outcome: "YES", side: "BID", quote: yesQuote, tickSize: yesTick },
      { outcome: "YES", side: "ASK", quote: yesQuote, tickSize: yesTick },
      { outcome: "NO", side: "BID", quote: noQuote, tickSize: noTick },
      { outcome: "NO", side: "ASK", quote: noQuote, tickSize: noTick },
    ];

    for (const desired of desiredOrders) {
      const existing = mm.orders.find(
        (order) => order.outcome === desired.outcome && order.side === desired.side && order.tier === 0
      );

      const price = desired.side === "BID" ? desired.quote.bidPrice : desired.quote.askPrice;
      const size = desired.side === "BID" ? desired.quote.bidSize : desired.quote.askSize;

      if (size <= 0) {
        if (existing) {
          await adapter.cancelOrder(existing.orderId);
          await prisma.marketMakerOrder.delete({ where: { id: existing.id } });
          result.quotesCancelled += 1;
        }
        continue;
      }

      if (existing) {
        const priceDiff = Math.abs(Number(existing.price) - price);
        const sizeDiff = Math.abs(Number(existing.size) - size);
        if (priceDiff <= desired.tickSize && sizeDiff <= 0.0001) {
          continue;
        }

        await adapter.cancelOrder(existing.orderId);
        await prisma.marketMakerOrder.delete({ where: { id: existing.id } });
        result.quotesCancelled += 1;
      }

      const clientOrderId = buildClientOrderId(
        `${mm.id}:${desired.outcome}:${desired.side}:${price.toFixed(4)}:${size.toFixed(4)}`
      );
      const orderResult = await adapter.placeOrder({
        venue: "kalshi",
        venueMarketId: mm.marketId,
        outcome: desired.outcome,
        side: desired.side,
        price,
        size,
        postOnly: true,
        reduceOnly: desired.quote.reduceOnly,
        clientOrderId,
        orderGroupId: ORDER_GROUP_ID,
      });

      if (!orderResult.success || !orderResult.orderId) {
        result.errors.push(orderResult.error ?? "unknown_error");
        continue;
      }

      await prisma.marketMakerOrder.upsert({
        where: {
          marketMakerId_outcome_side_tier: {
            marketMakerId: mm.id,
            outcome: desired.outcome,
            side: desired.side,
            tier: 0,
          },
        },
        update: {
          orderId: orderResult.orderId,
          clientOrderId,
          orderGroupId: ORDER_GROUP_ID,
          tokenId: mm.marketId,
          price,
          size,
          verified: true,
          lastMatchedSize: null,
        },
        create: {
          marketMakerId: mm.id,
          outcome: desired.outcome,
          side: desired.side,
          tier: 0,
          orderId: orderResult.orderId,
          clientOrderId,
          orderGroupId: ORDER_GROUP_ID,
          tokenId: mm.marketId,
          price,
          size,
          verified: true,
        },
      });

      result.quotesPlaced += 1;
    }

    await prisma.marketMaker.update({
      where: { id: mm.id },
      data: { lastQuoteAt: new Date() },
    });
  }

  return result;
}
