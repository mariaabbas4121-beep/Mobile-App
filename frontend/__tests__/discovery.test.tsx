import React from 'react';
import { AppState } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AuthProvider } from '../context/AuthContext';
import { ListingsProvider } from '../context/ListingsContext';
import { BorrowRequestsProvider } from '../context/BorrowRequestsContext';
import { DiscoveryProvider } from '../context/DiscoveryContext';
import { AppProvider } from '../context/AppContext';
import BrowseScreen from '../app/(tabs)/index';
import MapScreen from '../app/(tabs)/map';
import LendNewScreen from '../app/lend/new';
import type { ApiClient } from '../lib/api/client';
import type { Listing } from '../lib/api/types';
import { LocationTimeoutError, LocationUnavailableError, type LocationService } from '../lib/location/deviceLocation';
import { formatDistance, nextRadius } from '../lib/location/geo';
import { UAF, fakeApi, fakeLocation, listing, services, session } from './support/fakes';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), navigate: jest.fn(), canGoBack: jest.fn(() => true) };
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (effect: () => void) => jest.requireActual('react').useEffect(effect, [effect]),
}));
jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }));
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
  UIImagePickerPreferredAssetRepresentationMode: { Compatible: 'compatible' },
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = {};
});

const page = (items: Listing[]) => ({ items, pagination: { page: 1, pageSize: 20, total: items.length, totalPages: 1 } });

async function renderApp(element: React.ReactElement, { api = fakeApi(), location = fakeLocation() } = {}) {
  const s = services({ api });
  await s.sessionManager.setSession(session(1));
  const svc = { api: s.api as unknown as ApiClient, sessionManager: s.sessionManager };
  await render(
    <AuthProvider services={s.asServices}>
      <ListingsProvider services={svc}>
        <BorrowRequestsProvider services={svc}>
          <DiscoveryProvider location={location as unknown as LocationService}>
            <AppProvider>{element}</AppProvider>
          </DiscoveryProvider>
        </BorrowRequestsProvider>
      </ListingsProvider>
    </AuthProvider>,
  );
  return { api, location };
}

const press = async (name: string | RegExp) => fireEvent.press(screen.getByRole('button', { name }));
const lastQuery = (api: ReturnType<typeof fakeApi>) => api.listItems.mock.calls[api.listItems.mock.calls.length - 1]![0];
const near = (km: number) => ({ latitude: UAF.latitude + km / 111.32, longitude: UAF.longitude });

describe('distance helpers', () => {
  test('distances are approximate and never more precise than the public point', () => {
    expect(formatDistance(0.2)).toBe('Under 0.5 km away');
    expect(formatDistance(1.24)).toBe('About 1.2 km away');
    expect(formatDistance(23.6)).toBe('About 24 km away');
    expect(nextRadius(3)).toBe(5);
    expect(nextRadius(5)).toBe(10);
    expect(nextRadius(10)).toBeNull();
  });
});

