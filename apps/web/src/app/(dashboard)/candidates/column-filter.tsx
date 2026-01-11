"use client";

import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Search, X } from "lucide-react";
import type { CandidateFilters, SideFilter, ClosesFilter } from "./use-candidates-filters";

export type FilterColumn =
  | "market"
  | "side"
  | "prob"
  | "price"
  | "spread"
  | "liquidity"
  | "score"
  | "category"
  | "closes";

interface ColumnFilterProps {
  column: FilterColumn;
  filters: CandidateFilters;
  onFiltersChange: (updates: Partial<CandidateFilters>) => void;
  categories?: string[];
  onClose?: () => void;
}

const CLOSES_OPTIONS: { value: ClosesFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "24h", label: "< 24 hours" },
  { value: "1w", label: "< 1 week" },
  { value: "2w", label: "< 2 weeks" },
  { value: "1m", label: "< 1 month" },
];

const SIDE_OPTIONS: { value: "YES" | "NO"; label: string }[] = [
  { value: "YES", label: "YES" },
  { value: "NO", label: "NO" },
];

export function ColumnFilter({
  column,
  filters,
  onFiltersChange,
  categories = [],
  onClose,
}: ColumnFilterProps) {
  const handleClear = () => {
    switch (column) {
      case "market":
        onFiltersChange({ search: "" });
        break;
      case "side":
        onFiltersChange({ side: "all" });
        break;
      case "prob":
        onFiltersChange({ minProb: null, maxProb: null });
        break;
      case "price":
        onFiltersChange({ minPrice: null, maxPrice: null });
        break;
      case "spread":
        onFiltersChange({ maxSpread: null });
        break;
      case "liquidity":
        onFiltersChange({ minLiquidity: null });
        break;
      case "score":
        onFiltersChange({ minScore: 60 });
        break;
      case "category":
        onFiltersChange({ categories: [] });
        break;
      case "closes":
        onFiltersChange({ closes: "all" });
        break;
    }
    onClose?.();
  };

  const renderContent = () => {
    switch (column) {
      case "market":
        return (
          <div className="space-y-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
              <Input
                placeholder="Search markets..."
                value={filters.search}
                onChange={(e) => onFiltersChange({ search: e.target.value })}
                className="pl-8 h-8"
                autoFocus
              />
            </div>
          </div>
        );

      case "side":
        return (
          <div className="space-y-2">
            {SIDE_OPTIONS.map((option) => {
              const isChecked =
                filters.side === "all" || filters.side === option.value;
              const selectedSides =
                filters.side === "all"
                  ? ["YES", "NO"]
                  : filters.side === "YES"
                    ? ["YES"]
                    : ["NO"];

              return (
                <div key={option.value} className="flex items-center gap-2">
                  <Checkbox
                    id={`side-${option.value}`}
                    checked={selectedSides.includes(option.value)}
                    onCheckedChange={(checked) => {
                      let newSides = [...selectedSides];
                      if (checked) {
                        newSides.push(option.value);
                      } else {
                        newSides = newSides.filter((s) => s !== option.value);
                      }
                      if (newSides.length === 0 || newSides.length === 2) {
                        onFiltersChange({ side: "all" });
                      } else {
                        onFiltersChange({ side: newSides[0] as SideFilter });
                      }
                    }}
                  />
                  <Label htmlFor={`side-${option.value}`} className="text-sm cursor-pointer">
                    {option.label}
                  </Label>
                </div>
              );
            })}
          </div>
        );

      case "prob":
        return (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Label className="text-xs text-zinc-500 w-8">Min</Label>
              <Input
                type="number"
                placeholder="0"
                value={filters.minProb ?? ""}
                onChange={(e) =>
                  onFiltersChange({
                    minProb: e.target.value ? Number(e.target.value) : null,
                  })
                }
                className="h-8 w-20"
                min={0}
                max={100}
              />
              <span className="text-xs text-zinc-500">%</span>
            </div>
            <div className="flex items-center gap-2">
              <Label className="text-xs text-zinc-500 w-8">Max</Label>
              <Input
                type="number"
                placeholder="100"
                value={filters.maxProb ?? ""}
                onChange={(e) =>
                  onFiltersChange({
                    maxProb: e.target.value ? Number(e.target.value) : null,
                  })
                }
                className="h-8 w-20"
                min={0}
                max={100}
              />
              <span className="text-xs text-zinc-500">%</span>
            </div>
          </div>
        );

      case "price":
        return (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Label className="text-xs text-zinc-500 w-8">Min</Label>
              <span className="text-xs text-zinc-500">$</span>
              <Input
                type="number"
                placeholder="0"
                value={filters.minPrice ?? ""}
                onChange={(e) =>
                  onFiltersChange({
                    minPrice: e.target.value ? Number(e.target.value) : null,
                  })
                }
                className="h-8 w-20"
                min={0}
                max={1}
                step={0.01}
              />
            </div>
            <div className="flex items-center gap-2">
              <Label className="text-xs text-zinc-500 w-8">Max</Label>
              <span className="text-xs text-zinc-500">$</span>
              <Input
                type="number"
                placeholder="1"
                value={filters.maxPrice ?? ""}
                onChange={(e) =>
                  onFiltersChange({
                    maxPrice: e.target.value ? Number(e.target.value) : null,
                  })
                }
                className="h-8 w-20"
                min={0}
                max={1}
                step={0.01}
              />
            </div>
          </div>
        );

      case "spread":
        return (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500">Max spread:</span>
              <span className="text-sm font-medium w-12">
                {filters.maxSpread !== null ? `±${filters.maxSpread / 2}¢` : "Any"}
              </span>
            </div>
            <Slider
              value={[filters.maxSpread ?? 20]}
              onValueChange={([value]) =>
                onFiltersChange({ maxSpread: value === 20 ? null : value })
              }
              max={20}
              min={0}
              step={0.5}
            />
            <p className="text-xs text-zinc-400">Full spread = 2× displayed value</p>
          </div>
        );

      case "liquidity":
        return (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Label className="text-xs text-zinc-500">Min:</Label>
              <span className="text-xs text-zinc-500">$</span>
              <Input
                type="number"
                placeholder="0"
                value={filters.minLiquidity ?? ""}
                onChange={(e) =>
                  onFiltersChange({
                    minLiquidity: e.target.value ? Number(e.target.value) : null,
                  })
                }
                className="h-8 w-24"
                min={0}
              />
            </div>
          </div>
        );

      case "score":
        return (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Label className="text-xs text-zinc-500">Min:</Label>
              <Input
                type="number"
                value={filters.minScore}
                onChange={(e) =>
                  onFiltersChange({ minScore: Number(e.target.value) || 0 })
                }
                className="h-8 w-20"
                min={0}
                max={100}
              />
            </div>
          </div>
        );

      case "category":
        return (
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {categories.map((cat) => {
              const displayName = cat === "uncategorized" ? "Uncategorized" : cat;
              const isChecked =
                filters.categories.length === 0 ||
                filters.categories.includes(cat);

              return (
                <div key={cat} className="flex items-center gap-2">
                  <Checkbox
                    id={`cat-${cat}`}
                    checked={isChecked}
                    onCheckedChange={(checked) => {
                      let newCategories: string[];
                      if (filters.categories.length === 0) {
                        // Currently showing all, now selecting specific one
                        if (!checked) {
                          newCategories = categories.filter((c) => c !== cat);
                        } else {
                          newCategories = [];
                        }
                      } else {
                        if (checked) {
                          newCategories = [...filters.categories, cat];
                          // If all selected, reset to empty (show all)
                          if (newCategories.length === categories.length) {
                            newCategories = [];
                          }
                        } else {
                          newCategories = filters.categories.filter((c) => c !== cat);
                        }
                      }
                      onFiltersChange({ categories: newCategories });
                    }}
                  />
                  <Label htmlFor={`cat-${cat}`} className="text-sm cursor-pointer">
                    {displayName}
                  </Label>
                </div>
              );
            })}
          </div>
        );

      case "closes":
        return (
          <RadioGroup
            value={filters.closes}
            onValueChange={(value) => onFiltersChange({ closes: value as ClosesFilter })}
            className="space-y-2"
          >
            {CLOSES_OPTIONS.map((option) => (
              <div key={option.value} className="flex items-center gap-2">
                <RadioGroupItem value={option.value} id={`closes-${option.value}`} />
                <Label htmlFor={`closes-${option.value}`} className="text-sm cursor-pointer">
                  {option.label}
                </Label>
              </div>
            ))}
          </RadioGroup>
        );

      default:
        return null;
    }
  };

  return (
    <div className="p-3 space-y-3 min-w-[180px]">
      {renderContent()}
      <div className="pt-2 border-t">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleClear}
          className="w-full h-7 text-xs text-zinc-500 hover:text-zinc-900"
        >
          <X className="h-3 w-3 mr-1" />
          Clear filter
        </Button>
      </div>
    </div>
  );
}

// Helper to check if a column has an active filter
export function isFilterActive(column: FilterColumn, filters: CandidateFilters): boolean {
  switch (column) {
    case "market":
      return filters.search !== "";
    case "side":
      return filters.side !== "all";
    case "prob":
      return filters.minProb !== null || filters.maxProb !== null;
    case "price":
      return filters.minPrice !== null || filters.maxPrice !== null;
    case "spread":
      return filters.maxSpread !== null;
    case "liquidity":
      return filters.minLiquidity !== null;
    case "score":
      return filters.minScore !== 60;
    case "category":
      return filters.categories.length > 0;
    case "closes":
      return filters.closes !== "all";
    default:
      return false;
  }
}
