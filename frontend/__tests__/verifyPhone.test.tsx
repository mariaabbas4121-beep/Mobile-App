import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AuthProvider } from '../context/AuthContext';
import VerifyPhoneScreen from '../app/verify/phone';
import { apiError, fakeApi, phoneVerification, services, session } from './support/fakes';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

beforeEach(() => jest.clearAllMocks());

// Signed in: the session is in storage before the provider restores it.
async function renderSignedIn(s = services(), ready: () => Promise<unknown> = () => screen.findByLabelText('Phone number')) {
  await s.sessionManager.setSession(session(1));
  await render(
    <AuthProvider services={s.asServices}>
      <VerifyPhoneScreen />
    </AuthProvider>,
  );
  await ready();
  return s;
}

const type = async (label: string, text: string) => fireEvent.changeText(screen.getByLabelText(label), text);
const press = async (name: string | RegExp) => fireEvent.press(screen.getByRole('button', { name }));

async function requestCode(number = '0300 1234567') {
  await type('Phone number', number);
  await press('Send code');
  await screen.findByLabelText('Verification code');
}

describe('Verify phone: number step', () => {
  test('loads the server status and starts on the number step', async () => {
    const s = await renderSignedIn();
    expect(s.api.phoneVerification).toHaveBeenCalledWith('access-1');
    expect(screen.getByRole('button', { name: 'Country: Pakistan, +92' })).toBeTruthy();
  });

  test('an invalid number is caught before any request', async () => {
    const s = await renderSignedIn();
    await type('Phone number', '300 12');
    await press('Send code');
    expect(screen.getByText('Enter a valid Pakistan number, for example 300 1234567.')).toBeTruthy();
    expect(s.api.startPhoneVerification).not.toHaveBeenCalled();
  });

  test('sends the normalised number and does not claim the SMS was delivered', async () => {
    const s = await renderSignedIn();
    await requestCode('0300 1234567');
    expect(s.api.startPhoneVerification).toHaveBeenCalledWith('access-1', '+923001234567');
    expect(screen.getByText(/If \+92••••••4567 can receive text messages, a code is on its way/)).toBeTruthy();
    expect(screen.queryByText(/has been sent|SMS sent/i)).toBeNull();
    expect(screen.getByText('We sent a 6-digit code by text message to +92••••••4567.')).toBeTruthy();
  });

  test('another country can be chosen', async () => {
    const s = await renderSignedIn();
    await press('Country: Pakistan, +92');
    await press('United Arab Emirates, +971');
    await requestCode('050 123 4567');
    expect(s.api.startPhoneVerification).toHaveBeenCalledWith('access-1', '+971501234567');
  });

  test('a double tap sends one request', async () => {
    const api = fakeApi();
    let release: () => void = () => undefined;
    api.startPhoneVerification.mockImplementation(
      () =>
        new Promise((r) => {
          release = () => r({ verification: phoneVerification({ status: 'pending' }), codeSent: true, message: 'm' });
        }),
    );
    await renderSignedIn(services({ api }));
    await type('Phone number', '300 1234567');
    const button = screen.getByRole('button', { name: 'Send code' });
    await fireEvent.press(button);
    await fireEvent.press(button);
    await act(async () => release());
    await screen.findByLabelText('Verification code');
    expect(api.startPhoneVerification).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['SMS_DELIVERY_UNAVAILABLE', 503, 'We could not send a text message right now. Check the number, or try again later.'],
    ['PHONE_VERIFICATION_UNAVAILABLE', 503, 'Phone verification is not available right now. Please try again later.'],
    [
      'PHONE_VERIFICATION_NOT_CONFIGURED',
      503,
      'Phone verification is not set up yet. You can keep using NeighborShare and verify your phone later.',
    ],
    ['NETWORK_ERROR', 0, 'Could not reach NeighborShare. Check your connection and try again.'],
    ['PHONE_COUNTRY_NOT_SUPPORTED', 400, 'We cannot verify numbers from this country yet.'],
  ])('%s keeps the user on the number step with a clear message', async (code, status, message) => {
    const api = fakeApi();
    api.startPhoneVerification.mockRejectedValueOnce(apiError(status, code));
    await renderSignedIn(services({ api }));
    await type('Phone number', '300 1234567');
    await press('Send code');
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByLabelText('Verification code')).toBeNull();
  });

  test('a recent request (cooldown) moves on to the code step with the wait shown', async () => {
    const api = fakeApi();
    api.startPhoneVerification.mockRejectedValueOnce(
      apiError(429, 'RATE_LIMITED', { retryAfterSeconds: 42, details: { reason: 'resend_cooldown' } }),
    );
    await renderSignedIn(services({ api }));
    await requestCode();
    expect(screen.getByRole('button', { name: 'Resend code (42s)' })).toBeTruthy();
  });

  test('an already verified number shows the verified state', async () => {
    const api = fakeApi();
    api.phoneVerification.mockResolvedValueOnce({
      verification: phoneVerification({ status: 'verified', phone: '+92••••••4567', verifiedAt: '2026-10-26T12:00:00Z' }),
    });
    await renderSignedIn(services({ api }), () => screen.findByText('+92••••••4567 is verified.'));
    expect(screen.getByRole('button', { name: 'Use a different number' })).toBeTruthy();
  });
});

