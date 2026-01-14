import { KalshiAdapter } from "../kalshi/adapter.js";
import { PolymarketAdapter } from "../polymarket/adapter.js";
import { registerVenue } from "./registry.js";

let registered = false;

export function registerDefaultVenues(): void {
  if (registered) return;
  registerVenue(new PolymarketAdapter());
  registerVenue(new KalshiAdapter());
  registered = true;
}
