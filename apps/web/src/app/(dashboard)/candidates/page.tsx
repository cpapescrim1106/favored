"use client";

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
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, RefreshCw, Filter, Check } from "lucide-react";
import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { useToast } from "@/hooks/use-toast";

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

interface Candidate {
  id: string;
  marketId: string;
  side: "YES" | "NO";
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

export default function CandidatesPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [minScore, setMinScore] = useState(60);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");

  // Fetch candidates
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["candidates", minScore],
    queryFn: async () => {
      const res = await fetch(`/api/candidates?minScore=${minScore}&limit=100`);
      if (!res.ok) throw new Error("Failed to fetch candidates");
      return res.json();
    },
    refetchInterval: 60000, // Refresh every minute
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
      // Refetch candidates after a delay
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

  // Get unique categories
  const categories = [
    "all",
    ...new Set(candidates.map((c) => c.market.category || "uncategorized")),
  ];

  // Filter by category
  const filtered =
    categoryFilter === "all"
      ? candidates
      : candidates.filter((c) => (c.market.category || "uncategorized") === categoryFilter);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Candidates</h1>
          {lastScan && (
            <p className="text-sm text-zinc-500">
              Last scan: {formatDistanceToNow(new Date(lastScan), { addSuffix: true })}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
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

      {/* Filters */}
      <div className="flex items-center gap-4 p-3 bg-zinc-100 dark:bg-zinc-900 rounded-lg">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-zinc-500" />
          <span className="text-sm font-medium">Filters:</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-zinc-500">Min Score:</span>
          <Input
            type="number"
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value))}
            className="w-20 h-8"
            min={0}
            max={100}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-zinc-500">Category:</span>
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-40 h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {categories.map((cat) => (
                <SelectItem key={cat} value={cat}>
                  {cat === "all" ? "All Categories" : cat}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="ml-auto text-sm text-zinc-500">
          {filtered.length} candidates
        </div>
      </div>

      {/* Table */}
      <div className="border rounded-lg overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-zinc-50 dark:bg-zinc-900">
              <TableHead className="w-[300px]">Market</TableHead>
              <TableHead>Side</TableHead>
              <TableHead className="text-right">Prob</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">Spread</TableHead>
              <TableHead className="text-right">Liquidity</TableHead>
              <TableHead className="text-right">Score</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Closes</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              // Loading skeleton
              Array.from({ length: 10 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell>
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-12" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-12" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-12" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-12" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-16" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-12" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-20" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-16" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-8 w-8" />
                  </TableCell>
                </TableRow>
              ))
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="text-center py-8 text-zinc-500">
                  No candidates found. Try running a scan.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((candidate) => (
                <TableRow key={candidate.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50">
                  <TableCell className="font-medium">
                    <a
                      href={`https://polymarket.com/event/${candidate.market.slug}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline line-clamp-2"
                      title={candidate.market.question}
                    >
                      {candidate.market.question}
                    </a>
                  </TableCell>
                  <TableCell>
                    <Badge variant={candidate.side === "YES" ? "default" : "secondary"}>
                      {candidate.side}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {(candidate.impliedProb * 100).toFixed(1)}%
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    ${(
                      (candidate.side === "YES"
                        ? candidate.market.yesPrice
                        : candidate.market.noPrice) || 0
                    ).toFixed(2)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {((candidate.market.spread || 0) * 100).toFixed(1)}%
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    ${((candidate.market.liquidity || 0) / 1000).toFixed(1)}k
                  </TableCell>
                  <TableCell className="text-right">
                    <span
                      className={`font-bold ${
                        candidate.score >= 80
                          ? "text-green-600"
                          : candidate.score >= 60
                          ? "text-yellow-600"
                          : "text-zinc-500"
                      }`}
                    >
                      {candidate.score}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={`text-xs ${categoryColors[candidate.market.category || "Other"] || categoryColors.Other}`}
                    >
                      {candidate.market.category || "—"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right text-sm text-zinc-500">
                    {candidate.market.endDate
                      ? formatDistanceToNow(new Date(candidate.market.endDate), {
                          addSuffix: true,
                        })
                      : "—"}
                  </TableCell>
                  <TableCell>
                    {basketItemKeys.has(`${candidate.marketId}:${candidate.side}`) ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled
                        title="Already in basket"
                        className="text-green-600"
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
