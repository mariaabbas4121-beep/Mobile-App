import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AuthProvider } from '../context/AuthContext';
import { BorrowRequestsProvider } from '../context/BorrowRequestsContext';
import { ChatProvider } from '../context/ChatContext';
import RequestDetailsScreen from '../app/requests/[id]';
import AuthorizePickupScreen from '../app/handover/authorize';
import ConfirmHandoverScreen from '../app/handover/confirm';
import type { ApiClient } from '../lib/api/client';
import { memoryPickupCodes } from '../lib/handover/codeStore';
import { codeFromScan } from '../lib/handover/pickupCode';
import { describeActivity } from '../lib/activity/describe';
import type { SocketLike } from '../lib/chat/connection';
import {
  PICKUP_CODE,
  apiError,
  borrowRequest,
  extension,
  fakeApi,
  handover,
  handoverState,
  itemReturn,
  pickupAuthorization,
  returnState,
  services,
  session,
} from './support/fakes';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), navigate: jest.fn(), canGoBack: jest.fn(() => true) };
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (effect: () => void) => jest.requireActual('react').useEffect(effect, [effect]),
}));
jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }));
jest.mock('react-native-qrcode-svg', () => {
  const { Text } = jest.requireActual('react-native');
  const R = jest.requireActual('react');
  return {
    __esModule: true,
    default: ({ value, getRef }: { value: string; getRef?: (c: unknown) => void }) => {
      getRef?.({ toDataURL: (cb: (d: string) => void) => cb('iVBORw0KGgo=') });
      return R.createElement(Text, { testID: 'qr-value' }, value);
    },
  };
});
const mockShare = jest.fn(async (_s: unknown) => 'image');
jest.mock('../lib/handover/share', () => ({ sharePickupQr: (s: unknown) => mockShare(s) }));
const mockCamera: { permission: unknown; onScan: ((e: { data: string }) => void) | undefined } = { permission: null, onScan: undefined };
jest.mock('expo-camera', () => {
  const { View } = jest.requireActual('react-native');
  const R = jest.requireActual('react');
  return {
    useCameraPermissions: () => [mockCamera.permission, jest.fn()],
    CameraView: (props: { onBarcodeScanned?: (e: { data: string }) => void; testID?: string }) => {
      mockCamera.onScan = props.onBarcodeScanned;
      return R.createElement(View, { testID: props.testID });
    },
  };
});
const mockPicker = { launchImageLibraryAsync: jest.fn(), launchCameraAsync: jest.fn() };
jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: async () => ({ granted: true }),
  launchCameraAsync: (o: unknown) => mockPicker.launchCameraAsync(o),
  launchImageLibraryAsync: (o: unknown) => mockPicker.launchImageLibraryAsync(o),
}));

const REQUEST_ID = borrowRequest().id;
const accepted = (viewerRole: 'borrower' | 'lender') => ({ request: borrowRequest({ status: 'accepted', viewerRole }) });
const pickedUp = { handover: handoverState({ status: 'completed', handover: handover() }) };
const returnAuth = (over = {}) =>
  pickupAuthorization({ id: '99999999-9999-4999-8999-999999999999', operation: 'return', recipientName: 'Bilal', ...over });

function fakeSocket() {
  const handlers: Record<string, (...args: any[]) => void> = {};
  const socket: SocketLike = {
    connected: false,
    connect: () => handlers.connect?.(),
    disconnect: () => undefined,
    on: (e, l) => (handlers[e] = l),
    off: () => undefined,
    timeout: () => ({ emitWithAck: async () => ({ ok: true }) }),
  };
  return { socket, emit: (e: string, payload: unknown) => handlers[e]?.(payload) };
}

