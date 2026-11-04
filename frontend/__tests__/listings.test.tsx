import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';
import { AuthProvider } from '../context/AuthContext';
import { ListingsProvider } from '../context/ListingsContext';
import { BorrowRequestsProvider } from '../context/BorrowRequestsContext';
import { AppProvider } from '../context/AppContext';
import { DiscoveryProvider } from '../context/DiscoveryContext';
import type { LocationService } from '../lib/location/deviceLocation';
import BrowseScreen from '../app/(tabs)/index';
import ItemDetailScreen from '../app/item/[id]';
import LendNewScreen from '../app/lend/new';
import type { ApiClient } from '../lib/api/client';
import { photoType, toLocalPhoto } from '../lib/listings/photos';
import { validateListingForm, type ListingForm } from '../lib/listings/validation';
import { apiError, fakeApi, fakeLocation, listing, services, session } from './support/fakes';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
  // Treated as focused on mount.
  useFocusEffect: (effect: () => void) => jest.requireActual('react').useEffect(effect, [effect]),
}));

jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }));

const mockPicker = {
  requestMediaLibraryPermissionsAsync: jest.fn(async () => ({ granted: true })),
  launchImageLibraryAsync: jest.fn(),
};
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: () => mockPicker.requestMediaLibraryPermissionsAsync(),
  launchImageLibraryAsync: (...args: unknown[]) => mockPicker.launchImageLibraryAsync(...args),
  UIImagePickerPreferredAssetRepresentationMode: { Compatible: 'compatible' },
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = {};
});

const page = (items = [listing()], total = items.length) => ({
  items,
  pagination: { page: 1, pageSize: 20, total, totalPages: Math.ceil(total / 20) },
});

// Signed in as user-1 (see fakes), like every screen behind the app guard.
async function renderApp(element: React.ReactElement, s = services()) {
  await s.sessionManager.setSession(session(1));
  await render(
    <AuthProvider services={s.asServices}>
      <ListingsProvider services={{ api: s.api as unknown as ApiClient, sessionManager: s.sessionManager }}>
        <BorrowRequestsProvider services={{ api: s.api as unknown as ApiClient, sessionManager: s.sessionManager }}>
          <DiscoveryProvider location={fakeLocation() as unknown as LocationService}>
            <AppProvider>{element}</AppProvider>
          </DiscoveryProvider>
        </BorrowRequestsProvider>
      </ListingsProvider>
    </AuthProvider>,
  );
  return s;
}

const press = async (name: string | RegExp) => fireEvent.press(screen.getByRole('button', { name }));
const type = async (label: string, text: string) => fireEvent.changeText(screen.getByLabelText(label), text);

describe('Browse feed', () => {
  test('shows a loading state, then listings from the API', async () => {
    const api = fakeApi();
    let release: (v: unknown) => void = () => undefined;
    api.listItems.mockImplementationOnce(() => new Promise((r) => (release = r)));
    await renderApp(<BrowseScreen />, services({ api }));

    expect(await screen.findByLabelText('Loading items')).toBeTruthy();
    await act(async () => release(page([listing({ title: 'Canon camera' })])));

    expect(await screen.findByText('Canon camera')).toBeTruthy();
    expect(screen.getByText('1 item in all areas, newest first')).toBeTruthy();
    expect(api.listItems).toHaveBeenCalledWith({ owner: 'others', page: 1, pageSize: 20 }, 'access-1');
  });

  test('shows an empty state when there are no listings', async () => {
    await renderApp(<BrowseScreen />);
    expect(await screen.findByText('No items yet')).toBeTruthy();
  });

  test('shows an error with a working retry', async () => {
    const api = fakeApi();
    api.listItems.mockRejectedValueOnce(apiError(0, 'NETWORK_ERROR')).mockResolvedValueOnce(page([listing({ title: 'Tent' })]));
    await renderApp(<BrowseScreen />, services({ api }));

    expect(await screen.findByText('Could not load items')).toBeTruthy();
    expect(screen.getByText('Could not reach NeighborShare. Check your connection and try again.')).toBeTruthy();
    await press('Try again');
    expect(await screen.findByText('Tent')).toBeTruthy();
  });

  test('sends search text and category to the server', async () => {
    const api = fakeApi();
    api.listItems.mockResolvedValue(page([]));
    await renderApp(<BrowseScreen />, services({ api }));
    await screen.findByText('No items yet');

    await press('Electronics');
    await waitFor(() => expect(api.listItems).toHaveBeenLastCalledWith({ category: 'electronics', owner: 'others', page: 1, pageSize: 20 }, 'access-1'));
    await type('Search items', '  drill ');
    await waitFor(() =>
      expect(api.listItems).toHaveBeenLastCalledWith({ q: 'drill', category: 'electronics', owner: 'others', page: 1, pageSize: 20 }, 'access-1'),
    );
    expect(await screen.findByText('Nothing found')).toBeTruthy();
  });

  test('marks unavailable items', async () => {
    const api = fakeApi();
    api.listItems.mockResolvedValue(page([listing({ availability: 'unavailable' })]));
    await renderApp(<BrowseScreen />, services({ api }));
    expect(await screen.findByText('Unavailable')).toBeTruthy();
  });
});

