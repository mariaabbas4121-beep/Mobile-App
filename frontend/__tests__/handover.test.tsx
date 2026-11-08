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
import { memoryPickupCodes, type PickupCodeStore } from '../lib/handover/codeStore';
import { codeFromScan, formatPickupCode } from '../lib/handover/pickupCode';
import { describeActivity } from '../lib/activity/describe';
import type { SocketLike } from '../lib/chat/connection';
import {
  PICKUP_CODE,
  apiError,
  borrowRequest,
  fakeApi,
  handover,
  handoverState,
  pickupAuthorization,
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

// The QR renders its value as text, so tests can read what it encodes.
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

// Camera: permission state is set per test; the scanner exposes its callback.
const mockCamera: { permission: unknown; request: jest.Mock; onScan: ((e: { data: string }) => void) | undefined } = {
  permission: null,
  request: jest.fn(),
  onScan: undefined,
};
jest.mock('expo-camera', () => {
  const { View } = jest.requireActual('react-native');
  const R = jest.requireActual('react');
  return {
    useCameraPermissions: () => [mockCamera.permission, mockCamera.request],
    CameraView: (props: { onBarcodeScanned?: (e: { data: string }) => void; testID?: string }) => {
      mockCamera.onScan = props.onBarcodeScanned;
      return R.createElement(View, { testID: props.testID });
    },
  };
});
const mockPicker = {
  requestCameraPermissionsAsync: jest.fn(async () => ({ granted: true })),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
};
jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: () => mockPicker.requestCameraPermissionsAsync(),
  launchCameraAsync: (o: unknown) => mockPicker.launchCameraAsync(o),
  launchImageLibraryAsync: (o: unknown) => mockPicker.launchImageLibraryAsync(o),
}));

const REQUEST_ID = borrowRequest().id;
const accepted = (viewerRole: 'borrower' | 'lender') => ({ request: borrowRequest({ status: 'accepted', viewerRole }) });

// A socket stand-in, so a test can deliver server events.
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

async function renderScreen(element: React.ReactElement, api = fakeApi(), codes: PickupCodeStore = memoryPickupCodes()) {
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

const press = (name: string | RegExp) => fireEvent.press(screen.getByRole('button', { name }));

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = {};
  mockCamera.permission = null;
  mockCamera.onScan = undefined;
  jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
    void buttons?.find((b) => b.style === 'destructive')?.onPress?.();
  });
});

describe('pickup codes', () => {
  test('recognises the QR and typed codes, nothing else', () => {
    expect(codeFromScan(`neighborshare://pickup?v=1&code=${PICKUP_CODE}`)).toBe(PICKUP_CODE);
    expect(codeFromScan(formatPickupCode(PICKUP_CODE).toLowerCase())).toBe(PICKUP_CODE);
    expect(codeFromScan(`neighborshare://pickup?v=9&code=${PICKUP_CODE}`)).toBeNull();
    expect(codeFromScan('https://example.com/?code=1')).toBeNull();
  });
});

