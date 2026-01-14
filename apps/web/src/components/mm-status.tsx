"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { CheckCircle, AlertTriangle, XCircle, Loader2, ChevronDown } from "lucide-react";

type CheckResult = {
  ok: boolean;
  durationMs: number;
  count?: number | null;
  balance?: number | null;
  portfolioValue?: number | null;
  error?: string;
};

type StatusPayload = {
  dependencyHealth: {
    degraded: boolean;
    balance: CheckResult;
    openOrders: CheckResult;
    positions: CheckResult;
  };
  kalshi?: {
    configured: boolean;
    dependencyHealth: {
      degraded: boolean;
      balance: CheckResult;
      openOrders: CheckResult;
      positions: CheckResult;
    };
  };
  marketMaking: {
    enabled: boolean;
    killSwitchActive: boolean;
  };
};

const getBadge = (label: string, configured: boolean, degraded: boolean) => {
  if (!configured) {
    return (
      <Badge variant="outline" className="text-xs">
        {label}: Off
      </Badge>
    );
  }
  if (degraded) {
    return (
      <Badge className="bg-yellow-500 hover:bg-yellow-500 text-xs">
        {label}: Degraded
      </Badge>
    );
  }
  return (
    <Badge className="bg-green-500 hover:bg-green-500 text-xs">
      {label}: OK
    </Badge>
  );
};

const getStatusIcon = (configured: boolean, degraded: boolean, loading: boolean) => {
  if (loading) return <Loader2 className="h-4 w-4 animate-spin" />;
  if (!configured) return <XCircle className="h-4 w-4 text-zinc-400" />;
  if (degraded) return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
  return <CheckCircle className="h-4 w-4 text-green-500" />;
};

export function MarketMakingStatus() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStatus = async () => {
    try {
      const res = await fetch("/api/market-making/status");
      if (res.ok) {
        setStatus(await res.json());
      }
    } catch (error) {
      console.error("Failed to fetch MM status:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 30000);
    return () => clearInterval(interval);
  }, []);

  const kalshiConfigured = status?.kalshi?.configured ?? false;
  const polyDegraded = status?.dependencyHealth.degraded ?? true;
  const kalshiDegraded = status?.kalshi?.dependencyHealth.degraded ?? true;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          {getStatusIcon(true, polyDegraded, loading)}
          <span className="hidden sm:inline">MM Status</span>
          {getBadge("Poly", true, polyDegraded)}
          {getBadge("Kalshi", kalshiConfigured, kalshiDegraded)}
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96" align="end">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="font-medium text-sm">Market Making Status</h4>
            <div className="flex gap-2">
              {getBadge("Poly", true, polyDegraded)}
              {getBadge("Kalshi", kalshiConfigured, kalshiDegraded)}
            </div>
          </div>

          <div className="grid gap-3 text-sm">
            <div className="rounded-md border border-zinc-200 dark:border-zinc-800 p-3">
              <div className="flex items-center justify-between">
                <div className="font-medium">Polymarket</div>
                {getStatusIcon(true, polyDegraded, loading)}
              </div>
              {status && (
                <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-zinc-500">
                  <div>
                    Bal:{" "}
                    {status.dependencyHealth.balance.ok
                      ? `$${status.dependencyHealth.balance.balance?.toFixed(0) ?? "—"}`
                      : "—"}
                  </div>
                  <div>
                    Orders:{" "}
                    {status.dependencyHealth.openOrders.ok
                      ? status.dependencyHealth.openOrders.count ?? 0
                      : "—"}
                  </div>
                  <div>
                    Pos:{" "}
                    {status.dependencyHealth.positions.ok
                      ? status.dependencyHealth.positions.count ?? 0
                      : "—"}
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-md border border-zinc-200 dark:border-zinc-800 p-3">
              <div className="flex items-center justify-between">
                <div className="font-medium">Kalshi</div>
                {getStatusIcon(kalshiConfigured, kalshiDegraded, loading)}
              </div>
              {kalshiConfigured && status?.kalshi && (
                <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-zinc-500">
                  <div>
                    Bal:{" "}
                    {status.kalshi.dependencyHealth.balance.ok
                      ? `$${status.kalshi.dependencyHealth.balance.balance?.toFixed(0) ?? "—"}`
                      : "—"}
                  </div>
                  <div>
                    Orders:{" "}
                    {status.kalshi.dependencyHealth.openOrders.ok
                      ? status.kalshi.dependencyHealth.openOrders.count ?? 0
                      : "—"}
                  </div>
                  <div>
                    Pos:{" "}
                    {status.kalshi.dependencyHealth.positions.ok
                      ? status.kalshi.dependencyHealth.positions.count ?? 0
                      : "—"}
                  </div>
                </div>
              )}
              {!kalshiConfigured && (
                <div className="mt-2 text-xs text-zinc-500">
                  Not configured (set KALSHI_KEY_ID + KALSHI_PRIVATE_KEY)
                </div>
              )}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