describe('home feed: location permission', () => {
  test('explains first and does not ask for permission on its own; browsing works meanwhile', async () => {
    const { api, location } = await renderApp(<BrowseScreen />);
    expect(await screen.findByText('See what is near you')).toBeTruthy();
    expect(screen.getByText(/never shown to anyone or saved/)).toBeTruthy();
    expect(location.requestPermission).not.toHaveBeenCalled();
    await waitFor(() => expect(api.listItems).toHaveBeenCalled());
    expect(lastQuery(api)).toEqual({ owner: 'others', page: 1, pageSize: 20 });
    expect(screen.getByRole('button', { name: /Area: All areas/ })).toBeTruthy();
  });

  test('"Use my location" asks, then searches within 3 km, nearest first, with distances', async () => {
    const api = fakeApi();
    api.listItems.mockImplementation(async (q: { lat?: number }) =>
      q.lat ? page([listing({ distanceKm: 1.2, approximateLocation: near(1.2) })]) : page([]),
    );
    const { location } = await renderApp(<BrowseScreen />, { api });
    await press('Use my location');
    expect(location.requestPermission).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(lastQuery(api)).toEqual({ lat: UAF.latitude, lng: UAF.longitude, radiusKm: 3, owner: 'others', page: 1, pageSize: 20 }));
    expect(await screen.findByText('About 1.2 km away')).toBeTruthy();
    expect(screen.getByText('1 item within 3 km, nearest first')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Area: Near you, within 3 km. Change area' })).toBeTruthy();
    expect(screen.queryByText('See what is near you')).toBeNull();
  });

  test('with permission already granted, the first search is already nearby', async () => {
    const location = fakeLocation();
    location.setPermission({ status: 'granted', canAskAgain: true });
    const { api } = await renderApp(<BrowseScreen />, { location });
    await waitFor(() => expect(api.listItems).toHaveBeenCalled());
    expect(api.listItems.mock.calls[0]![0]).toMatchObject({ lat: UAF.latitude, lng: UAF.longitude, radiusKm: 3 });
    expect(location.requestPermission).not.toHaveBeenCalled();
  });

  test('denied: says so and offers the area picker instead', async () => {
    const location = fakeLocation({
      requestPermission: jest.fn(async () => ({ status: 'denied', canAskAgain: true })),
    });
    const { api } = await renderApp(<BrowseScreen />, { location });
    await press('Use my location');
    expect(await screen.findByText('Location was not allowed')).toBeTruthy();
    expect(screen.getByText(/choose “While using the app”/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Choose area' })).toBeTruthy();
    expect(lastQuery(api)).not.toHaveProperty('lat');
  });

  test('permanently denied: points to Settings, never shows the OS prompt', async () => {
    const location = fakeLocation();
    location.setPermission({ status: 'denied', canAskAgain: false });
    await renderApp(<BrowseScreen />, { location });
    expect(await screen.findByText('Location is turned off for NeighborShare')).toBeTruthy();
    await press('Open Settings');
    expect(location.openSettings).toHaveBeenCalled();
    expect(location.requestPermission).not.toHaveBeenCalled();
  });

  test('location unavailable or timing out: explains and offers a retry', async () => {
    const location = fakeLocation({ current: jest.fn().mockRejectedValueOnce(new LocationUnavailableError()).mockRejectedValueOnce(new LocationTimeoutError()) });
    await renderApp(<BrowseScreen />, { location });
    await press('Use my location');
    expect(await screen.findByText('Could not get your location')).toBeTruthy();
    await press('Try again');
    expect(await screen.findByText('Finding your location took too long')).toBeTruthy();
    await press('Try again');
    expect(await screen.findByRole('button', { name: /Area: Near you/ })).toBeTruthy();
  });
});

describe('location permission and services', () => {
  // Captures AppState listeners so a test can "return to the app".
  function appStateListeners() {
    const listeners: ((state: string) => void)[] = [];
    const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      listeners.push(listener as (state: string) => void);
      return { remove: jest.fn() } as never;
    });
    return {
      emit: (state: string) => act(async () => listeners.forEach((l) => l(state))),
      // See the foreground test below: keep an implementation in place.
      done: () => spy.mockImplementation(() => ({ remove: jest.fn() }) as never),
    };
  }

  test('first tap asks for permission once, then for GPS when it is off (Android dialog), then searches nearby', async () => {
    const location = fakeLocation();
    location.setServices(false);
    const { api } = await renderApp(<BrowseScreen />, { location });
    await press('Use my location');
    expect(location.requestPermission).toHaveBeenCalledTimes(1);
    expect(location.enableServices).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(lastQuery(api)).toMatchObject({ lat: UAF.latitude, radiusKm: 3, owner: 'others' }));
  });

  test('GPS left off: says so clearly and the button asks again; never a silent failure', async () => {
    const location = fakeLocation({ enableServices: jest.fn(async () => false) });
    location.setServices(false);
    location.setPermission({ status: 'granted', canAskAgain: true });
    const { api } = await renderApp(<BrowseScreen />, { location });
    // On start nothing is prompted, but the state is explained.
    expect(await screen.findByText('Your phone’s location is off')).toBeTruthy();
    expect(location.enableServices).not.toHaveBeenCalled();
    await press('Turn on location');
    expect(location.enableServices).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Your phone’s location is off')).toBeTruthy();
    expect(location.requestPermission).not.toHaveBeenCalled();
    expect(lastQuery(api)).not.toHaveProperty('lat');
  });

  test('GPS off where the app cannot switch it on (iOS): points to Settings', async () => {
    const location = fakeLocation({ canEnableServicesInApp: false });
    location.setServices(false);
    location.setPermission({ status: 'granted', canAskAgain: true });
    await renderApp(<BrowseScreen />, { location });
    expect(await screen.findByText('Location Services are off')).toBeTruthy();
    await press('Open Settings');
    expect(location.openSettings).toHaveBeenCalled();
    expect(location.enableServices).not.toHaveBeenCalled();
  });

  test('coming back from Settings with location allowed uses it at once, without prompting', async () => {
    const appState = appStateListeners();
    const location = fakeLocation();
    location.setPermission({ status: 'denied', canAskAgain: false });
    const { api } = await renderApp(<BrowseScreen />, { location });
    expect(await screen.findByText('Location is turned off for NeighborShare')).toBeTruthy();
    expect(screen.getByText(/Your phone will not ask again/)).toBeTruthy();

    await press('Open Settings');
    location.setPermission({ status: 'granted', canAskAgain: true });
    await appState.emit('active');
    await waitFor(() => expect(lastQuery(api)).toMatchObject({ lat: UAF.latitude, radiusKm: 3 }));
    expect(location.requestPermission).not.toHaveBeenCalled();
    appState.done();
  });

  test('returning to the app without having gone to Settings does not re-check or prompt', async () => {
    const appState = appStateListeners();
    const location = fakeLocation();
    location.setPermission({ status: 'denied', canAskAgain: false });
    await renderApp(<BrowseScreen />, { location });
    await screen.findByText('Location is turned off for NeighborShare');
    const reads = location.permission.mock.calls.length;
    await appState.emit('active');
    expect(location.permission.mock.calls.length).toBe(reads);
    expect(location.requestPermission).not.toHaveBeenCalled();
    appState.done();
  });

  test('tapping again while the prompt is open does not stack a second prompt', async () => {
    let answer: (p: { status: 'granted'; canAskAgain: boolean }) => void = () => undefined;
    const location = fakeLocation({
      requestPermission: jest.fn(() => new Promise((resolve) => (answer = resolve))),
    });
    const { api } = await renderApp(<BrowseScreen />, { location });
    await screen.findByText('See what is near you');
    const button = screen.getByRole('button', { name: 'Use my location' });
    await act(async () => {
      fireEvent.press(button);
      fireEvent.press(button);
    });
    // The picker offers the same action; it joins the request in progress.
    expect(location.requestPermission).toHaveBeenCalledTimes(1);
    await act(async () => answer({ status: 'granted', canAskAgain: true }));
    await waitFor(() => expect(lastQuery(api)).toMatchObject({ lat: UAF.latitude }));
    expect(location.requestPermission).toHaveBeenCalledTimes(1);
  });
});

