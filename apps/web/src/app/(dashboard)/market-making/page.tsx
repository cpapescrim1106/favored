"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  BarChart3,
  Plus,
  Trash2,
  Pause,
  Play,
  Settings,
  TrendingUp,
  TrendingDown,
  RefreshCw,
  AlertTriangle,
  Search,
  Check,
  ChevronRight,
  Loader2,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface MarketMakerOrder {
  outcome: string;
  side: string;
  orderId: string;
  price: number;
  size: number;
}

interface MarketMaker {
  id: string;
  marketId: string;
  market: {
    slug: string;
    question: string;
    category: string | null;
    yesPrice: number | null;
    noPrice: number | null;
    endDate: string | null;
  } | null;
  active: boolean;
  paused: boolean;
  targetSpread: number;
  orderSize: number;
  maxInventory: number;
  skewFactor: number;
  quotingPolicy: string;
  yesInventory: number;
  noInventory: number;
  avgYesCost: number;
  avgNoCost: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  minTimeToResolution: number;
  volatilityPauseUntil: string | null;
  orders: MarketMakerOrder[];
  fillCount: number;
  lastQuoteAt: string | null;
  createdAt: string;
}

interface MarketMakingData {
  mmEnabled: boolean;
  summary: {
    total: number;
    active: number;
    totalOpenOrders: number;
    marketsAtRisk: number;
    totalRealizedPnl: number;
    totalUnrealizedPnl: number;
    totalPnl: number;
    totalAtRisk: number;
    cashAvailable: number | null;
  };
  marketMakers: MarketMaker[];
}

interface MMCandidate {
  marketId: string;
  slug: string;
  question: string;
  category: string | null;
  endDate: string | null;
  midPrice: number;
  spreadTicks: number;
  spreadPercent: number;
  topDepth: number;
  depth3c: number;
  bookSlope: number;
  volume24h: number;
  hoursToEnd: number | null;
  scores: {
    liquidity: number;
    flow: number;
    time: number;
    priceZone: number;
    total: number;
  };
  flags: string[];
  eligible: boolean;
  disqualifyReasons: string[];
}

interface MMCandidatesData {
  total: number;
  candidates: MMCandidate[];
}

