/**
 * Polymarket Gamma API Client
 *
 * The Gamma API provides market discovery and metadata.
 * No authentication required.
 */

import type {
  GammaMarket,
  GammaEvent,
  GammaSport,
  GammaMarketEvent,
  GammaTag,
  GammaTagRelationship,
} from "./types.js";

const GAMMA_BASE_URL = "https://gamma-api.polymarket.com";
const REQUEST_DELAY_MS = 100;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface FetchMarketsParams {
  active?: boolean;
  closed?: boolean;
  limit?: number;
  offset?: number;
  order?: string;
  ascending?: boolean;
  minLiquidity?: number;
  maxLiquidity?: number;
  minVolume?: number;
  maxVolume?: number;
  startDateMin?: string;
  startDateMax?: string;
  endDateMin?: string;
  endDateMax?: string;
  tag?: string;
  tagId?: number;
  relatedTags?: boolean;
  includeTag?: boolean;
  excludeCategories?: string[];
}

export interface FetchEventsParams {
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  limit?: number;
  offset?: number;
  order?: string;
  ascending?: boolean;
  liquidityMin?: number;
  liquidityMax?: number;
  volumeMin?: number;
  volumeMax?: number;
  startDateMin?: string;
  startDateMax?: string;
  endDateMin?: string;
  endDateMax?: string;
  tagId?: number;
  excludeTagIds?: number[];
  relatedTags?: boolean;
  tagSlug?: string;
}

export interface FetchTagsParams {
  limit?: number;
  offset?: number;
  order?: string;
  ascending?: boolean;
  includeTemplate?: boolean;
  isCarousel?: boolean;
}

