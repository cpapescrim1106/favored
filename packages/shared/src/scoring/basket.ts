/**
 * Basket Building Algorithm
 *
 * Builds a basket of orders from scored candidates, respecting:
 * - Total stake limits
 * - Per-market exposure limits
 * - Per-category exposure limits
 * - Existing position constraints
 */

import { MAX_BATCH_SIZE } from "../polymarket/clob.js";

export interface BasketCandidate {
  id: string;
  marketId: string;
  side: "YES" | "NO";
  score: number;
  impliedProb: number;
  market: {
    slug: string;
    question: string;
    category: string | null;
    yesPrice: number | null;
    noPrice: number | null;
  };
}

export interface ExistingPosition {
  marketId: string;
  side: string;
  totalCost: number;
}

export interface BasketConfig {
  maxItems: number; // Max positions to add
  targetTotalStake: number; // Total USD to deploy
  minScore: number; // Minimum score threshold (e.g., 60)
  maxPerMarket: number; // Max stake per market
  maxPerCategory: number; // Max stake per category
  defaultStake: number; // Default stake per position
  batchSize?: number; // Orders per batch (default MAX_BATCH_SIZE)
}

export interface BasketItem {
  candidateId: string;
  marketId: string;
  marketSlug: string;
  side: "YES" | "NO";
  stake: number;
  limitPrice: number;
  snapshotPrice: number;
  score: number;
  category: string;
}

export interface BasketResult {
  items: BasketItem[];
  totalStake: number;
  batchCount: number;
  categoryExposure: Record<string, number>;
  skipped: Array<{ candidateId: string; reason: string }>;
}

/**
 * Build a basket from candidates
 */
export function buildBasket(
  candidates: BasketCandidate[],
  existingPositions: ExistingPosition[],
  existingCategoryExposure: Record<string, number>,
  config: BasketConfig
): BasketResult {
  const batchSize = config.batchSize || MAX_BATCH_SIZE;

  // Sort by score descending
  const sorted = [...candidates]
    .filter((c) => c.score >= config.minScore)
    .sort((a, b) => b.score - a.score);

  const items: BasketItem[] = [];
  const categoryExposure: Record<string, number> = { ...existingCategoryExposure };
  const skipped: Array<{ candidateId: string; reason: string }> = [];
  let totalStake = 0;

  // Track markets we're already adding to basket
  const basketMarkets = new Set<string>();

  for (const candidate of sorted) {
    // Check if we've hit limits
    if (items.length >= config.maxItems) {
      skipped.push({ candidateId: candidate.id, reason: "Max items reached" });
      continue;
    }

    if (totalStake >= config.targetTotalStake) {
      skipped.push({ candidateId: candidate.id, reason: "Target stake reached" });
      continue;
    }

    // Check if we already have a position in this market (same side)
    const existingPos = existingPositions.find(
      (p) => p.marketId === candidate.marketId && p.side === candidate.side
    );
    if (existingPos) {
      skipped.push({
        candidateId: candidate.id,
        reason: `Already have ${candidate.side} position in ${candidate.market.slug}`,
      });
      continue;
    }

    // Check if we're already adding this market to the basket
    const basketKey = `${candidate.marketId}-${candidate.side}`;
    if (basketMarkets.has(basketKey)) {
      skipped.push({
        candidateId: candidate.id,
        reason: `Already in basket: ${candidate.market.slug} ${candidate.side}`,
      });
      continue;
    }

    // Check category exposure
    const category = candidate.market.category || "uncategorized";
    const currentCatExposure = categoryExposure[category] || 0;
    if (currentCatExposure >= config.maxPerCategory) {
      skipped.push({
        candidateId: candidate.id,
        reason: `Category ${category} at max exposure`,
      });
      continue;
    }

    // Calculate stake (score-weighted)
    // Higher scores get larger allocations
    const scoreMultiplier = 0.5 + (candidate.score / 100) * 0.5; // 0.5x to 1x
    const baseStake = Math.min(config.defaultStake, config.targetTotalStake / config.maxItems);

    let stake = baseStake * scoreMultiplier;

    // Cap by various limits
    stake = Math.min(stake, config.maxPerMarket);
    stake = Math.min(stake, config.targetTotalStake - totalStake);
    stake = Math.min(stake, config.maxPerCategory - currentCatExposure);

    // Skip if stake is too small (less than $5)
    if (stake < 5) {
      skipped.push({
        candidateId: candidate.id,
        reason: "Calculated stake too small",
      });
      continue;
    }

    // Get current price for limit order
    const snapshotPrice =
      candidate.side === "YES"
        ? candidate.market.yesPrice || candidate.impliedProb
        : candidate.market.noPrice || (1 - candidate.impliedProb);

    // Use implied probability as limit price (willing to pay up to this)
    const limitPrice = candidate.impliedProb;

    items.push({
      candidateId: candidate.id,
      marketId: candidate.marketId,
      marketSlug: candidate.market.slug,
      side: candidate.side,
      stake: Math.round(stake * 100) / 100, // Round to cents
      limitPrice,
      snapshotPrice: snapshotPrice || candidate.impliedProb,
      score: candidate.score,
      category,
    });

    basketMarkets.add(basketKey);
    categoryExposure[category] = currentCatExposure + stake;
    totalStake += stake;
  }

  // Calculate batch count
  const batchCount = Math.ceil(items.length / batchSize);

  return {
    items,
    totalStake: Math.round(totalStake * 100) / 100,
    batchCount,
    categoryExposure,
    skipped,
  };
}

/**
 * Default basket configuration
 */
export const DEFAULT_BASKET_CONFIG: BasketConfig = {
  maxItems: 20,
  targetTotalStake: 1000,
  minScore: 60,
  maxPerMarket: 200,
  maxPerCategory: 500,
  defaultStake: 50,
  batchSize: MAX_BATCH_SIZE,
};
