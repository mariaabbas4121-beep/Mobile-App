import type { GeoPoint } from '../api/types';

// Foreground location only: NeighborShare never asks for background access
// and never tracks location while the app is in the background.

export type PermissionState = 'granted' | 'denied' | 'undetermined';

export interface PermissionInfo {
  status: PermissionState;
  // False when the OS will not show the prompt again (user chose "Don't
  // ask again" or denied in Settings): only Settings can change it.
  canAskAgain: boolean;
}

export class LocationTimeoutError extends Error {
  constructor() {
    super('Location request timed out');
    this.name = 'LocationTimeoutError';
  }
}

export class LocationUnavailableError extends Error {
  constructor(message = 'Location is unavailable') {
    super(message);
    this.name = 'LocationUnavailableError';
  }
}

// The device's location services (GPS / network location) are switched off.
export class LocationServicesOffError extends LocationUnavailableError {
  constructor() {
    super('Location services are turned off');
    this.name = 'LocationServicesOffError';
  }
}

// What the app needs from the device, injectable for tests.
export interface LocationService {
  permission(): Promise<PermissionInfo>;
  // Shows the OS prompt (only while canAskAgain).
  requestPermission(): Promise<PermissionInfo>;
  // Whether location services (GPS) are on for the whole device.
  servicesEnabled(): Promise<boolean>;
  // Asks the OS to switch location services on. Android shows its own
  // "Turn on location" dialog; iOS has no such dialog, so this is false
  // there and the user must use Settings. True once they are on.
  enableServices(): Promise<boolean>;
  // Whether enableServices() can show a system dialog (Android).
  readonly canEnableServicesInApp: boolean;
  // Throws LocationServicesOffError, LocationTimeoutError or
  // LocationUnavailableError.
  current(timeoutMs: number): Promise<GeoPoint>;
  // Updates while subscribed; returns an unsubscribe function.
  watch(onChange: (point: GeoPoint) => void): Promise<() => void>;
  openSettings(): void;
}

export const LOCATION_TIMEOUT_MS = 15_000;
// A recent fix is good enough to start with and much faster than a new one.
const LAST_KNOWN_MAX_AGE_MS = 5 * 60_000;
// Watch thresholds: battery-friendly accuracy, at most one update a minute
// and only after moving 200 m.
const WATCH_INTERVAL_MS = 60_000;
const WATCH_DISTANCE_M = 200;

export function expoLocationService(): LocationService {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const Location = require('expo-location') as typeof import('expo-location');
  const { Linking, Platform } = require('react-native') as typeof import('react-native');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const info = (r: { status: string; canAskAgain: boolean }): PermissionInfo => ({
    status: r.status === 'granted' ? 'granted' : r.status === 'denied' ? 'denied' : 'undetermined',
    canAskAgain: r.canAskAgain,
  });
  const point = (l: { coords: { latitude: number; longitude: number } }): GeoPoint => ({
    latitude: l.coords.latitude,
    longitude: l.coords.longitude,
  });

  const servicesEnabled = () => Location.hasServicesEnabledAsync().catch(() => false);
  const android = Platform.OS === 'android';

  return {
    permission: async () => info(await Location.getForegroundPermissionsAsync()),
    requestPermission: async () => info(await Location.requestForegroundPermissionsAsync()),
    servicesEnabled,
    canEnableServicesInApp: android,
    async enableServices() {
      if (!android) return false;
      try {
        // Rejects when the user dismisses the dialog.
        await Location.enableNetworkProviderAsync();
      } catch {
        return false;
      }
      return servicesEnabled();
    },
    async current(timeoutMs) {
      if (!(await servicesEnabled())) throw new LocationServicesOffError();
      const recent = await Location.getLastKnownPositionAsync({ maxAge: LAST_KNOWN_MAX_AGE_MS }).catch(() => null);
      if (recent) return point(recent);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).then(point),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new LocationTimeoutError()), timeoutMs);
          }),
        ]);
      } catch (err) {
        if (err instanceof LocationTimeoutError) throw err;
        throw new LocationUnavailableError();
      } finally {
        clearTimeout(timer);
      }
    },
    async watch(onChange) {
      const sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, timeInterval: WATCH_INTERVAL_MS, distanceInterval: WATCH_DISTANCE_M },
        (l) => onChange(point(l)),
      );
      return () => sub.remove();
    },
    openSettings: () => void Linking.openSettings().catch(() => undefined),
  };
}
