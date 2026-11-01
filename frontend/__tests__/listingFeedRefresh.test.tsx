// Regression: a listing created on the Lend screen must appear on the home
// feed, which stays mounted underneath the Lend modal. The fake API keeps a
// server-side list, so the feed only shows what a real refetch would return.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AuthProvider } from '../context/AuthContext';
import { ListingsProvider } from '../context/ListingsContext';
import { AppProvider } from '../context/AppContext';
import BrowseScreen from '../app/(tabs)/index';
import LendNewScreen from '../app/lend/new';
import type { ApiClient } from '../lib/api/client';
import type { Listing, ListingInput, ListingQuery } from '../lib/api/types';
import { apiError, fakeApi, listing, services, session } from './support/fakes';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
// The feed's latest focus callback, so a test can "return to the tab".
const mockFocus: { current: (() => void) | null } = { current: null };
jest.mock('expo-router', () => {
  const ReactActual = jest.requireActual('react');
  return {
    useRouter: () => mockRouter,
    useLocalSearchParams: () => ({}),
    // Runs like a plain effect: the screen is treated as focused on mount.
    useFocusEffect: (effect: () => void) => {
      mockFocus.current = effect;
      ReactActual.useEffect(effect, [effect]);
    },
  };
});
jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }));
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
  UIImagePickerPreferredAssetRepresentationMode: { Compatible: 'compatible' },
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockFocus.current = null;
});