describe('request details: borrower', () => {
  test('choosing how to collect: in person needs nothing; someone else opens the authorization', async () => {
    mockParams = { id: REQUEST_ID };
    const api = fakeApi();
    api.getBorrowRequest.mockResolvedValue(accepted('borrower'));
    await renderScreen(<RequestDetailsScreen />, api);
    expect(await screen.findByText('Not picked up yet')).toBeTruthy();
    await press('Collect the item myself');
    expect(screen.getByText(/You cannot mark it yourself/)).toBeTruthy();
    expect(api.confirmHandover).not.toHaveBeenCalled();
    await press('Authorize someone else to collect it');
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/handover/authorize', params: { requestId: REQUEST_ID } });
  });

  test('an active authorization shows who, until when, and can be revoked', async () => {
    mockParams = { id: REQUEST_ID };
    const api = fakeApi();
    api.getBorrowRequest.mockResolvedValue(accepted('borrower'));
    const active = pickupAuthorization();
    api.getHandover.mockResolvedValue({ handover: handoverState({ authorizations: [active], activeAuthorization: active }) });
    await renderScreen(<RequestDetailsScreen />, api);
    expect(await screen.findByLabelText('Authorization for Ali Khan, Active')).toBeTruthy();
    await press('Show pickup QR');
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/handover/authorize', params: { requestId: REQUEST_ID, authorizationId: active.id } });
    await press(/Revoke Ali Khan/);
    await waitFor(() => expect(api.revokePickupAuthorization).toHaveBeenCalledWith('access-1', REQUEST_ID, active.id));
  });

  test('a completed handover shows when, to whom, the notes and the photos', async () => {
    mockParams = { id: REQUEST_ID };
    const api = fakeApi();
    api.getBorrowRequest.mockResolvedValue(accepted('borrower'));
    api.getHandover.mockResolvedValue({
      handover: handoverState({
        status: 'completed',
        handover: handover({
          method: 'authorized',
          recipientName: 'Ali Khan',
          recipientPhone: '03001234567',
          conditionNotes: 'Scratch on the handle',
          photos: [{ id: 'p1', url: 'https://storage.test/p1.jpg', contentType: 'image/jpeg', createdAt: '2026-11-12T09:31:00Z' }],
        }),
        authorizations: [pickupAuthorization({ status: 'redeemed', redeemedAt: '2026-11-12T09:30:00Z' })],
      }),
    });
    await renderScreen(<RequestDetailsScreen />, api);
    expect(await screen.findByText('Handed over')).toBeTruthy();
    expect(screen.getByText(/Collected by Ali Khan \(03001234567\), authorized by you/)).toBeTruthy();
    expect(screen.getByText('Scratch on the handle')).toBeTruthy();
    expect(screen.getAllByLabelText('Condition photo')).toHaveLength(1);
    expect(screen.getByLabelText('Authorization for Ali Khan, Used')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Authorize someone/ })).toBeNull();
  });

  test('reloads when the server says the pickup changed on the other device', async () => {
    mockParams = { id: REQUEST_ID };
    const api = fakeApi();
    api.getBorrowRequest.mockResolvedValue(accepted('borrower'));
    const { live } = await renderScreen(<RequestDetailsScreen />, api);
    await screen.findByText('Not picked up yet');
    api.getHandover.mockResolvedValue({ handover: handoverState({ status: 'completed', handover: handover() }) });
    await act(async () => live.emit('handover:updated', { borrowRequestId: REQUEST_ID }));
    expect(await screen.findByText('Handed over')).toBeTruthy();
  });
});

