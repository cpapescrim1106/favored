export const Paths = {
  HOME: "/",
  DISCOVER: "/discover",
  CANDIDATES: "/candidates",
  BASKET: "/basket",
  PORTFOLIO: "/portfolio",
  MARKET_MAKING: "/market-making",
  CONFIG: "/config",
  LOGS: "/logs",
} as const;

export const ProtectedPaths = [
  Paths.DISCOVER,
  Paths.CANDIDATES,
  Paths.BASKET,
  Paths.PORTFOLIO,
  Paths.MARKET_MAKING,
  Paths.CONFIG,
  Paths.LOGS,
] as const;

export type PathKey = keyof typeof Paths;
