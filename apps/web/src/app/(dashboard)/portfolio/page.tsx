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
import { PieChart, TrendingUp, TrendingDown } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

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
  openedAt: string;
  market: {
    slug: string;
    question: string;
    category: string | null;
    endDate: string | null;
    active: boolean;
  };
}

export default function PortfolioPage() {
  // Fetch positions
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
            {summary.openCount} open positions
          </p>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="p-4 bg-zinc-100 dark:bg-zinc-900 rounded-lg">
          <div className="text-xs text-zinc-500 uppercase">Total Cost</div>
          <div className="text-2xl font-bold">${summary.totalCost.toFixed(2)}</div>
        </div>
        <div className="p-4 bg-zinc-100 dark:bg-zinc-900 rounded-lg">
          <div className="text-xs text-zinc-500 uppercase">Current Value</div>
          <div className="text-2xl font-bold">${summary.totalValue.toFixed(2)}</div>
        </div>
        <div className="p-4 bg-zinc-100 dark:bg-zinc-900 rounded-lg">
          <div className="text-xs text-zinc-500 uppercase">Unrealized P&L</div>
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
          <div className="text-xs text-zinc-500 uppercase">Return</div>
          <div
            className={`text-2xl font-bold ${
              summary.unrealizedPnl >= 0 ? "text-green-600" : "text-red-600"
            }`}
          >
            {summary.totalCost > 0
              ? `${((summary.unrealizedPnl / summary.totalCost) * 100).toFixed(1)}%`
              : "—"}
          </div>
        </div>
      </div>

      {/* Open Positions Table */}
      <div>
        <h2 className="text-lg font-semibold mb-2">Open Positions</h2>
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
                  <TableCell colSpan={9} className="text-center py-12 text-zinc-500">
                    <PieChart className="h-12 w-12 mx-auto mb-2 opacity-20" />
                    <p>No open positions</p>
                    <p className="text-sm">Execute a basket to open positions</p>
                  </TableCell>
                </TableRow>
              ) : (
                openPositions.map((position) => {
                  const pnl = position.unrealizedPnl || 0;
                  const pnlPercent =
                    position.totalCost > 0 ? (pnl / position.totalCost) * 100 : 0;

                  return (
                    <TableRow key={position.id}>
                      <TableCell className="font-medium">
                        <a
                          href={`https://polymarket.com/event/${position.market.slug}`}
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
                        <Badge variant="outline" className="text-xs">
                          {position.market.category || "—"}
                        </Badge>
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

      {/* Closed Positions (if any) */}
      {closedPositions.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-2">Closed Positions</h2>
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
                  <TableHead className="text-right">Opened</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {closedPositions.map((position) => (
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
                    <TableCell className="text-right text-sm text-zinc-500">
                      {formatDistanceToNow(new Date(position.openedAt), {
                        addSuffix: true,
                      })}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