describe('home feed: radius and area', () => {
  async function nearbyApp(api = fakeApi()) {
    const location = fakeLocation();
    location.setPermission({ status: 'granted', canAskAgain: true });
    await renderApp(<BrowseScreen />, { api, location });
    await waitFor(() => expect(api.listItems).toHaveBeenCalled());
    return { api, location };
  }

  test('no items nearby offers 5 km, then 10 km', async () => {
    const { api } = await nearbyApp();
    expect(await screen.findByText('No items nearby')).toBeTruthy();
    expect(screen.getByText('Nothing within 3 km of you.')).toBeTruthy();
    await press('Expand to 5 km');
    await waitFor(() => expect(lastQuery(api)).toMatchObject({ radiusKm: 5 }));
    await press('Expand to 10 km');
    await waitFor(() => expect(lastQuery(api)).toMatchObject({ radiusKm: 10 }));
    expect(await screen.findByText('Nothing within 10 km of you.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Expand to/ })).toBeNull();
  });

  test('the radius chips change the search; a category keeps the location', async () => {
    const { api } = await nearbyApp();
    await fireEvent.press(screen.getByRole('radio', { name: 'Within 10 km' }));
    await waitFor(() => expect(lastQuery(api)).toMatchObject({ radiusKm: 10 }));
    await press('Tools');
    await waitFor(() => expect(lastQuery(api)).toEqual({ category: 'tools', lat: UAF.latitude, lng: UAF.longitude, radiusKm: 10, owner: 'others', page: 1, pageSize: 20 }));
  });

  test('a manual neighbourhood searches around it; a city is labelled as city-wide; "All areas" is unrestricted', async () => {
    const api = fakeApi();
    api.listItems.mockImplementation(async (q: { city?: string }) =>
      q.city ? page([listing({ city: 'Lahore', approximateLocation: null })]) : page([]),
    );
    await renderApp(<BrowseScreen />, { api });
    await press('Choose area');
    await press('Faisalabad');
    await press('Near UAF campus, Faisalabad');
    await waitFor(() => expect(lastQuery(api)).toMatchObject({ lat: 31.431, lng: 73.07, radiusKm: 3 }));
    expect(screen.getByRole('button', { name: 'Area: Near UAF campus, Faisalabad, within 3 km. Change area' })).toBeTruthy();

    await press(/Area: Near UAF campus/);
    await press('Lahore');
    await press('All of Lahore');
    await waitFor(() => expect(lastQuery(api)).toEqual({ city: 'Lahore', owner: 'others', page: 1, pageSize: 20 }));
    expect(await screen.findByText('1 item in Lahore, newest first')).toBeTruthy();
    expect(screen.getByText('In Lahore · no map spot')).toBeTruthy();
    expect(screen.queryByRole('radio', { name: 'Within 3 km' })).toBeNull();

    await press(/Area: All of Lahore/);
    await press('All areas');
    await waitFor(() => expect(lastQuery(api)).toEqual({ owner: 'others', page: 1, pageSize: 20 }));
  });

  test('small movements do not re-search; moving 1 km does; choosing an area stops following', async () => {
    const { api, location } = await nearbyApp();
    await waitFor(() => expect(location.watcherCount()).toBe(1));
    const calls = api.listItems.mock.calls.length;
    await act(async () => location.move(near(0.1)));
    expect(api.listItems.mock.calls.length).toBe(calls);
    await act(async () => location.move(near(1)));
    await waitFor(() => expect(lastQuery(api)).toMatchObject({ lat: near(1).latitude }));

    await press(/Area: Near you/);
    await press('Faisalabad');
    await press('Near Gulberg, Faisalabad');
    await waitFor(() => expect(location.watcherCount()).toBe(0));
  });
});

describe('foreground only', () => {
  test('location updates stop in the background and resume when the app is active again', async () => {
    const listeners: ((state: string) => void)[] = [];
    const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      listeners.push(listener as (state: string) => void);
      return { remove: jest.fn() } as never;
    });
    const location = fakeLocation();
    location.setPermission({ status: 'granted', canAskAgain: true });
    await renderApp(<BrowseScreen />, { location });
    await waitFor(() => expect(location.watcherCount()).toBe(1));
    await act(async () => listeners.forEach((l) => l('background')));
    expect(location.watcherCount()).toBe(0);
    await act(async () => listeners.forEach((l) => l('active')));
    await waitFor(() => expect(location.watcherCount()).toBe(1));
    // React Native's test setup already mocks addEventListener; restoring
    // would leave it without an implementation, so give it a plain one.
    spy.mockImplementation(() => ({ remove: jest.fn() }) as never);
  });
});

