import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AuthProvider } from '../context/AuthContext';
import { ListingsProvider } from '../context/ListingsContext';
import { BorrowRequestsProvider } from '../context/BorrowRequestsContext';
import { ChatProvider } from '../context/ChatContext';
import ActivityScreen from '../app/(tabs)/activity';
import MyListingsScreen from '../app/listings/mine';
import type { ApiClient } from '../lib/api/client';
import type { ActivityItem } from '../lib/api/types';
import { describeActivity } from '../lib/activity/describe';
import { groupByPoint, shortLabel } from '../lib/listings/mapSpots';
import { apiError, fakeApi, listing, services, session } from './support/fakes';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), navigate: jest.fn(), canGoBack: jest.fn(() => true) };
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({}),
  useFocusEffect: (effect: () => void) => jest.requireActual('react').useEffect(effect, [effect]),
}));

beforeEach(() => jest.clearAllMocks());

async function renderWith(element: React.ReactElement, api = fakeApi()) {
  const s = services({ api });
  await s.sessionManager.setSession(session(1));
  const svc = { api: s.api as unknown as ApiClient, sessionManager: s.sessionManager };
  await render(
    <AuthProvider services={s.asServices}>
      <ListingsProvider services={svc}>
        <BorrowRequestsProvider services={svc}>
          <ChatProvider services={{ ...svc, socket: null, newId: () => 'id' }}>{element}</ChatProvider>
        </BorrowRequestsProvider>
      </ListingsProvider>
    </AuthProvider>,
  );
  return api;
}

const request = { id: 'r1', status: 'accepted' as const, startDate: '2026-11-12', endDate: '2026-11-14', viewerRole: 'lender' as const };
const tent = { id: 'l1', title: 'Camping tent', imageUrl: null };
const event = (over: Partial<ActivityItem>): ActivityItem => ({
  id: 'e',
  type: 'request_received',
  occurredAt: '2026-11-04T10:00:00Z',
  actor: { id: 'user-2', displayName: 'Ahmed', isYou: false },
  listing: tent,
  request,
  conversationId: null,
  preview: null,
  recipientName: null,
  handoverMethod: null,
  ...over,
});

describe('activity wording', () => {
  test('says who did what, from the user’s side', () => {
    expect(describeActivity(event({}))).toBe('Ahmed asked to borrow your Camping tent');
    expect(describeActivity(event({ type: 'request_sent', actor: { id: 'user-1', displayName: null, isYou: true } }))).toBe(
      'You asked to borrow Camping tent',
    );
    expect(describeActivity(event({ type: 'request_accepted' }))).toBe('Ahmed accepted your request for Camping tent');
    expect(describeActivity(event({ type: 'request_accepted', actor: { id: 'user-1', displayName: 'Sara', isYou: true } }))).toBe(
      'You accepted a request for Camping tent',
    );
    expect(describeActivity(event({ type: 'request_declined' }))).toBe('Ahmed declined your request for Camping tent');
    expect(describeActivity(event({ type: 'request_cancelled' }))).toBe('Ahmed cancelled their request for Camping tent');
    expect(describeActivity(event({ type: 'message' }))).toBe('Ahmed sent you a message about Camping tent');
    expect(describeActivity(event({ type: 'listing_created', actor: { id: 'user-1', displayName: 'Sara', isYou: true } }))).toBe(
      'You listed Camping tent',
    );
    expect(describeActivity(event({ actor: { id: 'user-2', displayName: null, isYou: false } }))).toBe(
      'A neighbour asked to borrow your Camping tent',
    );
  });
});

