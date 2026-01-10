"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PieChart, TrendingUp, TrendingDown } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

// Subtle category colors
const categoryColors: Record<string, string> = {
  Politics: "bg-red-50 text-red-700 border border-red-200",
  Sports: "bg-blue-50 text-blue-700 border border-blue-200",
  Crypto: "bg-orange-50 text-orange-700 border border-orange-200",
  Finance: "bg-emerald-50 text-emerald-700 border border-emerald-200",
  Tech: "bg-purple-50 text-purple-700 border border-purple-200",
  Entertainment: "bg-pink-50 text-pink-700 border border-pink-200",
  Science: "bg-cyan-50 text-cyan-700 border border-cyan-200",
  World: "bg-amber-50 text-amber-700 border border-amber-200",
  Other: "bg-zinc-50 text-zinc-700 border border-zinc-200",
  uncategorized: "bg-zinc-50 text-zinc-700 border border-zinc-200",
};

interface Position {
  id: string;
  marketId: string;
  side: "YES" | "NO";
  size: number;
  avgEntry: number;
  totalCost: number;
  markPrice: number | null;
  unrealizedPnl: number | null;
  takeProfitPrice: number | null;
  status: string;
  openedAt: string | null;
  market: {
    slug: string;
    eventSlug: string | null;
    question: string;
    category: string | null;
    endDate: string | null;
    active: boolean;
  };
}

