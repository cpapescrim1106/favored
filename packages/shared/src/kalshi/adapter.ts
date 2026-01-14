import type {
  OrderRequest,
  OrderResponse,
  VenueFill,
  VenueMarket,
  VenueOrderbook,
  VenuePosition,
} from "../venues/types.js";
import type { VenueAdapter } from "../venues/adapter.js";
import { clampPrice, quantizePrice } from "../venues/price.js";
import { getKalshiSubaccount, kalshiRequest, parseFixedPoint } from "./client.js";
import { normalizeKalshiOrderbook } from "./normalize.js";
import { subscribeKalshiOrderbook } from "./ws.js";
import type {
  KalshiBatchCreateOrdersRequest,
  KalshiBatchCreateOrdersResponse,
  KalshiCreateOrderRequest,
  KalshiCreateOrderResponse,
  KalshiFillsResponse,
  KalshiMarketsResponse,
  KalshiMarketResponse,
  KalshiOrderbookResponse,
  KalshiOrdersResponse,
  KalshiPositionsResponse,
  KalshiMarket,
  KalshiOrderGroupResponse,
} from "./types.js";

const MARKET_CACHE_TTL_MS = 5 * 60 * 1000;
const marketCache = new Map<string, { market: VenueMarket; at: number }>();

function isTradingEnabled(): boolean {
  return process.env.KALSHI_TRADING_ENABLED === "true";
}

function mapStatus(status?: string): VenueMarket["status"] {
  if (!status) return "unknown";
  if (status === "active") return "active";
  if (status === "closed" || status === "inactive") return "closed";
  if (status === "finalized" || status === "determined") return "resolved";
  return "unknown";
}

function mapMarket(market: KalshiMarket): VenueMarket {
  const lastPrice = parseFixedPoint(market.last_price_dollars);
  const yesBid = parseFixedPoint(market.yes_bid_dollars);
  const yesAsk = parseFixedPoint(market.yes_ask_dollars);

  let yesPrice: number | null = null;
  if (lastPrice !== null) {
    yesPrice = lastPrice;
  } else if (yesBid !== null && yesAsk !== null) {
    yesPrice = (yesBid + yesAsk) / 2;
  } else if (yesBid !== null) {
    yesPrice = yesBid;
  } else if (yesAsk !== null) {
    yesPrice = yesAsk;
  }

  const noPrice = yesPrice !== null ? 1 - yesPrice : null;

  return {
    venue: "kalshi",
    venueMarketId: market.ticker,
    slug: market.ticker,
    question: market.title || market.subtitle || market.ticker,
    status: mapStatus(market.status),
    closeTime: market.close_time,
    eventId: market.event_ticker,
    volume24h: market.volume_24h ?? undefined,
    liquidity: parseFixedPoint(market.liquidity_dollars) ?? undefined,
    openInterest: market.open_interest ?? undefined,
    yesPrice,
    noPrice,
    priceLevelStructure: market.price_level_structure ?? null,
    priceRanges: market.price_ranges?.map((range) => ({
      start: parseFloat(range.start),
      end: parseFloat(range.end),
      step: parseFloat(range.step),
    })) ?? null,
    metadata: {
      yes_bid: yesBid,
      yes_ask: yesAsk,
      no_bid: parseFixedPoint(market.no_bid_dollars),
      no_ask: parseFixedPoint(market.no_ask_dollars),
    },
  };
}

async function getMarketCached(ticker: string): Promise<VenueMarket | null> {
  const cached = marketCache.get(ticker);
  const now = Date.now();
  if (cached && now - cached.at <= MARKET_CACHE_TTL_MS) {
    return cached.market;
  }

  const response = await kalshiRequest<KalshiMarketResponse>({
    method: "GET",
    path: `/markets/${ticker}`,
  });
  const mapped = mapMarket(response.market);
  marketCache.set(ticker, { market: mapped, at: now });
  return mapped;
}

