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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Trash2, Play, AlertTriangle, ShoppingCart, Plus, Minus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface BasketItem {
  id: string;
  marketId: string;
  side: "YES" | "NO";
  stake: number;
  limitPrice: number;
  snapshotPrice: number;
  status: string;
  market: {
    slug: string;
    question: string;
    category: string | null;
  };
}

interface Basket {
  id: string;
  status: string;
  totalStake: number;
  itemCount: number;
  batchCount: number;
  items: BasketItem[];
  createdAt: string;
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

export default function BasketPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Fetch current basket
  const { data: basket, isLoading } = useQuery<Basket | null>({
    queryKey: ["basket"],
    queryFn: async () => {
      const res = await fetch("/api/basket");
      if (!res.ok) throw new Error("Failed to fetch basket");
      const data = await res.json();
      return data.basket;
    },
  });

  // Remove item mutation
  const removeItemMutation = useMutation({
    mutationFn: async (itemId: string) => {
      const res = await fetch(`/api/basket/items/${itemId}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to remove item");
      return data;
    },
    onSuccess: () => {
      toast({ title: "Item removed" });
      queryClient.invalidateQueries({ queryKey: ["basket"] });
    },
    onError: (error) => {
      toast({
        title: "Failed to remove",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Execute basket mutation
  const executeMutation = useMutation({
    mutationFn: async (dryRun: boolean) => {
      const res = await fetch("/api/basket/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ basketId: basket?.id, dryRun }),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Failed to execute basket");
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: data.dryRun ? "Dry run completed" : "Basket executed",
        description: `${data.ordersPlaced} orders ${data.dryRun ? "simulated" : "placed"}`,
      });
      queryClient.invalidateQueries({ queryKey: ["basket"] });
      queryClient.invalidateQueries({ queryKey: ["portfolio"] });
    },
    onError: (error) => {
      toast({
        title: "Execution failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Clear basket mutation
  const clearMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/basket/${basket?.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to clear basket");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Basket cleared" });
      queryClient.invalidateQueries({ queryKey: ["basket"] });
    },
  });

  // Bulk adjust all items mutation
  const bulkAdjustMutation = useMutation({
    mutationFn: async (sizeDelta: number) => {
      const res = await fetch("/api/basket/items", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sizeDelta }),
      });
      if (!res.ok) throw new Error("Failed to adjust");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["basket"] });
    },
  });

  // Individual item adjust mutation
  const adjustItemMutation = useMutation({
    mutationFn: async ({ itemId, size }: { itemId: string; size: number }) => {
      const res = await fetch(`/api/basket/items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ size }),
      });
      if (!res.ok) throw new Error("Failed to adjust item");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["basket"] });
    },
  });

  // Helper to calculate size from stake/price, rounded to nearest 50
  const getSize = (item: BasketItem) => Math.round(item.stake / item.snapshotPrice / 50) * 50;

  // Group items by category
  const items = basket?.items || [];
  const groupedItems = items.reduce((acc, item) => {
    const category = item.market.category || "uncategorized";
    if (!acc[category]) acc[category] = [];
    acc[category].push(item);
    return acc;
  }, {} as Record<string, BasketItem[]>);

  const categoryTotals = Object.entries(groupedItems).map(([category, items]) => ({
    category,
    total: items.reduce((sum, item) => sum + item.stake, 0),
    count: items.length,
  }));

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShoppingCart className="h-6 w-6" />
            Basket
          </h1>
          {basket && (
            <p className="text-sm text-zinc-500">
              {basket.itemCount ?? 0} items | {items.reduce((sum, i) => sum + getSize(i), 0)} shares | $
              {(basket.totalStake ?? 0).toFixed(2)} total
            </p>
          )}
        </div>
        {basket && items.length > 0 && (
          <div className="flex items-center gap-2">
            {/* Bulk adjust controls */}
            <div className="flex items-center gap-1 border rounded-md px-2 py-1">
              <span className="text-xs text-zinc-500 mr-1">All:</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => bulkAdjustMutation.mutate(-50)}
                disabled={bulkAdjustMutation.isPending}
              >
                <Minus className="h-4 w-4" />
              </Button>
              <span className="text-xs font-mono w-8 text-center">±50</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => bulkAdjustMutation.mutate(50)}
                disabled={bulkAdjustMutation.isPending}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm">
                  <Trash2 className="h-4 w-4 mr-1" />
                  Clear
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Clear basket?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will remove all {basket.itemCount} items from your basket.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => clearMutation.mutate()}>
                    Clear
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" className="bg-green-600 hover:bg-green-700">
                  <Play className="h-4 w-4 mr-1" />
                  Execute
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="flex items-center gap-2">
                    <AlertTriangle className="h-5 w-5 text-yellow-500" />
                    Confirm Execution
                  </AlertDialogTitle>
                  <AlertDialogDescription asChild>
                    <div className="space-y-3">
                      <p>
                        This will place {basket.itemCount} orders totaling $
                        {basket.totalStake.toFixed(2)}.
                      </p>
                      <p className="text-sm text-zinc-500">
                        Strategy: <span className="font-mono">GTC + postOnly</span> (maker orders at bid)
                      </p>
                    </div>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter className="flex-col sm:flex-row gap-2">
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => executeMutation.mutate(true)}
                    className="bg-zinc-600 hover:bg-zinc-700"
                  >
                    Dry Run
                  </AlertDialogAction>
                  <AlertDialogAction
                    onClick={() => executeMutation.mutate(false)}
                    className="bg-green-600 hover:bg-green-700"
                  >
                    Execute LIVE
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}
      </div>

      {/* Category Summary */}
      {categoryTotals.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {categoryTotals.map(({ category, total, count }) => (
            <div
              key={category}
              className="p-3 bg-zinc-100 dark:bg-zinc-900 rounded-lg"
            >
              <div className="text-xs text-zinc-500 uppercase">{category}</div>
              <div className="text-lg font-bold">${total.toFixed(0)}</div>
              <div className="text-xs text-zinc-500">{count} items</div>
            </div>
          ))}
        </div>
      )}

      {/* Table */}
      <div className="border rounded-lg overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-zinc-50 dark:bg-zinc-900">
              <TableHead className="w-[280px]">Market</TableHead>
              <TableHead>Side</TableHead>
              <TableHead className="text-center">Size</TableHead>
              <TableHead className="text-right">Stake</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Status</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={8}>
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : !basket || items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-12 text-zinc-500">
                  <ShoppingCart className="h-12 w-12 mx-auto mb-2 opacity-20" />
                  <p>Basket is empty</p>
                  <p className="text-sm">Add candidates from the Candidates tab</p>
                </TableCell>
              </TableRow>
            ) : (
              items.map((item) => {
                const size = getSize(item);
                return (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">
                      <span className="line-clamp-2" title={item.market.question}>
                        {item.market.question}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={item.side === "YES" ? "default" : "secondary"}>
                        {item.side}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => adjustItemMutation.mutate({ itemId: item.id, size: Math.max(0, size - 50) })}
                          disabled={adjustItemMutation.isPending || size <= 0}
                        >
                          <Minus className="h-3 w-3" />
                        </Button>
                        <span className="font-mono font-bold w-12 text-center">{size}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => adjustItemMutation.mutate({ itemId: item.id, size: size + 50 })}
                          disabled={adjustItemMutation.isPending}
                        >
                          <Plus className="h-3 w-3" />
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-zinc-500">
                      ${item.stake.toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-zinc-500">
                      ${item.snapshotPrice.toFixed(2)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={`text-xs ${categoryColors[item.market.category || "Other"] || categoryColors.Other}`}
                      >
                        {item.market.category || "—"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          item.status === "pending"
                            ? "outline"
                            : item.status === "filled"
                            ? "default"
                            : "destructive"
                        }
                      >
                        {item.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeItemMutation.mutate(item.id)}
                        disabled={removeItemMutation.isPending}
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