export default function PortfolioPage() {
  // Fetch portfolio data (includes positions and cash balance)
  const { data, isLoading } = useQuery({
    queryKey: ["portfolio"],
    queryFn: async () => {
      const res = await fetch("/api/portfolio");
      if (!res.ok) throw new Error("Failed to fetch portfolio");
      return res.json();
    },
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  const positions: Position[] = data?.positions || [];
  const summary = data?.summary || {
    totalValue: 0,
    totalCost: 0,
    unrealizedPnl: 0,
    openCount: 0,
  };
  const closedSummary = data?.closedSummary || {
    totalInvested: 0,
    totalReturned: 0,
    realizedPnl: 0,
    winRate: 0,
    closedCount: 0,
  };

  // Cash balance (USDC in wallet) - now included in portfolio response
  const cashBalance = data?.cashBalance ?? 0;

  // Combined metrics
  const totalPnl = summary.unrealizedPnl + closedSummary.realizedPnl;
  const totalCapital = summary.totalCost + closedSummary.totalInvested;
  const totalReturnPct = totalCapital > 0 ? (totalPnl / totalCapital) * 100 : 0;
  const totalPortfolioValue = cashBalance + summary.totalValue;

  // Group by status
  const openPositions = positions.filter((p) => p.status === "OPEN");
  const closedPositions = positions.filter((p) => p.status !== "OPEN");

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <PieChart className="h-6 w-6" />
            Portfolio
          </h1>
          <p className="text-sm text-zinc-500">
            {summary.openCount} open · {closedSummary.closedCount} closed
          </p>
        </div>
      </div>

      {/* Overall Metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        <div className="p-4 bg-zinc-100 dark:bg-zinc-900 rounded-lg">
          <div className="text-xs text-zinc-500 uppercase">Portfolio Value</div>
          <div className="text-2xl font-bold">
            ${totalPortfolioValue.toFixed(2)}
          </div>
        </div>
        <div className="p-4 bg-zinc-100 dark:bg-zinc-900 rounded-lg">
          <div className="text-xs text-zinc-500 uppercase">Cash</div>
          <div className="text-2xl font-bold">
            ${cashBalance.toFixed(2)}
          </div>
        </div>
        <div className="p-4 bg-zinc-100 dark:bg-zinc-900 rounded-lg">
          <div className="text-xs text-zinc-500 uppercase">Total P&L</div>
          <div
            className={`text-2xl font-bold flex items-center gap-1 ${
              totalPnl >= 0 ? "text-green-600" : "text-red-600"
            }`}
          >
            {totalPnl >= 0 ? (
              <TrendingUp className="h-5 w-5" />
            ) : (
              <TrendingDown className="h-5 w-5" />
            )}
            ${Math.abs(totalPnl).toFixed(2)}
          </div>
        </div>
        <div className="p-4 bg-zinc-100 dark:bg-zinc-900 rounded-lg">
          <div className="text-xs text-zinc-500 uppercase">Total Return</div>
          <div
            className={`text-2xl font-bold ${
              totalReturnPct >= 0 ? "text-green-600" : "text-red-600"
            }`}
          >
            {totalCapital > 0
              ? `${totalReturnPct >= 0 ? "+" : ""}${totalReturnPct.toFixed(1)}%`
              : "—"}
          </div>
        </div>
        <div className="p-4 bg-zinc-100 dark:bg-zinc-900 rounded-lg">
          <div className="text-xs text-zinc-500 uppercase">Open P&L</div>
          <div
            className={`text-2xl font-bold flex items-center gap-1 ${
              summary.unrealizedPnl >= 0 ? "text-green-600" : "text-red-600"
            }`}
          >
            {summary.unrealizedPnl >= 0 ? (
              <TrendingUp className="h-5 w-5" />
            ) : (
              <TrendingDown className="h-5 w-5" />
            )}
            ${Math.abs(summary.unrealizedPnl).toFixed(2)}
          </div>
        </div>
        <div className="p-4 bg-zinc-100 dark:bg-zinc-900 rounded-lg">
          <div className="text-xs text-zinc-500 uppercase">Win Rate</div>
          <div
            className={`text-2xl font-bold ${
              closedSummary.winRate >= 50 ? "text-green-600" : "text-red-600"
            }`}
          >
            {closedSummary.closedCount > 0
              ? `${closedSummary.winRate.toFixed(1)}%`
              : "—"}
          </div>
        </div>
      </div>

      <Tabs defaultValue="open">
        <TabsList>
          <TabsTrigger value="open">Open ({openPositions.length})</TabsTrigger>
          <TabsTrigger value="closed">Closed ({closedPositions.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="open" className="mt-4">
          <div className="space-y-4">
            <div className="flex items-center gap-4 text-sm text-zinc-500">
              <span>Cost: <span className="font-medium text-foreground">${summary.totalCost.toFixed(2)}</span></span>
              <span>Value: <span className="font-medium text-foreground">${summary.totalValue.toFixed(2)}</span></span>
            </div>
            <div className="border rounded-lg overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-zinc-50 dark:bg-zinc-900">
                    <TableHead className="w-[280px]">Market</TableHead>
                    <TableHead>Side</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead className="text-right">Avg Entry</TableHead>
                    <TableHead className="text-right">Mark</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead className="text-right">P&L</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right">Closes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    Array.from({ length: 5 }).map((_, i) => (
                      <TableRow key={i}>
                        <TableCell colSpan={9}>
                          <Skeleton className="h-4 w-full" />
                        </TableCell>
                      </TableRow>
                    ))
                  ) : openPositions.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={9}
                        className="text-center py-12 text-zinc-500"
                      >
                        <PieChart className="h-12 w-12 mx-auto mb-2 opacity-20" />
                        <p>No open positions</p>
                        <p className="text-sm">Execute a basket to open positions</p>
                      </TableCell>
                    </TableRow>
                  ) : (
                    openPositions.map((position) => {
                      const pnl = position.unrealizedPnl || 0;
                      const pnlPercent =
                        position.totalCost > 0
                          ? (pnl / position.totalCost) * 100
                          : 0;

                      return (
                        <TableRow key={position.id}>
                          <TableCell className="font-medium">
                            <a
                              href={`https://polymarket.com/event/${position.market.eventSlug || position.market.slug}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:underline line-clamp-2"
                              title={position.market.question}
                            >
                              {position.market.question}
                            </a>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={position.side === "YES" ? "default" : "secondary"}
                            >
                              {position.side}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {position.size.toFixed(2)}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            ${position.avgEntry.toFixed(2)}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            ${(position.markPrice || 0).toFixed(2)}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            ${position.totalCost.toFixed(2)}
                          </TableCell>
                          <TableCell
                            className={`text-right font-mono font-bold ${
                              pnl >= 0 ? "text-green-600" : "text-red-600"
                            }`}
                          >
                            ${pnl.toFixed(2)} ({pnlPercent >= 0 ? "+" : ""}
                            {pnlPercent.toFixed(1)}%)
                          </TableCell>
                        <TableCell>
                          <span
                            className={`text-xs px-2 py-0.5 rounded ${categoryColors[position.market.category || "Other"] || categoryColors.Other}`}
                          >
                            {position.market.category || "—"}
                          </span>
                        </TableCell>
                          <TableCell className="text-right text-sm text-zinc-500">
                            {position.market.endDate
                              ? formatDistanceToNow(new Date(position.market.endDate), {
                                  addSuffix: true,
                                })
                              : "—"}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        </TabsContent>
        <TabsContent value="closed" className="mt-4">
          <div className="space-y-4">
            <div className="flex items-center gap-4 text-sm text-zinc-500">
              <span>Invested: <span className="font-medium text-foreground">${closedSummary.totalInvested.toFixed(2)}</span></span>
              <span>Returned: <span className="font-medium text-foreground">${closedSummary.totalReturned.toFixed(2)}</span></span>
              <span>Realized P&L: <span className={`font-medium ${closedSummary.realizedPnl >= 0 ? "text-green-600" : "text-red-600"}`}>${closedSummary.realizedPnl.toFixed(2)}</span></span>
            </div>
            <div className="border rounded-lg overflow-hidden">
              <Table>
                <TableHeader>
                <TableRow className="bg-zinc-50 dark:bg-zinc-900">
                  <TableHead className="w-[280px]">Market</TableHead>
                  <TableHead>Side</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="text-right">Entry</TableHead>
                  <TableHead className="text-right">Exit</TableHead>
                  <TableHead className="text-right">P&L</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Opened</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={9}>
                        <Skeleton className="h-4 w-full" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : closedPositions.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center py-10 text-zinc-500">
                      <p>No closed positions yet</p>
                    </TableCell>
                  </TableRow>
                ) : (
                  closedPositions.map((position) => (
                    <TableRow key={position.id} className="opacity-60">
                        <TableCell className="font-medium">
                          {position.market.question}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={position.side === "YES" ? "default" : "secondary"}
                          >
                            {position.side}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{position.status}</Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {position.size.toFixed(2)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          ${position.avgEntry.toFixed(2)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          ${(position.markPrice || 0).toFixed(2)}
                        </TableCell>
                      <TableCell className="text-right font-mono">
                        ${(position.unrealizedPnl || 0).toFixed(2)}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`text-xs px-2 py-0.5 rounded ${categoryColors[position.market.category || "Other"] || categoryColors.Other}`}
                        >
                          {position.market.category || "—"}
                        </span>
                      </TableCell>
                      <TableCell className="text-right text-sm text-zinc-500">
                        {position.openedAt
                          ? formatDistanceToNow(new Date(position.openedAt), {
                              addSuffix: true,
                            })
                          : "—"}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