describe('map', () => {
  test('without an area it explains instead of loading anything', async () => {
    const { api } = await renderApp(<MapScreen />);
    expect(await screen.findByText('Choose an area to see items on the map')).toBeTruthy();
    expect(screen.getByText(/never the owner’s address/)).toBeTruthy();
    expect(api.listItems).not.toHaveBeenCalled();
  });

  test('shows markers at approximate points, the radius, and a preview that opens the item', async () => {
    const location = fakeLocation();
    location.setPermission({ status: 'granted', canAskAgain: true });
    const api = fakeApi();
    api.listItems.mockResolvedValue(
      page([
        listing({ id: 'a', title: 'Drill', distanceKm: 1.2, approximateLocation: near(1.2) }),
        listing({ id: 'b', title: 'Tent', distanceKm: 2.4, approximateLocation: near(2.4) }),
      ]),
    );
    await renderApp(<MapScreen />, { api, location });
    expect(await screen.findByTestId('items-map')).toBeTruthy();
    await waitFor(() => expect(lastQuery(api)).toMatchObject({ lat: UAF.latitude, radiusKm: 3, pageSize: 50 }));
    expect(screen.getByTestId('radius-circle')).toBeTruthy();

    await press('Drill, About 1.2 km away');
    expect(screen.getByLabelText('Preview of Drill')).toBeTruthy();
    await press('View Drill');
    expect(mockRouter.push).toHaveBeenCalledWith('/item/a');
    await press('Show as list');
    expect(mockRouter.navigate).toHaveBeenCalledWith('/');
  });

  test('markers carry short labels; the nearest is selected and previewed without a tap; tapping another updates it', async () => {
    const location = fakeLocation();
    location.setPermission({ status: 'granted', canAskAgain: true });
    const api = fakeApi();
    api.listItems.mockResolvedValue(
      page([
        listing({ id: 'a', title: 'Drill', category: 'tools', distanceKm: 1.2, approximateLocation: near(1.2) }),
        listing({ id: 'b', title: 'Four-person waterproof camping tent', category: 'outdoor', distanceKm: 2.4, approximateLocation: near(2.4) }),
      ]),
    );
    await renderApp(<MapScreen />, { api, location });
    expect(await screen.findByLabelText('Preview of Drill')).toBeTruthy();
    expect(lastQuery(api)).toMatchObject({ owner: 'others' });
    // Labels on the map itself; a long name is shortened at a word.
    // Marker label and preview title.
    expect(screen.getAllByText('Drill')).toHaveLength(2);
    expect(screen.getByText('Four-person…')).toBeTruthy();
    expect(screen.getByText(/Tools · Good/)).toBeTruthy();

    await press('Four-person waterproof camping tent, About 2.4 km away');
    expect(screen.getByLabelText('Preview of Four-person waterproof camping tent')).toBeTruthy();
    expect(screen.queryByLabelText('Preview of Drill')).toBeNull();
    await press('View Four-person waterproof camping tent');
    expect(mockRouter.push).toHaveBeenCalledWith('/item/b');
  });

  test('items at the same approximate point share one marker and can be stepped through', async () => {
    const location = fakeLocation();
    location.setPermission({ status: 'granted', canAskAgain: true });
    const api = fakeApi();
    const spot = near(1);
    api.listItems.mockResolvedValue(
      page([
        listing({ id: 'a', title: 'Drill', distanceKm: 1, approximateLocation: spot }),
        listing({ id: 'b', title: 'Ladder', distanceKm: 1, approximateLocation: spot }),
      ]),
    );
    await renderApp(<MapScreen />, { api, location });
    expect(await screen.findByText('2 items')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^2 items: Drill, Ladder$/ })).toHaveLength(1);
    expect(screen.getByText('1 of 2 at this spot')).toBeTruthy();
    await press('Next item here');
    expect(screen.getByLabelText('Preview of Ladder')).toBeTruthy();
    // Tapping the shared marker again also moves on.
    await press('2 items: Drill, Ladder');
    expect(screen.getByLabelText('Preview of Drill')).toBeTruthy();
  });

  test('an empty area offers a wider radius', async () => {
    const location = fakeLocation();
    location.setPermission({ status: 'granted', canAskAgain: true });
    const { api } = await renderApp(<MapScreen />, { location });
    expect(await screen.findByText('No items within 3 km.')).toBeTruthy();
    await press('Expand to 5 km');
    await waitFor(() => expect(lastQuery(api)).toMatchObject({ radiusKm: 5 }));
  });
});

