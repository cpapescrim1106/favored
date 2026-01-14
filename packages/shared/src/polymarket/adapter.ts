import type {
  OrderRequest,
  OrderResponse,
  VenueFill,
  VenueMarket,
  VenueOrderbook,
  VenuePosition,
} from "../venues/types.js";
import type { VenueAdapter } from "../venues/adapter.js";
import { fetchMarket, fetchAllActiveMarkets } from "./gamma.js";
import {
  getOrderbook,
  placeOrder,
  placeBatchOrders,
  cancelOrder,
  fetchActiveOrders,
  getPositions,
} from "./clob.js";

const MARKET_CACHE_TTL_MS = 5 * 60 * 1000;
const marketCache = new Map<string, { market: VenueMarket; tokenIds: string[]; at: number }>();

function parseTokenIds(raw?: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapMarket(market: Awaited<ReturnType<typeof fetchMarket>>): VenueMarket | null {
  if (!market) return null;

  let outcomes: string[] = [];
  let prices: number[] = [];
  try {
    outcomes = JSON.parse(market.outcomes || "[]");
    prices = JSON.parse(market.outcomePrices || "[]").map(Number);
  } catch {
    outcomes = [];
    prices = [];
  }

  let yesPrice: number | null = null;
  let noPrice: number | null = null;

  const yesIndex = outcomes.findIndex((o) => o === "Yes");
  const noIndex = outcomes.findIndex((o) => o === "No");
  if (yesIndex >= 0 && noIndex >= 0) {
    yesPrice = prices[yesIndex] ?? null;
    noPrice = prices[noIndex] ?? null;
  } else if (outcomes.length === 2) {
    yesPrice = prices[0] ?? null;
    noPrice = prices[1] ?? null;
  }

  return {
    venue: "polymarket",
    venueMarketId: market.id,
    slug: market.slug,
    question: market.question,
    status: market.closed ? "closed" : market.active ? "active" : "unknown",
    closeTime: market.endDate,
    eventId: market.events?.[0]?.slug ?? undefined,
    volume24h: market.volume ? Number(market.volume) : undefined,
    liquidity: market.liquidity ? Number(market.liquidity) : undefined,
    yesPrice,
    noPrice,
    priceRanges: [
      {
        start: 0.01,
        end: 0.99,
        step: 0.01,
      },
    ],
  };
}

async function getMarketCached(conditionId: string): Promise<{ market: VenueMarket; tokenIds: string[] } | null> {
  const cached = marketCache.get(conditionId);
  const now = Date.now();
  if (cached && now - cached.at <= MARKET_CACHE_TTL_MS) {
    return { market: cached.market, tokenIds: cached.tokenIds };
  }

  const market = await fetchMarket(conditionId);
  if (!market) return null;
  const mapped = mapMarket(market);
  if (!mapped) return null;
  const tokenIds = parseTokenIds(market.clobTokenIds);

  marketCache.set(conditionId, { market: mapped, tokenIds, at: now });
  return { market: mapped, tokenIds };
}

export class PolymarketAdapter implements VenueAdapter {
  id: VenueAdapter["id"] = "polymarket";

  async listMarkets(): Promise<VenueMarket[]> {
    const markets = await fetchAllActiveMarkets();
    return markets
      .map((market) => mapMarket(market))
      .filter((market): market is VenueMarket => Boolean(market));
  }

  async getMarket(venueMarketId: string): Promise<VenueMarket | null> {
    const result = await getMarketCached(venueMarketId);
    return result?.market ?? null;
  }

  async getOrderbookSnapshot(venueMarketId: string): Promise<VenueOrderbook> {
    const cached = await getMarketCached(venueMarketId);
    if (!cached || cached.tokenIds.length < 2) {
      return {
        venue: "polymarket",
        venueMarketId,
        yes: { bids: [], asks: [] },
        no: { bids: [], asks: [] },
        ts: Date.now(),
      };
    }

    const [yesToken, noToken] = cached.tokenIds;
    const [yesBook, noBook] = await Promise.all([
      getOrderbook(yesToken),
      getOrderbook(noToken),
    ]);

    return {
      venue: "polymarket",
      venueMarketId,
      yes: {
        bids: yesBook.bids,
        asks: yesBook.asks,
      },
      no: {
        bids: noBook.bids,
        asks: noBook.asks,
      },
      ts: Date.now(),
    };
  }

  async subscribeOrderbookDeltas(): Promise<() => void> {
    throw new Error("Polymarket WS subscriptions are not wired in shared adapter.");
  }

  async placeOrder(request: OrderRequest): Promise<OrderResponse> {
    const cached = await getMarketCached(request.venueMarketId);
    const tokenIds = cached?.tokenIds ?? [];
    const tokenId = request.outcome === "YES" ? tokenIds[0] : tokenIds[1];

    if (!tokenId) {
      return { success: false, error: "Missing tokenId for market" };
    }

    const result = await placeOrder({
      tokenId,
      side: request.side === "BID" ? "BUY" : "SELL",
      price: request.price,
      size: request.size,
      orderType: "GTC",
      postOnly: request.postOnly ?? true,
    });

    return {
      success: result.success,
      orderId: result.orderId,
      status: result.status,
      error: result.error,
    };
  }

  async placeOrders(requests: OrderRequest[]): Promise<OrderResponse[]> {
    const orders = [] as Parameters<typeof placeBatchOrders>[0]["orders"];

    for (const request of requests) {
      const cached = await getMarketCached(request.venueMarketId);
      const tokenIds = cached?.tokenIds ?? [];
      const tokenId = request.outcome === "YES" ? tokenIds[0] : tokenIds[1];
      if (!tokenId) {
        orders.push({
          tokenId: "",
          side: request.side === "BID" ? "BUY" : "SELL",
          price: request.price,
          size: request.size,
        });
        continue;
      }

      orders.push({
        tokenId,
        side: request.side === "BID" ? "BUY" : "SELL",
        price: request.price,
        size: request.size,
        orderType: "GTC",
        postOnly: request.postOnly ?? true,
      });
    }

    const response = await placeBatchOrders({ orders });
    return response.results.map((result) => ({
      success: result.success,
      orderId: result.orderId,
      status: result.status,
      error: result.error,
    }));
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    return cancelOrder(orderId);
  }

  async cancelOrders(orderIds: string[]): Promise<number> {
    let cancelled = 0;
    for (const orderId of orderIds) {
      const ok = await cancelOrder(orderId);
      if (ok) cancelled++;
    }
    return cancelled;
  }

  async getOpenOrders(venueMarketId?: string): Promise<OrderResponse[]> {
    const orders = await fetchActiveOrders();
    if (!orders) return [];

    let filtered = orders;
    if (venueMarketId) {
      const cached = await getMarketCached(venueMarketId);
      const tokenIds = cached?.tokenIds ?? [];
      filtered = orders.filter((order) => tokenIds.includes(order.asset_id));
    }

    return filtered.map((order) => ({
      success: true,
      orderId: order.id,
      status: order.status,
    }));
  }

  async getPositions(): Promise<VenuePosition[]> {
    const positions = await getPositions(undefined, { sizeThreshold: 0, limit: 500 });
    if (!positions) return [];

    return positions.map((position) => ({
      venue: "polymarket",
      venueMarketId: position.conditionId,
      outcome: position.outcome.toUpperCase() === "YES" ? "YES" : "NO",
      size: position.size,
      avgPrice: position.avgPrice,
    }));
  }

  async getFills(): Promise<VenueFill[]> {
    return [];
  }
}