function buildOrderRequest(
  request: OrderRequest,
  market: VenueMarket | null
): KalshiCreateOrderRequest {
  const basePrice = clampPrice(request.price);
  const quantized = quantizePrice(basePrice, market?.priceRanges ?? null, request.side === "BID" ? "floor" : "ceil");
  const priceCents = Math.round(quantized * 100);

  const isAsk = request.side === "ASK";
  const isYes = request.outcome === "YES";

  const translated: {
    side: "yes" | "no";
    action: "buy" | "sell";
    yes_price?: number;
    no_price?: number;
  } = (() => {
    if (!isAsk && isYes) {
      return { side: "yes", action: "buy", yes_price: priceCents };
    }
    if (isAsk && isYes) {
      return { side: "no", action: "buy", no_price: 100 - priceCents };
    }
    if (!isAsk && !isYes) {
      return { side: "no", action: "buy", no_price: priceCents };
    }
    return { side: "yes", action: "buy", yes_price: 100 - priceCents };
  })();

  return {
    ticker: request.venueMarketId,
    client_order_id: request.clientOrderId,
    side: translated.side,
    action: translated.action,
    count: Math.max(1, Math.round(request.size)),
    type: "limit",
    post_only: request.postOnly ?? true,
    reduce_only: request.reduceOnly ?? false,
    order_group_id: request.orderGroupId,
    yes_price: translated.side === "yes" ? translated.yes_price : undefined,
    no_price: translated.side === "no" ? translated.no_price : undefined,
  };
}

export class KalshiAdapter implements VenueAdapter {
  id: VenueAdapter["id"] = "kalshi";

  async listMarkets(params?: Record<string, unknown>): Promise<VenueMarket[]> {
    const limit = Number(params?.limit ?? 1000);
    const maxPages = Number(params?.maxPages ?? 5);
    const status = params?.status ? String(params.status) : "open";
    const mveFilter = params?.mveFilter ?? params?.mve_filter;

    const results: VenueMarket[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < maxPages; page++) {
      const response = await kalshiRequest<KalshiMarketsResponse>({
        method: "GET",
        path: "/markets",
        query: {
          limit,
          cursor,
          status,
          mve_filter: mveFilter ? String(mveFilter) : undefined,
        },
      });

      for (const market of response.markets ?? []) {
        results.push(mapMarket(market));
      }

      if (!response.cursor) break;
      cursor = response.cursor;
    }

    return results;
  }

  async getMarket(venueMarketId: string): Promise<VenueMarket | null> {
    return getMarketCached(venueMarketId);
  }

  async getOrderbookSnapshot(venueMarketId: string): Promise<VenueOrderbook> {
    const response = await kalshiRequest<KalshiOrderbookResponse>({
      method: "GET",
      path: `/markets/${venueMarketId}/orderbook`,
    });

    return normalizeKalshiOrderbook({
      ticker: venueMarketId,
      orderbook: response.orderbook,
    });
  }

  async subscribeOrderbookDeltas(params: {
    venueMarketIds: string[];
    onSnapshot: (orderbook: VenueOrderbook) => void;
    onDelta: (orderbook: VenueOrderbook) => void;
    onError: (error: Error) => void;
  }): Promise<() => void> {
    return subscribeKalshiOrderbook({
      marketTickers: params.venueMarketIds,
      onSnapshot: params.onSnapshot,
      onDelta: params.onDelta,
      onError: params.onError,
    });
  }

  async placeOrder(request: OrderRequest): Promise<OrderResponse> {
    if (!isTradingEnabled()) {
      return {
        success: true,
        status: "simulated",
        orderId: `kalshi-dry-${Date.now()}`,
        clientOrderId: request.clientOrderId,
      };
    }

    const market = await getMarketCached(request.venueMarketId);
    const payload = buildOrderRequest(request, market);

    const response = await kalshiRequest<KalshiCreateOrderResponse>({
      method: "POST",
      path: "/portfolio/orders",
      data: payload,
      auth: true,
    });

    return {
      success: true,
      orderId: response.order.order_id,
      clientOrderId: response.order.client_order_id ?? undefined,
      status: response.order.status,
    };
  }

