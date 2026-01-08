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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollText, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDistanceToNow, format } from "date-fns";
import { useState } from "react";

interface Log {
  id: string;
  level: "INFO" | "WARN" | "ERROR";
  category: string;
  message: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

const categories = ["all", "SCAN", "BASKET", "ORDER", "RECONCILE", "EXIT", "SYSTEM"];
const levels = ["all", "INFO", "WARN", "ERROR"];

export default function LogsPage() {
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [levelFilter, setLevelFilter] = useState("all");
  const [limit, setLimit] = useState(100);

  // Fetch logs
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["logs", categoryFilter, levelFilter, limit],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (categoryFilter !== "all") params.set("category", categoryFilter);
      if (levelFilter !== "all") params.set("level", levelFilter);

      const res = await fetch(`/api/logs?${params}`);
      if (!res.ok) throw new Error("Failed to fetch logs");
      return res.json();
    },
    refetchInterval: 10000, // Refresh every 10 seconds
  });

  const logs: Log[] = data?.logs || [];

  const getLevelBadge = (level: string) => {
    switch (level) {
      case "ERROR":
        return <Badge variant="destructive">ERROR</Badge>;
      case "WARN":
        return <Badge variant="secondary" className="bg-yellow-100 text-yellow-800">WARN</Badge>;
      default:
        return <Badge variant="outline">INFO</Badge>;
    }
  };

  const getCategoryBadge = (category: string) => {
    const colors: Record<string, string> = {
      SCAN: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
      BASKET: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
      ORDER: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
      RECONCILE: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
      EXIT: "bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-200",
      SYSTEM: "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200",
    };
    return (
      <Badge variant="outline" className={colors[category] || ""}>
        {category}
      </Badge>
    );
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ScrollText className="h-6 w-6" />
            Logs
          </h1>
          <p className="text-sm text-zinc-500">Audit trail of all system activity</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <RefreshCw className={`h-4 w-4 mr-1 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4 p-3 bg-zinc-100 dark:bg-zinc-900 rounded-lg">
        <div className="flex items-center gap-2">
          <span className="text-sm text-zinc-500">Category:</span>
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-32 h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {categories.map((cat) => (
                <SelectItem key={cat} value={cat}>
                  {cat === "all" ? "All" : cat}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-zinc-500">Level:</span>
          <Select value={levelFilter} onValueChange={setLevelFilter}>
            <SelectTrigger className="w-28 h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {levels.map((level) => (
                <SelectItem key={level} value={level}>
                  {level === "all" ? "All" : level}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-zinc-500">Limit:</span>
          <Select value={String(limit)} onValueChange={(v) => setLimit(Number(v))}>
            <SelectTrigger className="w-24 h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="50">50</SelectItem>
              <SelectItem value="100">100</SelectItem>
              <SelectItem value="250">250</SelectItem>
              <SelectItem value="500">500</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="ml-auto text-sm text-zinc-500">{logs.length} entries</div>
      </div>

      {/* Table */}
      <div className="border rounded-lg overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-zinc-50 dark:bg-zinc-900">
              <TableHead className="w-[160px]">Time</TableHead>
              <TableHead className="w-[80px]">Level</TableHead>
              <TableHead className="w-[100px]">Category</TableHead>
              <TableHead>Message</TableHead>
              <TableHead className="w-[200px]">Metadata</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 10 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : logs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-12 text-zinc-500">
                  <ScrollText className="h-12 w-12 mx-auto mb-2 opacity-20" />
                  <p>No logs found</p>
                </TableCell>
              </TableRow>
            ) : (
              logs.map((log) => (
                <TableRow
                  key={log.id}
                  className={
                    log.level === "ERROR"
                      ? "bg-red-50/50 dark:bg-red-950/20"
                      : log.level === "WARN"
                      ? "bg-yellow-50/50 dark:bg-yellow-950/20"
                      : ""
                  }
                >
                  <TableCell className="font-mono text-xs">
                    <div>{format(new Date(log.createdAt), "MMM d HH:mm:ss")}</div>
                    <div className="text-zinc-400">
                      {formatDistanceToNow(new Date(log.createdAt), {
                        addSuffix: true,
                      })}
                    </div>
                  </TableCell>
                  <TableCell>{getLevelBadge(log.level)}</TableCell>
                  <TableCell>{getCategoryBadge(log.category)}</TableCell>
                  <TableCell className="max-w-[400px]">
                    <span className="line-clamp-2">{log.message}</span>
                  </TableCell>
                  <TableCell className="text-xs font-mono text-zinc-500">
                    {log.metadata ? (
                      <pre className="whitespace-pre-wrap max-h-20 overflow-y-auto">
                        {JSON.stringify(log.metadata, null, 2)}
                      </pre>
                    ) : (
                      "—"
                    )}
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