export interface FetchRelatedTagsParams {
  status?: "active" | "closed" | "all";
  omitEmpty?: boolean;
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
  if (params.limit !== undefined) {
    url.searchParams.set("limit", String(params.limit));
  }
  if (params.offset !== undefined) {
    url.searchParams.set("offset", String(params.offset));
  }
  if (params.order) {
    url.searchParams.set("order", params.order);
  }
  if (params.ascending !== undefined) {
    url.searchParams.set("ascending", String(params.ascending));
  }
  if (params.minLiquidity !== undefined) {
    url.searchParams.set("liquidity_num_min", String(params.minLiquidity));
  }
  if (params.maxLiquidity !== undefined) {
    url.searchParams.set("liquidity_num_max", String(params.maxLiquidity));
  }
  if (params.minVolume !== undefined) {
    url.searchParams.set("volume_num_min", String(params.minVolume));
  }
  if (params.maxVolume !== undefined) {
    url.searchParams.set("volume_num_max", String(params.maxVolume));
  }
  if (params.startDateMin) {
    url.searchParams.set("start_date_min", params.startDateMin);
  }
  if (params.startDateMax) {
    url.searchParams.set("start_date_max", params.startDateMax);
  }
  if (params.endDateMin) {
    url.searchParams.set("end_date_min", params.endDateMin);
  }
  if (params.endDateMax) {
    url.searchParams.set("end_date_max", params.endDateMax);
  }
  if (params.tagId !== undefined) {
    url.searchParams.set("tag_id", String(params.tagId));
  } else if (params.tag) {
    url.searchParams.set("tag_id", params.tag);
  }
  if (params.relatedTags !== undefined) {
    url.searchParams.set("related_tags", String(params.relatedTags));
  }
  if (params.includeTag !== undefined) {
    url.searchParams.set("include_tag", String(params.includeTag));
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
      order: "id",
      ascending: false,
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

    await delay(REQUEST_DELAY_MS);
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
 * Fetch a single market by slug
 */
export async function fetchMarketBySlug(slug: string): Promise<GammaMarket | null> {
  try {
    const response = await fetch(`${GAMMA_BASE_URL}/markets/slug/${slug}`);

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Gamma API error: ${response.status}`);
    }

    return (await response.json()) as GammaMarket;
  } catch (error) {
    console.error(`Failed to fetch market slug ${slug}:`, error);
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
  if (params.archived !== undefined) {
    url.searchParams.set("archived", String(params.archived));
  }
  if (params.limit !== undefined) {
    url.searchParams.set("limit", String(params.limit));
  }
  if (params.offset !== undefined) {
    url.searchParams.set("offset", String(params.offset));
  }
  if (params.order) {
    url.searchParams.set("order", params.order);
  }
  if (params.ascending !== undefined) {
    url.searchParams.set("ascending", String(params.ascending));
  }
  if (params.liquidityMin !== undefined) {
    url.searchParams.set("liquidity_min", String(params.liquidityMin));
  }
  if (params.liquidityMax !== undefined) {
    url.searchParams.set("liquidity_max", String(params.liquidityMax));
  }
  if (params.volumeMin !== undefined) {
    url.searchParams.set("volume_min", String(params.volumeMin));
  }
  if (params.volumeMax !== undefined) {
    url.searchParams.set("volume_max", String(params.volumeMax));
  }
  if (params.startDateMin) {
    url.searchParams.set("start_date_min", params.startDateMin);
  }
  if (params.startDateMax) {
    url.searchParams.set("start_date_max", params.startDateMax);
  }
  if (params.endDateMin) {
    url.searchParams.set("end_date_min", params.endDateMin);
  }
  if (params.endDateMax) {
    url.searchParams.set("end_date_max", params.endDateMax);
  }
  if (params.tagSlug) {
    url.searchParams.set("tag_slug", params.tagSlug);
  }
  if (params.tagId !== undefined) {
    url.searchParams.set("tag_id", String(params.tagId));
  }
  if (params.excludeTagIds && params.excludeTagIds.length > 0) {
    for (const tagId of params.excludeTagIds) {
      url.searchParams.append("exclude_tag_id", String(tagId));
    }
  }
  if (params.relatedTags !== undefined) {
    url.searchParams.set("related_tags", String(params.relatedTags));
  }

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Gamma API error: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as GammaEvent[];
}

/**
 * Fetch a single event by slug
 */
export async function fetchEventBySlug(slug: string): Promise<GammaEvent | null> {
  try {
    const response = await fetch(`${GAMMA_BASE_URL}/events/slug/${slug}`);

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Gamma API error: ${response.status}`);
    }

    return (await response.json()) as GammaEvent;
  } catch (error) {
    console.error(`Failed to fetch event slug ${slug}:`, error);
    return null;
  }
}

/**
 * Fetch tags from Gamma API
 */
export async function fetchTags(params: FetchTagsParams = {}): Promise<GammaTag[]> {
  const url = new URL(`${GAMMA_BASE_URL}/tags`);

  if (params.limit !== undefined) {
    url.searchParams.set("limit", String(params.limit));
  }
  if (params.offset !== undefined) {
    url.searchParams.set("offset", String(params.offset));
  }
  if (params.order) {
    url.searchParams.set("order", params.order);
  }
  if (params.ascending !== undefined) {
    url.searchParams.set("ascending", String(params.ascending));
  }
  if (params.includeTemplate !== undefined) {
    url.searchParams.set("include_template", String(params.includeTemplate));
  }
  if (params.isCarousel !== undefined) {
    url.searchParams.set("is_carousel", String(params.isCarousel));
  }

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Gamma API error: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as GammaTag[];
}

/**
 * Fetch a tag by ID
 */
