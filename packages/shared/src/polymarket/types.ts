/**
 * Polymarket API Types
 */

export interface GammaToken {
  token_id: string;
  outcome: string;
  price: number;
  winner?: boolean;
}

export interface GammaTag {
  id: number;
  slug: string | null;
  label: string | null;
  isCarousel?: boolean | null;
  forceShow?: boolean | null;
  forceHide?: boolean | null;
  publishedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  requiresTranslation?: boolean | null;
}

export interface GammaTagRelationship {
  id: string;
  tagID: number;
  relatedTagID: number;
  rank: number;
}

export interface GammaMarketEvent {
  id: string;
  title: string;
  slug: string;
  seriesSlug?: string;
  category?: string;
  subcategory?: string;
  tags?: GammaTag[];
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
  tags?: GammaTag[];
  // Legacy field - may not exist in new API
  tokens?: GammaToken[];
  // CLOB token IDs for orderbook access (JSON string: '["token1", "token2"]')
  clobTokenIds?: string;
}

export interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  seriesSlug?: string;
  category?: string;
  subcategory?: string;
  tags?: GammaTag[];
  markets: GammaMarket[];
}

export interface GammaSport {
  id: number;
  sport: string; // e.g., "nhl", "nfl", "nba"
  image: string;
  resolution: string;
  ordering: string;
  tags: string; // Comma-separated tag IDs
  series: string; // Series ID for fetching events
  createdAt: string;
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

/**
 * Position data from Polymarket Data API
 * GET https://data-api.polymarket.com/positions
 */
export interface DataAPIPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  totalBought: number;
  realizedPnl: number;
  percentRealizedPnl: number;
  curPrice: number;
  redeemable: boolean;
  mergeable: boolean;
  title: string;
  slug: string;
  icon: string;
  eventId: string;
  eventSlug: string;
  outcome: "Yes" | "No";
  outcomeIndex: number;
  oppositeOutcome: string;
  oppositeAsset: string;
  endDate: string;
  negativeRisk: boolean;
}

export type OrderType = "GTC" | "GTD" | "FOK" | "FAK";

export interface OrderRequest {
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  orderType?: OrderType;
  postOnly?: boolean;
  expiration?: number; // Unix timestamp for GTD orders
}

export interface OrderResponse {
  success: boolean;
  orderId?: string;
  error?: string;
  status?: string;
  takingAmount?: string;
  makingAmount?: string;
}

export interface BatchOrderRequest {
  orders: OrderRequest[];
}

export interface BatchOrderResponse {
  success: boolean;
  results: OrderResponse[];
  errors?: string[];
}
