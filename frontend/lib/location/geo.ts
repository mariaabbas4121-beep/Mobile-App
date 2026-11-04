import type { GeoPoint } from '../api/types';

// Radius choices offered in the app. The server accepts 0.5-50 km.
export const RADIUS_OPTIONS_KM = [3, 5, 10] as const;
export const DEFAULT_RADIUS_KM = 3;

// Only re-search when the user has moved at least this far, so GPS jitter
// and short walks do not cause a request each time.
export const RESEARCH_DISTANCE_KM = 0.3;

export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(r(b.latitude - a.latitude) / 2) ** 2 +
    Math.cos(r(a.latitude)) * Math.cos(r(b.latitude)) * Math.sin(r(b.longitude - a.longitude) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Listing points are about 0.5 km from the real spot, so distances are
// shown as approximate and never more precise than that.
export function formatDistance(km: number): string {
  if (km < 0.5) return 'Under 0.5 km away';
  if (km < 10) return `About ${km.toFixed(1)} km away`;
  return `About ${Math.round(km)} km away`;
}

// The next radius worth offering when there are few results.
export function nextRadius(current: number): number | null {
  return RADIUS_OPTIONS_KM.find((r) => r > current) ?? null;
}

// Map region showing a circle of `radiusKm` around `center`, with a margin.
export function regionFor(center: GeoPoint, radiusKm: number) {
  const latitudeDelta = ((radiusKm * 2.4) / 111.32);
  const longitudeDelta = latitudeDelta / Math.max(0.2, Math.cos((center.latitude * Math.PI) / 180));
  return { latitude: center.latitude, longitude: center.longitude, latitudeDelta, longitudeDelta };
}
