import type {
  OrderRequest,
  OrderResponse,
  VenueFill,
  VenueMarket,
  VenueOrderbook,
  VenuePosition,
} from "./types.js";

export interface OrderbookSubscription {
  venueMarketIds: string[];
  onSnapshot: (orderbook: VenueOrderbook) => void;
  onDelta: (orderbook: VenueOrderbook) => void;
  onError: (error: Error) => void;
}

export interface VenueAdapter {
  id: VenueMarket["venue"];
  listMarkets(params?: Record<string, unknown>): Promise<VenueMarket[]>;
  getMarket(venueMarketId: string): Promise<VenueMarket | null>;
  getOrderbookSnapshot(venueMarketId: string): Promise<VenueOrderbook>;
  subscribeOrderbookDeltas(params: OrderbookSubscription): Promise<() => void>;
  placeOrder(request: OrderRequest): Promise<OrderResponse>;
  placeOrders(requests: OrderRequest[]): Promise<OrderResponse[]>;
  cancelOrder(orderId: string, clientOrderId?: string): Promise<boolean>;
  cancelOrders(orderIds: string[]): Promise<number>;
  getOpenOrders(venueMarketId?: string): Promise<OrderResponse[]>;
  getPositions(params?: Record<string, unknown>): Promise<VenuePosition[]>;
  getFills(params?: { sinceTs?: number }): Promise<VenueFill[]>;
  createOrderGroup?(params: { name?: string; cancelOnLimit?: boolean }): Promise<string>;
  resetOrderGroup?(orderGroupId: string): Promise<boolean>;
}