describe('lend form: pickup spot', () => {
  const fill = async () => {
    await fireEvent.changeText(screen.getByLabelText('Item title'), 'Bosch drill');
    await fireEvent.changeText(screen.getByLabelText('Description'), 'Cordless drill with bits.');
  };

  test('the current location becomes the pickup spot only when the owner taps it', async () => {
    const { api, location } = await renderApp(<LendNewScreen />);
    expect(screen.getByText(/never your address/)).toBeTruthy();
    await fill();
    await press('Use my current location as pickup spot');
    expect(await screen.findByText('Pickup spot set')).toBeTruthy();
    expect(location.requestPermission).toHaveBeenCalled();
    await press('List my item');
    await waitFor(() => expect(api.setItemLocation).toHaveBeenCalledWith('access-1', listing().id, UAF));
    expect(api.createItem.mock.invocationCallOrder[0]).toBeLessThan(api.setItemLocation.mock.invocationCallOrder[0]!);
  });

  test('without a spot nothing is sent; with location refused it says what to do', async () => {
    const location = fakeLocation({ requestPermission: jest.fn(async () => ({ status: 'denied', canAskAgain: false })) });
    const { api } = await renderApp(<LendNewScreen />, { location });
    await fill();
    await press('Use my current location as pickup spot');
    expect(await screen.findByText(/Pick the spot on the map instead/)).toBeTruthy();
    await press('List my item');
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    expect(api.setItemLocation).not.toHaveBeenCalled();
  });

  test('editing loads the saved spot, keeps it unless changed, and can remove it', async () => {
    mockParams = { id: listing().id };
    const api = fakeApi();
    api.getItem.mockResolvedValue({ listing: listing({ owner: { id: 'user-1', displayName: 'Sara' } }) });
    api.getItemLocation.mockResolvedValue({ location: { ...UAF, updatedAt: '2026-11-04T10:00:00Z' } });
    await renderApp(<LendNewScreen />, { api });
    expect(await screen.findByText('Pickup spot set')).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText('Item title'), 'Bosch drill v2');
    await press('Save changes');
    await waitFor(() => expect(api.updateItem).toHaveBeenCalled());
    expect(api.setItemLocation).not.toHaveBeenCalled();
    expect(api.clearItemLocation).not.toHaveBeenCalled();
  });

  test('removing the spot clears it on save', async () => {
    mockParams = { id: listing().id };
    const api = fakeApi();
    api.getItem.mockResolvedValue({ listing: listing({ owner: { id: 'user-1', displayName: 'Sara' } }) });
    api.getItemLocation.mockResolvedValue({ location: { ...UAF, updatedAt: '2026-11-04T10:00:00Z' } });
    await renderApp(<LendNewScreen />, { api });
    await screen.findByText('Pickup spot set');
    await press('Remove pickup spot');
    await press('Save changes');
    await waitFor(() => expect(api.clearItemLocation).toHaveBeenCalledWith('access-1', listing().id));
  });
});
