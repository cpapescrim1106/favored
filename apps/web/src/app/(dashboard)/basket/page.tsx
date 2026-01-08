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
import { Trash2, Play, AlertTriangle, ShoppingCart } from "lucide-react";
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
              {basket.itemCount ?? 0} items | {basket.batchCount ?? 0} batches | $
              {(basket.totalStake ?? 0).toFixed(2)} total
            </p>
          )}
        </div>
        {basket && items.length > 0 && (
          <div className="flex items-center gap-2">
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
                  <AlertDialogDescription className="space-y-2">
                    <p>
                      This will place {basket.itemCount} orders totaling $
                      {basket.totalStake.toFixed(2)}.
                    </p>
                    <p className="text-sm font-medium text-yellow-600">
                      MVP0 Mode: Orders will be logged but NOT actually placed.
                    </p>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => executeMutation.mutate(true)}
                    className="bg-green-600 hover:bg-green-700"
                  >
                    Execute (Dry Run)
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
              <TableHead className="w-[300px]">Market</TableHead>
              <TableHead>Side</TableHead>
              <TableHead className="text-right">Stake</TableHead>
              <TableHead className="text-right">Limit</TableHead>
              <TableHead className="text-right">Snapshot</TableHead>
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
              items.map((item) => (
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
                  <TableCell className="text-right font-mono font-bold">
                    ${item.stake.toFixed(2)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    ${item.limitPrice.toFixed(2)}
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
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
