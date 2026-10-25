// Uses the SDK's own error classes, constructed the way auth-js builds them
// from an API response.
import { describe, expect, test } from 'vitest';
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError, AuthWeakPasswordError } from '@supabase/supabase-js';
import { pino } from 'pino';
import { mapAuthError } from '../../src/auth/auth.errors.js';
import { AppError } from '../../src/lib/errors.js';
import { silentLogger } from '../helpers.js';

const api = (code: string, status: number) => new AuthApiError('provider message with user@example.test', status, code);

describe('mapAuthError', () => {
  test.each([
    ['invalid_credentials', 400, 'login', 401, 'INVALID_CREDENTIALS'],
    ['email_not_confirmed', 400, 'login', 403, 'EMAIL_NOT_CONFIRMED'],
    ['user_banned', 400, 'login', 403, 'ACCOUNT_BLOCKED'],
    ['user_already_exists', 422, 'signup', 409, 'EMAIL_ALREADY_REGISTERED'],
    ['signup_disabled', 422, 'signup', 403, 'SIGNUP_DISABLED'],
    ['email_address_invalid', 400, 'signup', 400, 'INVALID_EMAIL'],
    ['over_email_send_rate_limit', 429, 'signup', 429, 'RATE_LIMITED'],
    ['over_request_rate_limit', 429, 'login', 429, 'RATE_LIMITED'],
    ['refresh_token_not_found', 400, 'refresh', 401, 'INVALID_REFRESH_TOKEN'],
    ['refresh_token_already_used', 400, 'refresh', 401, 'INVALID_REFRESH_TOKEN'],
    ['session_not_found', 403, 'get_user', 401, 'INVALID_TOKEN'],
    ['bad_jwt', 403, 'get_user', 401, 'INVALID_TOKEN'],
    ['user_not_found', 403, 'get_user', 401, 'INVALID_TOKEN'],
    ['email_address_not_authorized', 400, 'signup', 503, 'EMAIL_DELIVERY_UNAVAILABLE'],
    ['unexpected_failure', 500, 'login', 503, 'AUTH_UNAVAILABLE'],
    ['some_new_code', 400, 'login', 502, 'AUTH_PROVIDER_ERROR'],
  ] as const)('%s (%i) during %s -> %i %s', (code, status, op, expectedStatus, expectedCode) => {
    const mapped = mapAuthError(api(code, status), op, silentLogger);
    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped.status).toBe(expectedStatus);
    expect(mapped.code).toBe(expectedCode);
    expect(mapped.message).not.toContain('user@example.test');
  });

  test('an unknown 401/403 from getUser is treated as an invalid token', () => {
    expect(mapAuthError(api('something', 401), 'get_user', silentLogger).code).toBe('INVALID_TOKEN');
  });

  // Observed live: getUser and signOut on a signed-out session return this.
  test.each([
    ['get_user', 'INVALID_TOKEN'],
    ['logout', 'INVALID_TOKEN'],
    ['refresh', 'INVALID_REFRESH_TOKEN'],
  ] as const)('a missing session during %s maps to 401 %s', (op, code) => {
    const mapped = mapAuthError(new AuthSessionMissingError(), op, silentLogger);
    expect(mapped.status).toBe(401);
    expect(mapped.code).toBe(code);
  });

  test.each([
    ['signup', 'Error sending confirmation email'],
    ['resend', 'Error sending confirmation email'],
    ['signup', 'SMTP server rejected the message'],
  ] as const)('a Supabase 500 about sending email during %s -> 503 EMAIL_DELIVERY_UNAVAILABLE', (op, message) => {
    const mapped = mapAuthError(new AuthRetryableFetchError(message, 500), op, silentLogger);
    expect(mapped.status).toBe(503);
    expect(mapped.code).toBe('EMAIL_DELIVERY_UNAVAILABLE');
  });

  test('other Supabase 500s, and email-like 500s during login, stay AUTH_UNAVAILABLE', () => {
    expect(mapAuthError(new AuthRetryableFetchError('Database error saving new user', 500), 'signup', silentLogger).code).toBe('AUTH_UNAVAILABLE');
    expect(mapAuthError(new AuthRetryableFetchError('Error sending confirmation email', 500), 'login', silentLogger).code).toBe('AUTH_UNAVAILABLE');
  });

  test('the logged provider message never contains an email address', () => {
    const lines: string[] = [];
    const logger = pino({ level: 'trace' }, { write: (l: string) => void lines.push(l) });
    mapAuthError(new AuthRetryableFetchError('Error sending confirmation email to sara@example.com', 500), 'signup', logger);
    const out = lines.join('\n');
    expect(out).toContain('Error sending confirmation email to [email]');
    expect(out).not.toContain('sara@example.com');
  });

  test('network failures map to 503', () => {
    const mapped = mapAuthError(new AuthRetryableFetchError('fetch failed', 0), 'login', silentLogger);
    expect(mapped.status).toBe(503);
  });

  test('weak passwords return 422 with reasons but no password', () => {
    const mapped = mapAuthError(new AuthWeakPasswordError('weak', 422, ['pwned']), 'signup', silentLogger);
    expect(mapped.status).toBe(422);
    expect(mapped.details).toEqual({ reasons: ['pwned'] });
  });

  test('non-auth errors become a generic 500', () => {
    const mapped = mapAuthError(new TypeError('boom'), 'login', silentLogger);
    expect(mapped.status).toBe(500);
    expect(mapped.message).toBe('Internal server error');
  });
});
