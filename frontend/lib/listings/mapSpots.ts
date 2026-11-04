import type { GeoPoint, Listing } from '../api/types';

// Map markers. Listings are placed at their approximate public point only;
// listings of the same owner share one (the per-owner privacy offset), so
// items at the same point become one marker instead of hidden stacks.

export interface MapSpot {
  key: string;
  point: GeoPoint;
  // In feed order (nearest first for nearby searches).
  items: Listing[];
}

export const MARKER_LABEL_MAX = 14;

// Public points are rounded to 3 decimals, so equal points compare exactly.
const pointKey = (p: GeoPoint) => `${p.latitude.toFixed(3)},${p.longitude.toFixed(3)}`;

export function groupByPoint(items: Listing[]): MapSpot[] {
  const spots = new Map<string, MapSpot>();
  for (const item of items) {
    if (!item.approximateLocation) continue;
    const key = pointKey(item.approximateLocation);
    const spot = spots.get(key);
    if (spot) spot.items.push(item);
    else spots.set(key, { key, point: item.approximateLocation, items: [item] });
  }
  return [...spots.values()];
}

// A short marker label: the title, cut at a word where possible.
export function shortLabel(title: string, max = MARKER_LABEL_MAX): string {
  const t = title.trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space >= max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function spotLabel(spot: MapSpot): string {
  return spot.items.length > 1 ? `${spot.items.length} items` : shortLabel(spot.items[0]!.title);
}
