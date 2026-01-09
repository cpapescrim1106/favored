"use client";

import { Suspense } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, RefreshCw, Check, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { formatDistanceToNow } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/utils/shadcn";
import { useCandidateFilters, type SortColumn } from "./use-candidates-filters";
import { SortableHeader, FilterableHeader, PlainHeader } from "./sortable-header";
import { ColumnFilter, isFilterActive } from "./column-filter";
import { filterAndSortCandidates, type Candidate } from "./filter-candidates";
import { columns, getColumn, CELL_PADDING, GROUP_BORDER } from "./columns-config";

interface BasketItem {
  marketId: string;
  side: string;
}

// Subtle category colors
const categoryColors: Record<string, string> = {
  Politics: "bg-purple-100 text-purple-700 border-purple-200",
  Sports: "bg-green-100 text-green-700 border-green-200",
  Crypto: "bg-orange-100 text-orange-700 border-orange-200",
  Finance: "bg-blue-100 text-blue-700 border-blue-200",
  Tech: "bg-cyan-100 text-cyan-700 border-cyan-200",
  Entertainment: "bg-pink-100 text-pink-700 border-pink-200",
  Science: "bg-teal-100 text-teal-700 border-teal-200",
  World: "bg-red-100 text-red-700 border-red-200",
  Other: "bg-zinc-100 text-zinc-600 border-zinc-200",
};

