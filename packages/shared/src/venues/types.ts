export type VenueId = "polymarket" | "kalshi";

export type VenueMarketStatus = "active" | "closed" | "resolved" | "unknown";

export type Outcome = "YES" | "NO";
export type QuoteSide = "BID" | "ASK";

export interface PriceRange {
  start: number; // decimal dollars (e.g., 0.10)
  end: number; // decimal dollars (e.g., 0.90)
  step: number; // decimal dollars (e.g., 0.01)
}

export interface VenueMarket {
  venue: VenueId;
  venueMarketId: string; // Polymarket condition_id or Kalshi ticker
  slug: string;
  question: string;
  status: VenueMarketStatus;
  closeTime?: string;
  eventId?: string;
  volume24h?: number;
  liquidity?: number;
  openInterest?: number;
  yesPrice?: number | null; // decimal 0-1
  noPrice?: number | null; // decimal 0-1
  priceLevelStructure?: string | null;
  priceRanges?: PriceRange[] | null;
  metadata?: Record<string, unknown>;
}

export interface OrderbookLevel {
  price: number; // decimal 0-1
  size: number; // contracts/shares
}

export interface OrderbookSide {
  bids: OrderbookLevel[]; // best-first
  asks: OrderbookLevel[]; // best-first
}

export interface VenueOrderbook {
  venue: VenueId;
  venueMarketId: string;
  yes: OrderbookSide;
  no: OrderbookSide;
  ts: number;
  sequence?: number;
}

export interface OrderRequest {
  venue: VenueId;
  venueMarketId: string;
  outcome: Outcome;
  side: QuoteSide;
  price: number; // decimal 0-1
  size: number; // contracts/shares
  postOnly?: boolean;
  reduceOnly?: boolean;
  clientOrderId?: string;
  orderGroupId?: string;
  timeInForce?: "GTC" | "IOC" | "FOK";
}

export interface OrderResponse {
  success: boolean;
  orderId?: string;
  clientOrderId?: string;
  status?: string;
  error?: string;
}

export interface VenuePosition {
  venue: VenueId;
  venueMarketId: string;
  outcome: Outcome;
  size: number;
  avgPrice: number; // decimal 0-1
}

export interface VenueFill {
  venue: VenueId;
  venueMarketId: string;
  orderId: string;
  clientOrderId?: string;
  outcome: Outcome;
  side: "BUY" | "SELL";
  price: number; // decimal 0-1
  size: number;
  ts: number;
}
