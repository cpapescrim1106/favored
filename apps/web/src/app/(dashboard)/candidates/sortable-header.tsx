"use client";

import { useState } from "react";
import { TableHead } from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ArrowUp, ArrowDown, ListFilter } from "lucide-react";
import { cn } from "@/utils/shadcn";
import type { SortColumn, SortDirection } from "./use-candidates-filters";
import { HEADER_PADDING, GROUP_BORDER } from "./columns-config";

interface SortableHeaderProps {
  column: SortColumn;
  label: string;
  currentSort: SortColumn | null;
  currentDir: SortDirection | null;
  onSort: (column: SortColumn) => void;
  width: string;
  align: string;
  filterContent?: React.ReactNode;
  isFilterActive?: boolean;
  groupStart?: boolean;
}

export function SortableHeader({
  column,
  label,
  currentSort,
  currentDir,
  onSort,
  width,
  align,
  filterContent,
  isFilterActive = false,
  groupStart = false,
}: SortableHeaderProps) {
  const [filterOpen, setFilterOpen] = useState(false);
  const isSortActive = currentSort === column;
  const isRightAligned = align.includes("text-right");
  const isCenterAligned = align.includes("text-center");

  return (
    <TableHead
      className={cn(
        width,
        align,
        HEADER_PADDING,
        groupStart && GROUP_BORDER
      )}
    >
      <div
        className={cn(
          "flex items-center gap-1",
          isRightAligned && "justify-end",
          isCenterAligned && "justify-center"
        )}
      >
        {/* Filter button - on left for left-aligned columns */}
        {filterContent && !isRightAligned && !isCenterAligned && (
          <FilterButton
            isActive={isFilterActive}
            isOpen={filterOpen}
            onOpenChange={setFilterOpen}
          >
            {filterContent}
          </FilterButton>
        )}

        {/* Sortable label + icon (stable width) */}
        <button
          type="button"
          onClick={() => onSort(column)}
          className="flex items-center gap-1 cursor-pointer select-none hover:text-foreground transition-colors"
        >
          <span className="text-xs font-medium">{label}</span>
          {/* Fixed-width icon container to prevent jitter */}
          <span className="w-4 h-4 flex items-center justify-center">
            {isSortActive ? (
              currentDir === "asc" ? (
                <ArrowUp className="h-3 w-3" />
              ) : (
                <ArrowDown className="h-3 w-3" />
              )
            ) : (
              // Invisible placeholder to maintain spacing
              <ArrowUp className="h-3 w-3 opacity-0" />
            )}
          </span>
        </button>

        {/* Filter button - on right for right-aligned or center columns */}
        {filterContent && (isRightAligned || isCenterAligned) && (
          <FilterButton
            isActive={isFilterActive}
            isOpen={filterOpen}
            onOpenChange={setFilterOpen}
          >
            {filterContent}
          </FilterButton>
        )}
      </div>
    </TableHead>
  );
}

// Non-sortable header with filter only (for Market, Side, Category columns)
interface FilterableHeaderProps {
  label: string;
  width: string;
  align: string;
  filterContent?: React.ReactNode;
  isFilterActive?: boolean;
  groupStart?: boolean;
}

export function FilterableHeader({
  label,
  width,
  align,
  filterContent,
  isFilterActive = false,
  groupStart = false,
}: FilterableHeaderProps) {
  const [filterOpen, setFilterOpen] = useState(false);
  const isRightAligned = align.includes("text-right");
  const isCenterAligned = align.includes("text-center");

  return (
    <TableHead
      className={cn(
        width,
        align,
        HEADER_PADDING,
        groupStart && GROUP_BORDER
      )}
    >
      <div
        className={cn(
          "flex items-center gap-1",
          isRightAligned && "justify-end",
          isCenterAligned && "justify-center"
        )}
      >
        {/* Filter button - on left for left-aligned columns */}
        {filterContent && !isRightAligned && !isCenterAligned && (
          <FilterButton
            isActive={isFilterActive}
            isOpen={filterOpen}
            onOpenChange={setFilterOpen}
          >
            {filterContent}
          </FilterButton>
        )}

        <span className="text-xs font-medium">{label}</span>

        {/* Filter button - on right for right-aligned or center columns */}
        {filterContent && (isRightAligned || isCenterAligned) && (
          <FilterButton
            isActive={isFilterActive}
            isOpen={filterOpen}
            onOpenChange={setFilterOpen}
          >
            {filterContent}
          </FilterButton>
        )}
      </div>
    </TableHead>
  );
}

// Plain header without filter or sort (for Actions column)
interface PlainHeaderProps {
  label: string;
  width: string;
  align: string;
  groupStart?: boolean;
}

export function PlainHeader({
  label,
  width,
  align,
  groupStart = false,
}: PlainHeaderProps) {
  return (
    <TableHead
      className={cn(
        width,
        align,
        HEADER_PADDING,
        groupStart && GROUP_BORDER
      )}
    >
      <span className="text-xs font-medium">{label}</span>
    </TableHead>
  );
}

// Shared filter button component
interface FilterButtonProps {
  isActive: boolean;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

function FilterButton({ isActive, isOpen, onOpenChange, children }: FilterButtonProps) {
  return (
    <Popover open={isOpen} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenChange(true);
          }}
          className={cn(
            "w-4 h-4 flex items-center justify-center rounded hover:bg-muted transition-colors",
            isActive ? "text-blue-500" : "text-muted-foreground/50 hover:text-muted-foreground"
          )}
        >
          <ListFilter className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-auto p-0"
        onInteractOutside={() => onOpenChange(false)}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
