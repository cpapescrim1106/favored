export interface KalshiPriceRange {
  start: string; // decimal dollars string
  end: string;
  step: string;
}

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title?: string;
  subtitle?: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  created_time: string;
  open_time: string;
  close_time: string;
  latest_expiration_time?: string;
  status: string;
  volume?: number;
  volume_24h?: number;
  liquidity_dollars?: string;
  open_interest?: number;
  last_price_dollars?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  price_level_structure?: string;
  price_ranges?: KalshiPriceRange[];
}

export interface KalshiMarketResponse {
  market: KalshiMarket;
}

export interface KalshiMarketsResponse {
  markets: KalshiMarket[];
  cursor: string;
}

export type KalshiOrderbookLevel = [number, number];

export interface KalshiOrderbook {
  yes: KalshiOrderbookLevel[];
  no: KalshiOrderbookLevel[];
}

export interface KalshiOrderbookResponse {
  orderbook: KalshiOrderbook;
}

export interface KalshiOrder {
  order_id: string;
  client_order_id?: string | null;
  ticker: string;
  side: "yes" | "no";
  action: "buy" | "sell";
  count: number;
  yes_price?: number;
  no_price?: number;
  yes_price_dollars?: string;
  no_price_dollars?: string;
  status?: string;
}

export interface KalshiOrdersResponse {
  orders: KalshiOrder[];
  cursor?: string;
}

export interface KalshiCreateOrderRequest {
  ticker: string;
  client_order_id?: string;
  side: "yes" | "no";
  action: "buy" | "sell";
  count: number;
  type?: "limit" | "market";
  yes_price?: number;
  no_price?: number;
  yes_price_dollars?: string;
  no_price_dollars?: string;
  time_in_force?: "fill_or_kill" | "good_till_canceled" | "immediate_or_cancel";
  post_only?: boolean;
  reduce_only?: boolean;
  order_group_id?: string;
  cancel_order_on_pause?: boolean;
}

export interface KalshiCreateOrderResponse {
  order: KalshiOrder;
}

export interface KalshiBatchCreateOrdersRequest {
  orders: KalshiCreateOrderRequest[];
}

export interface KalshiBatchCreateOrdersResponse {
  orders: Array<{
    client_order_id?: string | null;
    order?: KalshiOrder | null;
    error?: { code?: string; message?: string } | null;
  }>;
}

export interface KalshiPosition {
  ticker: string;
  position: number; // positive = YES, negative = NO
  market_exposure_dollars?: string;
}

export interface KalshiPositionsResponse {
  market_positions: KalshiPosition[];
  cursor?: string;
}

export interface KalshiFill {
  trade_id: string;
  ticker: string;
  price: number;
  count: number;
  side: "yes" | "no";
  action: "buy" | "sell";
  created_time?: string;
  client_order_id?: string;
  order_id?: string;
}

export interface KalshiFillsResponse {
  trades: KalshiFill[];
  cursor?: string;
}

export interface KalshiOrderGroupResponse {
  order_group_id: string;
}

export interface KalshiBalanceResponse {
  balance: number;
  portfolio_value: number;
  updated_ts: number;
}
