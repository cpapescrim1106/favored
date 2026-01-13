import type { PriceRange } from "./types.js";

export const DEFAULT_TICK_SIZE = 0.01;
export const DEFAULT_MIN_PRICE = 0.01;
export const DEFAULT_MAX_PRICE = 0.99;

export type QuantizeMode = "round" | "floor" | "ceil";

export function getTickSizeForPrice(
  price: number,
  ranges?: PriceRange[] | null
): number {
  if (!ranges || ranges.length === 0) {
    return DEFAULT_TICK_SIZE;
  }

  for (const range of ranges) {
    if (price >= range.start && price <= range.end) {
      return range.step;
    }
  }

  return ranges[ranges.length - 1]?.step ?? DEFAULT_TICK_SIZE;
}

export function quantizePrice(
  price: number,
  ranges?: PriceRange[] | null,
  mode: QuantizeMode = "round"
): number {
  const step = getTickSizeForPrice(price, ranges);
  if (step <= 0) return price;

  const raw = price / step;
  let ticks: number;

  if (mode === "floor") {
    ticks = Math.floor(raw);
  } else if (mode === "ceil") {
    ticks = Math.ceil(raw);
  } else {
    ticks = Math.round(raw);
  }

  return ticks * step;
}

export function clampPrice(
  price: number,
  minPrice = DEFAULT_MIN_PRICE,
  maxPrice = DEFAULT_MAX_PRICE
): number {
  return Math.max(minPrice, Math.min(maxPrice, price));
}
