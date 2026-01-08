/**
 * Polymarket API Types
 */

export interface GammaToken {
  token_id: string;
  outcome: string;
  price: number;
  winner?: boolean;
}

export interface GammaMarketEvent {
  id: string;
  title: string;
  slug: string;
  seriesSlug?: string;
}

export interface GammaMarket {
  id: string;
  question: string;
  slug: string;
  active: boolean;
  closed: boolean;
  endDate: string;
  // API returns JSON strings, not arrays
  outcomes: string; // JSON string: '["Yes", "No"]'
  outcomePrices: string; // JSON string: '["0.50", "0.50"]'
  spread?: number;
  volume: string;
  liquidity: string;
  category?: string;
  description?: string;
  conditionId?: string;
  // Events array contains parent event info
  events?: GammaMarketEvent[];
  // Legacy field - may not exist in new API
  tokens?: GammaToken[];
}

export interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  markets: GammaMarket[];
}

export interface CLOBOrder {
  id: string;
  asset_id: string;
  maker_address: string;
  side: "BUY" | "SELL";
  price: string;
  size: string;
  outcome: "Yes" | "No";
  status: "live" | "matched" | "cancelled";
  created_at: string;
}

export interface CLOBPosition {
  asset_id: string;
  size: string;
  average_price: string;
  side: "YES" | "NO";
}

export interface OrderRequest {
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
}

export interface OrderResponse {
  success: boolean;
  orderId?: string;
  error?: string;
}

export interface BatchOrderRequest {
  orders: OrderRequest[];
}

export interface BatchOrderResponse {
  success: boolean;
  results: OrderResponse[];
  errors?: string[];
}
