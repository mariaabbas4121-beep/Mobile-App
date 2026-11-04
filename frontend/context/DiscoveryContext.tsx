import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import type { GeoPoint } from '../lib/api/types';
import { DEFAULT_RADIUS_KM, RESEARCH_DISTANCE_KM, haversineKm } from '../lib/location/geo';
import {
  LOCATION_TIMEOUT_MS,
  LocationServicesOffError,
  LocationTimeoutError,
  expoLocationService,
  type LocationService,
} from '../lib/location/deviceLocation';
import type { Place } from '../lib/location/places';

// Where discovery is centred, and how the device location is doing.
//
// Permission is only requested when the user taps "Use my location" (after
// the app has explained why). If it was granted earlier, the app uses it on
// start. Location is watched only while the app is in the foreground and
// "Near you" is selected; it is never stored or sent anywhere except as the
// origin of a listing search.
//
// When location services (GPS) are off, tapping "Use my location" asks the
// OS to turn them on (Android shows its own dialog; iOS needs Settings).
// After the app sends the user to Settings, it checks again on return,
// without prompting, so a change made there takes effect at once. Only one
// request runs at a time, so repeated taps never stack prompts.

export type LocationStatus =
  | 'checking' // reading the permission on start
  | 'prompt' // never asked: explain, then ask on request
  | 'requesting' // OS prompt showing
  | 'locating' // getting a fix
  | 'ready' // location in use
  | 'denied' // refused, may ask again
  | 'blocked' // refused, only Settings can change it
  | 'services_off' // allowed, but the device's location services are off
  | 'unavailable' // no fix possible
  | 'timeout'; // no fix in time

export type DiscoveryArea =
  | { kind: 'device'; point: GeoPoint }
  | { kind: 'place'; place: Place }
  | { kind: 'city'; city: string }
  | { kind: 'all' };

// What listing searches should be limited to.
export type FeedScope = { near: GeoPoint & { radiusKm: number } } | { city: string } | null;

export type LocationProblem = 'denied' | 'blocked' | 'services_off' | 'unavailable' | 'timeout';
export type CurrentPoint = { point: GeoPoint } | { problem: LocationProblem };

export interface DiscoveryContextValue {
  area: DiscoveryArea;
  radiusKm: number;
  locationStatus: LocationStatus;
  // False until the start-up check has settled, so the first search is the
  // right one instead of "all areas" followed by "near you".
  ready: boolean;
  // Centre of a nearby search (device or chosen place).
  origin: GeoPoint | null;
  // Latest device fix, for the map's "you are here".
  devicePoint: GeoPoint | null;
  scope: FeedScope;
  label: string;
  enableLocation: () => Promise<void>;
  currentPoint: () => Promise<CurrentPoint>;
  choosePlace: (place: Place) => void;
  chooseCity: (city: string) => void;
  showAll: () => void;
  setRadius: (km: number) => void;
  // Opens the app's settings; the app re-checks when the user comes back.
  openSettings: () => void;
  // Whether "Turn on location" can be done in the app (Android's dialog)
  // rather than only in Settings.
  canEnableServicesInApp: boolean;
}

const DiscoveryContext = createContext<DiscoveryContextValue | null>(null);

// 'unknown' (early on launch) and 'inactive' (iOS transitions) count as in
// use; only the background stops location updates.
const inForeground = () => AppState.currentState !== 'background';

const problemOf = (err: unknown): LocationProblem =>
  err instanceof LocationServicesOffError ? 'services_off' : err instanceof LocationTimeoutError ? 'timeout' : 'unavailable';