describe('Verify phone: code step', () => {
  test('verify stays disabled until the full code is entered', async () => {
    await renderSignedIn();
    await requestCode();
    await type('Verification code', '123');
    expect(screen.getByRole('button', { name: 'Verify' }).props.accessibilityState.disabled).toBe(true);
    await type('Verification code', '123456');
    expect(screen.getByRole('button', { name: 'Verify' }).props.accessibilityState.disabled).toBe(false);
  });

  test('a correct code shows the verified state reported by the server and reloads the account', async () => {
    const s = await renderSignedIn();
    await requestCode();
    s.api.status.mockClear();
    await type('Verification code', '123456');
    await press('Verify');
    expect(await screen.findByText('+92••••••4567 is verified.')).toBeTruthy();
    expect(s.api.confirmPhoneVerification).toHaveBeenCalledWith('access-1', '+923001234567', '123456');
    expect(s.api.status).toHaveBeenCalled();
  });

  test('a wrong or expired code shows an error and clears the field', async () => {
    const api = fakeApi();
    api.confirmPhoneVerification.mockRejectedValueOnce(apiError(400, 'OTP_INVALID_OR_EXPIRED'));
    await renderSignedIn(services({ api }));
    await requestCode();
    await type('Verification code', '000000');
    await press('Verify');
    expect(await screen.findByText('That code is incorrect or has expired. Check it, or request a new code.')).toBeTruthy();
    expect(screen.getByLabelText('Verification code').props.value).toBe('');
    expect(screen.queryByText(/is verified/)).toBeNull();
  });

  test('an expired session is refreshed once and the confirmation retried', async () => {
    const api = fakeApi();
    api.confirmPhoneVerification.mockRejectedValueOnce(apiError(401, 'INVALID_TOKEN'));
    await renderSignedIn(services({ api }));
    await requestCode();
    await type('Verification code', '123456');
    await press('Verify');
    expect(await screen.findByText('+92••••••4567 is verified.')).toBeTruthy();
    expect(api.refresh).toHaveBeenCalledTimes(1);
    expect(api.confirmPhoneVerification).toHaveBeenLastCalledWith('access-2', '+923001234567', '123456');
  });

  test('resend waits for the server cooldown', async () => {
    await renderSignedIn();
    await requestCode();
    const resend = screen.getByRole('button', { name: /Resend code \(\d+s\)/ });
    expect(resend.props.accessibilityState.disabled).toBe(true);
  });

  test('resend after the cooldown asks the server again', async () => {
    const api = fakeApi();
    api.startPhoneVerification.mockResolvedValueOnce({
      verification: phoneVerification({ status: 'pending', pendingPhone: '+92••••••4567', resendAvailableAt: null }),
      codeSent: true,
      message: 'm',
    });
    await renderSignedIn(services({ api }));
    await requestCode();
    await press('Resend code');
    expect(await screen.findByText('If the number can receive text messages, a new code is on its way.')).toBeTruthy();
    expect(api.resendPhoneVerification).toHaveBeenCalledWith('access-1');
  });

  test('a rate-limited resend explains the wait', async () => {
    const api = fakeApi();
    api.startPhoneVerification.mockResolvedValueOnce({
      verification: phoneVerification({ status: 'pending', resendAvailableAt: null }),
      codeSent: true,
      message: 'm',
    });
    api.resendPhoneVerification.mockRejectedValueOnce(apiError(429, 'RATE_LIMITED', { retryAfterSeconds: 600 }));
    await renderSignedIn(services({ api }));
    await requestCode();
    await press('Resend code');
    expect(await screen.findByText('Too many attempts. Try again in about 10 minutes.')).toBeTruthy();
  });

  test('change number returns to the number step', async () => {
    await renderSignedIn();
    await requestCode();
    await press('Change number');
    expect(await screen.findByLabelText('Phone number')).toBeTruthy();
  });

  test('the code never reaches the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => undefined));
    const api = fakeApi();
    api.confirmPhoneVerification.mockRejectedValueOnce(apiError(400, 'OTP_INVALID_OR_EXPIRED'));
    await renderSignedIn(services({ api }));
    await requestCode();
    await type('Verification code', '864209');
    await press('Verify');
    await screen.findByText(/incorrect or has expired/);
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain('864209');
      spy.mockRestore();
    }
  });
});

test('the screen never marks a number verified on its own', async () => {
  const api = fakeApi();
  // The server answers but does not report "verified".
  api.confirmPhoneVerification.mockResolvedValueOnce({ verification: phoneVerification({ status: 'pending' }) });
  await renderSignedIn(services({ api }));
  await requestCode();
  await type('Verification code', '123456');
  await press('Verify');
  await waitFor(() => expect(api.confirmPhoneVerification).toHaveBeenCalled());
  expect(screen.queryByText(/is verified/)).toBeNull();
});