// A tiny server: listItems answers from `rows`, newest first, honouring
// category and q like the real API.
function serverApi(rows: Listing[]) {
  const api = fakeApi();
  api.listItems.mockImplementation(async (query: ListingQuery) => {
    const words = (query.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const items = rows.filter(
      (l) =>
        (!query.category || l.category === query.category) &&
        words.every((w) => `${l.title} ${l.description}`.toLowerCase().includes(w)),
    );
    return { items, pagination: { page: 1, pageSize: 20, total: items.length, totalPages: 1 } };
  });
  api.createItem.mockImplementation(async (_token: string, input: ListingInput) => {
    const created = listing({
      id: `22222222-2222-4222-8222-${String(rows.length).padStart(12, '0')}`,
      owner: { id: 'user-1', displayName: 'Sara' },
      title: input.title,
      description: input.description,
      category: input.category,
    });
    rows.unshift(created);
    return { listing: created };
  });
  return api;
}

async function renderBoth(api: ReturnType<typeof fakeApi>) {
  const s = services({ api });
  await s.sessionManager.setSession(session(1));
  await render(
    <AuthProvider services={s.asServices}>
      <ListingsProvider services={{ api: s.api as unknown as ApiClient, sessionManager: s.sessionManager }}>
        <AppProvider>
          <BrowseScreen />
          <LendNewScreen />
        </AppProvider>
      </ListingsProvider>
    </AuthProvider>,
  );
  return s;
}

async function createListing(title: string, category?: string) {
  await fireEvent.changeText(screen.getByLabelText('Item title'), title);
  await fireEvent.changeText(screen.getByLabelText('Description'), 'A perfectly good item to lend.');
  if (category) await fireEvent.press(screen.getAllByRole('button', { name: category }).at(-1)!);
  await fireEvent.press(screen.getByRole('button', { name: 'List my item' }));
  await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
}

describe('home feed after creating a listing', () => {
  test('shows the new listing without a full-screen loading state', async () => {
    const rows = [listing({ title: 'Old ladder' })];
    const api = serverApi(rows);
    await renderBoth(api);
    expect(await screen.findByText('Old ladder')).toBeTruthy();

    await createListing('Wireless power bank');

    expect(await screen.findByText('Wireless power bank')).toBeTruthy();
    expect(screen.getByText('Old ladder')).toBeTruthy();
    expect(screen.getByText('2 items available to borrow')).toBeTruthy();
    expect(screen.queryByLabelText('Loading items')).toBeNull();
  });

  test('refetches the first page once per change, not repeatedly', async () => {
    const api = serverApi([]);
    await renderBoth(api);
    await screen.findByText('No items yet');
    const before = api.listItems.mock.calls.length;

    await createListing('Wireless power bank');
    await screen.findByText('Wireless power bank');
    // Let any stray effects run.
    await act(async () => new Promise((r) => setTimeout(r, 50)));

    expect(api.listItems.mock.calls.length - before).toBe(1);
    expect(api.listItems).toHaveBeenLastCalledWith({ page: 1, pageSize: 20 }, 'access-1');
  });

  test('a later filter change after a create does not send a duplicate request', async () => {
    const api = serverApi([]);
    await renderBoth(api);
    await screen.findByText('No items yet');
    await createListing('Wireless power bank');
    await screen.findByText('Wireless power bank');
    const before = api.listItems.mock.calls.length;

    // The new listing is in Tools (the form default), so Books hides it.
    await fireEvent.press(screen.getAllByRole('button', { name: 'Books' })[0]!);
    await screen.findByText('Nothing found');
    await act(async () => new Promise((r) => setTimeout(r, 50)));

    expect(api.listItems.mock.calls.length - before).toBe(1);
  });

  test('keeps the user’s category filter and says when it hides the new listing', async () => {
    const api = serverApi([]);
    await renderBoth(api);
    await screen.findByText('No items yet');
    await fireEvent.press(screen.getAllByRole('button', { name: 'Tools' })[0]!);
    await screen.findByText('Nothing found');

    await createListing('Wireless power bank', 'Electronics');

    // The filter is not changed behind the user's back...
    expect(api.listItems).toHaveBeenLastCalledWith({ category: 'tools', page: 1, pageSize: 20 }, 'access-1');
    // ...but the feed explains why the new item is not in view.
    expect(await screen.findByText(/Your new listing is hidden by the current search or category/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Show all items' }));
    expect(await screen.findByText('Wireless power bank')).toBeTruthy();
  });

  test('a failed background refresh is reported instead of silently showing old results', async () => {
    const rows = [listing({ title: 'Old ladder' })];
    const api = serverApi(rows);
    await renderBoth(api);
    await screen.findByText('Old ladder');
    const realList = api.listItems.getMockImplementation()!;
    api.listItems.mockRejectedValueOnce(apiError(0, 'NETWORK_ERROR'));

    await createListing('Wireless power bank');

    expect(await screen.findByText(/Could not refresh the list/)).toBeTruthy();
    expect(screen.getByText('Old ladder')).toBeTruthy();
    api.listItems.mockImplementation(realList);
    await fireEvent.press(screen.getByRole('button', { name: 'Refresh list' }));
    expect(await screen.findByText('Wireless power bank')).toBeTruthy();
    expect(screen.queryByText(/Could not refresh the list/)).toBeNull();
  });

  test('returning to the tab retries a failed background refresh', async () => {
    const rows = [listing({ title: 'Old ladder' })];
    const api = serverApi(rows);
    await renderBoth(api);
    await screen.findByText('Old ladder');
    const realList = api.listItems.getMockImplementation()!;
    api.listItems.mockRejectedValueOnce(apiError(503, 'DATABASE_UNAVAILABLE'));
    await createListing('Wireless power bank');
    await screen.findByText(/Could not refresh the list/);
    api.listItems.mockImplementation(realList);

    await act(async () => mockFocus.current!());

    expect(await screen.findByText('Wireless power bank')).toBeTruthy();
    expect(screen.queryByText(/Could not refresh the list/)).toBeNull();
  });

  test('returning to an up-to-date tab sends no request', async () => {
    const api = serverApi([listing({ title: 'Old ladder' })]);
    await renderBoth(api);
    await screen.findByText('Old ladder');
    await createListing('Wireless power bank');
    await screen.findByText('Wireless power bank');
    const before = api.listItems.mock.calls.length;

    await act(async () => mockFocus.current!());
    await act(async () => new Promise((r) => setTimeout(r, 50)));

    expect(api.listItems.mock.calls.length).toBe(before);
  });

  test('a failed create shows the error on the form and leaves the feed as it was', async () => {
    const api = serverApi([listing({ title: 'Old ladder' })]);
    api.createItem.mockRejectedValueOnce(apiError(503, 'DATABASE_UNAVAILABLE'));
    await renderBoth(api);
    await screen.findByText('Old ladder');
    const before = api.listItems.mock.calls.length;

    await fireEvent.changeText(screen.getByLabelText('Item title'), 'Wireless power bank');
    await fireEvent.changeText(screen.getByLabelText('Description'), 'A perfectly good item to lend.');
    await fireEvent.press(screen.getByRole('button', { name: 'List my item' }));

    expect(await screen.findByText('NeighborShare is temporarily unavailable. Please try again shortly.')).toBeTruthy();
    expect(mockRouter.back).not.toHaveBeenCalled();
    expect(api.listItems.mock.calls.length).toBe(before);
    expect(screen.queryByText('Wireless power bank')).toBeNull();
  });

  test('pull-to-refresh fetches the first page again', async () => {
    const rows = [listing({ title: 'Old ladder' })];
    const api = serverApi(rows);
    await renderBoth(api);
    await screen.findByText('Old ladder');
    // Created elsewhere (another device): only a refresh can show it.
    rows.unshift(listing({ id: '33333333-3333-4333-8333-333333333333', title: 'Camping tent' }));

    const refreshControl = () => screen.getByTestId('listing-feed').props.refreshControl;
    await act(async () => refreshControl().props.onRefresh());

    expect(await screen.findByText('Camping tent')).toBeTruthy();
    expect(refreshControl().props.refreshing).toBe(false);
  });
});
