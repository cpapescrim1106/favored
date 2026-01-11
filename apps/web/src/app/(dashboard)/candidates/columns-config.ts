import type { SortColumn } from "./use-candidates-filters";

export interface ColumnConfig {
  key: string;
  label: string;
  sortKey?: SortColumn;
  width: string;
  alignHead: string;
  alignCell: string;
  hasFilter: boolean;
  groupStart?: boolean; // Add border-l for visual grouping
}

export const columns: ColumnConfig[] = [
  {
    key: "market",
    label: "Market",
    width: "max-w-[400px]",
    alignHead: "text-left",
    alignCell: "text-left",
    hasFilter: true,
  },
  {
    key: "side",
    label: "Side",
    width: "w-[60px]",
    alignHead: "text-center",
    alignCell: "text-center",
    hasFilter: true,
  },
  {
    key: "prob",
    label: "Prob (%)",
    sortKey: "prob",
    width: "w-[80px]",
    alignHead: "text-right",
    alignCell: "text-right tabular-nums",
    hasFilter: true,
    groupStart: true,
  },
  {
    key: "price",
    label: "Price ($)",
    sortKey: "price",
    width: "w-[80px]",
    alignHead: "text-right",
    alignCell: "text-right tabular-nums",
    hasFilter: true,
  },
  {
    key: "spread",
    label: "Spread",
    sortKey: "spread",
    width: "w-[70px]",
    alignHead: "text-right",
    alignCell: "text-right tabular-nums",
    hasFilter: true,
  },
  {
    key: "liquidity",
    label: "Liq ($)",
    sortKey: "liquidity",
    width: "w-[90px]",
    alignHead: "text-right",
    alignCell: "text-right tabular-nums",
    hasFilter: true,
  },
  {
    key: "score",
    label: "Score",
    sortKey: "score",
    width: "w-[70px]",
    alignHead: "text-right",
    alignCell: "text-right tabular-nums",
    hasFilter: true,
  },
  {
    key: "category",
    label: "Category",
    width: "w-[100px]",
    alignHead: "text-left",
    alignCell: "text-left",
    hasFilter: true,
    groupStart: true,
  },
  {
    key: "closes",
    label: "Closes",
    sortKey: "closes",
    width: "w-[110px]",
    alignHead: "text-left",
    alignCell: "text-left",
    hasFilter: true,
  },
  {
    key: "actions",
    label: "",
    width: "w-[44px]",
    alignHead: "text-center",
    alignCell: "text-center",
    hasFilter: false,
  },
];

// Helper to get column config by key
export function getColumn(key: string): ColumnConfig | undefined {
  return columns.find((c) => c.key === key);
}

// Shared padding classes
export const HEADER_PADDING = "px-3 h-10";
export const CELL_PADDING = "px-3 h-12";

// Group border class
export const GROUP_BORDER = "border-l border-border/50";