export async function fetchTagById(tagId: number): Promise<GammaTag> {
  const response = await fetch(`${GAMMA_BASE_URL}/tags/${tagId}`);

  if (!response.ok) {
    throw new Error(`Gamma API error: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as GammaTag;
}

/**
 * Fetch a tag by slug
 */
export async function fetchTagBySlug(slug: string): Promise<GammaTag> {
  const response = await fetch(`${GAMMA_BASE_URL}/tags/slug/${encodeURIComponent(slug)}`);

  if (!response.ok) {
    throw new Error(`Gamma API error: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as GammaTag;
}

/**
 * Fetch related tag relationships by tag ID
 */
export async function fetchRelatedTagRelationshipsById(
  tagId: number
): Promise<GammaTagRelationship[]> {
  const response = await fetch(`${GAMMA_BASE_URL}/tags/${tagId}/related-tags`);

  if (!response.ok) {
    throw new Error(`Gamma API error: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as GammaTagRelationship[];
}

/**
 * Fetch related tag relationships by tag slug
 */
export async function fetchRelatedTagRelationshipsBySlug(
  slug: string
): Promise<GammaTagRelationship[]> {
  const response = await fetch(
    `${GAMMA_BASE_URL}/tags/slug/${encodeURIComponent(slug)}/related-tags`
  );

  if (!response.ok) {
    throw new Error(`Gamma API error: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as GammaTagRelationship[];
}

/**
 * Fetch related tag objects by tag ID
 */
export async function fetchRelatedTagsById(
  tagId: number,
  params: FetchRelatedTagsParams = {}
): Promise<GammaTag[]> {
  const url = new URL(`${GAMMA_BASE_URL}/tags/${tagId}/related-tags/tags`);

  if (params.status) {
    url.searchParams.set("status", params.status);
  }
  if (params.omitEmpty !== undefined) {
    url.searchParams.set("omit_empty", String(params.omitEmpty));
  }

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Gamma API error: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as GammaTag[];
}

/**
 * Fetch related tag objects by tag slug
 */
export async function fetchRelatedTagsBySlug(
  slug: string,
  params: FetchRelatedTagsParams = {}
): Promise<GammaTag[]> {
  const url = new URL(`${GAMMA_BASE_URL}/tags/slug/${encodeURIComponent(slug)}/related-tags/tags`);

  if (params.status) {
    url.searchParams.set("status", params.status);
  }
  if (params.omitEmpty !== undefined) {
    url.searchParams.set("omit_empty", String(params.omitEmpty));
  }

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Gamma API error: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as GammaTag[];
}

/**
 * Fetch event tags by event ID
 */
export async function fetchEventTags(eventId: string): Promise<GammaTag[]> {
  const response = await fetch(`${GAMMA_BASE_URL}/events/${eventId}/tags`);

  if (!response.ok) {
    throw new Error(`Gamma API error: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as GammaTag[];
}

/**
 * Fetch market tags by market ID
 */
export async function fetchMarketTags(marketId: string): Promise<GammaTag[]> {
  const response = await fetch(`${GAMMA_BASE_URL}/markets/${marketId}/tags`);

  if (!response.ok) {
    throw new Error(`Gamma API error: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as GammaTag[];
}

/**
 * Search markets by query
 */
export async function searchMarkets(query: string): Promise<GammaMarket[]> {
  const url = new URL(`${GAMMA_BASE_URL}/public-search`);
  url.searchParams.set("q", query);
  url.searchParams.set("search_tags", "false");
  url.searchParams.set("search_profiles", "false");
  url.searchParams.set("limit_per_type", "50");

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Gamma API error: ${response.status}`);
  }

  const data = (await response.json()) as {
    events?: GammaEvent[];
    pagination?: { hasMore: boolean; totalResults: number };
  };

  const markets: GammaMarket[] = [];
  for (const event of data.events || []) {
    if (event.markets) {
      markets.push(...event.markets);
    }
  }
  return markets;
}

/**
 * Fetch all sports leagues with their series IDs
 */
export async function fetchSports(): Promise<GammaSport[]> {
  const response = await fetch(`${GAMMA_BASE_URL}/sports`);

  if (!response.ok) {
    throw new Error(`Gamma API error: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as GammaSport[];
}

/**
 * Fetch events by series ID (for sports leagues)
 */
export async function fetchEventsBySeries(seriesId: string, params: {
  active?: boolean;
  closed?: boolean;
  tagId?: string; // 100639 for game bets (not futures)
} = {}): Promise<GammaEvent[]> {
  const url = new URL(`${GAMMA_BASE_URL}/events`);
  url.searchParams.set("series_id", seriesId);

  if (params.active !== undefined) {
    url.searchParams.set("active", String(params.active));
  }
  if (params.closed !== undefined) {
    url.searchParams.set("closed", String(params.closed));
  }
  if (params.tagId) {
    url.searchParams.set("tag_id", params.tagId);
  }

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Gamma API error: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as GammaEvent[];
}

/**
 * Fetch all active sports markets from all leagues
 * Returns markets extracted from sports events
 */
export async function fetchActiveSportsMarkets(params: {
  minLiquidity?: number;
  excludeCategories?: string[];
}): Promise<GammaMarket[]> {
  const allMarkets: GammaMarket[] = [];

  try {
    // Fetch all sports leagues
    const sports = await fetchSports();
    console.log(`[Sports] Found ${sports.length} sports leagues`);

    // Fetch active events for each league
    for (const sport of sports) {
      // Skip if sport is missing required fields
      if (!sport.sport || !sport.series) {
        continue;
      }

      // Skip if this sport category is excluded
      if (params.excludeCategories?.some(exc =>
        exc && sport.sport.toLowerCase().includes(exc.toLowerCase())
      )) {
        continue;
      }

      try {
        // Fetch active events for this league (includes futures and game markets)
        const events = await fetchEventsBySeries(sport.series, {
          active: true,
          closed: false,
        });

        // Extract markets from events
        for (const event of events) {
          if (!event.markets) continue;

          for (const market of event.markets) {
            // Skip if liquidity is too low
            const liquidity = parseFloat(market.liquidity || "0");
            if (params.minLiquidity && liquidity < params.minLiquidity) {
              continue;
            }

            // Skip closed or inactive markets
            if (!market.active || market.closed) {
              continue;
            }

            // Add event info to market for category derivation
            if (!market.events) {
              market.events = [{
                id: event.id,
                title: event.title,
                slug: event.slug,
                seriesSlug: sport.sport,
              }];
            }

            // Set category from sport (uppercase for display)
            market.category = sport.sport.toUpperCase();

            allMarkets.push(market);
          }
        }

      } catch (error) {
        console.error(`[Sports] Error fetching ${sport.sport}:`, error);
        // Continue with other sports
      }
    }
  } catch (error) {
    console.error("[Sports] Error fetching sports:", error);
  }

  return allMarkets;
}

/**
 * Fetch all active markets via the events endpoint
 */
export async function fetchAllActiveMarkets(): Promise<GammaMarket[]> {
  const allMarkets: GammaMarket[] = [];
  const seenIds = new Set<string>();

  let offset = 0;
  const limit = 100;

  while (true) {
    const events = await fetchEvents({
      active: true,
      closed: false,
      archived: false,
      limit,
      offset,
      order: "id",
      ascending: false,
    });

    if (events.length === 0) break;

    for (const event of events) {
      const eventInfo: GammaMarketEvent = {
        id: event.id,
        title: event.title,
        slug: event.slug,
        seriesSlug: event.seriesSlug,
        category: event.category,
        subcategory: event.subcategory,
        tags: event.tags,
      };

      for (const market of event.markets || []) {
        if (seenIds.has(market.id)) continue;
        seenIds.add(market.id);

        if (!market.events || market.events.length === 0) {
          market.events = [eventInfo];
        } else if (!market.events.some((e) => e.id === eventInfo.id)) {
          market.events = [...market.events, eventInfo];
        }

        allMarkets.push(market);
      }
    }

    offset += limit;
    await delay(REQUEST_DELAY_MS);
  }

  return allMarkets;
}