export default function MarketMakingPage() {
  const queryClient = useQueryClient();
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editingMM, setEditingMM] = useState<MarketMaker | null>(null);
  const [selectedCandidate, setSelectedCandidate] = useState<MMCandidate | null>(null);
  const [dialogStep, setDialogStep] = useState<"select" | "configure">("select");
  const [formValues, setFormValues] = useState({
    targetSpread: 0.04,
    orderSize: 100,
    maxInventory: 500,
    skewFactor: 0.04,
    quotingPolicy: "touch",
    minTimeToResolution: 24,
  });

  // Fetch market makers
  const { data, isLoading, refetch } = useQuery<MarketMakingData>({
    queryKey: ["market-making"],
    queryFn: async () => {
      const res = await fetch("/api/market-making");
      if (!res.ok) throw new Error("Failed to fetch market makers");
      return res.json();
    },
    refetchInterval: 3000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

  // Fetch MM candidates when dialog opens
  const {
    data: candidatesData,
    isLoading: candidatesLoading,
    refetch: refetchCandidates,
  } = useQuery<MMCandidatesData>({
    queryKey: ["mm-candidates"],
    queryFn: async () => {
      const res = await fetch("/api/mm-candidates?limit=30&eligibleOnly=true");
      if (!res.ok) throw new Error("Failed to fetch candidates");
      return res.json();
    },
    enabled: addDialogOpen && dialogStep === "select",
  });

  // Toggle MM enabled
  const toggleMM = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mmEnabled: enabled }),
      });
      if (!res.ok) throw new Error("Failed to update config");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["market-making"] });
    },
  });

  // Create market maker
  const createMM = useMutation({
    mutationFn: async (data: { marketId: string } & typeof formValues) => {
      const res = await fetch("/api/market-making", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to create market maker");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["market-making"] });
      queryClient.invalidateQueries({ queryKey: ["mm-candidates"] });
      handleCloseDialog();
    },
  });

  // Update market maker
  const updateMM = useMutation({
    mutationFn: async ({
      id,
      ...data
    }: { id: string } & Partial<typeof formValues & { paused: boolean; active: boolean; volatilityPauseUntil: string | null }>) => {
      const res = await fetch(`/api/market-making/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to update market maker");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["market-making"] });
      setEditingMM(null);
    },
  });

  // Delete market maker
  const deleteMM = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/market-making/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete market maker");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["market-making"] });
      queryClient.invalidateQueries({ queryKey: ["mm-candidates"] });
    },
  });

  const handleCloseDialog = () => {
    setAddDialogOpen(false);
    setSelectedCandidate(null);
    setDialogStep("select");
  };

  const handleSelectCandidate = (candidate: MMCandidate) => {
    setSelectedCandidate(candidate);
    // Pre-fill spread: current spread + 1 tick buffer, minimum 4 ticks ($0.04)
    // Note: targetSpread is absolute (e.g., 0.02 = $0.02 = 2 ticks), not a percentage
    setFormValues({
      ...formValues,
      targetSpread: Math.max(0.04, (candidate.spreadTicks + 1) * 0.01),
    });
    setDialogStep("configure");
  };

  const summary = data?.summary || {
    total: 0,
    active: 0,
    totalOpenOrders: 0,
    marketsAtRisk: 0,
    totalRealizedPnl: 0,
    totalUnrealizedPnl: 0,
    totalPnl: 0,
    totalAtRisk: 0,
    cashAvailable: null,
  };
  const marketMakers = data?.marketMakers || [];
  const mmEnabled = data?.mmEnabled || false;
  const candidates = candidatesData?.candidates || [];
  const totalDeployed = marketMakers.reduce((sum, mm) => {
    const yesCost = mm.yesInventory * mm.avgYesCost;
    const noCost = mm.noInventory * mm.avgNoCost;
    return sum + yesCost + noCost;
  }, 0);

  // Helper to get order by outcome and side
  const getOrder = (mm: MarketMaker, outcome: string, side: string) => {
    return mm.orders.find((o) => o.outcome === outcome && o.side === side);
  };

  // Check if volatility paused
  const isVolatilityPaused = (mm: MarketMaker) => {
    if (!mm.volatilityPauseUntil) return false;
    return new Date(mm.volatilityPauseUntil) > new Date();
  };

  // Score color helper
  const getScoreColor = (score: number) => {
    if (score >= 70) return "text-green-600";
    if (score >= 50) return "text-yellow-600";
    return "text-red-600";
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BarChart3 className="h-6 w-6" />
            Market Making
          </h1>
          <p className="text-sm text-zinc-500">
            {summary.active} active of {summary.total} configured
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Label htmlFor="mm-enabled" className="text-sm">
              MM Enabled
            </Label>
            <Switch
              id="mm-enabled"
              checked={mmEnabled}
              onCheckedChange={(checked) => toggleMM.mutate(checked)}
              disabled={toggleMM.isPending}
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isLoading}
          >
            <RefreshCw className={`h-4 w-4 mr-1 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Dialog open={addDialogOpen} onOpenChange={(open) => {
            if (!open) handleCloseDialog();
            else setAddDialogOpen(true);
          }}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="h-4 w-4 mr-1" />
                Add Market
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              {dialogStep === "select" ? (
                <>
                  <DialogHeader>
                    <DialogTitle>Select Market</DialogTitle>
                    <DialogDescription>
                      Choose from scored candidates or search for a market.
                      Markets are ranked by MM viability (liquidity, volume, spread).
                    </DialogDescription>
                  </DialogHeader>
                  <div className="py-4">
                    {candidatesLoading ? (
                      <div className="flex items-center justify-center py-12">
                        <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
                        <span className="ml-2 text-zinc-500">Screening markets...</span>
                      </div>
                    ) : candidates.length === 0 ? (
                      <div className="text-center py-12 text-zinc-500">
                        <Search className="h-12 w-12 mx-auto mb-2 opacity-20" />
                        <p>No eligible markets found</p>
                        <p className="text-sm">Try adjusting screening parameters</p>
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-4"
                          onClick={() => refetchCandidates()}
                        >
                          <RefreshCw className="h-4 w-4 mr-1" />
                          Refresh
                        </Button>
                      </div>
                    ) : (
                      <ScrollArea className="h-[400px] pr-4">
                        <div className="space-y-2">
                          {candidates.map((candidate) => (
                            <button
                              key={candidate.marketId}
                              onClick={() => handleSelectCandidate(candidate)}
                              className="w-full text-left p-3 rounded-lg border hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors"
                            >
                              <div className="flex items-start justify-between gap-4">
                                <div className="flex-1 min-w-0">
                                  <p className="font-medium line-clamp-2 text-sm">
                                    {candidate.question}
                                  </p>
                                  <div className="flex items-center gap-2 mt-1 text-xs text-zinc-500">
                                    <span>{candidate.category || "—"}</span>
                                    <span>·</span>
                                    <span>${candidate.volume24h >= 1000000 ? `${(candidate.volume24h / 1000000).toFixed(1)}M` : `${(candidate.volume24h / 1000).toFixed(0)}k`} vol</span>
                                    <span>·</span>
                                    <span>{candidate.spreadTicks} tick spread</span>
                                    {candidate.hoursToEnd && (
                                      <>
                                        <span>·</span>
                                        <span>{Math.round(candidate.hoursToEnd / 24)}d left</span>
                                      </>
                                    )}
                                  </div>
                                  {candidate.flags.length > 0 && (
                                    <div className="flex gap-1 mt-1">
                                      {candidate.flags.slice(0, 3).map((flag) => (
                                        <Badge key={flag} variant="outline" className="text-xs">
                                          {flag}
                                        </Badge>
                                      ))}
                                    </div>
                                  )}
                                </div>
                                <div className="flex items-center gap-3">
                                  <div className="text-right">
                                    <div className={`text-lg font-bold ${getScoreColor(candidate.scores.total)}`}>
                                      {candidate.scores.total}
                                    </div>
                                    <div className="text-xs text-zinc-500">score</div>
                                  </div>
                                  <ChevronRight className="h-5 w-5 text-zinc-400" />
                                </div>
                              </div>
                            </button>
                          ))}
                        </div>
                      </ScrollArea>
                    )}
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={handleCloseDialog}>
                      Cancel
                    </Button>
                  </DialogFooter>
                </>
              ) : (
                <>
                  <DialogHeader>
                    <DialogTitle>Configure Market Maker</DialogTitle>
                    <DialogDescription className="line-clamp-2">
                      {selectedCandidate?.question}
                    </DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-4 py-4">
                    {/* Market stats */}
                    <div className="grid grid-cols-4 gap-2 p-3 bg-zinc-50 dark:bg-zinc-900 rounded-lg text-sm">
                      <div>
                        <div className="text-zinc-500 text-xs">Mid Price</div>
                        <div className="font-mono">{((selectedCandidate?.midPrice || 0.5) * 100).toFixed(0)}¢</div>
                      </div>
                      <div>
                        <div className="text-zinc-500 text-xs">Spread</div>
                        <div className="font-mono">{selectedCandidate?.spreadTicks} ticks</div>
                      </div>
                      <div>
                        <div className="text-zinc-500 text-xs">Top Depth</div>
                        <div className="font-mono">${(selectedCandidate?.topDepth || 0).toFixed(0)}</div>
                      </div>
                      <div>
                        <div className="text-zinc-500 text-xs">Score</div>
                        <div className={`font-bold ${getScoreColor(selectedCandidate?.scores.total || 0)}`}>
                          {selectedCandidate?.scores.total}
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="grid gap-2">
                        <Label htmlFor="targetSpread">Target Spread (¢)</Label>
                        <Input
                          id="targetSpread"
                          type="number"
                          step="1"
                          min="1"
                          value={(formValues.targetSpread * 100).toFixed(0)}
                          onChange={(e) =>
                            setFormValues({
                              ...formValues,
                              targetSpread: parseFloat(e.target.value) / 100,
                            })
                          }
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="orderSize">Order Size (shares)</Label>
                        <Input
                          id="orderSize"
                          type="number"
                          value={formValues.orderSize}
                          onChange={(e) =>
                            setFormValues({
                              ...formValues,
                              orderSize: parseFloat(e.target.value),
                            })
                          }
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="grid gap-2">
                        <Label htmlFor="maxInventory">Max Inventory (shares)</Label>
                        <Input
                          id="maxInventory"
                          type="number"
                          value={formValues.maxInventory}
                          onChange={(e) =>
                            setFormValues({
                              ...formValues,
                              maxInventory: parseFloat(e.target.value),
                            })
                          }
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="skewFactor">Skew Factor</Label>
                        <Input
                          id="skewFactor"
                          type="number"
                          step="0.001"
                          value={formValues.skewFactor}
                          onChange={(e) =>
                            setFormValues({
                              ...formValues,
                              skewFactor: parseFloat(e.target.value),
                            })
                          }
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="grid gap-2">
                        <Label htmlFor="quotingPolicy">Quoting Policy</Label>
                        <Select
                          value={formValues.quotingPolicy}
                          onValueChange={(value) =>
                            setFormValues({ ...formValues, quotingPolicy: value })
                          }
                        >
                          <SelectTrigger id="quotingPolicy">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="touch">Touch (at best bid/ask)</SelectItem>
                            <SelectItem value="inside">Inside (improve by 1 tick)</SelectItem>
                            <SelectItem value="back">Back (behind best)</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="minTimeToResolution">Min Time to Resolution (hrs)</Label>
                        <Input
                          id="minTimeToResolution"
                          type="number"
                          value={formValues.minTimeToResolution}
                          onChange={(e) =>
                            setFormValues({
                              ...formValues,
                              minTimeToResolution: parseInt(e.target.value),
                            })
                          }
                        />
                      </div>
                    </div>
                  </div>
                  <DialogFooter>
                    <Button
                      variant="outline"
                      onClick={() => setDialogStep("select")}
                    >
                      Back
                    </Button>
                    <Button
                      onClick={() =>
                        selectedCandidate &&
                        createMM.mutate({ marketId: selectedCandidate.marketId, ...formValues })
                      }
                      disabled={createMM.isPending || !selectedCandidate}
                    >
                      {createMM.isPending ? "Creating..." : "Start Making"}
                    </Button>
                  </DialogFooter>
                </>
              )}
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Summary Metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-4">
        <div className="p-4 bg-zinc-100 dark:bg-zinc-900 rounded-lg">
          <div className="text-xs text-zinc-500 uppercase">Cash Available</div>
          <div className="text-2xl font-bold">
            {summary.cashAvailable !== null
              ? `$${summary.cashAvailable >= 1000 ? `${(summary.cashAvailable / 1000).toFixed(1)}k` : summary.cashAvailable.toFixed(0)}`
              : "—"}
          </div>
        </div>
        <div className="p-4 bg-zinc-100 dark:bg-zinc-900 rounded-lg">
          <div className="text-xs text-zinc-500 uppercase">Net Risk</div>
          <div className={`text-2xl font-bold ${summary.totalAtRisk > 0 ? "text-amber-600" : ""}`}>
            ${summary.totalAtRisk >= 1000 ? `${(summary.totalAtRisk / 1000).toFixed(1)}k` : summary.totalAtRisk.toFixed(0)}
          </div>
          <div className="text-xs text-zinc-500 mt-1">
            {summary.marketsAtRisk > 0 && `${summary.marketsAtRisk} near max inv`}
          </div>
        </div>
        <div className="p-4 bg-zinc-100 dark:bg-zinc-900 rounded-lg">
          <div className="text-xs text-zinc-500 uppercase">Capital Deployed</div>
          <div className="text-2xl font-bold">
            ${totalDeployed >= 1000 ? `${(totalDeployed / 1000).toFixed(1)}k` : totalDeployed.toFixed(0)}
          </div>
        </div>
        <div className="p-4 bg-zinc-100 dark:bg-zinc-900 rounded-lg">
          <div className="text-xs text-zinc-500 uppercase">Total P&L</div>
          <div
            className={`text-2xl font-bold flex items-center gap-1 ${
              summary.totalPnl >= 0 ? "text-green-600" : "text-red-600"
            }`}
          >
            {summary.totalPnl >= 0 ? (
              <TrendingUp className="h-5 w-5" />
            ) : (
              <TrendingDown className="h-5 w-5" />
            )}
            ${Math.abs(summary.totalPnl).toFixed(2)}
          </div>
          <div className="text-xs text-zinc-500 mt-1">
            <span className={summary.totalRealizedPnl >= 0 ? "text-green-600/70" : "text-red-600/70"}>
              ${summary.totalRealizedPnl >= 0 ? "+" : ""}{summary.totalRealizedPnl.toFixed(2)} real
            </span>
            {" / "}
            <span className={summary.totalUnrealizedPnl >= 0 ? "text-green-600/70" : "text-red-600/70"}>
              ${summary.totalUnrealizedPnl >= 0 ? "+" : ""}{summary.totalUnrealizedPnl.toFixed(2)} unreal
            </span>
          </div>
        </div>
        <div className="p-4 bg-zinc-100 dark:bg-zinc-900 rounded-lg">
          <div className="text-xs text-zinc-500 uppercase">Active Makers</div>
          <div className="text-2xl font-bold">{summary.active}</div>
        </div>
        <div className="p-4 bg-zinc-100 dark:bg-zinc-900 rounded-lg">
          <div className="text-xs text-zinc-500 uppercase">Open Orders</div>
          <div className="text-2xl font-bold">{summary.totalOpenOrders}</div>
        </div>
        <div className="p-4 bg-zinc-100 dark:bg-zinc-900 rounded-lg">
          <div className="text-xs text-zinc-500 uppercase">Status</div>
          <div className="text-2xl font-bold">
            <Badge variant={mmEnabled ? "default" : "secondary"}>
              {mmEnabled ? "Running" : "Stopped"}
            </Badge>
          </div>
        </div>
      </div>

      {/* Market Makers Table */}
      <div className="border rounded-lg overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-zinc-50 dark:bg-zinc-900">
              <TableHead className="w-[220px]">Market</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">YES Bid</TableHead>
              <TableHead className="text-right">YES Ask</TableHead>
              <TableHead className="text-right">NO Bid</TableHead>
              <TableHead className="text-right">NO Ask</TableHead>
              <TableHead className="text-right">YES Inv</TableHead>
              <TableHead className="text-right">NO Inv</TableHead>
              <TableHead className="text-right">Deployed</TableHead>
              <TableHead className="text-right">P&L</TableHead>
              <TableHead className="text-right">Fills</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={12}>
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : marketMakers.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={12}
                  className="text-center py-12 text-zinc-500"
                >
                  <BarChart3 className="h-12 w-12 mx-auto mb-2 opacity-20" />
                  <p>No market makers configured</p>
                  <p className="text-sm">Add a market to start making</p>
                </TableCell>
              </TableRow>
            ) : (
              marketMakers.map((mm) => {
                const yesBid = getOrder(mm, "YES", "BID");
                const yesAsk = getOrder(mm, "YES", "ASK");
                const noBid = getOrder(mm, "NO", "BID");
                const noAsk = getOrder(mm, "NO", "ASK");
                const volatilityPaused = isVolatilityPaused(mm);
                const deployed = mm.yesInventory * mm.avgYesCost + mm.noInventory * mm.avgNoCost;

                return (
                  <TableRow
                    key={mm.id}
                    className={mm.paused || volatilityPaused ? "opacity-50" : ""}
                  >
                    <TableCell className="font-medium">
                      <div>
                        <a
                          href={`https://polymarket.com/market/${mm.market?.slug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:underline line-clamp-1"
                          title={mm.market?.question}
                        >
                          {mm.market?.question || mm.marketId.slice(0, 16) + "..."}
                        </a>
                        <div className="text-xs text-zinc-500 flex items-center gap-1">
                          {mm.market?.category || "—"}
                          <span className="text-zinc-400">·</span>
                          <span>{mm.quotingPolicy}</span>
                        </div>
                        <div className="text-xs text-zinc-500 flex items-center gap-2">
                          <span>
                            {mm.market?.endDate
                              ? `Ends ${formatDistanceToNow(new Date(mm.market.endDate), { addSuffix: true })}`
                              : "End date —"}
                          </span>
                          <span className="text-zinc-400">·</span>
                          <span>
                            Yes {mm.market?.yesPrice != null ? `$${mm.market.yesPrice.toFixed(2)}` : "—"}
                          </span>
                          <span>/</span>
                          <span>
                            No {mm.market?.noPrice != null ? `$${mm.market.noPrice.toFixed(2)}` : "—"}
                          </span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        {volatilityPaused ? (
                          <Badge variant="outline" className="text-amber-600">
                            <AlertTriangle className="h-3 w-3 mr-1" />
                            Vol Pause
                          </Badge>
                        ) : mm.paused ? (
                          <Badge variant="outline">Paused</Badge>
                        ) : mm.active ? (
                          <Badge variant="default">Active</Badge>
                        ) : (
                          <Badge variant="secondary">Inactive</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-green-600">
                      {yesBid ? (
                        <div>
                          <div>${yesBid.price.toFixed(2)}</div>
                          <div className="text-xs text-zinc-500">{yesBid.size}</div>
                        </div>
                      ) : "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-red-600">
                      {yesAsk ? (
                        <div>
                          <div>${yesAsk.price.toFixed(2)}</div>
                          <div className="text-xs text-zinc-500">{yesAsk.size}</div>
                        </div>
                      ) : "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-green-600">
                      {noBid ? (
                        <div>
                          <div>${noBid.price.toFixed(2)}</div>
                          <div className="text-xs text-zinc-500">{noBid.size}</div>
                        </div>
                      ) : "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-red-600">
                      {noAsk ? (
                        <div>
                          <div>${noAsk.price.toFixed(2)}</div>
                          <div className="text-xs text-zinc-500">{noAsk.size}</div>
                        </div>
                      ) : "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      <span className="text-green-600">{mm.yesInventory.toFixed(1)}</span>
                      {mm.avgYesCost > 0 && (
                        <div className="text-xs text-zinc-500">
                          @${mm.avgYesCost.toFixed(2)}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      <span className="text-red-600">{mm.noInventory.toFixed(1)}</span>
                      {mm.avgNoCost > 0 && (
                        <div className="text-xs text-zinc-500">
                          @${mm.avgNoCost.toFixed(2)}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      ${deployed.toFixed(2)}
                    </TableCell>
                    <TableCell
                      className={`text-right font-mono ${
                        mm.totalPnl >= 0 ? "text-green-600" : "text-red-600"
                      }`}
                    >
                      <div className="font-bold">${mm.totalPnl.toFixed(2)}</div>
                      <div className="text-xs opacity-70">
                        {deployed > 0
                          ? `${mm.totalPnl >= 0 ? "+" : ""}${((mm.totalPnl / deployed) * 100).toFixed(1)}%`
                          : "—"}
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-sm">
                      {mm.fillCount}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            updateMM.mutate({ id: mm.id, paused: !mm.paused })
                          }
                          title={mm.paused ? "Resume" : "Pause"}
                        >
                          {mm.paused ? (
                            <Play className="h-4 w-4" />
                          ) : (
                            <Pause className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditingMM(mm);
                            setFormValues({
                              targetSpread: mm.targetSpread,
                              orderSize: mm.orderSize,
                              maxInventory: mm.maxInventory,
                              skewFactor: mm.skewFactor,
                              quotingPolicy: mm.quotingPolicy,
                              minTimeToResolution: mm.minTimeToResolution,
                            });
                          }}
                          title="Settings"
                        >
                          <Settings className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            if (
                              confirm(
                                `Delete market maker for ${mm.market?.slug || mm.marketId}?`
                              )
                            ) {
                              deleteMM.mutate(mm.id);
                            }
                          }}
                          title="Delete"
                          className="text-red-600 hover:text-red-700"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Edit Dialog */}
      <Dialog open={!!editingMM} onOpenChange={() => setEditingMM(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Market Maker</DialogTitle>
            <DialogDescription>
              {editingMM?.market?.question || editingMM?.marketId}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="edit-targetSpread">Target Spread (¢)</Label>
                <Input
                  id="edit-targetSpread"
                  type="number"
                  step="1"
                  min="1"
                  value={(formValues.targetSpread * 100).toFixed(0)}
                  onChange={(e) =>
                    setFormValues({
                      ...formValues,
                      targetSpread: parseFloat(e.target.value) / 100,
                    })
                  }
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="edit-orderSize">Order Size (shares)</Label>
                <Input
                  id="edit-orderSize"
                  type="number"
                  value={formValues.orderSize}
                  onChange={(e) =>
                    setFormValues({
                      ...formValues,
                      orderSize: parseFloat(e.target.value),
                    })
                  }
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="edit-maxInventory">Max Inventory (shares)</Label>
                <Input
                  id="edit-maxInventory"
                  type="number"
                  value={formValues.maxInventory}
                  onChange={(e) =>
                    setFormValues({
                      ...formValues,
                      maxInventory: parseFloat(e.target.value),
                    })
                  }
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="edit-skewFactor">Skew Factor</Label>
                <Input
                  id="edit-skewFactor"
                  type="number"
                  step="0.001"
                  value={formValues.skewFactor}
                  onChange={(e) =>
                    setFormValues({
                      ...formValues,
                      skewFactor: parseFloat(e.target.value),
                    })
                  }
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="edit-quotingPolicy">Quoting Policy</Label>
                <Select
                  value={formValues.quotingPolicy}
                  onValueChange={(value) =>
                    setFormValues({ ...formValues, quotingPolicy: value })
                  }
                >
                  <SelectTrigger id="edit-quotingPolicy">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="touch">Touch (at best bid/ask)</SelectItem>
                    <SelectItem value="inside">Inside (improve by 1 tick)</SelectItem>
                    <SelectItem value="back">Back (behind best)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="edit-minTimeToResolution">Min Time to Resolution (hrs)</Label>
                <Input
                  id="edit-minTimeToResolution"
                  type="number"
                  value={formValues.minTimeToResolution}
                  onChange={(e) =>
                    setFormValues({
                      ...formValues,
                      minTimeToResolution: parseInt(e.target.value),
                    })
                  }
                />
              </div>
            </div>
            {editingMM?.volatilityPauseUntil && isVolatilityPaused(editingMM) && (
              <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="h-4 w-4" />
                  <span className="font-medium">Volatility Pause Active</span>
                </div>
                <p className="text-sm text-amber-600 dark:text-amber-500 mt-1">
                  Resumes {formatDistanceToNow(new Date(editingMM.volatilityPauseUntil), { addSuffix: true })}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() =>
                    updateMM.mutate({ id: editingMM.id, volatilityPauseUntil: null })
                  }
                >
                  Clear Volatility Pause
                </Button>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingMM(null)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                editingMM &&
                updateMM.mutate({ id: editingMM.id, ...formValues })
              }
              disabled={updateMM.isPending}
            >
              {updateMM.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