async function renderScreen(element: React.ReactElement, api = fakeApi(), codes = memoryPickupCodes()) {
  const s = services({ api });
  await s.sessionManager.setSession(session(1));
  const live = fakeSocket();
  const svc = { api: s.api as unknown as ApiClient, sessionManager: s.sessionManager };
  await render(
    <AuthProvider services={s.asServices}>
      <BorrowRequestsProvider services={{ ...svc, pickupCodes: codes }}>
        <ChatProvider services={{ ...svc, socket: { url: 'http://test', create: () => live.socket }, newId: () => 'id' }}>{element}</ChatProvider>
      </BorrowRequestsProvider>
    </AuthProvider>,
  );
  return { api, codes, live };
}

// A details screen for an accepted, picked-up request.
async function details(viewer: 'borrower' | 'lender', state = returnState(), api = fakeApi()) {
  mockParams = { id: REQUEST_ID };
  api.getBorrowRequest.mockResolvedValue(accepted(viewer));
  api.getHandover.mockResolvedValue(pickedUp);
  api.getReturn.mockResolvedValue({ return: state });
  const r = await renderScreen(<RequestDetailsScreen />, api);
  await screen.findByLabelText('Due date');
  return r;
}

const press = (name: string | RegExp) => fireEvent.press(screen.getByRole('button', { name }));

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = {};
  mockCamera.permission = null;
  mockCamera.onScan = undefined;
  // Answers every confirmation dialog with its non-cancel choice.
  jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
    void buttons?.filter((b) => b.style !== 'cancel').at(-1)?.onPress?.();
  });
});

describe('return codes', () => {
  test('a pickup QR is not a return code, and vice versa', () => {
    expect(codeFromScan(`neighborshare://return?v=1&code=${PICKUP_CODE}`, 'return')).toBe(PICKUP_CODE);
    expect(codeFromScan(`neighborshare://pickup?v=1&code=${PICKUP_CODE}`, 'return')).toBeNull();
    expect(codeFromScan(`neighborshare://return?v=1&code=${PICKUP_CODE}`, 'pickup')).toBeNull();
  });
});

describe('borrower: starting the return', () => {
  test('ready to return, with the due date; returning in person needs the owner’s confirmation', async () => {
    const { api } = await details('borrower');
    expect(screen.getByLabelText('Ready to return')).toBeTruthy();
    expect(screen.getByText('Return by 14 Nov')).toBeTruthy();
    await press('Return it myself');
    await waitFor(() => expect(api.initiateReturn).toHaveBeenCalledWith('access-1', REQUEST_ID, { method: 'personal' }));
    // No button lets the borrower complete the return.
    expect(screen.queryByRole('button', { name: /Confirm receipt/ })).toBeNull();
  });

  test('delivery details are optional and saved', async () => {
    const { api } = await details('borrower');
    await press('Send it by delivery');
    await fireEvent.changeText(screen.getByLabelText('Delivery provider'), 'TCS');
    await fireEvent.changeText(screen.getByLabelText('Tracking or reference number'), 'TRK-123');
    await press('Save delivery details');
    await waitFor(() =>
      expect(api.initiateReturn).toHaveBeenCalledWith('access-1', REQUEST_ID, {
        method: 'delivery',
        deliveryProvider: 'TCS',
        deliveryReference: 'TRK-123',
        deliveryNote: null,
      }),
    );
  });

  test('authorizing someone else opens the return authorization', async () => {
    await details('borrower');
    await press('Authorize someone else to return it');
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/handover/authorize', params: { requestId: REQUEST_ID, kind: 'return' } });
  });

  test('awaiting confirmation: shows the active code, which can be shown again or revoked', async () => {
    const active = returnAuth();
    const { api } = await details(
      'borrower',
      returnState({
        status: 'awaiting_confirmation',
        return: itemReturn({ method: 'authorized' }),
        authorizations: [active, returnAuth({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'expired' })],
        activeAuthorization: active,
      }),
    );
    expect(screen.getByLabelText('Awaiting confirmation')).toBeTruthy();
    expect(screen.getByText('Awaiting owner’s confirmation')).toBeTruthy();
    expect(screen.getByLabelText('Return authorization for Bilal, Active')).toBeTruthy();
    expect(screen.getByLabelText('Return authorization for Bilal, Expired')).toBeTruthy();
    await press('Show return QR');
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/handover/authorize',
      params: { requestId: REQUEST_ID, authorizationId: active.id, kind: 'return' },
    });
    await press(/Revoke Bilal/);
    await waitFor(() => expect(api.revokeReturnAuthorization).toHaveBeenCalledWith('access-1', REQUEST_ID, active.id));
  });

  test('if return details cannot load, the pickup is still shown', async () => {
    mockParams = { id: REQUEST_ID };
    const api = fakeApi();
    api.getBorrowRequest.mockResolvedValue(accepted('borrower'));
    api.getHandover.mockResolvedValue(pickedUp);
    api.getReturn.mockRejectedValue(apiError(503, 'DATABASE_UNAVAILABLE'));
    await renderScreen(<RequestDetailsScreen />, api);
    expect(await screen.findByText('Handed over')).toBeTruthy();
    expect(screen.getByText(/Return and due-date details could not be loaded/)).toBeTruthy();
  });
});

