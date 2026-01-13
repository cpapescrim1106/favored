import { prisma } from "../apps/worker/src/lib/db.js";
import {
  configureCLOB,
  fetchActiveOrders,
  getPositions,
  type DataAPIPosition,
} from "../packages/shared/src/polymarket/index.js";

type Outcome = "YES" | "NO";

type PositionAggregate = {
  marketId: string;
  outcome: Outcome;
  size: number;
  avgPrice: number;
};

type OrderGroup = {
  marketMakerId: string;
  outcome: Outcome;
  side: "BID" | "ASK";
  orders: Array<{
    orderId: string;
    tokenId: string;
    price: number;
    size: number;
  }>;
};

const isOpenPosition = (position: DataAPIPosition): boolean =>
  !position.redeemable && position.curPrice > 0;

const normalizeOutcome = (value: string): Outcome | null => {
  const normalized = value.toUpperCase();
  if (normalized === "YES") return "YES";
  if (normalized === "NO") return "NO";
  return null;
};

function aggregatePositions(positions: DataAPIPosition[]): PositionAggregate[] {
  const aggregate = new Map<string, PositionAggregate>();

  for (const position of positions) {
    const outcome = normalizeOutcome(position.outcome);
    if (!outcome) continue;
    if (!isOpenPosition(position)) continue;

    const key = `${position.conditionId}:${outcome}`;
    const size = Number(position.size) || 0;
    const avgPrice = Number(position.avgPrice) || 0;
    if (!aggregate.has(key)) {
      aggregate.set(key, {
        marketId: position.conditionId,
        outcome,
        size,
        avgPrice,
      });
      continue;
    }

    const existing = aggregate.get(key)!;
    const totalSize = existing.size + size;
    const weightedAvg =
      totalSize > 0
        ? (existing.avgPrice * existing.size + avgPrice * size) / totalSize
        : 0;

    existing.size = totalSize;
    existing.avgPrice = weightedAvg;
  }

  return Array.from(aggregate.values());
}

async function restoreMarketMakers(): Promise<void> {
  console.log("[RestoreMM] Fetching open positions from Data API...");
  const positions = await getPositions(undefined, { sizeThreshold: 0, limit: 500 });
  if (!positions) {
    throw new Error("Data API unavailable; cannot restore market makers.");
  }

  const aggregates = aggregatePositions(positions);
  if (aggregates.length === 0) {
    console.log("[RestoreMM] No open positions found; nothing to restore.");
    return;
  }

  const marketIds = Array.from(new Set(aggregates.map((p) => p.marketId)));
  const markets = await prisma.market.findMany({
    where: { id: { in: marketIds } },
    select: { id: true },
  });
  const marketSet = new Set(markets.map((m) => m.id));
  const sampleByMarket = new Map(
    positions.map((position) => [position.conditionId, position])
  );

  const config = await prisma.config.findUnique({
    where: { id: "singleton" },
  });
  if (!config) {
    throw new Error("Config singleton missing; seed the database first.");
  }

  let restored = 0;

  for (const marketId of marketIds) {
    if (!marketSet.has(marketId)) {
      const sample = sampleByMarket.get(marketId);
      if (!sample) {
        console.warn(`[RestoreMM] Missing market ${marketId}; skip.`);
        continue;
      }

      const outcome = normalizeOutcome(sample.outcome);
      if (!outcome) {
        console.warn(`[RestoreMM] Unknown outcome for market ${marketId}; skip.`);
        continue;
      }

      const yesToken = outcome === "YES" ? sample.asset : sample.oppositeAsset;
      const noToken = outcome === "NO" ? sample.asset : sample.oppositeAsset;

      const existingSlug = await prisma.market.findFirst({
        where: { venue: "POLYMARKET", slug: sample.slug },
        select: { id: true },
      });
      const slug = existingSlug
        ? `${sample.slug}-${marketId.slice(0, 8)}`
        : sample.slug;

      await prisma.market.create({
        data: {
          id: marketId,
          venue: "POLYMARKET",
          slug,
          eventSlug: sample.eventSlug,
          question: sample.title,
          category: null,
          endDate: sample.endDate ? new Date(sample.endDate) : null,
          active: !sample.redeemable && sample.curPrice > 0,
          yesPrice: outcome === "YES" ? sample.curPrice : null,
          noPrice: outcome === "NO" ? sample.curPrice : null,
          liquidity: 0,
          volume24h: 0,
          clobTokenIds: [yesToken, noToken],
          lastUpdated: new Date(),
        },
      });

      marketSet.add(marketId);
      console.log(`[RestoreMM] Created missing market ${marketId} (${sample.slug})`);
    }

    const yes = aggregates.find((p) => p.marketId === marketId && p.outcome === "YES");
    const no = aggregates.find((p) => p.marketId === marketId && p.outcome === "NO");

    await prisma.marketMaker.upsert({
      where: { marketId },
      update: {
        active: false,
        paused: true,
        yesInventory: yes?.size ?? 0,
        noInventory: no?.size ?? 0,
        avgYesCost: yes?.avgPrice ?? 0,
        avgNoCost: no?.avgPrice ?? 0,
      },
      create: {
        marketId,
        active: false,
        paused: true,
        targetSpread: config.mmDefaultSpread,
        orderSize: config.mmDefaultOrderSize,
        maxInventory: config.mmDefaultMaxInventory,
        skewFactor: config.mmDefaultSkewFactor,
        quotingPolicy: config.mmDefaultQuotingPolicy,
        bidOffsetTicks: null,
        askOffsetTicks: null,
        yesInventory: yes?.size ?? 0,
        noInventory: no?.size ?? 0,
        avgYesCost: yes?.avgPrice ?? 0,
        avgNoCost: no?.avgPrice ?? 0,
        minTimeToResolution: config.mmMinTimeToResolution,
      },
    });

    restored++;
  }

  console.log(`[RestoreMM] Restored ${restored} market makers (paused).`);
}