describe('request details: lender', () => {
  test('offers Scan Pickup QR and Confirm Pickup, and shows who the borrower authorized', async () => {
    mockParams = { id: REQUEST_ID };
    const api = fakeApi();
    api.getBorrowRequest.mockResolvedValue(accepted('lender'));
    const active = pickupAuthorization();
    api.getHandover.mockResolvedValue({ handover: handoverState({ authorizations: [active], activeAuthorization: active }) });
    await renderScreen(<RequestDetailsScreen />, api);
    expect(await screen.findByText('Ali Khan')).toBeTruthy();
    await press('Scan pickup QR');
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/handover/confirm', params: { requestId: REQUEST_ID, mode: 'scan' } });
    await press(/Confirm pickup by Sara/);
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/handover/confirm', params: { requestId: REQUEST_ID, mode: 'personal' } });
  });

  test('requests that are not accepted have no pickup actions', async () => {
    mockParams = { id: REQUEST_ID };
    const api = fakeApi();
    api.getBorrowRequest.mockResolvedValue({ request: borrowRequest({ status: 'pending', viewerRole: 'lender' }) });
    await renderScreen(<RequestDetailsScreen />, api);
    expect(await screen.findByText(/once the request is accepted/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Scan pickup QR' })).toBeNull();
    expect(api.getHandover).not.toHaveBeenCalled();
  });
});

describe('authorizing someone else', () => {
  test('form, review, explicit confirmation, then the one-time QR, which can be shared', async () => {
    mockParams = { requestId: REQUEST_ID };
    const api = fakeApi();
    api.getBorrowRequest.mockResolvedValue(accepted('borrower'));
    const { codes } = await renderScreen(<AuthorizePickupScreen />, api);
    await screen.findByLabelText("Authorized person's name");
    // Name is required; a bad phone number is caught.
    expect(screen.getByRole('button', { name: 'Review authorization' })).toBeDisabled();
    await fireEvent.changeText(screen.getByLabelText("Authorized person's name"), 'Ali Khan');
    await fireEvent.changeText(screen.getByLabelText("Authorized person's phone number"), 'call me');
    expect(screen.getByText(/7 to 15 digits/)).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText("Authorized person's phone number"), '0300 123-4567');
    await fireEvent.changeText(screen.getByLabelText('Note for the owner'), 'My brother');
    await press('Review authorization');

    // Nothing is created until the borrower confirms.
    expect(screen.getByText(/to collect/)).toBeTruthy();
    expect(api.createPickupAuthorization).not.toHaveBeenCalled();
    await press('Confirm and create QR');
    await waitFor(() =>
      expect(api.createPickupAuthorization).toHaveBeenCalledWith('access-1', REQUEST_ID, {
        recipientName: 'Ali Khan',
        recipientPhone: '03001234567',
        note: 'My brother',
      }),
    );
    expect(await screen.findByText(`neighborshare://pickup?v=1&code=${PICKUP_CODE}`)).toBeTruthy();
    expect(screen.getByText(formatPickupCode(PICKUP_CODE))).toBeTruthy();
    expect(await codes.load(pickupAuthorization().id)).toBe(PICKUP_CODE);

    await press('Share QR');
    await waitFor(() =>
      expect(mockShare).toHaveBeenCalledWith(
        expect.objectContaining({ qrPngBase64: 'iVBORw0KGgo=', recipientName: 'Ali Khan', displayCode: formatPickupCode(PICKUP_CODE) }),
      ),
    );
  });

  test('a server refusal is shown on the review step', async () => {
    mockParams = { requestId: REQUEST_ID };
    const api = fakeApi();
    api.getBorrowRequest.mockResolvedValue(accepted('borrower'));
    api.createPickupAuthorization.mockRejectedValueOnce(apiError(409, 'ACTIVE_AUTHORIZATION_EXISTS'));
    await renderScreen(<AuthorizePickupScreen />, api);
    await fireEvent.changeText(await screen.findByLabelText("Authorized person's name"), 'Ali Khan');
    await press('Review authorization');
    await press('Confirm and create QR');
    expect(await screen.findByText(/Revoke that first/)).toBeTruthy();
  });

  test('the QR can be shown again on this device, and revoked', async () => {
    const active = pickupAuthorization();
    mockParams = { requestId: REQUEST_ID, authorizationId: active.id };
    const api = fakeApi();
    api.getBorrowRequest.mockResolvedValue(accepted('borrower'));
    api.getHandover.mockResolvedValue({ handover: handoverState({ authorizations: [active], activeAuthorization: active }) });
    const codes = memoryPickupCodes();
    await codes.save(active.id, PICKUP_CODE);
    await renderScreen(<AuthorizePickupScreen />, api, codes);
    expect(await screen.findByTestId('qr-value')).toBeTruthy();
    await press('Revoke authorization');
    await waitFor(() => expect(api.revokePickupAuthorization).toHaveBeenCalled());
    expect(await codes.load(active.id)).toBeNull();
    expect(mockRouter.back).toHaveBeenCalled();
  });

  test('without this device’s copy, or once revoked or expired, no QR is shown', async () => {
    for (const a of [pickupAuthorization(), pickupAuthorization({ status: 'expired' }), pickupAuthorization({ status: 'revoked', revokedAt: '2026-11-10T09:00:00Z' })]) {
      mockParams = { requestId: REQUEST_ID, authorizationId: a.id };
      const api = fakeApi();
      api.getBorrowRequest.mockResolvedValue(accepted('borrower'));
      api.getHandover.mockResolvedValue({ handover: handoverState({ authorizations: [a] }) });
      const codes = memoryPickupCodes();
      if (a.status !== 'active') await codes.save(a.id, PICKUP_CODE);
      await renderScreen(<AuthorizePickupScreen />, api, codes);
      expect(
        await screen.findByText(
          a.status === 'active' ? 'QR not available on this device' : `This authorization is ${a.status}`,
        ),
      ).toBeTruthy();
      expect(screen.queryByTestId('qr-value')).toBeNull();
      screen.unmount();
    }
  });
});

describe('lender: scanning', () => {
  const scanApp = async (api = fakeApi()) => {
    mockParams = { requestId: REQUEST_ID, mode: 'scan' };
    api.getBorrowRequest.mockResolvedValue(accepted('lender'));
    return renderScreen(<ConfirmHandoverScreen />, api);
  };

  test('camera permission: asks when it can, points to Settings when it cannot', async () => {
    mockCamera.permission = { granted: false, canAskAgain: true };
    await scanApp();
    await press('Allow camera');
    expect(mockCamera.request).toHaveBeenCalled();
    screen.unmount();

    mockCamera.permission = { granted: false, canAskAgain: false };
    await scanApp();
    expect(await screen.findByText(/turned off for NeighborShare/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Settings' })).toBeTruthy();
    // The typed code still works.
    expect(screen.getByLabelText('Pickup code')).toBeTruthy();
  });

  test('a valid QR shows the authorized person; nothing is handed over until the lender confirms after checking', async () => {
    mockCamera.permission = { granted: true, canAskAgain: true };
    const { api } = await scanApp();
    await screen.findByTestId('pickup-scanner');
    await act(async () => mockCamera.onScan!({ data: `neighborshare://pickup?v=1&code=${PICKUP_CODE}` }));
    expect(api.verifyPickupCode).toHaveBeenCalledWith('access-1', REQUEST_ID, PICKUP_CODE);
    expect(await screen.findByText('Ali Khan')).toBeTruthy();
    expect(screen.getByText('Phone: 03001234567')).toBeTruthy();
    expect(api.confirmHandover).not.toHaveBeenCalled();

    expect(screen.getByRole('button', { name: 'Confirm handover' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('checkbox', { name: 'The person is Ali Khan' }));
    expect(screen.getByRole('button', { name: 'Confirm handover' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('checkbox', { name: 'I checked the item and its condition' }));
    await fireEvent.changeText(screen.getByLabelText('Condition notes'), 'Scratch on the handle');
    await press('Confirm handover');
    await waitFor(() =>
      expect(api.confirmHandover).toHaveBeenCalledWith('access-1', REQUEST_ID, {
        method: 'authorized',
        code: PICKUP_CODE,
        conditionNotes: 'Scratch on the handle',
      }),
    );
    expect(await screen.findByText('Handover recorded')).toBeTruthy();
    expect(screen.getByText(/Handed to Ali Khan/)).toBeTruthy();
  });

  test('other QR codes are refused without asking the server', async () => {
    mockCamera.permission = { granted: true, canAskAgain: true };
    const { api } = await scanApp();
    await screen.findByTestId('pickup-scanner');
    await act(async () => mockCamera.onScan!({ data: 'https://example.com' }));
    expect(screen.getByText('This is not a NeighborShare pickup QR.')).toBeTruthy();
    expect(api.verifyPickupCode).not.toHaveBeenCalled();
  });

  test('expired, revoked, used and wrong codes say not to hand over', async () => {
    for (const [code, text] of [
      ['AUTHORIZATION_EXPIRED', /expired/],
      ['AUTHORIZATION_REVOKED', /revoked/],
      ['AUTHORIZATION_ALREADY_USED', /already been used/],
      ['INVALID_PICKUP_CODE', /not a valid pickup code/],
    ] as const) {
      mockCamera.permission = { granted: true, canAskAgain: true };
      const api = fakeApi();
      api.verifyPickupCode.mockRejectedValueOnce(apiError(409, code));
      await scanApp(api);
      await screen.findByTestId('pickup-scanner');
      await act(async () => mockCamera.onScan!({ data: PICKUP_CODE }));
      const alert = await screen.findByText(/^Do not hand over the item\./);
      expect(alert.props.children).toMatch(text);
      expect(api.confirmHandover).not.toHaveBeenCalled();
      screen.unmount();
    }
  });

  test('the code can be typed instead of scanned', async () => {
    mockCamera.permission = { granted: false, canAskAgain: false };
    const { api } = await scanApp();
    await fireEvent.changeText(await screen.findByLabelText('Pickup code'), formatPickupCode(PICKUP_CODE).toLowerCase());
    await press('Check code');
    await waitFor(() => expect(api.verifyPickupCode).toHaveBeenCalledWith('access-1', REQUEST_ID, PICKUP_CODE));
    expect(await screen.findByText('Ali Khan')).toBeTruthy();
  });
});

describe('lender: personal pickup and evidence', () => {
  const personalApp = async (api = fakeApi()) => {
    mockParams = { requestId: REQUEST_ID, mode: 'personal' };
    api.getBorrowRequest.mockResolvedValue(accepted('lender'));
    return renderScreen(<ConfirmHandoverScreen />, api);
  };
  const asset = (n: number) => ({ uri: `file:///photo${n}.jpg`, mimeType: 'image/jpeg', fileName: `photo${n}.jpg`, fileSize: 1000 });

  test('confirms an in-person pickup only after the item is checked; photos follow', async () => {
    const { api } = await personalApp();
    expect(await screen.findByText(/collecting the item in person/)).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /The person is/ })).toBeNull();
    mockPicker.launchImageLibraryAsync.mockResolvedValueOnce({ canceled: false, assets: [asset(1)] });
    await press('Choose photos');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove photo 1' })).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Confirm handover' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('checkbox', { name: 'I checked the item and its condition' }));
    await press('Confirm handover');
    await waitFor(() => expect(api.confirmHandover).toHaveBeenCalledWith('access-1', REQUEST_ID, { method: 'personal', conditionNotes: null }));
    expect(await screen.findByText('1 condition photo saved.')).toBeTruthy();
    expect(api.uploadHandoverPhoto).toHaveBeenCalledWith('access-1', REQUEST_ID, 'file:///photo1.jpg', 'image/jpeg');
    // Recorded before any upload began.
    expect(api.confirmHandover.mock.invocationCallOrder[0]).toBeLessThan(api.uploadHandoverPhoto.mock.invocationCallOrder[0]!);
  });

  test('a failed photo upload is reported, not hidden, and can be retried', async () => {
    const api = fakeApi();
    api.uploadHandoverPhoto.mockRejectedValueOnce(apiError(0, 'NETWORK_ERROR'));
    await personalApp(api);
    await screen.findByText(/collecting the item in person/);
    mockPicker.launchImageLibraryAsync.mockResolvedValueOnce({ canceled: false, assets: [asset(1), asset(2)] });
    await press('Choose photos');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove photo 2' })).toBeTruthy());
    await fireEvent.press(screen.getByRole('checkbox', { name: 'I checked the item and its condition' }));
    await press('Confirm handover');
    expect(await screen.findByText(/1 of 2 photos saved\. 1 could not be uploaded/)).toBeTruthy();
    expect(screen.getByText(/The handover itself is recorded/)).toBeTruthy();
    await press('Retry photo upload');
    expect(await screen.findByText('2 condition photos saved.')).toBeTruthy();
  });

  test('a refused confirmation (e.g. already handed over) is explained', async () => {
    const api = fakeApi();
    api.confirmHandover.mockRejectedValueOnce(apiError(409, 'ALREADY_HANDED_OVER'));
    await personalApp(api);
    await fireEvent.press(await screen.findByRole('checkbox', { name: 'I checked the item and its condition' }));
    await press('Confirm handover');
    expect(await screen.findByText('This item has already been handed over.')).toBeTruthy();
    expect(api.uploadHandoverPhoto).not.toHaveBeenCalled();
  });
});

describe('activity wording for pickups', () => {
  const base = {
    id: 'h',
    occurredAt: '2026-11-12T09:30:00Z',
    listing: { id: 'l1', title: 'Camping tent', imageUrl: null },
    request: { id: REQUEST_ID, status: 'accepted' as const, startDate: '2026-11-12', endDate: '2026-11-14', viewerRole: 'lender' as const },
    conversationId: null,
    preview: null,
    recipientName: 'Ali Khan',
    handoverMethod: null,
  };
  const sara = { id: 'user-1', displayName: 'Sara', isYou: false };
  const me = { id: 'user-2', displayName: 'Ahmed', isYou: true };

  test('both sides see who did what', () => {
    expect(describeActivity({ ...base, type: 'pickup_authorized', actor: sara })).toBe('Sara authorized Ali Khan to collect Camping tent');
    expect(describeActivity({ ...base, type: 'pickup_authorized', actor: { ...sara, isYou: true } })).toBe(
      'You authorized Ali Khan to collect Camping tent',
    );
    expect(describeActivity({ ...base, type: 'pickup_authorization_revoked', actor: sara })).toBe(
      'Sara revoked Ali Khan’s pickup authorization for Camping tent',
    );
    expect(describeActivity({ ...base, type: 'pickup_authorization_redeemed', actor: me })).toBe('Ali Khan’s pickup code was used for Camping tent');
    expect(describeActivity({ ...base, type: 'item_handed_over', handoverMethod: 'authorized', actor: me })).toBe('You handed over Camping tent to Ali Khan');
    expect(describeActivity({ ...base, type: 'item_handed_over', handoverMethod: 'personal', recipientName: null, actor: { ...me, isYou: false } })).toBe(
      'Ahmed handed over Camping tent to you',
    );
  });
});
