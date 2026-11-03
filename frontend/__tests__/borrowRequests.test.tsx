import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AuthProvider } from '../context/AuthContext';
import { ListingsProvider } from '../context/ListingsContext';
import { BorrowRequestsProvider } from '../context/BorrowRequestsContext';
import { ChatProvider } from '../context/ChatContext';
import { AppProvider } from '../context/AppContext';
import { BorrowRequestSheet } from '../components/borrow/BorrowRequestSheet';
import ItemDetailScreen from '../app/item/[id]';
import BorrowRequestsScreen from '../app/requests/index';
import type { ApiClient } from '../lib/api/client';
import { formatRange, inclusiveDays, rangeProblem, todayInPakistan } from '../lib/borrow/dates';
import { apiError, borrowRequest, fakeApi, listing, services, session } from './support/fakes';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (effect: () => void) => jest.requireActual('react').useEffect(effect, [effect]),
}));
jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }));

const TODAY = '2026-11-10';

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = {};
});

async function renderApp(element: React.ReactElement, api = fakeApi()) {
  const s = services({ api });
  await s.sessionManager.setSession(session(1));
  const svc = { api: s.api as unknown as ApiClient, sessionManager: s.sessionManager };
  await render(
    <AuthProvider services={s.asServices}>
      <ListingsProvider services={svc}>
        <BorrowRequestsProvider services={svc}>
          <ChatProvider services={{ ...svc, socket: null, newId: () => 'client-id' }}>
            <AppProvider>{element}</AppProvider>
          </ChatProvider>
        </BorrowRequestsProvider>
      </ListingsProvider>
    </AuthProvider>,
  );
  return s;
}

const press = async (name: string | RegExp) => fireEvent.press(screen.getByRole('button', { name }));
const sendButton = () => screen.getByRole('button', { name: 'Send request' });

describe('date rules', () => {
  test('Pakistan date, inclusive days and readable ranges', () => {
    expect(todayInPakistan(Date.parse('2026-11-09T23:30:00Z'))).toBe('2026-11-10');
    expect(inclusiveDays('2026-11-12', '2026-11-14')).toBe(3);
    expect(inclusiveDays('2026-11-12', '2026-11-12')).toBe(1);
    expect(formatRange('2026-11-12', '2026-11-14')).toBe('12 Nov – 14 Nov');
  });

  test('range problems match the server rules', () => {
    const booked = [{ startDate: '2026-11-15', endDate: '2026-11-16' }];
    expect(rangeProblem(null, [], TODAY)).toMatch(/Choose a start/);
    expect(rangeProblem({ startDate: '2026-11-09', endDate: '2026-11-10' }, [], TODAY)).toMatch(/today onwards/);
    expect(rangeProblem({ startDate: '2026-11-12', endDate: '2026-12-12' }, [], TODAY)).toMatch(/at most 30 days/);
    expect(rangeProblem({ startDate: '2026-11-14', endDate: '2026-11-15' }, booked, TODAY)).toMatch(/already booked/);
    expect(rangeProblem({ startDate: '2026-11-17', endDate: '2026-11-17' }, booked, TODAY)).toBeNull();
  });
});

