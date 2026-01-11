export const Paths = {
  HOME: "/",
  CANDIDATES: "/candidates",
  BASKET: "/basket",
  PORTFOLIO: "/portfolio",
  MARKET_MAKING: "/market-making",
  CONFIG: "/config",
  LOGS: "/logs",
} as const;

export type PathKey = keyof typeof Paths;