async function restoreOpenOrders(): Promise<void> {
  console.log("[RestoreMM] Attempting to sync open orders from CLOB...");

  configureCLOB({ dryRun: false });
  const orders = await fetchActiveOrders();
  if (!orders || orders.length === 0) {
    console.log("[RestoreMM] No open orders found (or CLOB unavailable).");
    return;
  }

  const markets = await prisma.market.findMany({
    select: { id: true, clobTokenIds: true },
  });

  const tokenMap = new Map<string, { marketId: string; outcome: Outcome }>();
  for (const market of markets) {
    const [yesToken, noToken] = market.clobTokenIds || [];
    if (yesToken) tokenMap.set(yesToken, { marketId: market.id, outcome: "YES" });
    if (noToken) tokenMap.set(noToken, { marketId: market.id, outcome: "NO" });
  }

  const marketMakers = await prisma.marketMaker.findMany({
    select: { id: true, marketId: true },
  });
  const mmByMarket = new Map(marketMakers.map((mm) => [mm.marketId, mm.id]));

  const grouped = new Map<string, OrderGroup>();

  for (const order of orders) {
    const token = tokenMap.get(order.asset_id);
    if (!token) continue;

    const marketMakerId = mmByMarket.get(token.marketId);
    if (!marketMakerId) continue;

    const side = order.side === "BUY" ? "BID" : "ASK";
    const groupKey = `${marketMakerId}:${token.outcome}:${side}`;
    const entry = grouped.get(groupKey) ?? {
      marketMakerId,
      outcome: token.outcome,
      side,
      orders: [],
    };

    entry.orders.push({
      orderId: order.id,
      tokenId: order.asset_id,
      price: Number(order.price),
      size: Number(order.size),
    });

    grouped.set(groupKey, entry);
  }

  let synced = 0;

  for (const group of grouped.values()) {
    const sorted = [...group.orders].sort((a, b) =>
      group.side === "BID" ? b.price - a.price : a.price - b.price
    );

    for (let tier = 0; tier < sorted.length; tier++) {
      const order = sorted[tier];
      await prisma.marketMakerOrder.upsert({
        where: {
          marketMakerId_outcome_side_tier: {
            marketMakerId: group.marketMakerId,
            outcome: group.outcome,
            side: group.side,
            tier,
          },
        },
        update: {
          orderId: order.orderId,
          tokenId: order.tokenId,
          price: order.price,
          size: order.size,
          verified: true,
          lastMatchedSize: null,
        },
        create: {
          marketMakerId: group.marketMakerId,
          outcome: group.outcome,
          side: group.side,
          tier,
          orderId: order.orderId,
          tokenId: order.tokenId,
          price: order.price,
          size: order.size,
          verified: true,
        },
      });
      synced++;
    }
  }

  console.log(`[RestoreMM] Synced ${synced} open orders into tracking.`);
}

async function main(): Promise<void> {
  await restoreMarketMakers();
  await restoreOpenOrders();
}

main()
  .catch((error) => {
    console.error("[RestoreMM] Failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