describe('Item detail', () => {
  test('a neighbor sees the listing from the server and the borrow button', async () => {
    mockParams = { id: listing().id };
    const s = await renderApp(<ItemDetailScreen />);
    expect(await screen.findByText('Bosch power drill')).toBeTruthy();
    expect(s.api.getItem).toHaveBeenCalledWith(listing().id, 'access-1');
    expect(screen.getByText('Request to Borrow')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit listing' })).toBeNull();
  });

  test('a missing listing shows "not found" without a retry', async () => {
    mockParams = { id: listing().id };
    const api = fakeApi();
    api.getItem.mockRejectedValue(apiError(404, 'LISTING_NOT_FOUND'));
    await renderApp(<ItemDetailScreen />, services({ api }));
    expect(await screen.findByText('Item not found')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  test('the owner can toggle availability, which the server decides', async () => {
    mockParams = { id: listing().id };
    const api = fakeApi();
    const mine = listing({ owner: { id: 'user-1', displayName: 'Sara' } });
    // The screen re-reads the server after saving; the server has the change.
    api.getItem.mockResolvedValueOnce({ listing: mine }).mockResolvedValue({ listing: { ...mine, availability: 'unavailable' } });
    api.updateItem.mockResolvedValue({ listing: { ...mine, availability: 'unavailable' } });
    await renderApp(<ItemDetailScreen />, services({ api }));

    await screen.findByRole('button', { name: 'Mark unavailable' });
    await press('Mark unavailable');
    await waitFor(() => expect(api.updateItem).toHaveBeenCalledWith('access-1', mine.id, { availability: 'unavailable' }));
    expect(await screen.findByText('Currently Unavailable')).toBeTruthy();
    expect(screen.queryByText('Request to Borrow')).toBeNull();
  });

  test('the owner archives after confirming', async () => {
    mockParams = { id: listing().id };
    const api = fakeApi();
    api.getItem.mockResolvedValue({ listing: listing({ owner: { id: 'user-1', displayName: 'Sara' } }) });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      buttons?.find((b) => b.style === 'destructive')?.onPress?.();
    });
    await renderApp(<ItemDetailScreen />, services({ api }));
    await screen.findByRole('button', { name: 'Remove listing' });
    await press('Remove listing');
    await waitFor(() => expect(api.archiveItem).toHaveBeenCalledWith('access-1', listing().id));
    expect(mockRouter.back).toHaveBeenCalled();
    alert.mockRestore();
  });
});

describe('Lend screen', () => {
  const fill = async () => {
    await type('Item title', 'Bosch drill');
    await type('Description', 'Cordless drill with bits.');
  };

  test('invalid input shows field errors and sends nothing', async () => {
    const s = await renderApp(<LendNewScreen />);
    await type('Item title', 'ab');
    await press('List my item');
    expect(screen.getByText('Enter a title of at least 3 characters.')).toBeTruthy();
    expect(screen.getByText('Describe the item in at least 10 characters.')).toBeTruthy();
    expect(s.api.createItem).not.toHaveBeenCalled();
  });

  test('creates the listing through the API; a double tap creates one', async () => {
    const api = fakeApi();
    let release: (v: unknown) => void = () => undefined;
    api.createItem.mockImplementation(() => new Promise((r) => (release = r)));
    await renderApp(<LendNewScreen />, services({ api }));
    await waitFor(() => expect(screen.getByLabelText('Area').props.value).toBe('Gulberg'));
    await fill();
    await type('Approximate value', '15,000');
    await press('Electronics');

    const button = screen.getByRole('button', { name: 'List my item' });
    await fireEvent.press(button);
    await fireEvent.press(button);
    await act(async () => release({ listing: listing() }));

    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    expect(api.createItem).toHaveBeenCalledTimes(1);
    expect(api.createItem).toHaveBeenCalledWith('access-1', {
      title: 'Bosch drill',
      description: 'Cordless drill with bits.',
      category: 'electronics',
      condition: 'good',
      replacementValuePkr: 15000,
      borrowingTerms: null,
      // Defaults to the profile neighborhood and city (fakes: Gulberg, Lahore).
      area: 'Gulberg',
      city: 'Lahore',
      teachMeEnabled: false,
      tags: [],
    });
  });

  test('server field errors appear on the matching field', async () => {
    const api = fakeApi();
    api.createItem.mockRejectedValueOnce(
      apiError(400, 'VALIDATION_ERROR', { details: [{ field: 'title', message: 'must be at most 80 characters' }] }),
    );
    await renderApp(<LendNewScreen />, services({ api }));
    await fill();
    await press('List my item');
    expect(await screen.findByText('Must be at most 80 characters.')).toBeTruthy();
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  test('uploads picked photos after creating, and reports failures without losing the listing', async () => {
    const api = fakeApi();
    api.uploadItemImage.mockResolvedValueOnce({ image: {} }).mockRejectedValueOnce(apiError(415, 'UNSUPPORTED_IMAGE_TYPE'));
    mockPicker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [
        { uri: 'file:///a.jpg', mimeType: 'image/jpeg', fileSize: 1000 },
        { uri: 'file:///b.png', mimeType: 'image/png', fileSize: 1000 },
        { uri: 'file:///c.heic', mimeType: 'image/heic', fileSize: 1000 },
      ],
    });
    await renderApp(<LendNewScreen />, services({ api }));
    await press('Add photos');
    await screen.findByText(/^2\/5 photos/);
    await fill();
    await press('List my item');

    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    // The picked file's own URI is handed to the uploader; no Blob is built.
    expect(api.uploadItemImage).toHaveBeenCalledTimes(2);
    expect(api.uploadItemImage).toHaveBeenNthCalledWith(1, 'access-1', listing().id, 'file:///a.jpg', 'image/jpeg');
    expect(api.uploadItemImage).toHaveBeenNthCalledWith(2, 'access-1', listing().id, 'file:///b.png', 'image/png');
    expect(Toast.show).toHaveBeenCalledWith(expect.objectContaining({ text1: 'Item listed, but some photos failed' }));
  });

  test('edit mode loads the listing and sends only changed fields', async () => {
    mockParams = { id: listing().id };
    const api = fakeApi();
    api.getItem.mockResolvedValue({ listing: listing({ owner: { id: 'user-1', displayName: 'Sara' } }) });
    await renderApp(<LendNewScreen />, services({ api }));
    expect(await screen.findByDisplayValue('Bosch power drill')).toBeTruthy();
    await type('Item title', 'Bosch drill v2');
    await press('Save changes');
    await waitFor(() => expect(api.updateItem).toHaveBeenCalledWith('access-1', listing().id, { title: 'Bosch drill v2' }));
    expect(api.createItem).not.toHaveBeenCalled();
  });
});

describe('API client: listings', () => {
  const ok = (data: unknown) =>
    ({ status: 200, ok: true, headers: { get: () => null }, json: async () => ({ success: true, data }) }) as unknown as Response;

  test('builds the query string from set filters only, and keeps it out of timing logs', async () => {
    const { createApiClient } = jest.requireActual('../lib/api/client') as typeof import('../lib/api/client');
    const fetchImpl = jest.fn(async () => ok(page([])));
    const onTiming = jest.fn();
    const api = createApiClient({ baseUrl: 'http://api.test', fetchImpl: fetchImpl as unknown as typeof fetch, onTiming });
    await api.listItems({ q: 'drill & bits', category: 'tools', page: 2 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api.test/api/v1/items?q=drill%20%26%20bits&category=tools&page=2');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(onTiming.mock.calls[0][0].path).toBe('/items');
  });

  const uploadClient = (uploadFile: jest.Mock, onTiming = jest.fn()) => {
    const { createApiClient } = jest.requireActual('../lib/api/client') as typeof import('../lib/api/client');
    return createApiClient({ baseUrl: 'http://api.test', uploadFile, onTiming });
  };
  const envelope = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
    status,
    body: JSON.stringify(body),
    headers,
  });

  test('uploads a photo by handing the local file to the native uploader', async () => {
    const image = { id: 'img-1', url: 'https://signed', contentType: 'image/png', createdAt: 'now' };
    const uploadFile = jest.fn(async () => envelope(201, { success: true, data: { image } }, { 'X-Request-Id': 'rid-1' }));
    const onTiming = jest.fn();
    const result = await uploadClient(uploadFile, onTiming).uploadItemImage('tok', 'abc', 'file:///photo.png', 'image/png');

    expect(result.image).toEqual(image);
    const [url, fileUri, init] = uploadFile.mock.calls[0] as unknown as [string, string, { headers: Record<string, string>; contentType: string }];
    expect(url).toBe('http://api.test/api/v1/items/abc/images');
    expect(fileUri).toBe('file:///photo.png');
    expect(init.headers).toMatchObject({ 'Content-Type': 'image/png', Authorization: 'Bearer tok' });
    expect(init.contentType).toBe('image/png');
    expect(onTiming.mock.calls[0][0]).toMatchObject({ method: 'POST', path: '/items/abc/images', status: 201, requestId: 'rid-1' });
  });

  test('upload errors keep the server code, so the app can explain them', async () => {
    const uploadFile = jest.fn(async () =>
      envelope(415, { success: false, code: 'UNSUPPORTED_IMAGE_TYPE', message: 'Upload a JPEG, PNG or WebP image' }),
    );
    await expect(uploadClient(uploadFile).uploadItemImage('tok', 'abc', 'file:///x.jpg', 'image/jpeg')).rejects.toMatchObject({
      status: 415,
      code: 'UNSUPPORTED_IMAGE_TYPE',
    });
  });

  test('a network failure or timeout during upload becomes NETWORK_ERROR / TIMEOUT', async () => {
    const { UploadTimeoutError } = jest.requireActual('../lib/api/client') as typeof import('../lib/api/client');
    await expect(
      uploadClient(jest.fn(async () => Promise.reject(new Error('socket closed')))).uploadItemImage('t', 'a', 'file:///x.jpg', 'image/jpeg'),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await expect(
      uploadClient(jest.fn(async () => Promise.reject(new UploadTimeoutError()))).uploadItemImage('t', 'a', 'file:///x.jpg', 'image/jpeg'),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  test('a non-JSON reply (e.g. a proxy error page) is a clear BAD_RESPONSE', async () => {
    const uploadFile = jest.fn(async () => ({ status: 502, body: '<html>Bad gateway</html>', headers: {} }));
    await expect(uploadClient(uploadFile).uploadItemImage('t', 'a', 'file:///x.jpg', 'image/jpeg')).rejects.toMatchObject({
      status: 502,
      code: 'BAD_RESPONSE',
    });
  });
});

describe('listing form rules', () => {
  const base: ListingForm = {
    title: 'Drill',
    description: 'A good cordless drill.',
    category: 'tools',
    condition: 'good',
    replacementValue: '',
    borrowingTerms: '',
    area: '',
    city: '',
    tags: '',
    teachMeEnabled: false,
  };

  test('accepts valid input and normalises optional fields', () => {
    expect(validateListingForm({ ...base, tags: ' a, ,b ', replacementValue: '1 500' }).input).toMatchObject({
      tags: ['a', 'b'],
      replacementValuePkr: 1500,
      area: null,
      borrowingTerms: null,
    });
  });

  test.each([
    [{ replacementValue: '12.5' }, 'replacementValue'],
    [{ replacementValue: '-3' }, 'replacementValue'],
    [{ replacementValue: '20000000' }, 'replacementValue'],
    [{ tags: 'a,b,c,d,e,f' }, 'tags'],
    [{ area: 'x' }, 'area'],
    [{ title: 'x'.repeat(81) }, 'title'],
  ])('rejects %o', (change, field) => {
    expect(validateListingForm({ ...base, ...change }).errors).toHaveProperty(field);
  });

  test('photo types: JPEG, PNG and WebP only; size limit enforced', () => {
    expect(photoType({ uri: 'file:///x', mimeType: 'image/jpg' })).toBe('image/jpeg');
    expect(photoType({ uri: 'file:///x.webp' })).toBe('image/webp');
    expect(photoType({ uri: 'file:///x', mimeType: 'image/heic' })).toBeNull();
    expect(toLocalPhoto({ uri: 'file:///x.jpg', fileSize: 6 * 1024 * 1024 })).toBe('too_large');
  });
});
