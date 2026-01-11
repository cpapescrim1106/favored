"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  RefreshCw,
  CheckCircle,
  AlertTriangle,
  XCircle,
  Loader2,
  RotateCcw,
} from "lucide-react";
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

interface SyncStatus {
  status: "SYNCED" | "DRIFT_DETECTED" | "ERROR";
  orders: {
    clob: number;
    db: number;
    match: boolean;
    error?: string;
  };
  positions: {
    chain: number;
    chainTotal: string;
    db: number;
    dbTotal: string;
    drift: string;
    match: boolean;
    error?: string;
  };
  lastSync: string | null;
}

interface SyncResult {
  success: boolean;
  duration: number;
  ordersRemoved: number;
  positionsCorrected: number;
  issues: Array<{
    type: string;
    severity: string;
    marketSlug?: string;
    details: Record<string, unknown>;
  }>;
}

export function SyncStatus() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [lastResult, setLastResult] = useState<SyncResult | null>(null);

  const fetchStatus = async () => {
    try {
      const res = await fetch("/api/sync");
      if (res.ok) {
        setStatus(await res.json());
      }
    } catch (e) {
      console.error("Failed to fetch sync status:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    setLastResult(null);
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoCorrect: true }),
      });
      if (res.ok) {
        const result = await res.json();
        setLastResult(result);
        await fetchStatus();
      }
    } catch (e) {
      console.error("Sync failed:", e);
    } finally {
      setSyncing(false);
    }
  };

  const handleReset = async () => {
    setResetting(true);
    try {
      const res = await fetch("/api/sync", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "RESET_TO_CHAIN" }),
      });
      if (res.ok) {
        const result = await res.json();
        setLastResult({
          success: true,
          duration: 0,
          ordersRemoved: result.ordersCleared,
          positionsCorrected: result.marketsReset,
          issues: [],
        });
        await fetchStatus();
      }
    } catch (e) {
      console.error("Reset failed:", e);
    } finally {
      setResetting(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Data Integrity</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-center py-4">
          <Loader2 className="h-4 w-4 animate-spin" />
        </CardContent>
      </Card>
    );
  }

  const getStatusIcon = () => {
    if (!status) return <XCircle className="h-4 w-4 text-gray-400" />;
    switch (status.status) {
      case "SYNCED":
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case "DRIFT_DETECTED":
        return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
      default:
        return <XCircle className="h-4 w-4 text-red-500" />;
    }
  };

  const getStatusBadge = () => {
    if (!status) return <Badge variant="outline">Unknown</Badge>;
    switch (status.status) {
      case "SYNCED":
        return <Badge className="bg-green-500">Synced</Badge>;
      case "DRIFT_DETECTED":
        return <Badge className="bg-yellow-500">Drift Detected</Badge>;
      default:
        return <Badge variant="destructive">Error</Badge>;
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            {getStatusIcon()}
            Data Integrity
          </CardTitle>
          {getStatusBadge()}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {status && (
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-muted-foreground">Orders</div>
              <div className="font-mono">
                CLOB: {status.orders.clob} / DB: {status.orders.db}
                {!status.orders.match && (
                  <span className="text-yellow-500 ml-1">!</span>
                )}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Positions</div>
              <div className="font-mono">
                Chain: {status.positions.chainTotal} / DB: {status.positions.dbTotal}
                {!status.positions.match && (
                  <span className="text-yellow-500 ml-1">
                    ({status.positions.drift})
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {status?.orders.error && (
          <div className="text-sm text-red-500">
            CLOB Error: {status.orders.error}
          </div>
        )}
        {status?.positions.error && (
          <div className="text-sm text-red-500">
            Chain Error: {status.positions.error}
          </div>
        )}

        {lastResult && (
          <div className="text-sm border rounded p-2 bg-muted/50">
            <div className="font-medium mb-1">
              Last Sync: {lastResult.success ? "Success" : "Failed"} ({lastResult.duration}ms)
            </div>
            {lastResult.ordersRemoved > 0 && (
              <div>Stale orders removed: {lastResult.ordersRemoved}</div>
            )}
            {lastResult.positionsCorrected > 0 && (
              <div>Positions corrected: {lastResult.positionsCorrected}</div>
            )}
            {lastResult.issues.length > 0 && (
              <div className="mt-1 text-muted-foreground">
                {lastResult.issues.length} issues found
              </div>
            )}
          </div>
        )}

        {status?.lastSync && (
          <div className="text-xs text-muted-foreground">
            Last full sync: {new Date(status.lastSync).toLocaleString()}
          </div>
        )}

        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleSync}
            disabled={syncing || resetting}
            className="flex-1"
          >
            {syncing ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-1" />
            )}
            Sync Now
          </Button>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="destructive"
                size="sm"
                disabled={syncing || resetting}
              >
                {resetting ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <RotateCcw className="h-4 w-4 mr-1" />
                )}
                Reset
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Reset to Chain State?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will reset ALL market maker inventory to match on-chain
                  positions and clear ALL tracked orders. This is a nuclear
                  option - only use if the database is completely out of sync.
                  <br />
                  <br />
                  <strong>Note:</strong> Realized P&L history will be preserved.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleReset}
                  className="bg-destructive text-destructive-foreground"
                >
                  Reset to Chain
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  );
}