function CandidatesPageContent() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { filters, setFilters } = useCandidateFilters();

  // Fetch candidates (only minScore goes to API)
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["candidates", filters.minScore],
    queryFn: async () => {
      const res = await fetch(`/api/candidates?minScore=${filters.minScore}&limit=1000`);
      if (!res.ok) throw new Error("Failed to fetch candidates");
      return res.json();
    },
    refetchInterval: 60000,
  });

  // Fetch basket to know which items are already added
  const { data: basketData } = useQuery({
    queryKey: ["basket"],
    queryFn: async () => {
      const res = await fetch("/api/basket");
      if (!res.ok) return { items: [] };
      return res.json();
    },
  });

  // Set of items already in basket (marketId:side)
  const basketItemKeys = new Set(
    (basketData?.basket?.items || []).map((item: BasketItem) => `${item.marketId}:${item.side}`)
  );

  // Trigger scan mutation
  const scanMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/scan", { method: "POST" });
      if (!res.ok) throw new Error("Failed to trigger scan");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Scan triggered", description: "Scan job started" });
      setTimeout(() => refetch(), 3000);
    },
    onError: (error) => {
      toast({
        title: "Scan failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Add to basket mutation
  const addToBasketMutation = useMutation({
    mutationFn: async (candidateId: string) => {
      const res = await fetch("/api/basket/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to add to basket");
      return data;
    },
    onSuccess: () => {
      toast({ title: "Added to basket" });
      queryClient.invalidateQueries({ queryKey: ["basket"] });
    },
    onError: (error) => {
      toast({
        title: "Failed to add",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const candidates: Candidate[] = data?.candidates || [];
  const lastScan = data?.lastScan;

  // Get unique categories for multi-select
  const categoriesList = [...new Set(candidates.map((c) => c.market.category || "uncategorized"))];

  // Apply client-side filters and sorting
  const filtered = filterAndSortCandidates(candidates, filters);

  // Handle sort column click (cycle: desc -> asc -> none)
  const handleSort = (column: SortColumn) => {
    if (filters.sortBy !== column) {
      setFilters({ sortBy: column, sortDir: "desc" });
    } else if (filters.sortDir === "desc") {
      setFilters({ sortDir: "asc" });
    } else {
      setFilters({ sortBy: null, sortDir: null });
    }
  };

  // Column configs for easy access
  const col = {
    market: getColumn("market")!,
    side: getColumn("side")!,
    prob: getColumn("prob")!,
    price: getColumn("price")!,
    spread: getColumn("spread")!,
    liquidity: getColumn("liquidity")!,
    score: getColumn("score")!,
    category: getColumn("category")!,
    closes: getColumn("closes")!,
    actions: getColumn("actions")!,
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Candidates</h1>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            {lastScan && (
              <span>Last scan: {formatDistanceToNow(new Date(lastScan), { addSuffix: true })}</span>
            )}
            <span className="font-medium">{filtered.length} candidates</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Search bar */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search markets..."
              value={filters.search}
              onChange={(e) => setFilters({ search: e.target.value })}
              className="pl-8 h-9 w-64"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => scanMutation.mutate()}
            disabled={scanMutation.isPending}
          >
            <RefreshCw
              className={`h-4 w-4 mr-1 ${scanMutation.isPending ? "animate-spin" : ""}`}
            />
            Scan Now
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="border rounded-lg overflow-hidden">
        <Table className="w-full">
          <TableHeader>
            <TableRow className="bg-muted/50">
              {/* Market */}
              <FilterableHeader
                label={col.market.label}
                width={col.market.width}
                align={col.market.alignHead}
                filterContent={
                  <ColumnFilter
                    column="market"
                    filters={filters}
                    onFiltersChange={setFilters}
                  />
                }
                isFilterActive={isFilterActive("market", filters)}
              />
              {/* Side */}
              <FilterableHeader
                label={col.side.label}
                width={col.side.width}
                align={col.side.alignHead}
                filterContent={
                  <ColumnFilter
                    column="side"
                    filters={filters}
                    onFiltersChange={setFilters}
                  />
                }
                isFilterActive={isFilterActive("side", filters)}
              />
              {/* Prob */}
              <SortableHeader
                column="prob"
                label={col.prob.label}
                currentSort={filters.sortBy}
                currentDir={filters.sortDir}
                onSort={handleSort}
                width={col.prob.width}
                align={col.prob.alignHead}
                groupStart={col.prob.groupStart}
                filterContent={
                  <ColumnFilter
                    column="prob"
                    filters={filters}
                    onFiltersChange={setFilters}
                  />
                }
                isFilterActive={isFilterActive("prob", filters)}
              />
              {/* Price */}
              <SortableHeader
                column="price"
                label={col.price.label}
                currentSort={filters.sortBy}
                currentDir={filters.sortDir}
                onSort={handleSort}
                width={col.price.width}
                align={col.price.alignHead}
                filterContent={
                  <ColumnFilter
                    column="price"
                    filters={filters}
                    onFiltersChange={setFilters}
                  />
                }
                isFilterActive={isFilterActive("price", filters)}
              />
              {/* Spread */}
              <SortableHeader
                column="spread"
                label={col.spread.label}
                currentSort={filters.sortBy}
                currentDir={filters.sortDir}
                onSort={handleSort}
                width={col.spread.width}
                align={col.spread.alignHead}
                filterContent={
                  <ColumnFilter
                    column="spread"
                    filters={filters}
                    onFiltersChange={setFilters}
                  />
                }
                isFilterActive={isFilterActive("spread", filters)}
              />
              {/* Liquidity */}
              <SortableHeader
                column="liquidity"
                label={col.liquidity.label}
                currentSort={filters.sortBy}
                currentDir={filters.sortDir}
                onSort={handleSort}
                width={col.liquidity.width}
                align={col.liquidity.alignHead}
                filterContent={
                  <ColumnFilter
                    column="liquidity"
                    filters={filters}
                    onFiltersChange={setFilters}
                  />
                }
                isFilterActive={isFilterActive("liquidity", filters)}
              />
              {/* Score */}
              <SortableHeader
                column="score"
                label={col.score.label}
                currentSort={filters.sortBy}
                currentDir={filters.sortDir}
                onSort={handleSort}
                width={col.score.width}
                align={col.score.alignHead}
                filterContent={
                  <ColumnFilter
                    column="score"
                    filters={filters}
                    onFiltersChange={setFilters}
                  />
                }
                isFilterActive={isFilterActive("score", filters)}
              />
              {/* Category */}
              <FilterableHeader
                label={col.category.label}
                width={col.category.width}
                align={col.category.alignHead}
                groupStart={col.category.groupStart}
                filterContent={
                  <ColumnFilter
                    column="category"
                    filters={filters}
                    onFiltersChange={setFilters}
                    categories={categoriesList}
                  />
                }
                isFilterActive={isFilterActive("category", filters)}
              />
              {/* Closes */}
              <SortableHeader
                column="closes"
                label={col.closes.label}
                currentSort={filters.sortBy}
                currentDir={filters.sortDir}
                onSort={handleSort}
                width={col.closes.width}
                align={col.closes.alignHead}
                filterContent={
                  <ColumnFilter
                    column="closes"
                    filters={filters}
                    onFiltersChange={setFilters}
                  />
                }
                isFilterActive={isFilterActive("closes", filters)}
              />
              {/* Actions */}
              <PlainHeader
                label={col.actions.label}
                width={col.actions.width}
                align={col.actions.alignHead}
              />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 10 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell className={cn(col.market.width, CELL_PADDING)}>
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                  <TableCell className={cn(col.side.width, col.side.alignCell, CELL_PADDING)}>
                    <Skeleton className="h-5 w-12 mx-auto" />
                  </TableCell>
                  <TableCell className={cn(col.prob.width, col.prob.alignCell, CELL_PADDING, GROUP_BORDER)}>
                    <Skeleton className="h-4 w-12 ml-auto" />
                  </TableCell>
                  <TableCell className={cn(col.price.width, col.price.alignCell, CELL_PADDING)}>
                    <Skeleton className="h-4 w-12 ml-auto" />
                  </TableCell>
                  <TableCell className={cn(col.spread.width, col.spread.alignCell, CELL_PADDING)}>
                    <Skeleton className="h-4 w-12 ml-auto" />
                  </TableCell>
                  <TableCell className={cn(col.liquidity.width, col.liquidity.alignCell, CELL_PADDING)}>
                    <Skeleton className="h-4 w-16 ml-auto" />
                  </TableCell>
                  <TableCell className={cn(col.score.width, col.score.alignCell, CELL_PADDING)}>
                    <Skeleton className="h-4 w-8 ml-auto" />
                  </TableCell>
                  <TableCell className={cn(col.category.width, col.category.alignCell, CELL_PADDING, GROUP_BORDER)}>
                    <Skeleton className="h-5 w-16" />
                  </TableCell>
                  <TableCell className={cn(col.closes.width, col.closes.alignCell, CELL_PADDING)}>
                    <Skeleton className="h-4 w-20" />
                  </TableCell>
                  <TableCell className={cn(col.actions.width, col.actions.alignCell, CELL_PADDING)}>
                    <Skeleton className="h-8 w-8 mx-auto" />
                  </TableCell>
                </TableRow>
              ))
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="text-center py-8 text-muted-foreground">
                  No candidates found. Try adjusting filters or running a scan.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((candidate) => (
                <TableRow key={candidate.id} className="hover:bg-muted/50">
                  {/* Market */}
                  <TableCell className={cn(col.market.width, col.market.alignCell, CELL_PADDING)}>
                    <a
                      href={`https://polymarket.com/event/${candidate.market.slug}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline truncate block font-medium"
                      title={candidate.market.question}
                    >
                      {candidate.market.question}
                    </a>
                  </TableCell>
                  {/* Side */}
                  <TableCell className={cn(col.side.width, col.side.alignCell, CELL_PADDING)}>
                    <Badge variant={candidate.side === "YES" ? "default" : "secondary"}>
                      {candidate.outcomeName}
                    </Badge>
                  </TableCell>
                  {/* Prob */}
                  <TableCell className={cn(col.prob.width, col.prob.alignCell, CELL_PADDING, GROUP_BORDER)}>
                    {(candidate.impliedProb * 100).toFixed(1)}
                  </TableCell>
                  {/* Price */}
                  <TableCell className={cn(col.price.width, col.price.alignCell, CELL_PADDING)}>
                    {(
                      (candidate.side === "YES"
                        ? candidate.market.yesPrice
                        : candidate.market.noPrice) || 0
                    ).toFixed(2)}
                  </TableCell>
                  {/* Spread (±half spread since mid price is shown) */}
                  <TableCell className={cn(col.spread.width, col.spread.alignCell, CELL_PADDING)}>
                    {(() => {
                      const spread = candidate.market.spread || 0;
                      const halfSpread = (spread / 2) * 100; // in cents
                      return `±${halfSpread.toFixed(1)}`;
                    })()}
                  </TableCell>
                  {/* Liquidity */}
                  <TableCell className={cn(col.liquidity.width, col.liquidity.alignCell, CELL_PADDING)}>
                    {((candidate.market.liquidity || 0) / 1000).toFixed(1)}k
                  </TableCell>
                  {/* Score */}
                  <TableCell className={cn(col.score.width, col.score.alignCell, CELL_PADDING)}>
                    <span
                      className={cn(
                        "font-bold",
                        candidate.score >= 80
                          ? "text-green-600"
                          : candidate.score >= 60
                            ? "text-yellow-600"
                            : "text-muted-foreground"
                      )}
                    >
                      {candidate.score}
                    </span>
                  </TableCell>
                  {/* Category */}
                  <TableCell className={cn(col.category.width, col.category.alignCell, CELL_PADDING, GROUP_BORDER)}>
                    <Badge
                      variant="outline"
                      className={`text-xs ${categoryColors[candidate.market.category || "Other"] || categoryColors.Other}`}
                    >
                      {candidate.market.category || "—"}
                    </Badge>
                  </TableCell>
                  {/* Closes */}
                  <TableCell className={cn(col.closes.width, col.closes.alignCell, CELL_PADDING, "text-sm text-muted-foreground")}>
                    {candidate.market.endDate
                      ? formatDistanceToNow(new Date(candidate.market.endDate), {
                          addSuffix: true,
                        })
                      : "—"}
                  </TableCell>
                  {/* Actions */}
                  <TableCell className={cn(col.actions.width, col.actions.alignCell, CELL_PADDING)}>
                    {basketItemKeys.has(`${candidate.marketId}:${candidate.side}`) ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled
                        title="Already in basket"
                        className="text-green-600 h-8 w-8"
                      >
                        <Check className="h-4 w-4" />
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => addToBasketMutation.mutate(candidate.id)}
                        disabled={addToBasketMutation.isPending}
                        title="Add to basket"
                        className="h-8 w-8"
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Refresh indicator */}
      {isFetching && !isLoading && (
        <div className="fixed bottom-4 right-4 bg-zinc-900 text-white px-3 py-2 rounded-lg text-sm flex items-center gap-2">
          <RefreshCw className="h-4 w-4 animate-spin" />
          Refreshing...
        </div>
      )}
    </div>
  );
}

export default function CandidatesPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-96 w-full" />
        </div>
      }
    >
      <CandidatesPageContent />
    </Suspense>
  );
}