describe('request form', () => {
  const renderSheet = async (api = fakeApi(), onSubmitted = jest.fn()) => {
    const s = await renderApp(
      <BorrowRequestSheet visible listing={{ id: listing().id, title: 'Camping tent' }} onClose={jest.fn()} onSubmitted={onSubmitted} today={TODAY} />,
      api,
    );
    await waitFor(() => expect(api.getBookedDates).toHaveBeenCalled());
    return { ...s, onSubmitted };
  };

  test('send is disabled until dates are chosen; then sends the inclusive range and note', async () => {
    const api = fakeApi();
    const { onSubmitted } = await renderSheet(api);
    expect(sendButton().props.accessibilityState.disabled).toBe(true);

    await press('12 Nov');
    await press('14 Nov');
    expect(screen.getByText('12 Nov – 14 Nov · 3 day(s)')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Message to the owner'), '  For a weekend trip  ');
    await fireEvent.press(sendButton());

    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
    expect(api.createBorrowRequest).toHaveBeenCalledWith('access-1', {
      listingId: listing().id,
      startDate: '2026-11-12',
      endDate: '2026-11-14',
      message: 'For a weekend trip',
    });
  });

  test('one tap is a one-day request; tapping an earlier day moves the start', async () => {
    const api = fakeApi();
    await renderSheet(api);
    await press('13 Nov');
    expect(screen.getByText('13 Nov · 1 day(s)')).toBeTruthy();
    await press('11 Nov');
    expect(screen.getByText('11 Nov · 1 day(s)')).toBeTruthy();
  });

  test('booked days are greyed out and cannot be picked; a range across them is refused', async () => {
    const api = fakeApi();
    api.getBookedDates.mockResolvedValue({ bookedDates: [{ startDate: '2026-11-13', endDate: '2026-11-13' }] });
    await renderSheet(api);
    await screen.findByText('Greyed-out days are already booked.');
    expect(screen.getByRole('button', { name: '13 Nov, booked' }).props.accessibilityState.disabled).toBe(true);

    await press('12 Nov');
    await press('14 Nov');
    expect(screen.getByText('Some of those days are already booked.')).toBeTruthy();
    expect(sendButton().props.accessibilityState.disabled).toBe(true);
  });

  test('a double tap sends one request', async () => {
    const api = fakeApi();
    let release: (v: unknown) => void = () => undefined;
    api.createBorrowRequest.mockImplementation(() => new Promise((r) => (release = r)));
    const { onSubmitted } = await renderSheet(api);
    await press('12 Nov');
    await fireEvent.press(sendButton());
    await fireEvent.press(sendButton());
    await act(async () => release({ request: borrowRequest() }));
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
    expect(api.createBorrowRequest).toHaveBeenCalledTimes(1);
  });

  test('dates taken meanwhile: explains it and reloads booked days', async () => {
    const api = fakeApi();
    api.createBorrowRequest.mockRejectedValueOnce(apiError(409, 'DATES_UNAVAILABLE'));
    const { onSubmitted } = await renderSheet(api);
    await press('12 Nov');
    await fireEvent.press(sendButton());
    expect(await screen.findByText('Those dates are already booked. Choose different dates.')).toBeTruthy();
    expect(api.getBookedDates).toHaveBeenCalledTimes(2);
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  test('a duplicate pending request is explained', async () => {
    const api = fakeApi();
    api.createBorrowRequest.mockRejectedValueOnce(apiError(409, 'DUPLICATE_PENDING_REQUEST'));
    await renderSheet(api);
    await press('12 Nov');
    await fireEvent.press(sendButton());
    expect(await screen.findByText(/already have a pending request for this item/)).toBeTruthy();
  });

  test('says chat comes only after acceptance, and offers no chat', async () => {
    await renderSheet();
    expect(screen.getByText(/chat with the owner after they accept/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /chat|message owner/i })).toBeNull();
  });
});

describe('item screen', () => {
  test('a neighbor opens the real request form; no preview transaction is created', async () => {
    mockParams = { id: listing().id };
    await renderApp(<ItemDetailScreen />);
    await screen.findByRole('button', { name: 'Request to borrow' });
    await press('Request to borrow');
    expect(await screen.findByText('Request to borrow')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send request' })).toBeTruthy();
  });

  test('the button is disabled for unavailable items', async () => {
    mockParams = { id: listing().id };
    const api = fakeApi();
    api.getItem.mockResolvedValue({ listing: listing({ availability: 'unavailable' }) });
    await renderApp(<ItemDetailScreen />, api);
    const button = await screen.findByRole('button', { name: 'Not available' });
    expect(button.props.accessibilityState.disabled).toBe(true);
  });

  test('owners do not see the request button', async () => {
    mockParams = { id: listing().id };
    const api = fakeApi();
    api.getItem.mockResolvedValue({ listing: listing({ owner: { id: 'user-1', displayName: 'Sara' } }) });
    await renderApp(<ItemDetailScreen />, api);
    await screen.findByRole('button', { name: 'Edit listing' });
    expect(screen.queryByRole('button', { name: 'Request to borrow' })).toBeNull();
  });
});

describe('borrow requests screen', () => {
  const page = (items: ReturnType<typeof borrowRequest>[]) => ({
    items,
    pagination: { page: 1, pageSize: 50, total: items.length, totalPages: 1 },
  });
  const confirmAlerts = () =>
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      buttons?.find((b) => b.style === 'destructive')?.onPress?.();
    });

  test('Borrowing lists my requests with dates, status and owner', async () => {
    const api = fakeApi();
    api.listOutgoingRequests.mockResolvedValue(page([borrowRequest()]));
    await renderApp(<BorrowRequestsScreen />, api);
    expect(await screen.findByText('Bosch power drill')).toBeTruthy();
    expect(screen.getByText('Owner: Ahmed')).toBeTruthy();
    expect(screen.getByText('12 Nov – 14 Nov · 3 days')).toBeTruthy();
    expect(screen.getByText('Waiting for answer')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Accept/ })).toBeNull();
  });

  test('a borrower cancels a pending request after confirming', async () => {
    const api = fakeApi();
    api.listOutgoingRequests
      .mockResolvedValueOnce(page([borrowRequest()]))
      .mockResolvedValue(page([borrowRequest({ status: 'cancelled', cancelledAt: '2026-11-10T09:00:00Z' })]));
    const alert = confirmAlerts();
    await renderApp(<BorrowRequestsScreen />, api);
    await screen.findByRole('button', { name: /Cancel request for/ });
    await press(/Cancel request for/);
    await waitFor(() => expect(api.decideBorrowRequest).toHaveBeenCalledWith('access-1', borrowRequest().id, 'cancel'));
    expect(await screen.findByText('Cancelled')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Cancel request for/ })).toBeNull();
    alert.mockRestore();
  });

  test('only pending requests can be cancelled', async () => {
    const api = fakeApi();
    api.listOutgoingRequests.mockResolvedValue(page([borrowRequest({ status: 'accepted', decidedAt: '2026-11-10T09:00:00Z' })]));
    await renderApp(<BorrowRequestsScreen />, api);
    expect(await screen.findByText('Accepted')).toBeTruthy();
    expect(screen.getByText('These dates are reserved for you.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Cancel request for/ })).toBeNull();
  });

  test('Lending shows the borrower and message, and accepts', async () => {
    mockParams = { tab: 'lending' };
    const api = fakeApi();
    const incoming = borrowRequest({ viewerRole: 'lender' });
    api.listIncomingRequests
      .mockResolvedValueOnce(page([incoming]))
      .mockResolvedValue(page([{ ...incoming, status: 'accepted', decidedAt: '2026-11-10T09:00:00Z' }]));
    await renderApp(<BorrowRequestsScreen />, api);
    expect(await screen.findByText('Sara wants to borrow this')).toBeTruthy();
    expect(screen.getByText(/For a weekend trip/)).toBeTruthy();

    await press(/Accept request for/);
    await waitFor(() => expect(api.decideBorrowRequest).toHaveBeenCalledWith('access-1', incoming.id, 'accept'));
    expect(await screen.findByText('These dates are reserved for Sara.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Accept request for/ })).toBeNull();
  });

  test('accepting dates that were taken meanwhile shows a clear message and refreshes', async () => {
    mockParams = { tab: 'lending' };
    const api = fakeApi();
    api.listIncomingRequests.mockResolvedValue(page([borrowRequest({ viewerRole: 'lender' })]));
    api.decideBorrowRequest.mockRejectedValueOnce(apiError(409, 'DATES_UNAVAILABLE'));
    await renderApp(<BorrowRequestsScreen />, api);
    await screen.findByText('Sara wants to borrow this');
    const before = api.listIncomingRequests.mock.calls.length;

    await press(/Accept request for/);
    expect(await screen.findByText(/These dates are no longer available: another request for them was accepted/)).toBeTruthy();
    await waitFor(() => expect(api.listIncomingRequests.mock.calls.length).toBeGreaterThan(before));
    // The request is still pending, so the lender can decline it.
    expect(screen.getByRole('button', { name: /Decline request for/ })).toBeTruthy();
  });

  test('declining asks for confirmation first', async () => {
    mockParams = { tab: 'lending' };
    const api = fakeApi();
    api.listIncomingRequests.mockResolvedValue(page([borrowRequest({ viewerRole: 'lender' })]));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await renderApp(<BorrowRequestsScreen />, api);
    await screen.findByText('Sara wants to borrow this');
    await press(/Decline request for/);
    expect(alert).toHaveBeenCalled();
    expect(api.decideBorrowRequest).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  test('switching tabs loads the other list', async () => {
    const api = fakeApi();
    await renderApp(<BorrowRequestsScreen />, api);
    await screen.findByText('No borrow requests yet');
    await fireEvent.press(screen.getByRole('tab', { name: 'Lending' }));
    expect(await screen.findByText('No requests for your items yet')).toBeTruthy();
    expect(api.listIncomingRequests).toHaveBeenCalled();
  });

  test('a load failure offers a working retry', async () => {
    const api = fakeApi();
    api.listOutgoingRequests.mockRejectedValueOnce(apiError(0, 'NETWORK_ERROR')).mockResolvedValue(page([borrowRequest()]));
    await renderApp(<BorrowRequestsScreen />, api);
    expect(await screen.findByText('Could not load requests')).toBeTruthy();
    await press('Try again');
    expect(await screen.findByText('Bosch power drill')).toBeTruthy();
  });

  test('pull-to-refresh reloads the list', async () => {
    const api = fakeApi();
    api.listOutgoingRequests.mockResolvedValueOnce(page([])).mockResolvedValue(page([borrowRequest()]));
    await renderApp(<BorrowRequestsScreen />, api);
    await screen.findByText('No borrow requests yet');
    await act(async () => screen.getByTestId('requests-list').props.refreshControl.props.onRefresh());
    expect(await screen.findByText('Bosch power drill')).toBeTruthy();
  });

  // Chat (Phase 2C) opens only after acceptance.
  test('no chat is offered on pending, declined or cancelled requests', async () => {
    const api = fakeApi();
    api.listOutgoingRequests.mockResolvedValue(
      page([
        borrowRequest(),
        borrowRequest({ id: 'r-declined', status: 'declined', decidedAt: '2026-11-10T09:00:00Z' }),
        borrowRequest({ id: 'r-cancelled', status: 'cancelled', cancelledAt: '2026-11-10T09:00:00Z' }),
      ]),
    );
    await renderApp(<BorrowRequestsScreen />, api);
    await screen.findByText('Declined');
    expect(screen.queryByText(/chat/i)).toBeNull();
    expect(api.openConversation).not.toHaveBeenCalled();
  });

  test('an accepted request offers chat', async () => {
    const api = fakeApi();
    api.listOutgoingRequests.mockResolvedValue(page([borrowRequest({ status: 'accepted', decidedAt: '2026-11-10T09:00:00Z' })]));
    await renderApp(<BorrowRequestsScreen />, api);
    await screen.findByText('Accepted');
    expect(screen.getByRole('button', { name: 'Open chat about Bosch power drill' })).toBeTruthy();
  });
});
