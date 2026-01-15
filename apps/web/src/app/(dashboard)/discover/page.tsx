"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { MultiSelect } from "@/components/ui/multi-select";
import {
  AlertTriangle,
  ChevronRight,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface MMCandidate {
  marketId: string;
  slug: string;
  question: string;
  category: string | null;
  endDate: string | null;
  venue: "POLYMARKET" | "KALSHI";
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
  scoredAt?: string | null;
}

interface MMCandidatesData {
  total: number;
  candidates: MMCandidate[];
}

interface UniverseMarket {
  marketId: string;
  slug: string;
  question: string;
  category: string | null;
  endDate: string | null;
  venue: "POLYMARKET" | "KALSHI";
  volume24h: number;
  midPrice: number | null;
  spreadTicks: number | null;
  lastUpdated: string | null;
}

interface UniverseData {
  total: number;
  markets: UniverseMarket[];
}

interface HotMarket {
  marketId: string;
  question: string;
  category: string | null;
  endDate: string | null;
  venue: "POLYMARKET" | "KALSHI";
  volume24h: number;
  midPrice: number | null;
  spreadTicks: number | null;
  score: number | null;
  scoredAt: string | null;
  reason: string;
}

interface HotListData {
  total: number;
  markets: HotMarket[];
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

export default function DiscoverPage() {
  const [activeTab, setActiveTab] = useState<"candidates" | "universe">("candidates");
  const [candidateScreenVenue, setCandidateScreenVenue] = useState<
    "all" | "POLYMARKET" | "KALSHI"
  >("all");
  const [candidateVenueFilter, setCandidateVenueFilter] = useState<
    "all" | "POLYMARKET" | "KALSHI"
  >("all");
  const [candidateEligibleOnly, setCandidateEligibleOnly] = useState(true);
  const [candidateViewMode, setCandidateViewMode] = useState<"ranked" | "category">("ranked");
  const [candidateCategoryFilter, setCandidateCategoryFilter] = useState<string[]>([]);
  const [candidateResults, setCandidateResults] = useState<MMCandidate[]>([]);
  const [candidateTotal, setCandidateTotal] = useState<number | null>(null);
  const [candidateScreening, setCandidateScreening] = useState(false);
  const [candidateLastRunAt, setCandidateLastRunAt] = useState<Date | null>(null);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const [universeVenueFilter, setUniverseVenueFilter] = useState<
    "all" | "POLYMARKET" | "KALSHI"
  >("all");
  const [universeCategoryFilter, setUniverseCategoryFilter] = useState<string[]>([]);
  const [universeResults, setUniverseResults] = useState<UniverseMarket[]>([]);
  const [universeTotal, setUniverseTotal] = useState<number | null>(null);
  const [universeLoading, setUniverseLoading] = useState(false);
  const [universeLastRunAt, setUniverseLastRunAt] = useState<Date | null>(null);
  const [universeError, setUniverseError] = useState<string | null>(null);
  const [hotVenueFilter, setHotVenueFilter] = useState<
    "all" | "POLYMARKET" | "KALSHI"
  >("all");
  const [hotResults, setHotResults] = useState<HotMarket[]>([]);
  const [hotLoading, setHotLoading] = useState(false);
  const [hotLastRunAt, setHotLastRunAt] = useState<Date | null>(null);
  const [hotError, setHotError] = useState<string | null>(null);
  const [selectedCandidate, setSelectedCandidate] = useState<MMCandidate | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [rescoreMarketId, setRescoreMarketId] = useState<string | null>(null);
  const [rescoreError, setRescoreError] = useState<string | null>(null);

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

  const runCandidateScreen = async () => {
    setCandidateScreening(true);
    setCandidateError(null);
    try {
      const res = await fetch(
        `/api/mm-candidates?limit=40&eligibleOnly=${candidateEligibleOnly}&venue=${candidateScreenVenue}`
      );
      if (!res.ok) throw new Error("Failed to fetch candidates");
      const data: MMCandidatesData = await res.json();
      setCandidateResults(data.candidates ?? []);
      setCandidateTotal(data.total ?? data.candidates?.length ?? 0);
      const scoredTimes = (data.candidates ?? [])
        .map((candidate) =>
          candidate.scoredAt ? new Date(candidate.scoredAt).getTime() : null
        )
        .filter((value): value is number => value !== null);
      if (scoredTimes.length > 0) {
        setCandidateLastRunAt(new Date(Math.max(...scoredTimes)));
      } else {
        setCandidateLastRunAt(new Date());
      }
    } catch (error) {
      setCandidateError(error instanceof Error ? error.message : "Failed to fetch candidates");
      setCandidateResults([]);
      setCandidateTotal(0);
    } finally {
      setCandidateScreening(false);
    }
  };

  const runUniverseFetch = async () => {
    setUniverseLoading(true);
    setUniverseError(null);
    try {
      const res = await fetch(
        `/api/mm-universe?limit=80&venue=${universeVenueFilter}`
      );
      if (!res.ok) throw new Error("Failed to fetch universe markets");
      const data: UniverseData = await res.json();
      setUniverseResults(data.markets ?? []);
      setUniverseTotal(data.total ?? data.markets?.length ?? 0);
      setUniverseLastRunAt(new Date());
    } catch (error) {
      setUniverseError(error instanceof Error ? error.message : "Failed to fetch universe");
      setUniverseResults([]);
      setUniverseTotal(0);
    } finally {
      setUniverseLoading(false);
    }
  };

  const runHotListFetch = async () => {
    setHotLoading(true);
    setHotError(null);
    try {
      const res = await fetch(
        `/api/mm-hotlist?limit=14&venue=${hotVenueFilter}`
      );
      if (!res.ok) throw new Error("Failed to fetch hot list");
      const data: HotListData = await res.json();
      setHotResults(data.markets ?? []);
      setHotLastRunAt(new Date());
    } catch (error) {
      setHotError(error instanceof Error ? error.message : "Failed to fetch hot list");
      setHotResults([]);
    } finally {
      setHotLoading(false);
    }
  };

  const rescoreMarket = async (marketId: string) => {
    setRescoreMarketId(marketId);
    setRescoreError(null);
    try {
      const res = await fetch(
        `/api/mm-candidates?marketId=${encodeURIComponent(marketId)}&eligibleOnly=false`
      );
      if (!res.ok) throw new Error("Failed to rescore market");
      const data: MMCandidatesData = await res.json();
      const candidate = data.candidates?.[0] ?? null;
      if (!candidate) {
        throw new Error("No scored result returned for this market");
      }
      handleSelectCandidate(candidate);
    } catch (error) {
      setRescoreError(error instanceof Error ? error.message : "Failed to rescore market");
    } finally {
      setRescoreMarketId(null);
    }
  };

  useEffect(() => {
    runHotListFetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hotVenueFilter]);

  useEffect(() => {
    if (activeTab !== "universe") return;
    runUniverseFetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, universeVenueFilter]);

  const createMM = useMutation({
    mutationFn: async (data: { marketId: string } & FormValues) => {
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
      setConfigOpen(false);
      setSelectedCandidate(null);
    },
  });

  const handleSelectCandidate = (candidate: MMCandidate) => {
    setSelectedCandidate(candidate);
    setFormValues((prev) => ({
      ...prev,
      targetSpread: Math.max(0.04, (candidate.spreadTicks + 1) * 0.01),
    }));
    setConfigOpen(true);
  };

  const candidates = candidateResults;
  const normalizedCategory = (category: string | null) =>
    (category ?? "Uncategorized").trim() || "Uncategorized";

  const candidateCategoryOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const candidate of candidates) {
      const key = normalizedCategory(candidate.category);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([category, count]) => ({
        label: `${category} (${count})`,
        value: category,
      }));
  }, [candidates]);

  const universeCategoryOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const market of universeResults) {
      const key = normalizedCategory(market.category);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([category, count]) => ({
        label: `${category} (${count})`,
        value: category,
      }));
  }, [universeResults]);

  const filteredCandidates = useMemo(() => {
    if (candidateVenueFilter === "all") return candidates;
    return candidates.filter((candidate) => candidate.venue === candidateVenueFilter);
  }, [candidateVenueFilter, candidates]);
  const filteredCandidateCategories = useMemo(() => {
    if (candidateCategoryFilter.length === 0) return filteredCandidates;
    const selected = new Set(candidateCategoryFilter.map((c) => c.toLowerCase()));
    return filteredCandidates.filter((candidate) =>
      selected.has(normalizedCategory(candidate.category).toLowerCase())
    );
  }, [candidateCategoryFilter, filteredCandidates]);

  const candidateRows = useMemo(() => {
    if (candidateViewMode === "ranked") {
      return filteredCandidateCategories.map((candidate) => ({
        type: "candidate" as const,
        candidate,
      }));
    }

    const byCategory = new Map<string, MMCandidate[]>();
    for (const candidate of filteredCandidateCategories) {
      const key = normalizedCategory(candidate.category);
      const list = byCategory.get(key) ?? [];
      list.push(candidate);
      byCategory.set(key, list);
    }

    const rows: Array<
      | { type: "header"; label: string; count: number }
      | { type: "candidate"; candidate: MMCandidate }
    > = [];
    const categories = Array.from(byCategory.entries())
      .map(([label, list]) => ({
        label,
        list: [...list].sort((a, b) => b.scores.total - a.scores.total).slice(0, 3),
      }))
      .sort((a, b) => (b.list[0]?.scores.total ?? 0) - (a.list[0]?.scores.total ?? 0));

    for (const category of categories) {
      rows.push({ type: "header", label: category.label, count: category.list.length });
      for (const candidate of category.list) {
        rows.push({ type: "candidate", candidate });
      }
    }

    return rows;
  }, [candidateViewMode, filteredCandidateCategories, normalizedCategory]);
  const candidateCountLabel =
    candidateTotal === null ? "—" : `${filteredCandidateCategories.length}/${candidateTotal}`;
  const universeCountLabel =
    universeTotal === null ? "—" : `${universeResults.length}/${universeTotal}`;
  const filteredUniverse = useMemo(() => {
    if (universeCategoryFilter.length === 0) return universeResults;
    const selected = new Set(universeCategoryFilter.map((c) => c.toLowerCase()));
    return universeResults.filter((market) =>
      selected.has(normalizedCategory(market.category).toLowerCase())
    );
  }, [universeCategoryFilter, universeResults]);

  const getScoreColor = (score: number) => {
    if (score >= 70) return "text-green-600";
    if (score >= 50) return "text-yellow-600";
    return "text-red-600";
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Market Discovery</h1>
        <p className="text-sm text-zinc-500">
          Explore the full universe, screen candidates, and rescore before adding to MM.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <Tabs value={activeTab} onValueChange={(value) =>
            setActiveTab(value as "candidates" | "universe")
          }>
            <TabsList>
              <TabsTrigger value="candidates">Candidates</TabsTrigger>
              <TabsTrigger value="universe">Universe</TabsTrigger>
            </TabsList>
            <TabsContent value="candidates" className="mt-4">
              <div className="flex flex-col gap-3 pb-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-xs text-zinc-500 uppercase">Screen Venue</span>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center rounded-md border border-zinc-200 dark:border-zinc-800 p-1">
                      {[
                        { value: "all", label: "All" },
                        { value: "POLYMARKET", label: "Poly" },
                        { value: "KALSHI", label: "Kalshi" },
                      ].map((option) => (
                        <Button
                          key={option.value}
                          type="button"
                          variant={candidateScreenVenue === option.value ? "secondary" : "ghost"}
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() =>
                            setCandidateScreenVenue(
                              option.value as "all" | "POLYMARKET" | "KALSHI"
                            )
                          }
                        >
                          {option.label}
                        </Button>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-zinc-500">Eligible only</span>
                      <Switch
                        checked={candidateEligibleOnly}
                        onCheckedChange={(checked) => setCandidateEligibleOnly(checked)}
                      />
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      onClick={runCandidateScreen}
                      disabled={candidateScreening}
                    >
                      {candidateScreening ? "Screening..." : "Run Screen"}
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-xs text-zinc-500 uppercase">Filter Results</span>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center rounded-md border border-zinc-200 dark:border-zinc-800 p-1">
                      {[
                        { value: "all", label: "All" },
                        { value: "POLYMARKET", label: "Poly" },
                        { value: "KALSHI", label: "Kalshi" },
                      ].map((option) => (
                        <Button
                          key={option.value}
                          type="button"
                          variant={candidateVenueFilter === option.value ? "secondary" : "ghost"}
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() =>
                            setCandidateVenueFilter(
                              option.value as "all" | "POLYMARKET" | "KALSHI"
                            )
                          }
                        >
                          {option.label}
                        </Button>
                      ))}
                    </div>
                    <span className="text-xs text-zinc-500">{candidateCountLabel}</span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-xs text-zinc-500 uppercase">Categories</span>
                  <div className="w-full max-w-md">
                    <MultiSelect
                      options={candidateCategoryOptions}
                      onValueChange={setCandidateCategoryFilter}
                      defaultValue={candidateCategoryFilter}
                      placeholder="Filter categories"
                      maxCount={2}
                      className="w-full"
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-xs text-zinc-500 uppercase">View</span>
                  <div className="flex items-center rounded-md border border-zinc-200 dark:border-zinc-800 p-1">
                    {[
                      { value: "ranked", label: "Ranked" },
                      { value: "category", label: "Top per category" },
                    ].map((option) => (
                      <Button
                        key={option.value}
                        type="button"
                        variant={candidateViewMode === option.value ? "secondary" : "ghost"}
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => setCandidateViewMode(option.value as "ranked" | "category")}
                      >
                        {option.label}
                      </Button>
                    ))}
                  </div>
                </div>
                {candidateLastRunAt && (
                  <div className="text-xs text-zinc-500">
                    Last screened {formatDistanceToNow(candidateLastRunAt, { addSuffix: true })}
                  </div>
                )}
                {rescoreError && (
                  <div className="text-xs text-rose-500">{rescoreError}</div>
                )}
              </div>
              {candidateScreening ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
                  <span className="ml-2 text-zinc-500">Screening markets...</span>
                </div>
              ) : candidateError ? (
                <div className="text-center py-12 text-zinc-500">
                  <AlertTriangle className="h-12 w-12 mx-auto mb-2 opacity-20" />
                  <p>{candidateError}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-4"
                    onClick={runCandidateScreen}
                  >
                    <RefreshCw className="h-4 w-4 mr-1" />
                    Retry
                  </Button>
                </div>
              ) : filteredCandidateCategories.length === 0 ? (
                <div className="text-center py-12 text-zinc-500">
                  <Search className="h-12 w-12 mx-auto mb-2 opacity-20" />
                  <p>No markets found</p>
                  <p className="text-sm">Run a screen or adjust filters</p>
                </div>
              ) : (
                <ScrollArea className="h-[560px] pr-4">
                  <div className="space-y-2">
                    {candidateRows.map((row, index) => {
                      if (row.type === "header") {
                        return (
                          <div
                            key={`header-${row.label}-${index}`}
                            className="text-xs font-semibold uppercase tracking-wide text-zinc-500 pt-3"
                          >
                            {row.label}
                          </div>
                        );
                      }

                      const candidate = row.candidate;
                      return (
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
                                <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                  {candidate.venue === "KALSHI" ? "Kalshi" : "Poly"}
                                </Badge>
                                <span>{candidate.category || "—"}</span>
                                <span>·</span>
                                <span>
                                  $
                                  {candidate.volume24h >= 1000000
                                    ? `${(candidate.volume24h / 1000000).toFixed(1)}M`
                                    : `${(candidate.volume24h / 1000).toFixed(0)}k`}{" "}
                                  vol
                                </span>
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
                                  {!candidate.eligible && (
                                    <Badge variant="outline" className="text-xs text-zinc-500">
                                      Ineligible
                                    </Badge>
                                  )}
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
                      );
                    })}
                  </div>
                </ScrollArea>
              )}
            </TabsContent>
            <TabsContent value="universe" className="mt-4">
              <div className="flex flex-col gap-3 pb-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-xs text-zinc-500 uppercase">Filter Results</span>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center rounded-md border border-zinc-200 dark:border-zinc-800 p-1">
                      {[
                        { value: "all", label: "All" },
                        { value: "POLYMARKET", label: "Poly" },
                        { value: "KALSHI", label: "Kalshi" },
                      ].map((option) => (
                        <Button
                          key={option.value}
                          type="button"
                          variant={universeVenueFilter === option.value ? "secondary" : "ghost"}
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() =>
                            setUniverseVenueFilter(
                              option.value as "all" | "POLYMARKET" | "KALSHI"
                            )
                          }
                        >
                          {option.label}
                        </Button>
                      ))}
                    </div>
                    <span className="text-xs text-zinc-500">{universeCountLabel}</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={runUniverseFetch}
                      disabled={universeLoading}
                    >
                      {universeLoading ? "Refreshing..." : "Refresh"}
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-xs text-zinc-500 uppercase">Categories</span>
                  <div className="w-full max-w-md">
                    <MultiSelect
                      options={universeCategoryOptions}
                      onValueChange={setUniverseCategoryFilter}
                      defaultValue={universeCategoryFilter}
                      placeholder="Filter categories"
                      maxCount={2}
                      className="w-full"
                    />
                  </div>
                </div>
                {universeLastRunAt && (
                  <div className="text-xs text-zinc-500">
                    Last updated {formatDistanceToNow(universeLastRunAt, { addSuffix: true })}
                  </div>
                )}
                {rescoreError && (
                  <div className="text-xs text-rose-500">{rescoreError}</div>
                )}
              </div>
              {universeLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
                  <span className="ml-2 text-zinc-500">Loading universe...</span>
                </div>
              ) : universeError ? (
                <div className="text-center py-12 text-zinc-500">
                  <AlertTriangle className="h-12 w-12 mx-auto mb-2 opacity-20" />
                  <p>{universeError}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-4"
                    onClick={runUniverseFetch}
                  >
                    <RefreshCw className="h-4 w-4 mr-1" />
                    Retry
                  </Button>
                </div>
              ) : filteredUniverse.length === 0 ? (
                <div className="text-center py-12 text-zinc-500">
                  <Search className="h-12 w-12 mx-auto mb-2 opacity-20" />
                  <p>No markets found</p>
                  <p className="text-sm">Adjust filters or refresh</p>
                </div>
              ) : (
                <ScrollArea className="h-[560px] pr-4">
                  <div className="space-y-2">
                    {filteredUniverse.map((market) => (
                      <div
                        key={market.marketId}
                        className="w-full p-3 rounded-lg border hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors"
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <p className="font-medium line-clamp-2 text-sm">
                              {market.question}
                            </p>
                            <div className="flex items-center gap-2 mt-1 text-xs text-zinc-500">
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                {market.venue === "KALSHI" ? "Kalshi" : "Poly"}
                              </Badge>
                              <span>{market.category || "—"}</span>
                              <span>·</span>
                              <span>
                                $
                                {market.volume24h >= 1000000
                                  ? `${(market.volume24h / 1000000).toFixed(1)}M`
                                  : `${(market.volume24h / 1000).toFixed(0)}k`}{" "}
                                vol
                              </span>
                              {market.spreadTicks !== null && (
                                <>
                                  <span>·</span>
                                  <span>{market.spreadTicks} tick spread</span>
                                </>
                              )}
                              {market.endDate && (
                                <>
                                  <span>·</span>
                                  <span>
                                    {Math.round(
                                      (new Date(market.endDate).getTime() - Date.now()) /
                                        (1000 * 60 * 60 * 24)
                                    )}
                                    d left
                                  </span>
                                </>
                              )}
                            </div>
                            {market.lastUpdated && (
                              <div className="mt-1 text-[11px] text-zinc-500">
                                Updated{" "}
                                {formatDistanceToNow(new Date(market.lastUpdated), {
                                  addSuffix: true,
                                })}
                              </div>
                            )}
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => rescoreMarket(market.marketId)}
                            disabled={rescoreMarketId === market.marketId}
                          >
                            {rescoreMarketId === market.marketId ? "Rescoring..." : "Rescore"}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </TabsContent>
          </Tabs>
        </div>

        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 h-full">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-zinc-500 uppercase">Hot List</div>
              <div className="text-sm font-medium">Live activity</div>
            </div>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={runHotListFetch}
              disabled={hotLoading}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
          <div className="mt-3 flex items-center rounded-md border border-zinc-200 dark:border-zinc-800 p-1 w-fit">
            {[
              { value: "all", label: "All" },
              { value: "POLYMARKET", label: "Poly" },
              { value: "KALSHI", label: "Kalshi" },
            ].map((option) => (
              <Button
                key={option.value}
                type="button"
                variant={hotVenueFilter === option.value ? "secondary" : "ghost"}
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() =>
                  setHotVenueFilter(option.value as "all" | "POLYMARKET" | "KALSHI")
                }
              >
                {option.label}
              </Button>
            ))}
          </div>
          {hotLastRunAt && (
            <div className="mt-2 text-xs text-zinc-500">
              Updated {formatDistanceToNow(hotLastRunAt, { addSuffix: true })}
            </div>
          )}
          {hotError && (
            <div className="mt-2 text-xs text-rose-500">{hotError}</div>
          )}
          {hotLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
            </div>
          ) : hotResults.length === 0 ? (
            <div className="py-10 text-center text-xs text-zinc-500">
              No hot markets found
            </div>
          ) : (
            <ScrollArea className="h-[620px] pr-3 mt-3">
              <div className="space-y-2">
                {hotResults.map((market) => (
                  <div
                    key={market.marketId}
                    className="rounded-md border border-zinc-200 dark:border-zinc-800 p-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-xs font-medium line-clamp-2">
                          {market.question}
                        </div>
                        <div className="mt-1 flex items-center gap-1 text-[11px] text-zinc-500">
                          <Badge variant="outline" className="text-[9px] px-1 py-0">
                            {market.venue === "KALSHI" ? "Kalshi" : "Poly"}
                          </Badge>
                          <span>{market.category || "—"}</span>
                        </div>
                        <div className="mt-1 text-[11px] text-zinc-500">
                          {market.reason} ·{" "}
                          {market.volume24h >= 1000000
                            ? `${(market.volume24h / 1000000).toFixed(1)}M`
                            : `${(market.volume24h / 1000).toFixed(0)}k`}{" "}
                          vol
                          {market.score !== null && market.score !== undefined && (
                            <>
                              {" "}
                              · Score {market.score}
                            </>
                          )}
                        </div>
                        {market.scoredAt && (
                          <div className="mt-1 text-[10px] text-zinc-500">
                            Scored{" "}
                            {formatDistanceToNow(new Date(market.scoredAt), {
                              addSuffix: true,
                            })}
                          </div>
                        )}
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="text-xs"
                        onClick={() => rescoreMarket(market.marketId)}
                        disabled={rescoreMarketId === market.marketId}
                      >
                        {rescoreMarketId === market.marketId ? "..." : "Rescore"}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
      </div>

      <Dialog open={configOpen} onOpenChange={setConfigOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Configure Market Maker</DialogTitle>
            <DialogDescription className="line-clamp-2">
              {selectedCandidate?.question}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 gap-2 p-3 bg-zinc-50 dark:bg-zinc-900 rounded-lg text-sm">
              <div>
                <div className="text-zinc-500 text-xs">Mid Price</div>
                <div className="font-mono">
                  {((selectedCandidate?.midPrice || 0.5) * 100).toFixed(0)}¢
                </div>
              </div>
              <div>
                <div className="text-zinc-500 text-xs">Spread</div>
                <div className="font-mono">{selectedCandidate?.spreadTicks} ticks</div>
              </div>
              <div>
                <div className="text-zinc-500 text-xs">Top Depth</div>
                <div className="font-mono">
                  ${(selectedCandidate?.topDepth || 0).toFixed(0)}
                </div>
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
                <div className="text-xs text-zinc-500">
                  Toggle between offsets and target spread
                </div>
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
                      value={formValues.bidOffsetTicks ?? ""}
                      onChange={(e) =>
                        setFormValues({
                          ...formValues,
                          bidOffsetTicks: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="askOffsetTicks">Ask Offset (ticks)</Label>
                    <Input
                      id="askOffsetTicks"
                      type="number"
                      value={formValues.askOffsetTicks ?? ""}
                      onChange={(e) =>
                        setFormValues({
                          ...formValues,
                          askOffsetTicks: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                    />
                  </div>
                </>
              ) : (
                <div className="grid gap-2">
                  <Label htmlFor="targetSpread">Target Spread ($)</Label>
                  <Input
                    id="targetSpread"
                    type="number"
                    step="0.01"
                    value={formValues.targetSpread}
                    onChange={(e) =>
                      setFormValues({ ...formValues, targetSpread: Number(e.target.value) })
                    }
                  />
                </div>
              )}
              <div className="grid gap-2">
                <Label htmlFor="orderSize">Order Size (shares)</Label>
                <Input
                  id="orderSize"
                  type="number"
                  value={formValues.orderSize}
                  onChange={(e) =>
                    setFormValues({ ...formValues, orderSize: Number(e.target.value) })
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
                    setFormValues({ ...formValues, maxInventory: Number(e.target.value) })
                  }
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="skewFactor">Skew Factor</Label>
                <Input
                  id="skewFactor"
                  type="number"
                  step="0.01"
                  value={formValues.skewFactor}
                  onChange={(e) =>
                    setFormValues({ ...formValues, skewFactor: Number(e.target.value) })
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
                      minTimeToResolution: Number(e.target.value),
                    })
                  }
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfigOpen(false)}>
              Cancel
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
        </DialogContent>
      </Dialog>
    </div>
  );
}
