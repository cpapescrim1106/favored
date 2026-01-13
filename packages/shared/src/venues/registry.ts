import type { VenueAdapter } from "./adapter.js";
import type { VenueId } from "./types.js";

const registry = new Map<VenueId, VenueAdapter>();

export function registerVenue(adapter: VenueAdapter): void {
  registry.set(adapter.id, adapter);
}

export function getVenueAdapter(id: VenueId): VenueAdapter {
  const adapter = registry.get(id);
  if (!adapter) {
    throw new Error(`Venue adapter not registered: ${id}`);
  }
  return adapter;
}

export function listVenueAdapters(): VenueAdapter[] {
  return Array.from(registry.values());
}
