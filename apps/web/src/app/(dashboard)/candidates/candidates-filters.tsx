"use client";

import { Input } from "@/components/ui/input";
import { MultiSelect } from "@/components/ui/multi-select";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Filter, Search } from "lucide-react";
import type { CandidateFilters, SideFilter, ClosesFilter } from "./use-candidates-filters";

interface CandidatesFiltersProps {
  filters: CandidateFilters;
  onFiltersChange: (updates: Partial<CandidateFilters>) => void;
  categories: string[];
  resultCount: number;
}

const CLOSES_OPTIONS = [
  { value: "all", label: "All" },
  { value: "24h", label: "< 24hr" },
  { value: "1w", label: "< 1 Week" },
  { value: "2w", label: "< 2 Weeks" },
  { value: "1m", label: "< 1 Month" },
];

export function CandidatesFilters({
  filters,
  onFiltersChange,
  categories,
  resultCount,
}: CandidatesFiltersProps) {
  const categoryOptions = categories.map((cat) => ({
    label: cat === "uncategorized" ? "Uncategorized" : cat,
    value: cat,
  }));

  return (
    <div className="space-y-3 p-3 bg-zinc-100 dark:bg-zinc-900 rounded-lg">
      {/* Row 1: Search, Side, Closes */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
          <Input
            placeholder="Search markets..."
            value={filters.search}
            onChange={(e) => onFiltersChange({ search: e.target.value })}
            className="pl-8 h-8"
          />
        </div>

        {/* Side Toggle */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-zinc-500">Side:</span>
          <ToggleGroup
            type="single"
            value={filters.side}
            onValueChange={(value) => value && onFiltersChange({ side: value as SideFilter })}
            className="bg-white dark:bg-zinc-800 rounded-md border"
          >
            <ToggleGroupItem value="all" className="h-8 px-3 text-xs">
              All
            </ToggleGroupItem>
            <ToggleGroupItem value="YES" className="h-8 px-3 text-xs">
              YES
            </ToggleGroupItem>
            <ToggleGroupItem value="NO" className="h-8 px-3 text-xs">
              NO
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        {/* Closes Dropdown */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-zinc-500">Closes:</span>
          <Select
            value={filters.closes}
            onValueChange={(value) => onFiltersChange({ closes: value as ClosesFilter })}
          >
            <SelectTrigger className="w-32 h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CLOSES_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Row 2: Categories, Spread, Liquidity, Score */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-zinc-500" />
        </div>

        {/* Categories Multi-select */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-zinc-500">Categories:</span>
          <MultiSelect
            options={categoryOptions}
            onValueChange={(values) => onFiltersChange({ categories: values })}
            defaultValue={filters.categories}
            placeholder="All Categories"
            className="w-48"
            maxCount={2}
          />
        </div>

        {/* Max Spread */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-zinc-500 whitespace-nowrap">Max Spread:</span>
          <div className="flex items-center gap-2 w-32">
            <Slider
              value={[filters.maxSpread ?? 20]}
              onValueChange={([value]) =>
                onFiltersChange({ maxSpread: value === 20 ? null : value })
              }
              max={20}
              min={0}
              step={0.5}
              className="flex-1"
            />
            <span className="text-xs text-zinc-500 w-10 text-right">
              {filters.maxSpread !== null ? `${filters.maxSpread}%` : "Any"}
            </span>
          </div>
        </div>

        {/* Min Liquidity */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-zinc-500 whitespace-nowrap">Min Liq:</span>
          <Input
            type="number"
            value={filters.minLiquidity ?? ""}
            onChange={(e) =>
              onFiltersChange({
                minLiquidity: e.target.value ? Number(e.target.value) : null,
              })
            }
            placeholder="$0"
            className="w-20 h-8"
            min={0}
          />
        </div>

        {/* Min Score */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-zinc-500">Min Score:</span>
          <Input
            type="number"
            value={filters.minScore}
            onChange={(e) => onFiltersChange({ minScore: Number(e.target.value) })}
            className="w-20 h-8"
            min={0}
            max={100}
          />
        </div>

        {/* Result Count */}
        <div className="ml-auto text-sm text-zinc-500">{resultCount} candidates</div>
      </div>
    </div>
  );
}
