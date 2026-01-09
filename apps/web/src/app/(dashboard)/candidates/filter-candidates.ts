import { addHours, addWeeks, addMonths, isBefore } from "date-fns";
import type { CandidateFilters, SortColumn, ClosesFilter } from "./use-candidates-filters";

export interface Candidate {
  id: string;
  marketId: string;
  side: "YES" | "NO";
  outcomeName: string; // Display name: "Rams", "Yes", "Trump", etc.
  impliedProb: number;
  score: number;
  spreadOk: boolean;
  liquidityOk: boolean;
  scannedAt: string;
  market: {
    slug: string;
    question: string;
    category: string | null;
    endDate: string | null;
    yesPrice: number | null;
    noPrice: number | null;
    liquidity: number | null;
    spread: number | null;
  };
}

function getClosesThreshold(closes: ClosesFilter): Date | null {
  const now = new Date();
  switch (closes) {
    case "24h":
      return addHours(now, 24);
    case "1w":
      return addWeeks(now, 1);
    case "2w":
      return addWeeks(now, 2);
    case "1m":
      return addMonths(now, 1);
    default:
      return null;
  }
}

function getPrice(candidate: Candidate): number {
  return (candidate.side === "YES" ? candidate.market.yesPrice : candidate.market.noPrice) || 0;
}

function getSortValue(candidate: Candidate, sortBy: SortColumn): number | Date | null {
  switch (sortBy) {
    case "prob":
      return candidate.impliedProb;
    case "price":
      return getPrice(candidate);
    case "spread":
      return candidate.market.spread ?? Infinity;
    case "liquidity":
      return candidate.market.liquidity ?? 0;
    case "score":
      return candidate.score;
    case "closes":
      return candidate.market.endDate ? new Date(candidate.market.endDate) : new Date(9999, 11, 31);
    default:
      return null;
  }
}

export function filterAndSortCandidates(
  candidates: Candidate[],
  filters: CandidateFilters
): Candidate[] {
  let result = candidates;

  // Text search
  if (filters.search) {
    const searchLower = filters.search.toLowerCase();
    result = result.filter((c) => c.market.question.toLowerCase().includes(searchLower));
  }

  // Side filter
  if (filters.side !== "all") {
    result = result.filter((c) => c.side === filters.side);
  }

  // Max spread filter (spread is stored as decimal, e.g., 0.05 = 5%)
  if (filters.maxSpread !== null) {
    result = result.filter(
      (c) => c.market.spread !== null && c.market.spread * 100 <= filters.maxSpread!
    );
  }

  // Min liquidity filter
  if (filters.minLiquidity !== null) {
    result = result.filter(
      (c) => c.market.liquidity !== null && c.market.liquidity >= filters.minLiquidity!
    );
  }

  // Prob range filter (impliedProb is stored as decimal, e.g., 0.75 = 75%)
  if (filters.minProb !== null) {
    result = result.filter((c) => c.impliedProb * 100 >= filters.minProb!);
  }
  if (filters.maxProb !== null) {
    result = result.filter((c) => c.impliedProb * 100 <= filters.maxProb!);
  }

  // Price range filter
  if (filters.minPrice !== null) {
    result = result.filter((c) => getPrice(c) >= filters.minPrice!);
  }
  if (filters.maxPrice !== null) {
    result = result.filter((c) => getPrice(c) <= filters.maxPrice!);
  }

  // Closes filter
  const closesThreshold = getClosesThreshold(filters.closes);
  if (closesThreshold) {
    result = result.filter(
      (c) => c.market.endDate !== null && isBefore(new Date(c.market.endDate), closesThreshold)
    );
  }

  // Categories filter (multi-select)
  if (filters.categories.length > 0) {
    result = result.filter((c) =>
      filters.categories.includes(c.market.category || "uncategorized")
    );
  }

  // Sorting
  if (filters.sortBy && filters.sortDir) {
    result = [...result].sort((a, b) => {
      const aVal = getSortValue(a, filters.sortBy!);
      const bVal = getSortValue(b, filters.sortBy!);

      if (aVal === null && bVal === null) return 0;
      if (aVal === null) return 1;
      if (bVal === null) return -1;

      let comparison: number;
      if (aVal instanceof Date && bVal instanceof Date) {
        comparison = aVal.getTime() - bVal.getTime();
      } else {
        comparison = (aVal as number) - (bVal as number);
      }

      return filters.sortDir === "asc" ? comparison : -comparison;
    });
  }

  return result;
}