describe('Activity screen', () => {
  test('shows real activity from the server, with times, dates and message previews', async () => {
    const api = fakeApi();
    api.getActivity.mockResolvedValue({
      items: [
        event({ id: 'm', type: 'message', conversationId: 'c1', preview: 'Can I pick it up at 5?' }),
        event({ id: 'a', type: 'request_accepted', actor: { id: 'user-1', displayName: 'Sara', isYou: true } }),
        event({ id: 'l', type: 'listing_created', request: null, actor: { id: 'user-1', displayName: 'Sara', isYou: true } }),
      ],
      unavailable: [],
    });
    await renderWith(<ActivityScreen />, api);
    expect(await screen.findByText('Ahmed sent you a message about Camping tent')).toBeTruthy();
    expect(api.getActivity).toHaveBeenCalledWith('access-1', { limit: 50 });
    expect(screen.getByText('“Can I pick it up at 5?”')).toBeTruthy();
    expect(screen.getByText('You accepted a request for Camping tent')).toBeTruthy();
    expect(screen.getAllByText(/for 12/).length).toBeGreaterThan(0);

    await fireEvent.press(screen.getByRole('button', { name: 'Ahmed sent you a message about Camping tent' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/chat/c1');
    await fireEvent.press(screen.getByRole('button', { name: 'You accepted a request for Camping tent' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/requests/${request.id}`);
    await fireEvent.press(screen.getByRole('button', { name: 'You listed Camping tent' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/item/l1');
  });

  test('no activity shows the empty state, never sample entries', async () => {
    await renderWith(<ActivityScreen />);
    expect(await screen.findByText('No activity yet')).toBeTruthy();
    expect(screen.queryByText(/Borrowed from|Lent to|Teach Me/)).toBeNull();
  });

  test('an error offers a retry; a partly unavailable feed says so', async () => {
    const api = fakeApi();
    api.getActivity
      .mockRejectedValueOnce(apiError(503, 'DATABASE_UNAVAILABLE'))
      .mockResolvedValueOnce({ items: [event({})], unavailable: ['conversations'] });
    await renderWith(<ActivityScreen />, api);
    expect(await screen.findByText('Could not load your activity')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Ahmed asked to borrow your Camping tent')).toBeTruthy();
    expect(screen.getByText(/could not be loaded right now \(messages\)/)).toBeTruthy();
  });
});

describe('My Listings', () => {
  test('lists the user’s own listings (including removed ones) and opens them', async () => {
    const api = fakeApi();
    api.listItems.mockResolvedValue({
      items: [
        listing({ id: 'x', title: 'Bosch drill', owner: { id: 'user-1', displayName: 'Sara' } }),
        listing({ id: 'y', title: 'Old kettle', owner: { id: 'user-1', displayName: 'Sara' }, archivedAt: '2026-11-01T00:00:00Z' }),
      ],
      pagination: { page: 1, pageSize: 50, total: 2, totalPages: 1 },
    });
    await renderWith(<MyListingsScreen />, api);
    expect(await screen.findByText('Bosch drill')).toBeTruthy();
    expect(api.listItems).toHaveBeenCalledWith({ owner: 'me', includeArchived: true, pageSize: 50 }, 'access-1');
    expect(screen.getByRole('button', { name: 'Old kettle, Removed' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Bosch drill, Available' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/item/x');
  });

  test('with nothing listed it offers to list an item', async () => {
    await renderWith(<MyListingsScreen />);
    expect(await screen.findByText('You have not listed anything yet')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'List your first item' }));
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/lend/new'));
  });
});

describe('map marker helpers', () => {
  test('labels are short and cut at a word; equal points group together', () => {
    expect(shortLabel('Drill')).toBe('Drill');
    expect(shortLabel('Four-person waterproof camping tent')).toBe('Four-person…');
    expect(shortLabel('Supercalifragilistic')).toBe('Supercalifrag…');
    const p = { latitude: 31.441, longitude: 73.071 };
    const spots = groupByPoint([
      listing({ id: 'a', approximateLocation: p }),
      listing({ id: 'b', approximateLocation: { ...p } }),
      listing({ id: 'c', approximateLocation: { latitude: 31.45, longitude: 73.071 } }),
      listing({ id: 'd', approximateLocation: null }),
    ]);
    expect(spots.map((s) => s.items.map((i) => i.id))).toEqual([['a', 'b'], ['c']]);
  });
});
