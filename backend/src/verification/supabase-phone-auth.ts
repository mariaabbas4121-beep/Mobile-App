import { AuthApiError, isAuthError, isAuthRetryableFetchError, type User } from '@supabase/supabase-js';
import type { Config } from '../config/env.js';
import { fetchWithTimeout, type SupabaseClients } from '../config/supabase.js';
import type { Logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';
import { mapAuthError } from '../auth/auth.errors.js';
import { AUTH_OPERATION_DEADLINE_MS, withDeadline } from '../auth/supabase-auth.gateway.js';
import { fromAuthPhone } from './phone.js';
import type { AuthPhoneState, PhoneAuthProvider, PhoneAuthSettings } from './phone.types.js';

type PhoneOperation = 'phone_settings' | 'phone_state' | 'phone_change' | 'phone_verify';

// Auth settings change rarely; re-read them at most once a minute.
export const SETTINGS_CACHE_MS = 60_000;

const UNAVAILABLE = () => AppError.unavailable('Authentication service is temporarily unavailable', 'AUTH_UNAVAILABLE');
// A setup problem rather than an outage: retrying will not help until an
// operator changes the Supabase project. The reason names which setting, and
// reveals nothing the public /auth/v1/settings endpoint does not.
export type PhoneSetupProblem = 'phone_provider_disabled' | 'phone_confirmations_disabled' | 'database_migration_missing';
export const PHONE_VERIFICATION_NOT_CONFIGURED = (reason: PhoneSetupProblem) =>
  new AppError(503, 'PHONE_VERIFICATION_NOT_CONFIGURED', 'Phone verification is not set up on the server', { reason });
const SMS_UNAVAILABLE = () => AppError.unavailable('We could not send a text message right now', 'SMS_DELIVERY_UNAVAILABLE');
export const OTP_INVALID = () =>
  AppError.badRequest('OTP_INVALID_OR_EXPIRED', 'The code is incorrect or has expired');

// Supabase's 5xx messages when its SMS provider fails, e.g. "Error sending
// phone change otp" or a Twilio error.
const SMS_FAILURE = /sms|otp|twilio|messagebird|vonage|textlocal|phone/i;

// Provider messages can contain the number; strip digit runs before logging.
const redact = (text: string) => text.replace(/\+?\d[\d\s-]{5,}\d/g, '[number]').slice(0, 300);

export function toPhoneState(user: User): AuthPhoneState {
  return {
    userId: user.id,
    phone: fromAuthPhone(user.phone),
    phoneConfirmedAt: user.phone ? (user.phone_confirmed_at ?? null) : null,
    pendingPhone: fromAuthPhone(user.new_phone),
  };
}

// Translates Supabase Auth errors from the phone flow into client-safe
// AppErrors. Only codes and statuses are inspected; OTPs and numbers are
// never logged.
export function mapPhoneAuthError(err: unknown, operation: PhoneOperation, logger: Logger): AppError {
  if (err instanceof AppError) return err;

  if (isAuthError(err)) {
    const { code, status } = err;
    switch (code) {
      case 'phone_exists':
        // Only the service sees this; clients get the same answer as for a
        // number that is free, so the endpoint cannot reveal other accounts.
        return AppError.conflict('PHONE_IN_USE', 'Phone number belongs to another account');
      case 'over_sms_send_rate_limit':
      case 'over_request_rate_limit':
        return AppError.rateLimited();
      case 'phone_provider_disabled':
      case 'otp_disabled':
        logger.error({ operation, code }, 'phone verification disabled in Supabase: enable the Phone provider and an SMS provider');
        return PHONE_VERIFICATION_NOT_CONFIGURED('phone_provider_disabled');
      case 'sms_send_failed':
        logger.error({ operation, code }, 'Supabase could not send the SMS: check the SMS provider settings and Auth logs');
        return SMS_UNAVAILABLE();
    }
    if (status === 429) return AppError.rateLimited();

    if (operation === 'phone_verify') {
      // Supabase reports wrong, expired, reused and unknown codes alike
      // (otp_expired, "Token has expired or is invalid").
      if (code === 'otp_expired' || (status !== undefined && status >= 400 && status < 500)) return OTP_INVALID();
    }

    if (operation === 'phone_change') {
      if (code === 'validation_failed') return AppError.badRequest('INVALID_PHONE', 'Phone number is not accepted');
      if (status !== undefined && status >= 500 && SMS_FAILURE.test(err.message)) {
        logger.error(
          { operation, status, providerMessage: redact(err.message) },
          'Supabase could not send the phone change SMS: check the SMS provider settings and Auth logs',
        );
        return SMS_UNAVAILABLE();
      }
    }

    if (isAuthRetryableFetchError(err)) {
      logger.warn({ operation, status }, 'auth provider unavailable');
      return UNAVAILABLE();
    }
  }

  // Token, session and outage handling are shared with the rest of the API.
  return mapAuthError(err, 'get_user', logger);
}

export function createSupabasePhoneAuth(
  clients: SupabaseClients,
  config: Pick<Config, 'supabase'>,
  logger: Logger,
  options: { deadlineMs?: number; fetchImpl?: typeof fetch; now?: () => number } = {},
): PhoneAuthProvider {
  const deadlineMs = options.deadlineMs ?? AUTH_OPERATION_DEADLINE_MS;
  const fetchImpl = options.fetchImpl ?? fetchWithTimeout;
  const now = options.now ?? Date.now;
  const authUrl = `${config.supabase.url}/auth/v1`;
  let settingsCache: { value: PhoneAuthSettings; at: number } | undefined;

  // Supabase Auth's HTTP API, for the one call auth-js only offers on a
  // client holding a stored session (and refresh token), which this
  // stateless server never has.
  async function authRequest(path: string, init: { method: string; accessToken?: string; body?: unknown }): Promise<unknown> {
    const headers: Record<string, string> = {
      apikey: config.supabase.publishableKey,
      'X-Supabase-Api-Version': '2024-01-01',
    };
    if (init.accessToken) headers.Authorization = `Bearer ${init.accessToken}`;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';

    let res: Response;
    try {
      res = await fetchImpl(`${authUrl}${path}`, {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch {
      throw UNAVAILABLE();
    }

    const payload: unknown = await res.json().catch(() => null);
    if (res.ok) return payload;

    const p = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
    const code = typeof p.code === 'string' ? p.code : typeof p.error_code === 'string' ? p.error_code : undefined;
    const message = typeof p.message === 'string' ? p.message : typeof p.msg === 'string' ? p.msg : '';
    throw new AuthApiError(message, res.status, code);
  }

  async function getPhoneState(accessToken: string): Promise<AuthPhoneState> {
    try {
      const { data, error } = await withDeadline(clients.anon().auth.getUser(accessToken), deadlineMs);
      if (error) throw error;
      return toPhoneState(data.user);
    } catch (err) {
      throw mapPhoneAuthError(err, 'phone_state', logger);
    }
  }

  return {
    async getSettings() {
      if (settingsCache && now() - settingsCache.at < SETTINGS_CACHE_MS) return settingsCache.value;
      try {
        const s = (await authRequest('/settings', { method: 'GET' })) as {
          external?: { phone?: unknown };
          phone_autoconfirm?: unknown;
        } | null;
        const value: PhoneAuthSettings = {
          phoneEnabled: s?.external?.phone === true,
          // Anything other than an explicit false is treated as unsafe.
          autoconfirm: s?.phone_autoconfirm !== false,
        };
        settingsCache = { value, at: now() };
        return value;
      } catch (err) {
        throw mapPhoneAuthError(err, 'phone_settings', logger);
      }
    },

    getPhoneState,

    async requestPhoneChange(accessToken, phone) {
      try {
        // Authorised by the caller's own token: Auth applies it to that user
        // only, and sends the OTP to the new number.
        const user = (await authRequest('/user', { method: 'PUT', accessToken, body: { phone } })) as User | null;
        if (!user?.id) {
          logger.error({ operation: 'phone_change' }, 'auth provider returned no user');
          throw new AppError(502, 'AUTH_PROVIDER_ERROR', 'Authentication could not be completed');
        }
        return toPhoneState(user);
      } catch (err) {
        throw mapPhoneAuthError(err, 'phone_change', logger);
      }
    },

    async verifyPhoneChange(phone, code) {
      let issuedToken: string | undefined;
      try {
        // A fresh client: the session verifyOtp returns stays in this
        // request's memory and is never shared or refreshed.
        const { data, error } = await withDeadline(
          clients.ephemeral().auth.verifyOtp({ phone, token: code, type: 'phone_change' }),
          deadlineMs,
        );
        if (error) throw error;
        issuedToken = data.session?.access_token;
        if (!data.user?.id) {
          logger.error({ operation: 'phone_verify' }, 'auth provider returned no user');
          throw new AppError(502, 'AUTH_PROVIDER_ERROR', 'Authentication could not be completed');
        }
        return { userId: data.user.id };
      } catch (err) {
        throw mapPhoneAuthError(err, 'phone_verify', logger);
      } finally {
        // Auth signs the user in as a side effect of verifying. That extra
        // session is not the app's (SessionManager owns that); end it.
        if (issuedToken) {
          await withDeadline(clients.anon().auth.admin.signOut(issuedToken, 'local'), deadlineMs)
            .then(({ error }) => {
              if (error) throw error;
            })
            .catch((e: unknown) =>
              logger.warn({ operation: 'phone_verify', code: isAuthError(e) ? e.code : undefined }, 'could not revoke the session issued by phone verification'),
            );
        }
      }
    },
  };
}