describe('lender: receiving it back', () => {
  test('scan the return QR, or confirm in person or by delivery', async () => {
    await details(
      'lender',
      returnState({ status: 'awaiting_confirmation', return: itemReturn({ method: 'delivery', delivery: { provider: 'TCS', reference: 'TRK-1', note: null } }) }),
    );
    expect(screen.getByText(/Sara is returning it by delivery/)).toBeTruthy();
    expect(screen.getByText('TCS · ref TRK-1')).toBeTruthy();
    await press('Confirm delivery received');
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/handover/confirm', params: { requestId: REQUEST_ID, mode: 'delivery', kind: 'return' } });
    await press(/Confirm Sara returned it in person/);
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/handover/confirm', params: { requestId: REQUEST_ID, mode: 'personal', kind: 'return' } });
  });

  test('with an authorized person, the return QR can be scanned', async () => {
    const active = returnAuth();
    await details('lender', returnState({ status: 'awaiting_confirmation', return: itemReturn({ method: 'authorized' }), activeAuthorization: active, authorizations: [active] }));
    await press('Scan return QR');
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/handover/confirm', params: { requestId: REQUEST_ID, mode: 'scan', kind: 'return' } });
  });

  test('not started yet: nothing to confirm', async () => {
    await details('lender');
    expect(screen.getByText('Sara has not started the return yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Confirm/ })).toBeNull();
  });

  test('returned: when, how, notes and photos', async () => {
    await details(
      'lender',
      returnState({
        status: 'returned',
        return: itemReturn({
          method: 'authorized',
          recipientName: 'Bilal',
          confirmedAt: '2026-11-14T10:00:00Z',
          confirmedBy: { id: 'user-2', displayName: 'Ahmed' },
          conditionNotes: 'Pole slightly bent',
          photos: [{ id: 'p', url: 'https://storage.test/r.jpg', contentType: 'image/jpeg', createdAt: '2026-11-14T10:01:00Z' }],
        }),
      }),
    );
    expect(screen.getByLabelText('Return completed')).toBeTruthy();
    expect(screen.getByText(/Brought back by Bilal, on behalf of Sara/)).toBeTruthy();
    expect(screen.getByText('Pole slightly bent')).toBeTruthy();
    expect(screen.getAllByLabelText('Return condition photo')).toHaveLength(1);
  });
});

describe('due date, overdue and extensions', () => {
  test('overdue comes from the server and is shown on both sides', async () => {
    await details('lender', returnState({ overdue: true, daysOverdue: 2, today: '2026-11-16' }));
    expect(screen.getByText('Overdue · 2 days')).toBeTruthy();
    expect(screen.getByText(/has not been returned\. Contact Sara in chat/)).toBeTruthy();
  });

  test('not overdue once an approved extension moved the due date', async () => {
    await details(
      'borrower',
      returnState({
        dueDate: '2026-11-17',
        originalDueDate: '2026-11-14',
        today: '2026-11-16',
        overdue: false,
        extensions: [extension({ status: 'approved', requestedWhileOverdue: true, overdueAtDecision: true, decidedAt: '2026-11-15T09:00:00Z' })],
      }),
    );
    expect(screen.getByText('Return by 17 Nov')).toBeTruthy();
    expect(screen.getByText('Extended from 14 Nov')).toBeTruthy();
    expect(screen.getByText('Extension approved')).toBeTruthy();
    expect(screen.queryByText(/Overdue/)).toBeNull();
  });

  test('the borrower asks for a later date with a reason', async () => {
    const { api } = await details('borrower');
    await press('Ask for more time');
    // Starts the day after the due date.
    expect(screen.getByLabelText('New due date 15 Nov')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'One day earlier' })).toBeDisabled();
    await press('One day later');
    await press('One day later');
    expect(screen.getByLabelText('New due date 17 Nov')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Reason for more time'), 'Trip got longer');
    await press('Send extension request');
    await waitFor(() =>
      expect(api.requestExtension).toHaveBeenCalledWith('access-1', REQUEST_ID, { requestedEndDate: '2026-11-17', reason: 'Trip got longer' }),
    );
  });

  test('a refused request is explained', async () => {
    const api = fakeApi();
    api.requestExtension.mockRejectedValueOnce(apiError(409, 'DATES_UNAVAILABLE'));
    await details('borrower', returnState(), api);
    await press('Ask for more time');
    await press('Send extension request');
    expect(await screen.findByText(/already booked/)).toBeTruthy();
  });

  test('pending: the borrower waits and cannot ask again; the due date is unchanged', async () => {
    await details('borrower', returnState({ pendingExtension: extension(), extensions: [extension()] }));
    expect(screen.getByLabelText('Extension pending')).toBeTruthy();
    expect(screen.getByText('Return by 14 Nov')).toBeTruthy();
    expect(screen.getByText(/only changes if Ahmed approves/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ask for more time' })).toBeNull();
  });

  test('the lender approves or declines', async () => {
    const pending = extension();
    const { api } = await details('lender', returnState({ pendingExtension: pending, extensions: [pending] }));
    expect(screen.getByText('Sara asked for more time')).toBeTruthy();
    expect(screen.getByText('“Trip got longer”')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ask for more time' })).toBeNull();
    await press('Approve extension until 17 Nov');
    await waitFor(() => expect(api.decideExtension).toHaveBeenCalledWith('access-1', REQUEST_ID, pending.id, 'approve'));
    await press('Decline extension');
    await waitFor(() => expect(api.decideExtension).toHaveBeenCalledWith('access-1', REQUEST_ID, pending.id, 'reject'));
  });

  test('reloads when the server says the return or due date changed', async () => {
    const api = fakeApi();
    const { live } = await details('borrower', returnState(), api);
    api.getReturn.mockResolvedValue({ return: returnState({ dueDate: '2026-11-18', originalDueDate: '2026-11-14' }) });
    await act(async () => live.emit('return:updated', { borrowRequestId: REQUEST_ID }));
    expect(await screen.findByText('Return by 18 Nov')).toBeTruthy();
  });
});

describe('return authorization screen', () => {
  test('creates a return code (not a pickup code) and shares its QR', async () => {
    mockParams = { requestId: REQUEST_ID, kind: 'return' };
    const api = fakeApi();
    api.getBorrowRequest.mockResolvedValue(accepted('borrower'));
    const { codes } = await renderScreen(<AuthorizePickupScreen />, api);
    expect(await screen.findByText(/Who will return/)).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText("Authorized person's name"), 'Bilal');
    await press('Review authorization');
    await press('Confirm and create QR');
    await waitFor(() => expect(api.createReturnAuthorization).toHaveBeenCalledWith('access-1', REQUEST_ID, { recipientName: 'Bilal', recipientPhone: null, note: null }));
    expect(api.createPickupAuthorization).not.toHaveBeenCalled();
    expect(await screen.findByText(`neighborshare://return?v=1&code=${PICKUP_CODE}`)).toBeTruthy();
    expect(screen.getByText('Bilal can return it')).toBeTruthy();
    expect(await codes.load('99999999-9999-4999-8999-999999999999')).toBe(PICKUP_CODE);
    await press('Share QR');
    await waitFor(() => expect(mockShare).toHaveBeenCalledWith(expect.objectContaining({ operation: 'return', recipientName: 'Bilal' })));
    await press('Revoke authorization');
    await waitFor(() => expect(api.revokeReturnAuthorization).toHaveBeenCalled());
  });
});

describe('lender confirmation screen (return)', () => {
  const confirmApp = async (mode: 'scan' | 'personal' | 'delivery', api = fakeApi()) => {
    mockParams = { requestId: REQUEST_ID, mode, kind: 'return' };
    api.getBorrowRequest.mockResolvedValue(accepted('lender'));
    return renderScreen(<ConfirmHandoverScreen />, api);
  };

  test('scan: a pickup QR is refused; the return QR shows the person; receipt confirmed only after the checks', async () => {
    mockCamera.permission = { granted: true, canAskAgain: true };
    const { api } = await confirmApp('scan');
    await screen.findByTestId('pickup-scanner');
    await act(async () => mockCamera.onScan!({ data: `neighborshare://pickup?v=1&code=${PICKUP_CODE}` }));
    expect(screen.getByText('This is not a NeighborShare return QR.')).toBeTruthy();
    expect(api.verifyReturnCode).not.toHaveBeenCalled();

    await act(async () => mockCamera.onScan!({ data: `neighborshare://return?v=1&code=${PICKUP_CODE}` }));
    expect(api.verifyReturnCode).toHaveBeenCalledWith('access-1', REQUEST_ID, PICKUP_CODE);
    expect(api.verifyPickupCode).not.toHaveBeenCalled();
    expect(await screen.findByLabelText('Valid return code')).toBeTruthy();
    expect(screen.getByText('Bilal')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Confirm receipt' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('checkbox', { name: 'The person is Bilal' }));
    await fireEvent.press(screen.getByRole('checkbox', { name: 'I checked the item and its condition' }));
    await press('Confirm receipt');
    await waitFor(() => expect(api.confirmReturn).toHaveBeenCalledWith('access-1', REQUEST_ID, { method: 'authorized', code: PICKUP_CODE, conditionNotes: null }));
    expect(api.confirmHandover).not.toHaveBeenCalled();
    expect(await screen.findByText('Return recorded')).toBeTruthy();
    expect(screen.getByText(/Returned by Bilal/)).toBeTruthy();
  });

  test('a typed code works; an expired code says not to accept it', async () => {
    mockCamera.permission = { granted: false, canAskAgain: false };
    const api = fakeApi();
    api.verifyReturnCode.mockRejectedValueOnce(apiError(409, 'AUTHORIZATION_EXPIRED'));
    await confirmApp('scan', api);
    await fireEvent.changeText(await screen.findByLabelText('Return code'), PICKUP_CODE.toLowerCase());
    await press('Check code');
    expect(await screen.findByText(/^Do not accept this code\. This code has expired/)).toBeTruthy();
    await press('Check code');
    expect(await screen.findByLabelText('Valid return code')).toBeTruthy();
  });

  test('delivery: confirmed as delivery; a failed photo upload is reported, the return stays recorded, and retry works', async () => {
    const api = fakeApi();
    api.uploadReturnPhoto.mockRejectedValueOnce(apiError(0, 'NETWORK_ERROR'));
    await confirmApp('delivery', api);
    expect(await screen.findByText(/sent the item back by delivery/)).toBeTruthy();
    mockPicker.launchImageLibraryAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///r1.jpg', mimeType: 'image/jpeg', fileName: 'r1.jpg', fileSize: 1000 }],
    });
    await press('Choose photos');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove photo 1' })).toBeTruthy());
    await fireEvent.press(screen.getByRole('checkbox', { name: 'I checked the item and its condition' }));
    await press('Confirm receipt');
    await waitFor(() => expect(api.confirmReturn).toHaveBeenCalledWith('access-1', REQUEST_ID, { method: 'delivery', conditionNotes: null }));
    expect(await screen.findByText(/0 of 1 photos saved/)).toBeTruthy();
    expect(screen.getByText(/The return itself is recorded/)).toBeTruthy();
    expect(screen.getByText('Received by delivery', { exact: false })).toBeTruthy();
    await press('Retry photo upload');
    expect(await screen.findByText('1 condition photo saved.')).toBeTruthy();
    expect(api.uploadReturnPhoto).toHaveBeenCalledTimes(2);
    expect(api.uploadHandoverPhoto).not.toHaveBeenCalled();
  });

  test('a repeated confirmation is explained', async () => {
    const api = fakeApi();
    api.confirmReturn.mockRejectedValueOnce(apiError(409, 'ALREADY_RETURNED'));
    await confirmApp('personal', api);
    await fireEvent.press(await screen.findByRole('checkbox', { name: 'I checked the item and its condition' }));
    await press('Confirm receipt');
    expect(await screen.findByText('This item has already been returned.')).toBeTruthy();
  });
});

describe('activity wording for returns and extensions', () => {
  const base = {
    id: 'r',
    occurredAt: '2026-11-14T10:00:00Z',
    listing: { id: 'l1', title: 'Camping tent', imageUrl: null },
    request: { id: REQUEST_ID, status: 'accepted' as const, startDate: '2026-11-12', endDate: '2026-11-14', viewerRole: 'lender' as const },
    conversationId: null,
    preview: null,
    recipientName: null,
    handoverMethod: null,
    returnMethod: null,
    requestedEndDate: null,
  };
  const sara = { id: 'user-1', displayName: 'Sara', isYou: false };
  const me = { id: 'user-2', displayName: 'Ahmed', isYou: true };

  test('both sides see who did what', () => {
    expect(describeActivity({ ...base, type: 'return_initiated', returnMethod: 'delivery', actor: sara })).toBe('Sara is returning Camping tent by delivery');
    expect(describeActivity({ ...base, type: 'return_initiated', returnMethod: 'personal', actor: { ...sara, isYou: true } })).toBe(
      'You are returning Camping tent in person',
    );
    expect(describeActivity({ ...base, type: 'return_authorized', recipientName: 'Bilal', actor: sara })).toBe('Sara authorized Bilal to return Camping tent');
    expect(describeActivity({ ...base, type: 'return_authorization_redeemed', recipientName: 'Bilal', actor: me })).toBe(
      'Bilal’s return code was used for Camping tent',
    );
    expect(describeActivity({ ...base, type: 'item_returned', actor: me })).toBe('You confirmed Camping tent is back');
    expect(describeActivity({ ...base, type: 'item_returned', actor: { ...me, isYou: false } })).toBe('Ahmed confirmed receiving Camping tent back');
    expect(describeActivity({ ...base, type: 'extension_requested', requestedEndDate: '2026-11-18', actor: sara })).toBe(
      'Sara asked to keep Camping tent until 18 Nov',
    );
    expect(describeActivity({ ...base, type: 'extension_approved', actor: me })).toBe('You approved more time for Camping tent');
    expect(describeActivity({ ...base, type: 'extension_rejected', actor: { ...me, isYou: false } })).toBe('Ahmed declined more time for Camping tent');
  });
});
