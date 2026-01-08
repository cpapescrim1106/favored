export const Paths = {
  HOME: "/",
  CANDIDATES: "/candidates",
  BASKET: "/basket",
  PORTFOLIO: "/portfolio",
  CONFIG: "/config",
  LOGS: "/logs",
} as const;

export type PathKey = keyof typeof Paths;
