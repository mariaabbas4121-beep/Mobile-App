import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AuthProvider } from '../context/AuthContext';
import SignupScreen from '../app/auth/signup';
import LoginScreen from '../app/auth/login';
import CheckEmailScreen from '../app/auth/check-email';
import { apiError, fakeApi, fakeGoogle, services } from './support/fakes';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = {};
});

async function renderWith(element: React.ReactElement, s = services()) {
  await render(<AuthProvider services={s.asServices}>{element}</AuthProvider>);
  return s;
}

const type = async (label: string, text: string) => fireEvent.changeText(screen.getByLabelText(label), text);

async function fillSignup(overrides: Partial<Record<'name' | 'email' | 'password' | 'confirm', string>> = {}) {
  await type('Full name', overrides.name ?? 'Sara Khan');
  await type('Email', overrides.email ?? 'Sara@Example.com');
  await type('Password', overrides.password ?? 'correct1horse');
  await type('Confirm password', overrides.confirm ?? overrides.password ?? 'correct1horse');
}

describe('Sign-up screen', () => {
  test('shows field errors and does not call the API for invalid input', async () => {
    const s = await renderWith(<SignupScreen />);
    await fillSignup({ email: 'not-an-email', password: 'short', confirm: 'other' });
    await fireEvent.press(screen.getByRole('button', { name: 'Create account' }));

    expect(screen.getByText('Enter a valid email address.')).toBeTruthy();
    expect(screen.getByText(/Use at least 8 characters/)).toBeTruthy();
    expect(screen.getByText('Passwords do not match.')).toBeTruthy();
    expect(s.api.signup).not.toHaveBeenCalled();
  });

  test('the generic 202 goes to "check your inbox" without claiming an email was sent', async () => {
    const s = await renderWith(<SignupScreen />);
    await fillSignup();
    await fireEvent.press(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() =>
      expect(mockRouter.replace).toHaveBeenCalledWith({
        pathname: '/auth/check-email',
        params: { email: 'sara@example.com', reason: 'signup' },
      }),
    );
    expect(s.api.signup).toHaveBeenCalledWith({ email: 'sara@example.com', password: 'correct1horse', displayName: 'Sara Khan' });
  });

  test('a double tap sends one signup request', async () => {
    const api = fakeApi();
    let release: () => void = () => undefined;
    api.signup.mockImplementation(() => new Promise((r) => (release = () => r({ emailConfirmationRequired: true, message: 'g' }))));
    await renderWith(<SignupScreen />, services({ api }));
    await fillSignup();
    const button = screen.getByRole('button', { name: 'Create account' });
    await fireEvent.press(button);
    await fireEvent.press(button);
    await fireEvent.press(button);
    release();
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalled());
    expect(api.signup).toHaveBeenCalledTimes(1);
  });

  test('backend field errors are shown on the matching field', async () => {
    const api = fakeApi();
    api.signup.mockRejectedValueOnce(
      apiError(400, 'VALIDATION_ERROR', { details: [{ field: 'email', message: 'must be a valid email address' }] }),
    );
    await renderWith(<SignupScreen />, services({ api }));
    await fillSignup({ email: 'odd@example.c' });
    await fireEvent.press(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Must be a valid email address.')).toBeTruthy();
  });

  test('rate limiting is explained with the wait time', async () => {
    const api = fakeApi();
    api.signup.mockRejectedValueOnce(apiError(429, 'RATE_LIMITED', { retryAfterSeconds: 30 }));
    await renderWith(<SignupScreen />, services({ api }));
    await fillSignup();
    await fireEvent.press(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Too many attempts. Try again in 30 seconds.')).toBeTruthy();
  });
});

describe('Sign-in screen', () => {
  async function submit(email = 'sara@example.com', password = 'pw') {
    await type('Email', email);
    await type('Password', password);
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
  }

  test('invalid credentials show one generic message and clear the password', async () => {
    const api = fakeApi();
    api.login.mockRejectedValueOnce(apiError(401, 'INVALID_CREDENTIALS'));
    await renderWith(<LoginScreen />, services({ api }));
    await submit();
    expect(await screen.findByText('Incorrect email or password.')).toBeTruthy();
    expect(screen.getByLabelText('Password').props.value).toBe('');
  });

  test('an unconfirmed email goes to the confirmation screen', async () => {
    const api = fakeApi();
    api.login.mockRejectedValueOnce(apiError(403, 'EMAIL_NOT_CONFIRMED'));
    await renderWith(<LoginScreen />, services({ api }));
    await submit(' Sara@Example.com ');
    await waitFor(() =>
      expect(mockRouter.push).toHaveBeenCalledWith({
        pathname: '/auth/check-email',
        params: { email: 'sara@example.com', reason: 'unconfirmed' },
      }),
    );
  });

  test.each([
    ['NETWORK_ERROR', 0, 'Could not reach NeighborShare. Check your connection and try again.'],
    ['AUTH_UNAVAILABLE', 503, 'NeighborShare is temporarily unavailable. Please try again shortly.'],
    ['INTERNAL_ERROR', 500, 'Something went wrong. Please try again.'],
  ])('%s shows a safe message', async (code, status, message) => {
    const api = fakeApi();
    api.login.mockRejectedValueOnce(apiError(status, code));
    await renderWith(<LoginScreen />, services({ api }));
    await submit();
    expect(await screen.findByText(message)).toBeTruthy();
  });

  test('Google sign-in reports a missing configuration instead of opening a browser', async () => {
    const google = fakeGoogle({ isConfigured: jest.fn(() => false) });
    await renderWith(<LoginScreen />, services({ google }));
    await fireEvent.press(screen.getByRole('button', { name: 'Continue with Google' }));
    expect(await screen.findByText('Google sign-in is not set up in this build of the app.')).toBeTruthy();
    expect(google.signIn).not.toHaveBeenCalled();
  });

  test('a cancelled Google sign-in shows no error', async () => {
    const google = fakeGoogle({ signIn: jest.fn(async () => ({ type: 'cancelled' })) });
    await renderWith(<LoginScreen />, services({ google }));
    await fireEvent.press(screen.getByRole('button', { name: 'Continue with Google' }));
    await waitFor(() => expect(google.signIn).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Check-email screen', () => {
  test('resend uses the generic wording and then starts a cooldown', async () => {
    mockParams = { email: 'sara@example.com', reason: 'signup' };
    const s = await renderWith(<CheckEmailScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'Resend confirmation link' }));
    expect(await screen.findByText('If this address is waiting for confirmation, a new link is on its way.')).toBeTruthy();
    expect(s.api.resendConfirmation).toHaveBeenCalledWith('sara@example.com');
    expect(screen.getByRole('button', { name: /Resend link \(\d+s\)/ })).toBeTruthy();
  });

  test('a rate-limited resend explains the wait', async () => {
    mockParams = { email: 'sara@example.com' };
    const api = fakeApi();
    api.resendConfirmation.mockRejectedValueOnce(apiError(429, 'RATE_LIMITED', { retryAfterSeconds: 600 }));
    await renderWith(<CheckEmailScreen />, services({ api }));
    await fireEvent.press(screen.getByRole('button', { name: 'Resend confirmation link' }));
    expect(await screen.findByText('Too many attempts. Try again in about 10 minutes.')).toBeTruthy();
  });

  test('an invalid email parameter hides resend', async () => {
    mockParams = { email: 'not-an-email' };
    await renderWith(<CheckEmailScreen />);
    expect(screen.queryByRole('button', { name: 'Resend confirmation link' })).toBeNull();
  });
});
