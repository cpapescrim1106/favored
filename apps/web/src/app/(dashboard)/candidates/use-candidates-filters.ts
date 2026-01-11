"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useCallback, useMemo } from "react";

export type SideFilter = "all" | "YES" | "NO";
export type ClosesFilter = "all" | "24h" | "1w" | "2w" | "1m";
export type SortColumn = "prob" | "price" | "spread" | "liquidity" | "score" | "closes";
export type SortDirection = "asc" | "desc";

export interface CandidateFilters {
  minScore: number;
  search: string;
  side: SideFilter;
  maxSpread: number | null;
  minLiquidity: number | null;
  minProb: number | null;
  maxProb: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  closes: ClosesFilter;
  categories: string[];
  sortBy: SortColumn | null;
  sortDir: SortDirection | null;
}

const DEFAULTS: CandidateFilters = {
  minScore: 40,
  search: "",
  side: "all",
  maxSpread: null,
  minLiquidity: null,
  minProb: null,
  maxProb: null,
  minPrice: null,
  maxPrice: null,
  closes: "all",
  categories: [],
  sortBy: "score",
  sortDir: "desc",
};

export function useCandidateFilters() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const filters = useMemo((): CandidateFilters => {
    return {
      minScore: Number(searchParams.get("minScore")) || DEFAULTS.minScore,
      search: searchParams.get("search") || "",
      side: (searchParams.get("side") as SideFilter) || "all",
      maxSpread: searchParams.get("maxSpread") ? Number(searchParams.get("maxSpread")) : null,
      minLiquidity: searchParams.get("minLiquidity") ? Number(searchParams.get("minLiquidity")) : null,
      minProb: searchParams.get("minProb") ? Number(searchParams.get("minProb")) : null,
      maxProb: searchParams.get("maxProb") ? Number(searchParams.get("maxProb")) : null,
      minPrice: searchParams.get("minPrice") ? Number(searchParams.get("minPrice")) : null,
      maxPrice: searchParams.get("maxPrice") ? Number(searchParams.get("maxPrice")) : null,
      closes: (searchParams.get("closes") as ClosesFilter) || "all",
      categories: searchParams.get("categories")?.split(",").filter(Boolean) || [],
      sortBy: (searchParams.get("sortBy") as SortColumn) || "score",
      sortDir: (searchParams.get("sortDir") as SortDirection) || "desc",
    };
  }, [searchParams]);

  const setFilters = useCallback(
    (updates: Partial<CandidateFilters>) => {
      const params = new URLSearchParams(searchParams.toString());

      Object.entries(updates).forEach(([key, value]) => {
        const defaultValue = DEFAULTS[key as keyof CandidateFilters];

        if (value === null || value === "" || value === defaultValue) {
          params.delete(key);
        } else if (Array.isArray(value)) {
          if (value.length === 0) {
            params.delete(key);
          } else {
            params.set(key, value.join(","));
          }
        } else {
          params.set(key, String(value));
        }
      });

      const queryString = params.toString();
      router.push(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
    },
    [searchParams, router, pathname]
  );

  return { filters, setFilters };
}
