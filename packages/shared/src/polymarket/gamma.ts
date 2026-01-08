/**
 * Polymarket Gamma API Client
 *
 * The Gamma API provides market discovery and metadata.
 * No authentication required.
 */

import type { GammaMarket, GammaEvent } from "./types.js";

const GAMMA_BASE_URL = "https://gamma-api.polymarket.com";

export interface FetchMarketsParams {
  active?: boolean;
  closed?: boolean;
  limit?: number;
  offset?: number;
  minLiquidity?: number;
  maxLiquidity?: number;
  minVolume?: number;
  maxVolume?: number;
  startDateMin?: string;
  startDateMax?: string;
  endDateMin?: string;
  endDateMax?: string;
  tag?: string;
  excludeCategories?: string[];
}

export interface FetchEventsParams {
  active?: boolean;
  closed?: boolean;
  limit?: number;
  offset?: number;
  liquidityMin?: number;
  liquidityMax?: number;
  volumeMin?: number;
  volumeMax?: number;
  tagSlug?: string;
}

/**
 * Fetch markets from Gamma API with filtering
 */
export async function fetchMarkets(params: FetchMarketsParams = {}): Promise<GammaMarket[]> {
  const url = new URL(`${GAMMA_BASE_URL}/markets`);

  if (params.active !== undefined) {
    url.searchParams.set("active", String(params.active));
  }
  if (params.closed !== undefined) {
    url.searchParams.set("closed", String(params.closed));
  }
  if (params.limit) {
    url.searchParams.set("limit", String(params.limit));
  }
  if (params.offset) {
    url.searchParams.set("offset", String(params.offset));
  }
  if (params.minLiquidity) {
    url.searchParams.set("liquidity_min", String(params.minLiquidity));
  }
  if (params.maxLiquidity) {
    url.searchParams.set("liquidity_max", String(params.maxLiquidity));
  }
  if (params.minVolume) {
    url.searchParams.set("volume_min", String(params.minVolume));
  }
  if (params.endDateMin) {
    url.searchParams.set("end_date_min", params.endDateMin);
  }
  if (params.endDateMax) {
    url.searchParams.set("end_date_max", params.endDateMax);
  }

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Gamma API error: ${response.status} ${response.statusText}`);
  }

  const markets = (await response.json()) as GammaMarket[];
  return markets;
}

/**
 * Fetch active markets suitable for trading
 */
export async function fetchActiveMarkets(params: {
  minLiquidity?: number;
  excludeCategories?: string[];
  limit?: number;
}): Promise<GammaMarket[]> {
  // Fetch in batches to get all active markets
  const limit = params.limit || 100;
  let offset = 0;
  const allMarkets: GammaMarket[] = [];

  while (true) {
    const markets = await fetchMarkets({
      active: true,
      closed: false,
      limit,
      offset,
      minLiquidity: params.minLiquidity,
    });

    if (markets.length === 0) break;

    // Filter out excluded categories
    const filtered = markets.filter((m) => {
      if (!params.excludeCategories || params.excludeCategories.length === 0) {
        return true;
      }
      const category = m.category?.toLowerCase() || "";
      return !params.excludeCategories.some((exc) =>
        category.includes(exc.toLowerCase())
      );
    });

    allMarkets.push(...filtered);
    offset += limit;

    // Safety limit to prevent infinite loops
    if (offset > 10000) break;
  }

  return allMarkets;
}

/**
 * Fetch a single market by ID or slug
 */
export async function fetchMarket(idOrSlug: string): Promise<GammaMarket | null> {
  try {
    const response = await fetch(`${GAMMA_BASE_URL}/markets/${idOrSlug}`);

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Gamma API error: ${response.status}`);
    }

    return (await response.json()) as GammaMarket;
  } catch (error) {
    console.error(`Failed to fetch market ${idOrSlug}:`, error);
    return null;
  }
}

/**
 * Fetch events with their markets
 */
export async function fetchEvents(params: FetchEventsParams = {}): Promise<GammaEvent[]> {
  const url = new URL(`${GAMMA_BASE_URL}/events`);

  if (params.active !== undefined) {
    url.searchParams.set("active", String(params.active));
  }
  if (params.closed !== undefined) {
    url.searchParams.set("closed", String(params.closed));
  }
  if (params.limit) {
    url.searchParams.set("limit", String(params.limit));
  }
  if (params.offset) {
    url.searchParams.set("offset", String(params.offset));
  }
  if (params.liquidityMin) {
    url.searchParams.set("liquidity_min", String(params.liquidityMin));
  }
  if (params.tagSlug) {
    url.searchParams.set("tag_slug", params.tagSlug);
  }

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Gamma API error: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as GammaEvent[];
}

/**
 * Search markets by query
 */
export async function searchMarkets(query: string): Promise<GammaMarket[]> {
  const url = new URL(`${GAMMA_BASE_URL}/search`);
  url.searchParams.set("q", query);

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Gamma API error: ${response.status}`);
  }

  const data = (await response.json()) as { markets?: GammaMarket[] };
  return data.markets || [];
}
