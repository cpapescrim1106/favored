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
import { Checkbox } from "@/components/ui/checkbox";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
import { SyncStatus } from "@/components/sync-status";

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
    yesBestBid: number | null;
    noBestBid: number | null;
    endDate: string | null;
  } | null;
  active: boolean;
  paused: boolean;
  targetSpread: number;
  orderSize: number;
  maxInventory: number;
  skewFactor: number;
  bidOffsetTicks: number | null;
  askOffsetTicks: number | null;
  yesInventory: number;
  noInventory: number;
  avgYesCost: number;
  avgNoCost: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  pnl24h: number;
  pnl1w: number;
  minTimeToResolution: number;
  volatilityPauseUntil: string | null;
  orders: MarketMakerOrder[];
  fillCount: number;
  lastFillAt: string | null;
  lastQuoteAt: string | null;
  createdAt: string;
}

interface Fill {
  id: string;
  orderId: string;
  marketSlug: string;
  marketQuestion: string;
  outcome: string;
  side: string;
  size: number;
  price: number;
  filledAt: string;
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

interface FillsResponse {
  count: number;
  fills: Fill[];
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
  queueSpeed: number;
  queueDepthRatio: number;
  hoursToEnd: number | null;
  scores: {
    liquidity: number;
    flow: number;
    time: number;
    priceZone: number;
    queueSpeed: number;
    queueDepth: number;
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

interface FormValues {
  useOffsets: boolean;
  targetSpread: number;
  orderSize: number;
  maxInventory: number;
  skewFactor: number;
  bidOffsetTicks: number | null;
  askOffsetTicks: number | null;
  minTimeToResolution: number;
}

export default function MarketMakingPage() {
  const queryClient = useQueryClient();
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editingMM, setEditingMM] = useState<MarketMaker | null>(null);
  const [selectedCandidate, setSelectedCandidate] = useState<MMCandidate | null>(null);
  const [dialogStep, setDialogStep] = useState<"select" | "configure">("select");
  const [pnlWindow, setPnlWindow] = useState<"24h" | "1w" | "all">("24h");
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [bulkApplyToAll, setBulkApplyToAll] = useState(false);
  const [fillsOpen, setFillsOpen] = useState(false);
  const [selectedMarketIds, setSelectedMarketIds] = useState<string[]>([]);
  const [formValues, setFormValues] = useState<FormValues>({
    useOffsets: true,
    targetSpread: 0.04,
    orderSize: 100,
    maxInventory: 500,
    skewFactor: 0.04,
    bidOffsetTicks: 1,
    askOffsetTicks: 0,
    minTimeToResolution: 24,
  });
  const [bulkValues, setBulkValues] = useState<FormValues>({
    useOffsets: true,
    targetSpread: 0.04,
    orderSize: 100,
    maxInventory: 500,
    skewFactor: 0.04,
    bidOffsetTicks: 1,
    askOffsetTicks: 0,
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

  const { data: fillsData, isLoading: fillsLoading } = useQuery<FillsResponse>({
    queryKey: ["market-making-fills-24h-asks"],
    queryFn: async () => {
      const res = await fetch("/api/market-making/fills");
      if (!res.ok) throw new Error("Failed to fetch fills");
      return res.json();
    },
    enabled: fillsOpen,
    refetchInterval: fillsOpen ? 10000 : false,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: false,
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
      const payload = {
        marketId: data.marketId,
        targetSpread: data.targetSpread,
        orderSize: data.orderSize,
        maxInventory: data.maxInventory,
        skewFactor: data.skewFactor,
        minTimeToResolution: data.minTimeToResolution,
        bidOffsetTicks: data.useOffsets ? data.bidOffsetTicks ?? 1 : null,
        askOffsetTicks: data.useOffsets ? data.askOffsetTicks ?? 0 : null,
      };
      const res = await fetch("/api/market-making", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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
      const payload = {
        ...data,
        bidOffsetTicks:
          data.useOffsets === undefined
            ? undefined
            : data.useOffsets
            ? data.bidOffsetTicks ?? 1
            : null,
        askOffsetTicks:
          data.useOffsets === undefined
            ? undefined
            : data.useOffsets
            ? data.askOffsetTicks ?? 0
            : null,
      };
      delete (payload as { useOffsets?: boolean }).useOffsets;
      const res = await fetch(`/api/market-making/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Failed to update market maker");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["market-making"] });
      setEditingMM(null);
    },
  });

  const bulkUpdateMM = useMutation({
    mutationFn: async (payload: {
      applyToAll: boolean;
      ids: string[];
      updates: {
        targetSpread?: number;
        orderSize?: number;
        maxInventory?: number;
        skewFactor?: number;
        bidOffsetTicks?: number | null;
        askOffsetTicks?: number | null;
        minTimeToResolution?: number;
      };
    }) => {
      const res = await fetch("/api/market-making/bulk", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Failed to bulk update market makers");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["market-making"] });
      setSelectedMarketIds([]);
      setBulkDialogOpen(false);
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
  const fillsAll = fillsData?.fills || [];
  const fillsTotalCount = fillsData?.count ?? null;
  const fillsCountLabel = fillsTotalCount === null ? "—" : fillsTotalCount;
  const marketMakers = data?.marketMakers || [];
  const mmEnabled = data?.mmEnabled || false;
  const candidates = candidatesData?.candidates || [];
  const totalDeployed = marketMakers.reduce((sum, mm) => {
    const yesCost = mm.yesInventory * mm.avgYesCost;
    const noCost = mm.noInventory * mm.avgNoCost;
    return sum + yesCost + noCost;
  }, 0);
  const marketMakerOrder = new Map(
    marketMakers.map((mm, index) => [mm.id, index])
  );
  const sortedMarketMakers = [...marketMakers].sort((a, b) => {
    const aHasInventory =
      Math.abs(a.yesInventory) > 0.0001 || Math.abs(a.noInventory) > 0.0001;
    const bHasInventory =
      Math.abs(b.yesInventory) > 0.0001 || Math.abs(b.noInventory) > 0.0001;
    if (aHasInventory !== bHasInventory) {
      return aHasInventory ? -1 : 1;
    }
    return (marketMakerOrder.get(a.id) ?? 0) - (marketMakerOrder.get(b.id) ?? 0);
  });
  const selectedMarketIdSet = new Set(selectedMarketIds);
  const hasSelections = selectedMarketIds.length > 0;
  const allSelected =
    marketMakers.length > 0 && selectedMarketIds.length === marketMakers.length;

  // Helper to get order by outcome and side
  const getOrder = (mm: MarketMaker, outcome: string, side: string) => {
    return mm.orders.find((o) => o.outcome === outcome && o.side === side);
  };

  const toggleMarketSelection = (marketId: string, checked: boolean) => {
    setSelectedMarketIds((prev) => {
      if (checked) {
        return prev.includes(marketId) ? prev : [...prev, marketId];
      }
      return prev.filter((id) => id !== marketId);
    });
  };

  const toggleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedMarketIds(marketMakers.map((mm) => mm.id));
    } else {
      setSelectedMarketIds([]);
    }
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

  // Staleness indicator: hours since last fill
  // Returns: null (no fills), or hours since last fill
  const getHoursSinceLastFill = (mm: MarketMaker): number | null => {
    if (!mm.lastFillAt) return null;
    const lastFill = new Date(mm.lastFillAt);
    const now = new Date();
    return (now.getTime() - lastFill.getTime()) / (1000 * 60 * 60);
  };

  // Staleness row background color based on hours since last fill (or hours bidding if no fills)
  // < 12h: normal, 12-24h: yellow tint, 24-48h: orange tint, > 48h: red tint
  const getStaleRowClass = (mm: MarketMaker): string => {
    // Only apply staleness if market has inventory OR active orders (trying to get filled)
    const hasInventory = Math.abs(mm.yesInventory) > 0.001 || Math.abs(mm.noInventory) > 0.001;
    const hasOrders = mm.orders.length > 0;
    if (!hasInventory && !hasOrders) return "";

    const hours = getHoursSinceLastFill(mm);
    if (hours === null) {
      // No fills yet - use time since creation if we have orders out
      if (!hasOrders) return "";
      const createdAt = new Date(mm.createdAt);
      const hoursSinceCreation = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60);
      if (hoursSinceCreation >= 48) return "bg-red-50 dark:bg-red-950/30";
      if (hoursSinceCreation >= 24) return "bg-orange-50 dark:bg-orange-950/30";
      if (hoursSinceCreation >= 12) return "bg-amber-50 dark:bg-amber-950/30";
      return "";
    }
    if (hours >= 48) return "bg-red-50 dark:bg-red-950/30";
    if (hours >= 24) return "bg-orange-50 dark:bg-orange-950/30";
    if (hours >= 12) return "bg-amber-50 dark:bg-amber-950/30";
    return "";
  };

  const pnlWindowLabel = pnlWindow === "24h" ? "24h" : pnlWindow === "1w" ? "1W" : "All";
  const getWindowPnl = (mm: MarketMaker) => {
    if (pnlWindow === "24h") return mm.pnl24h;
    if (pnlWindow === "1w") return mm.pnl1w;
    return mm.realizedPnl;
  };
  const windowPnlTotal =
    pnlWindow === "all"
      ? summary.totalPnl
      : marketMakers.reduce((sum, mm) => sum + getWindowPnl(mm), 0);

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
            <span className="text-xs text-zinc-500 uppercase">P&L Window</span>
            <div className="flex items-center rounded-md border border-zinc-200 dark:border-zinc-800 p-1">
              {[
                { value: "24h", label: "24h" },
                { value: "1w", label: "1W" },
                { value: "all", label: "All" },
              ].map((option) => (
                <Button
                  key={option.value}
                  type="button"
                  variant={pnlWindow === option.value ? "secondary" : "ghost"}
                  size="sm"
                  className="h-7 px-2"
                  onClick={() => setPnlWindow(option.value as "24h" | "1w" | "all")}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>
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
          <SyncStatus />
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isLoading}
          >
            <RefreshCw className={`h-4 w-4 mr-1 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Dialog open={bulkDialogOpen} onOpenChange={setBulkDialogOpen}>
            <DialogTrigger asChild>
              <Button
                variant="outline"
                size="sm"
              >
                <Settings className="h-4 w-4 mr-1" />
                Bulk Edit
                {hasSelections ? ` (${selectedMarketIds.length})` : ""}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Bulk Update Market Makers</DialogTitle>
                <DialogDescription>
                  Update settings for selected markets or apply globally.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 py-2">
                <div className="flex items-center justify-between rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
                  <div>
                    <div className="text-sm font-medium">Apply to all markets</div>
                    <div className="text-xs text-zinc-500">
                      Overrides selection and updates every market maker.
                    </div>
                  </div>
                  <Switch
                    checked={bulkApplyToAll}
                    onCheckedChange={setBulkApplyToAll}
                  />
                </div>
                {!bulkApplyToAll && (
                  <div className="text-sm text-zinc-500">
                    {hasSelections
                      ? `${selectedMarketIds.length} market(s) selected`
                      : "Select markets from the table to enable bulk updates."}
                  </div>
                )}
                <div className="flex items-center justify-between rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
                  <div>
                    <div className="text-sm font-medium">Use Bid/Ask Offsets</div>
                    <div className="text-xs text-zinc-500">
                      Toggle between offsets and target spread
                    </div>
                  </div>
                  <Switch
                    checked={bulkValues.useOffsets}
                    onCheckedChange={(checked) =>
                      setBulkValues({ ...bulkValues, useOffsets: checked })
                    }
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  {bulkValues.useOffsets ? (
                    <>
                      <div className="grid gap-2">
                        <Label htmlFor="bulk-bidOffsetTicks">Bid Offset (ticks)</Label>
                        <Input
                          id="bulk-bidOffsetTicks"
                          type="number"
                          step="1"
                          value={bulkValues.bidOffsetTicks ?? ""}
                          onChange={(e) =>
                            setBulkValues({
                              ...bulkValues,
                              bidOffsetTicks:
                                e.target.value === "" ? null : parseInt(e.target.value, 10),
                            })
                          }
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="bulk-askOffsetTicks">Ask Offset (ticks)</Label>
                        <Input
                          id="bulk-askOffsetTicks"
                          type="number"
                          step="1"
                          value={bulkValues.askOffsetTicks ?? ""}
                          onChange={(e) =>
                            setBulkValues({
                              ...bulkValues,
                              askOffsetTicks:
                                e.target.value === "" ? null : parseInt(e.target.value, 10),
                            })
                          }
                        />
                      </div>
                    </>
                  ) : (
                    <div className="grid gap-2">
                      <Label htmlFor="bulk-targetSpread">Target Spread (¢)</Label>
                      <Input
                        id="bulk-targetSpread"
                        type="number"
                        step="1"
                        min="1"
                        value={(bulkValues.targetSpread * 100).toFixed(0)}
                        onChange={(e) =>
                          setBulkValues({
                            ...bulkValues,
                            targetSpread: parseFloat(e.target.value) / 100,
                          })
                        }
                      />
                    </div>
                  )}
                  <div className="grid gap-2">
                    <Label htmlFor="bulk-orderSize">Order Size (shares)</Label>
                    <Input
                      id="bulk-orderSize"
                      type="number"
                      value={bulkValues.orderSize}
                      onChange={(e) =>
                        setBulkValues({
                          ...bulkValues,
                          orderSize: parseFloat(e.target.value),
                        })
                      }
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="bulk-maxInventory">Max Inventory (shares)</Label>
                    <Input
                      id="bulk-maxInventory"
                      type="number"
                      value={bulkValues.maxInventory}
                      onChange={(e) =>
                        setBulkValues({
                          ...bulkValues,
                          maxInventory: parseFloat(e.target.value),
                        })
                      }
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="bulk-skewFactor">Skew Factor</Label>
                    <Input
                      id="bulk-skewFactor"
                      type="number"
                      step="0.001"
                      value={bulkValues.skewFactor}
                      onChange={(e) =>
                        setBulkValues({
                          ...bulkValues,
                          skewFactor: parseFloat(e.target.value),
                        })
                      }
                    />
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="bulk-minTimeToResolution">Min Time to Resolution (hrs)</Label>
                  <Input
                    id="bulk-minTimeToResolution"
                    type="number"
                    value={bulkValues.minTimeToResolution}
                    onChange={(e) =>
                      setBulkValues({
                        ...bulkValues,
                        minTimeToResolution: parseFloat(e.target.value),
                      })
                    }
                  />
                </div>
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setBulkDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() =>
                    bulkUpdateMM.mutate({
                      applyToAll: bulkApplyToAll,
                      ids: selectedMarketIds,
                      updates: {
                        targetSpread: bulkValues.targetSpread,
                        orderSize: bulkValues.orderSize,
                        maxInventory: bulkValues.maxInventory,
                        skewFactor: bulkValues.skewFactor,
                        bidOffsetTicks: bulkValues.useOffsets
                          ? bulkValues.bidOffsetTicks ?? null
                          : null,
                        askOffsetTicks: bulkValues.useOffsets
                          ? bulkValues.askOffsetTicks ?? null
                          : null,
                        minTimeToResolution: bulkValues.minTimeToResolution,
                      },
                    })
                  }
                  disabled={
                    bulkUpdateMM.isPending || (!bulkApplyToAll && !hasSelections)
                  }
                >
                  {bulkUpdateMM.isPending ? "Updating..." : "Apply Updates"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
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

                    <div className="flex items-center justify-between rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
                      <div>
                        <div className="text-sm font-medium">Use Bid/Ask Offsets</div>
                        <div className="text-xs text-zinc-500">Toggle between offsets and target spread</div>
                      </div>
                      <Switch
                        checked={formValues.useOffsets}
                        onCheckedChange={(checked) =>
                          setFormValues({ ...formValues, useOffsets: checked })
                        }
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      {formValues.useOffsets ? (
                        <>
                          <div className="grid gap-2">
                            <Label htmlFor="bidOffsetTicks">Bid Offset (ticks)</Label>
                            <Input
                              id="bidOffsetTicks"
                              type="number"
                              step="1"
                              value={formValues.bidOffsetTicks ?? ""}
                              onChange={(e) =>
                                setFormValues({
                                  ...formValues,
                                  bidOffsetTicks: e.target.value === "" ? null : parseInt(e.target.value, 10),
                                })
                              }
                            />
                          </div>
                          <div className="grid gap-2">
                            <Label htmlFor="askOffsetTicks">Ask Offset (ticks)</Label>
                            <Input
                              id="askOffsetTicks"
                              type="number"
                              step="1"
                              value={formValues.askOffsetTicks ?? ""}
                              onChange={(e) =>
                                setFormValues({
                                  ...formValues,
                                  askOffsetTicks: e.target.value === "" ? null : parseInt(e.target.value, 10),
                                })
                              }
                            />
                          </div>
                        </>
                      ) : (
                        <>
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
                        </>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-4">
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
                    </div>
                    <div className="grid grid-cols-2 gap-4">
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

      <Collapsible open={fillsOpen} onOpenChange={setFillsOpen} className="space-y-4">
        {/* Summary Metrics */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-8 gap-4">
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
            <div className="text-xs text-zinc-500 uppercase">
              {pnlWindow === "all" ? "Total P&L" : `${pnlWindowLabel} P&L`}
            </div>
            <div
              className={`text-2xl font-bold flex items-center gap-1 ${
                windowPnlTotal >= 0 ? "text-green-600" : "text-red-600"
              }`}
            >
              {windowPnlTotal >= 0 ? (
                <TrendingUp className="h-5 w-5" />
              ) : (
                <TrendingDown className="h-5 w-5" />
              )}
              ${Math.abs(windowPnlTotal).toFixed(2)}
            </div>
            <div className="text-xs text-zinc-500 mt-1">
              {pnlWindow === "all" ? (
                <>
                  <span className={summary.totalRealizedPnl >= 0 ? "text-green-600/70" : "text-red-600/70"}>
                    ${summary.totalRealizedPnl >= 0 ? "+" : ""}{summary.totalRealizedPnl.toFixed(2)} real
                  </span>
                  {" / "}
                  <span className={summary.totalUnrealizedPnl >= 0 ? "text-green-600/70" : "text-red-600/70"}>
                    ${summary.totalUnrealizedPnl >= 0 ? "+" : ""}{summary.totalUnrealizedPnl.toFixed(2)} unreal
                  </span>
                </>
              ) : (
                <span className={windowPnlTotal >= 0 ? "text-green-600/70" : "text-red-600/70"}>
                  ${windowPnlTotal >= 0 ? "+" : ""}{windowPnlTotal.toFixed(2)} realized
                </span>
              )}
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
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="p-4 bg-zinc-100 dark:bg-zinc-900 rounded-lg text-left transition hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-xs text-zinc-500 uppercase">Ask Fills</div>
                  <div className="text-2xl font-bold">{fillsCountLabel}</div>
                </div>
                <ChevronRight
                  className={`h-4 w-4 text-zinc-500 transition-transform ${fillsOpen ? "rotate-90" : ""}`}
                />
              </div>
              <div className="text-xs text-zinc-500 mt-1">Last 24h</div>
            </button>
          </CollapsibleTrigger>
        </div>

        <CollapsibleContent>
          <div className="border rounded-lg overflow-hidden bg-zinc-100 dark:bg-zinc-900">
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
              <div className="text-sm font-medium">Ask Fill History (24h)</div>
              <div className="text-xs text-zinc-500">{fillsCountLabel} total</div>
            </div>
            <div className="p-4">
              {fillsLoading ? (
                <div className="text-sm text-zinc-500">Loading ask fills...</div>
              ) : fillsAll.length === 0 ? (
                <div className="text-sm text-zinc-500">No ask fills in the last 24h.</div>
              ) : (
                <ScrollArea className="h-64">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-zinc-50 dark:bg-zinc-900">
                        <TableHead>Time</TableHead>
                        <TableHead>Market</TableHead>
                        <TableHead>Side</TableHead>
                        <TableHead className="text-right">Size</TableHead>
                        <TableHead className="text-right">Price</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {fillsAll.map((fill) => (
                        <TableRow key={fill.id}>
                          <TableCell className="text-sm text-zinc-600">
                            {formatDistanceToNow(new Date(fill.filledAt), { addSuffix: true })}
                          </TableCell>
                          <TableCell className="max-w-[320px]">
                            <div className="text-sm font-medium truncate" title={fill.marketQuestion}>
                              {fill.marketSlug}
                            </div>
                            {fill.marketQuestion && (
                              <div className="text-xs text-zinc-500 truncate" title={fill.marketQuestion}>
                                {fill.marketQuestion}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="text-sm">
                            <span className={fill.side === "BUY" ? "text-green-600" : "text-red-600"}>
                              {fill.side}
                            </span>
                            <span className="text-zinc-500"> {fill.outcome}</span>
                          </TableCell>
                          <TableCell className="text-right text-sm">
                            {fill.size.toFixed(2)}
                          </TableCell>
                          <TableCell className="text-right text-sm">
                            {fill.price.toFixed(4)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollArea>
              )}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Market Makers Table */}
      <div className="border rounded-lg overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-zinc-50 dark:bg-zinc-900">
                  <TableHead className="w-[40px]">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={(checked) => toggleSelectAll(checked === true)}
                      aria-label="Select all markets"
                    />
                  </TableHead>
                  <TableHead className="w-[220px]">Market</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">YES Bid</TableHead>
                  <TableHead className="text-right">YES Ask</TableHead>
                  <TableHead className="text-right">YES Inv</TableHead>
                  <TableHead className="text-right">NO Bid</TableHead>
                  <TableHead className="text-right">NO Ask</TableHead>
                  <TableHead className="text-right">NO Inv</TableHead>
                  <TableHead className="text-right">Deployed</TableHead>
                  <TableHead className="text-right">P&L</TableHead>
                  <TableHead className="text-right">{pnlWindowLabel} P&L</TableHead>
                  <TableHead className="text-right">Fills</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={14}>
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : marketMakers.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={14}
                  className="text-center py-12 text-zinc-500"
                >
                  <BarChart3 className="h-12 w-12 mx-auto mb-2 opacity-20" />
                  <p>No market makers configured</p>
                  <p className="text-sm">Add a market to start making</p>
                </TableCell>
              </TableRow>
            ) : (
              sortedMarketMakers.map((mm) => {
                const yesBid = getOrder(mm, "YES", "BID");
                const yesAsk = getOrder(mm, "YES", "ASK");
                const noBid = getOrder(mm, "NO", "BID");
                const noAsk = getOrder(mm, "NO", "ASK");
                const volatilityPaused = isVolatilityPaused(mm);
                const deployed = mm.yesInventory * mm.avgYesCost + mm.noInventory * mm.avgNoCost;
                const windowPnl = getWindowPnl(mm);
                const yesInventoryMagnitude = Math.abs(mm.yesInventory);
                const noInventoryMagnitude = Math.abs(mm.noInventory);
                const hasYesInventory = yesInventoryMagnitude > 0.0001;
                const hasNoInventory = noInventoryMagnitude > 0.0001;
                const yesPriceClass =
                  hasYesInventory && yesInventoryMagnitude >= 1
                    ? "text-green-600"
                    : "text-zinc-500";
                const noPriceClass =
                  hasNoInventory && noInventoryMagnitude >= 1
                    ? "text-red-600"
                    : "text-zinc-500";

                const staleClass = getStaleRowClass(mm);

                return (
                  <TableRow
                    key={mm.id}
                    className={`${mm.paused || volatilityPaused ? "opacity-50" : ""} ${staleClass}`}
                  >
                    <TableCell>
                      <Checkbox
                        checked={selectedMarketIdSet.has(mm.id)}
                        onCheckedChange={(checked) =>
                          toggleMarketSelection(mm.id, checked === true)
                        }
                        aria-label={`Select ${mm.market?.slug ?? mm.id}`}
                      />
                    </TableCell>
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
                          <span>
                            {mm.bidOffsetTicks !== null || mm.askOffsetTicks !== null
                              ? `Bid -${mm.bidOffsetTicks ?? 0}t / Ask +${mm.askOffsetTicks ?? 0}t`
                              : `Spread ${(mm.targetSpread * 100).toFixed(0)}¢`}
                          </span>
                        </div>
                        <div className="text-xs text-zinc-500 flex items-center gap-2">
                          <span>
                            {mm.market?.endDate
                              ? `Ends ${formatDistanceToNow(new Date(mm.market.endDate), { addSuffix: true })}`
                              : "End date —"}
                          </span>
                          <span className="text-zinc-400">·</span>
                          <span>
                            Yes {mm.market?.yesBestBid != null ? `$${mm.market.yesBestBid.toFixed(2)}` : "—"}
                          </span>
                          <span>/</span>
                          <span>
                            No {mm.market?.noBestBid != null ? `$${mm.market.noBestBid.toFixed(2)}` : "—"}
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
                    <TableCell className="text-right font-mono">
                      <span className={yesPriceClass}>
                        {hasYesInventory && mm.avgYesCost > 0 ? `$${mm.avgYesCost.toFixed(2)}` : "-"}
                      </span>
                      {hasYesInventory && (
                        <div className="text-xs text-zinc-500">{mm.yesInventory.toFixed(1)}</div>
                      )}
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
                      <span className={noPriceClass}>
                        {hasNoInventory && mm.avgNoCost > 0 ? `$${mm.avgNoCost.toFixed(2)}` : "-"}
                      </span>
                      {hasNoInventory && (
                        <div className="text-xs text-zinc-500">{mm.noInventory.toFixed(1)}</div>
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
                        {mm.realizedPnl !== 0 && (
                          <span>{mm.realizedPnl >= 0 ? "+" : ""}{mm.realizedPnl.toFixed(2)}r</span>
                        )}
                        {mm.realizedPnl !== 0 && mm.unrealizedPnl !== 0 && " / "}
                        {mm.unrealizedPnl !== 0 && (
                          <span>{mm.unrealizedPnl >= 0 ? "+" : ""}{mm.unrealizedPnl.toFixed(2)}u</span>
                        )}
                        {mm.realizedPnl === 0 && mm.unrealizedPnl === 0 && "—"}
                      </div>
                      <div className="text-xs opacity-70">
                        {deployed > 0
                          ? `${mm.totalPnl >= 0 ? "+" : ""}${((mm.totalPnl / deployed) * 100).toFixed(1)}%`
                          : "—"}
                      </div>
                    </TableCell>
                    <TableCell
                      className={`text-right font-mono ${
                        windowPnl >= 0 ? "text-green-600" : "text-red-600"
                      }`}
                    >
                      <div className="font-bold">${windowPnl.toFixed(2)}</div>
                      <div className="text-xs opacity-70">realized</div>
                    </TableCell>
                    <TableCell className="text-right text-sm">
                      <div>{mm.fillCount}</div>
                      <div className="text-xs text-zinc-500">
                        {mm.lastFillAt ? (
                          formatDistanceToNow(new Date(mm.lastFillAt), { addSuffix: true })
                        ) : mm.orders.length > 0 ? (
                          `bidding ${formatDistanceToNow(new Date(mm.createdAt))}`
                        ) : null}
                      </div>
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
                              useOffsets:
                                mm.bidOffsetTicks !== null ||
                                mm.askOffsetTicks !== null,
                              targetSpread: mm.targetSpread,
                              orderSize: mm.orderSize,
                              maxInventory: mm.maxInventory,
                              skewFactor: mm.skewFactor,
                              bidOffsetTicks: mm.bidOffsetTicks ?? 1,
                              askOffsetTicks: mm.askOffsetTicks ?? 0,
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
            <div className="flex items-center justify-between rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
              <div>
                <div className="text-sm font-medium">Use Bid/Ask Offsets</div>
                <div className="text-xs text-zinc-500">Toggle between offsets and target spread</div>
              </div>
              <Switch
                checked={formValues.useOffsets}
                onCheckedChange={(checked) =>
                  setFormValues({ ...formValues, useOffsets: checked })
                }
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              {formValues.useOffsets ? (
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="edit-bidOffsetTicks">Bid Offset (ticks)</Label>
                    <Input
                      id="edit-bidOffsetTicks"
                      type="number"
                      step="1"
                      value={formValues.bidOffsetTicks ?? ""}
                      onChange={(e) =>
                        setFormValues({
                          ...formValues,
                          bidOffsetTicks: e.target.value === "" ? null : parseInt(e.target.value, 10),
                        })
                      }
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="edit-askOffsetTicks">Ask Offset (ticks)</Label>
                    <Input
                      id="edit-askOffsetTicks"
                      type="number"
                      step="1"
                      value={formValues.askOffsetTicks ?? ""}
                      onChange={(e) =>
                        setFormValues({
                          ...formValues,
                          askOffsetTicks: e.target.value === "" ? null : parseInt(e.target.value, 10),
                        })
                      }
                    />
                  </div>
                </>
              ) : (
                <>
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
                </>
              )}
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