  async placeOrders(requests: OrderRequest[]): Promise<OrderResponse[]> {
    if (requests.length === 0) return [];

    if (!isTradingEnabled()) {
      return requests.map((request) => ({
        success: true,
        status: "simulated",
        orderId: `kalshi-dry-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        clientOrderId: request.clientOrderId,
      }));
    }

    const payload: KalshiBatchCreateOrdersRequest = {
      orders: [],
    };

    for (const request of requests) {
      const market = await getMarketCached(request.venueMarketId);
      payload.orders.push(buildOrderRequest(request, market));
    }

    const response = await kalshiRequest<KalshiBatchCreateOrdersResponse>({
      method: "POST",
      path: "/portfolio/orders/batched",
      data: payload,
      auth: true,
    });

    return response.orders.map((result) => ({
      success: !result.error,
      orderId: result.order?.order_id,
      clientOrderId: result.client_order_id ?? undefined,
      status: result.order?.status,
      error: result.error?.message,
    }));
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    if (!isTradingEnabled()) return true;

    await kalshiRequest({
      method: "DELETE",
      path: `/portfolio/orders/${orderId}`,
      auth: true,
    });

    return true;
  }

  async cancelOrders(orderIds: string[]): Promise<number> {
    let cancelled = 0;
    for (const orderId of orderIds) {
      const ok = await this.cancelOrder(orderId);
      if (ok) cancelled++;
    }
    return cancelled;
  }

  async getOpenOrders(venueMarketId?: string): Promise<OrderResponse[]> {
    const subaccount = getKalshiSubaccount();
    const response = await kalshiRequest<KalshiOrdersResponse>({
      method: "GET",
      path: "/portfolio/orders",
      query: {
        ...(venueMarketId ? { ticker: venueMarketId } : {}),
        ...(subaccount !== undefined ? { subaccount } : {}),
      },
      auth: true,
    });

    return (response.orders ?? []).map((order) => ({
      success: true,
      orderId: order.order_id,
      clientOrderId: order.client_order_id ?? undefined,
      status: order.status,
    }));
  }

  async getPositions(): Promise<VenuePosition[]> {
    const subaccount = getKalshiSubaccount();
    const response = await kalshiRequest<KalshiPositionsResponse>({
      method: "GET",
      path: "/portfolio/positions",
      query: subaccount !== undefined ? { subaccount } : undefined,
      auth: true,
    });

    const positions: VenuePosition[] = [];

    for (const position of response.market_positions ?? []) {
      if (!position.position) continue;
      const outcome = position.position > 0 ? "YES" : "NO";
      const size = Math.abs(position.position);
      const exposure = parseFixedPoint(position.market_exposure_dollars) ?? 0;
      const avgPrice = size > 0 ? exposure / size : 0;

      positions.push({
        venue: "kalshi",
        venueMarketId: position.ticker,
        outcome,
        size,
        avgPrice,
      });
    }

    return positions;
  }

  async getFills(params?: { sinceTs?: number }): Promise<VenueFill[]> {
    const query: Record<string, string | number> = {};
    if (params?.sinceTs) {
      query.since_ts = params.sinceTs;
    }
    const subaccount = getKalshiSubaccount();
    if (subaccount !== undefined) {
      query.subaccount = subaccount;
    }

    const response = await kalshiRequest<KalshiFillsResponse>({
      method: "GET",
      path: "/portfolio/fills",
      query,
      auth: true,
    });

    return (response.trades ?? []).map((fill) => ({
      venue: "kalshi",
      venueMarketId: fill.ticker,
      orderId: fill.order_id ?? "",
      clientOrderId: fill.client_order_id ?? undefined,
      outcome: fill.side === "yes" ? "YES" : "NO",
      side: fill.action === "buy" ? "BUY" : "SELL",
      price: fill.price / 100,
      size: fill.count,
      ts: fill.created_time ? new Date(fill.created_time).getTime() : Date.now(),
    }));
  }

  async createOrderGroup(params: { contractsLimit: number }): Promise<string> {
    if (!isTradingEnabled()) {
      return `kalshi-group-dry-${Date.now()}`;
    }

    const response = await kalshiRequest<KalshiOrderGroupResponse>({
      method: "POST",
      path: "/portfolio/order_groups/create",
      data: { contracts_limit: params.contractsLimit },
      auth: true,
    });

    return response.order_group_id;
  }

  async resetOrderGroup(orderGroupId: string): Promise<boolean> {
    if (!isTradingEnabled()) return true;

    await kalshiRequest({
      method: "POST",
      path: `/portfolio/order_groups/${orderGroupId}/reset`,
      auth: true,
    });

    return true;
  }
}
