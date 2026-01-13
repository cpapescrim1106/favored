import type { KalshiOrderbook } from "./types.js";
import type { OrderbookLevel, VenueOrderbook } from "../venues/types.js";

const toDecimal = (priceCents: number): number => priceCents / 100;

function normalizeBids(levels: KalshiOrderbook["yes"]): OrderbookLevel[] {
  return levels
    .map(([price, size]) => ({ price: toDecimal(price), size }))
    .sort((a, b) => b.price - a.price);
}

function normalizeAsksFromOpposite(levels: KalshiOrderbook["yes"]): OrderbookLevel[] {
  const map = new Map<number, number>();
  for (const [price, size] of levels) {
    const askPrice = (100 - price) / 100;
    map.set(askPrice, (map.get(askPrice) ?? 0) + size);
  }
  return Array.from(map.entries())
    .map(([price, size]) => ({ price, size }))
    .sort((a, b) => a.price - b.price);
}

export function normalizeKalshiOrderbook(params: {
  ticker: string;
  orderbook: KalshiOrderbook;
  ts?: number;
  sequence?: number;
}): VenueOrderbook {
  const { ticker, orderbook, ts, sequence } = params;

  const yesBids = normalizeBids(orderbook.yes ?? []);
  const noBids = normalizeBids(orderbook.no ?? []);

  const yesAsks = normalizeAsksFromOpposite(orderbook.no ?? []);
  const noAsks = normalizeAsksFromOpposite(orderbook.yes ?? []);

  return {
    venue: "kalshi",
    venueMarketId: ticker,
    yes: {
      bids: yesBids,
      asks: yesAsks,
    },
    no: {
      bids: noBids,
      asks: noAsks,
    },
    ts: ts ?? Date.now(),
    sequence,
  };
}