export function DiscoveryProvider({ children, location }: { children: ReactNode; location?: LocationService }) {
  const [service] = useState<LocationService>(() => location ?? expoLocationService());
  const [area, setArea] = useState<DiscoveryArea>({ kind: 'all' });
  const [radiusKm, setRadiusKm] = useState(DEFAULT_RADIUS_KM);
  const [locationStatus, setLocationStatus] = useState<LocationStatus>('checking');
  const [ready, setReady] = useState(false);
  const [devicePoint, setDevicePoint] = useState<GeoPoint | null>(null);
  // The newest request wins: a manual choice made while locating sticks.
  const ticket = useRef(0);
  // A permission or services request in progress; further taps wait for it.
  const pending = useRef<Promise<unknown> | null>(null);
  // Set when the app sent the user to Settings, to re-check on return.
  const awaitingSettings = useRef(false);

  const locate = useCallback(async () => {
    const mine = ++ticket.current;
    setLocationStatus('locating');
    try {
      const point = await service.current(LOCATION_TIMEOUT_MS);
      if (mine !== ticket.current) return;
      setDevicePoint(point);
      setArea({ kind: 'device', point });
      setLocationStatus('ready');
    } catch (err) {
      if (mine !== ticket.current) return;
      setLocationStatus(problemOf(err));
    }
  }, [service]);

  // Start-up: use location only if it was already allowed. Never prompts.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const p = await service.permission();
        if (cancelled) return;
        if (p.status === 'granted') {
          await locate();
        } else {
          setLocationStatus(p.status === 'undetermined' ? 'prompt' : p.canAskAgain ? 'denied' : 'blocked');
        }
      } catch {
        if (!cancelled) setLocationStatus('unavailable');
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [service, locate]);

  // Asks only if the OS still allows asking; reports the outcome.
  const ensurePermission = useCallback(async (): Promise<'granted' | 'denied' | 'blocked' | 'unavailable'> => {
    let p = await service.permission().catch(() => null);
    if (p && p.status !== 'granted' && p.canAskAgain) {
      setLocationStatus('requesting');
      p = await service.requestPermission().catch(() => null);
    }
    if (!p) return 'unavailable';
    if (p.status === 'granted') return 'granted';
    return p.canAskAgain ? 'denied' : 'blocked';
  }, [service]);

  // Location services on, asking the OS to switch them on when it can.
  const ensureServices = useCallback(async (): Promise<boolean> => {
    if (await service.servicesEnabled().catch(() => false)) return true;
    if (!service.canEnableServicesInApp) return false;
    setLocationStatus('requesting');
    return service.enableServices().catch(() => false);
  }, [service]);

  // Runs one user-started request at a time: a second tap while the OS
  // prompt is showing joins the first instead of prompting again.
  const once = useCallback(<T,>(run: () => Promise<T>): Promise<T> => {
    if (pending.current) return pending.current as Promise<T>;
    const p = run().finally(() => {
      pending.current = null;
    });
    pending.current = p;
    return p;
  }, []);

  const enableLocation = useCallback(
    () =>
      once(async () => {
        const outcome = await ensurePermission();
        if (outcome !== 'granted') {
          setLocationStatus(outcome);
          return;
        }
        if (!(await ensureServices())) {
          setLocationStatus('services_off');
          return;
        }
        await locate();
      }),
    [once, ensurePermission, ensureServices, locate],
  );

  // One fix for another purpose (setting a listing's pickup spot). Does not
  // change the discovery area.
  const currentPoint = useCallback(
    () =>
      once(async (): Promise<CurrentPoint> => {
        const restore = (s: LocationStatus) => (s === 'requesting' ? 'prompt' : s);
        const outcome = await ensurePermission();
        if (outcome !== 'granted') {
          setLocationStatus((s) => (s === 'requesting' ? outcome : s));
          return { problem: outcome };
        }
        const servicesOn = await ensureServices();
        setLocationStatus(restore);
        if (!servicesOn) return { problem: 'services_off' };
        try {
          return { point: await service.current(LOCATION_TIMEOUT_MS) };
        } catch (err) {
          return { problem: problemOf(err) };
        }
      }),
    [once, ensurePermission, ensureServices, service],
  );

  // Back from Settings: read the permission again (never prompting) and use
  // the location if it is now allowed and switched on.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || !awaitingSettings.current) return;
      awaitingSettings.current = false;
      void (async () => {
        const p = await service.permission().catch(() => null);
        if (!p) return;
        if (p.status === 'granted') await locate();
        else setLocationStatus(p.canAskAgain ? 'denied' : 'blocked');
      })();
    });
    return () => sub.remove();
  }, [service, locate]);

  // Follow the device while "Near you" is selected and the app is in the
  // foreground; stop as soon as it goes to the background.
  const following = area.kind === 'device';
  useEffect(() => {
    if (!following) return;
    let stop: (() => void) | null = null;
    let active = true;
    const start = () => {
      if (stop) return;
      service
        .watch((point) => {
          setDevicePoint(point);
          setArea((current) =>
            current.kind === 'device' && haversineKm(current.point, point) >= RESEARCH_DISTANCE_KM ? { kind: 'device', point } : current,
          );
        })
        .then(
          (unsubscribe) => {
            if (active && inForeground()) stop = unsubscribe;
            else unsubscribe();
          },
          () => undefined,
        );
    };
    const halt = () => {
      stop?.();
      stop = null;
    };
    if (inForeground()) start();
    const sub = AppState.addEventListener('change', (state) => (state === 'background' ? halt() : start()));
    return () => {
      active = false;
      sub.remove();
      halt();
    };
  }, [following, service]);

  const choosePlace = useCallback((place: Place) => {
    ticket.current += 1;
    setArea({ kind: 'place', place });
  }, []);
  const chooseCity = useCallback((city: string) => {
    ticket.current += 1;
    setArea({ kind: 'city', city });
  }, []);
  const showAll = useCallback(() => {
    ticket.current += 1;
    setArea({ kind: 'all' });
  }, []);
  const openSettings = useCallback(() => {
    awaitingSettings.current = true;
    service.openSettings();
  }, [service]);

  const origin = area.kind === 'device' ? area.point : area.kind === 'place' ? area.place : null;
  const scope = useMemo<FeedScope>(
    () =>
      origin
        ? { near: { latitude: origin.latitude, longitude: origin.longitude, radiusKm } }
        : area.kind === 'city'
          ? { city: area.city }
          : null,
    [origin, area, radiusKm],
  );
  const label =
    area.kind === 'device'
      ? 'Near you'
      : area.kind === 'place'
        ? `Near ${area.place.name}, ${area.place.city}`
        : area.kind === 'city'
          ? `All of ${area.city}`
          : 'All areas';

  const value = useMemo<DiscoveryContextValue>(
    () => ({
      area,
      radiusKm,
      locationStatus,
      ready,
      origin,
      devicePoint,
      scope,
      label,
      enableLocation,
      currentPoint,
      choosePlace,
      chooseCity,
      showAll,
      setRadius: setRadiusKm,
      openSettings,
      canEnableServicesInApp: service.canEnableServicesInApp,
    }),
    [area, radiusKm, locationStatus, ready, origin, devicePoint, scope, label, enableLocation, currentPoint, choosePlace, chooseCity, showAll, openSettings, service],
  );

  return <DiscoveryContext.Provider value={value}>{children}</DiscoveryContext.Provider>;
}

export function useDiscovery(): DiscoveryContextValue {
  const ctx = useContext(DiscoveryContext);
  if (!ctx) throw new Error('useDiscovery must be used within DiscoveryProvider');
  return ctx;
}
