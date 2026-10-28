import type { Config } from '../config/env.js';
import type { Logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';
import { hasAllowedCountryCode, maskPhone } from './phone.js';
import { OTP_INVALID, PHONE_VERIFICATION_NOT_CONFIGURED } from './supabase-phone-auth.js';
import type {
  AuthPhoneState,
  PhoneAuthProvider,
  PhoneFailureReason,
  PhoneRecord,
  PhoneVerificationStore,
  PhoneVerificationView,
} from './phone.types.js';

export type PhoneVerificationPolicy = Config['phoneVerification'];

// The caller, as established by requireAuth.
export interface Caller {
  userId: string;
  accessToken: string;
}

export interface PhoneVerificationService {
  status(caller: Caller): Promise<PhoneVerificationView>;
  // `sent` is false when nothing needed sending (the number is already
  // verified). When true, Supabase accepted the request; delivery itself is
  // not confirmed.
  start(caller: Caller, phone: string): Promise<{ verification: PhoneVerificationView; sent: boolean }>;
  resend(caller: Caller): Promise<{ verification: PhoneVerificationView; sent: boolean }>;
  confirm(caller: Caller, phone: string, code: string): Promise<PhoneVerificationView>;
}

const AUTH_PROVIDER_ERROR = () => new AppError(502, 'AUTH_PROVIDER_ERROR', 'Phone verification could not be completed');
const NO_PENDING = () => AppError.conflict('NO_PENDING_PHONE_VERIFICATION', 'Request a new code for this number first');

// Supabase Auth sends and checks the code; this service decides what the
// database may record. A number becomes `verified` only after Supabase Auth,
// asked with the caller's own token, reports that same user with that number
// confirmed, and only for a number the user requested a code for here.
export function createPhoneVerificationService(deps: {
  auth: PhoneAuthProvider;
  store: PhoneVerificationStore;
  policy: PhoneVerificationPolicy;
  logger: Logger;
  now?: () => number;
}): PhoneVerificationService {
  const { auth, store, policy, logger } = deps;
  const now = deps.now ?? Date.now;

  const view = (r: PhoneRecord): PhoneVerificationView => {
    const verified = r.status === 'verified';
    const resendAt = r.otpSentAt ? Date.parse(r.otpSentAt) + policy.resendCooldownSeconds * 1000 : NaN;
    return {
      status: r.status,
      verifiedAt: verified ? r.verifiedAt : null,
      phone: verified ? maskPhone(r.phone) : null,
      pendingPhone: maskPhone(r.pendingPhone),
      resendAvailableAt: Number.isFinite(resendAt) && resendAt > now() ? new Date(resendAt).toISOString() : null,
      codeLength: policy.otpLength,
    };
  };

  async function authState(caller: Caller): Promise<AuthPhoneState> {
    const state = await auth.getPhoneState(caller.accessToken);
    if (state.userId !== caller.userId) {
      // Cannot happen with a token requireAuth just validated; fail closed.
      logger.error({ operation: 'phone_state' }, 'auth user does not match the authenticated caller');
      throw AppError.unauthenticated('Access token is invalid or expired', 'INVALID_TOKEN');
    }
    return state;
  }

  const authConfirms = (state: AuthPhoneState, phone: string | null) =>
    phone !== null && state.phone === phone && state.phoneConfirmedAt !== null;

  // A stored result Supabase Auth no longer backs (the user changed number
  // directly in Auth) is withdrawn rather than reported.
  async function reconcile(caller: Caller, record: PhoneRecord, state: AuthPhoneState): Promise<PhoneRecord> {
    if (record.status !== 'verified' || authConfirms(state, record.phone)) return record;
    logger.warn({ operation: 'phone_reconcile' }, 'verified phone no longer confirmed in Supabase Auth; revoking');
    await store.revoke(caller.userId);
    return store.get(caller.userId);
  }

  async function recordFailure(caller: Caller, reason: PhoneFailureReason) {
    await store.recordFailure(caller.userId, reason).catch(() =>
      logger.warn({ operation: 'phone_confirm', reason }, 'could not audit a rejected phone code'),
    );
  }

  async function ensureAvailable() {
    const settings = await auth.getSettings();
    if (!settings.phoneEnabled) {
      logger.error({ operation: 'phone_start' }, 'phone verification needs the Phone provider enabled in Supabase Auth');
      throw PHONE_VERIFICATION_NOT_CONFIGURED('phone_provider_disabled');
    }
    if (settings.autoconfirm) {
      // Supabase would accept any number without an OTP, which would make
      // "verified" meaningless.
      logger.error({ operation: 'phone_start' }, 'phone confirmations are off in Supabase Auth; refusing to verify phones');
      throw PHONE_VERIFICATION_NOT_CONFIGURED('phone_confirmations_disabled');
    }
  }

  async function send(caller: Caller, phone: string, resend: boolean) {
    if (!hasAllowedCountryCode(phone, policy.allowedCountryCodes)) {
      throw AppError.badRequest('PHONE_COUNTRY_NOT_SUPPORTED', 'Numbers from this country cannot be verified yet');
    }
    await ensureAvailable();
    const state = await authState(caller);
    const record = await reconcile(caller, await store.get(caller.userId), state);

    if (authConfirms(state, phone)) {
      // Auth already has this number confirmed for the user, so Supabase
      // would send nothing.
      if (record.status === 'verified' && record.phone === phone) return { verification: view(record), sent: false };
      if (record.pendingPhone === phone) {
        // A code requested here was accepted by Auth, but the database
        // update was lost (e.g. the earlier confirmation failed midway).
        await store.complete(caller.userId, phone, state.phoneConfirmedAt as string);
        return { verification: view(await store.get(caller.userId)), sent: false };
      }
      throw AppError.conflict(
        'PHONE_ALREADY_ON_ACCOUNT',
        'This number is already on your account but was not verified in NeighborShare. Use a different number or contact support.',
      );
    }

    // One send per cooldown, shared by every API instance: a double tap or a
    // second device waits instead of triggering a second SMS.
    const wait = await store.reserveSend(caller.userId, policy.resendCooldownSeconds);
    if (wait > 0) {
      throw AppError.rateLimited('Please wait before requesting another code', wait, { reason: 'resend_cooldown' });
    }

    let result: AuthPhoneState | null;
    try {
      result = await auth.requestPhoneChange(caller.accessToken, phone);
    } catch (err) {
      if (err instanceof AppError && err.code === 'PHONE_IN_USE') {
        // Another account has this number. Answer exactly as for a free
        // number (no SMS is sent; confirming will fail like a wrong code), so
        // the endpoint cannot be used to find out whose number it is.
        result = null;
      } else {
        await store.releaseSend(caller.userId).catch(() => undefined);
        throw err;
      }
    }

    if (result && (result.userId !== caller.userId || result.pendingPhone !== phone)) {
      await store.releaseSend(caller.userId).catch(() => undefined);
      if (result.userId === caller.userId && result.phone === phone) {
        logger.error({ operation: 'phone_start' }, 'Supabase changed the phone without an OTP: turn on phone confirmations');
        throw PHONE_VERIFICATION_NOT_CONFIGURED('phone_confirmations_disabled');
      }
      logger.error({ operation: 'phone_start' }, 'Supabase did not record the requested phone change');
      throw AUTH_PROVIDER_ERROR();
    }

    await store.markPending(caller.userId, phone, resend);
    return { verification: view(await store.get(caller.userId)), sent: true };
  }

  return {
    async status(caller) {
      const [state, record] = await Promise.all([authState(caller), store.get(caller.userId)]);
      return view(await reconcile(caller, record, state));
    },

    start: (caller, phone) => send(caller, phone, false),

    async resend(caller) {
      const record = await store.get(caller.userId);
      if (!record.pendingPhone) throw NO_PENDING();
      return send(caller, record.pendingPhone, true);
    },

    async confirm(caller, phone, code) {
      const state = await authState(caller);
      const record = await reconcile(caller, await store.get(caller.userId), state);

      if (record.pendingPhone !== phone) {
        // A repeat of a confirmation that already succeeded.
        if (record.status === 'verified' && record.phone === phone && authConfirms(state, phone)) return view(record);
        throw NO_PENDING();
      }

      if (authConfirms(state, phone) && state.pendingPhone !== phone) {
        // Auth already applied the code (an earlier attempt whose database
        // update failed); the code itself is spent.
        await store.complete(caller.userId, phone, state.phoneConfirmedAt as string);
        return view(await store.get(caller.userId));
      }

      if (state.pendingPhone !== phone) {
        // Auth is not waiting for this number from this user (superseded, or
        // it belongs to another account): same answer as a wrong code.
        await recordFailure(caller, 'auth_state_mismatch');
        throw OTP_INVALID();
      }

      let verifiedUserId: string;
      try {
        ({ userId: verifiedUserId } = await auth.verifyPhoneChange(phone, code));
      } catch (err) {
        if (err instanceof AppError && err.code === 'OTP_INVALID_OR_EXPIRED') await recordFailure(caller, 'invalid_or_expired_code');
        throw err;
      }

      if (verifiedUserId !== caller.userId) {
        // Auth matched the code to another account waiting for the same
        // number. Nothing is recorded for this caller.
        logger.error({ operation: 'phone_confirm' }, 'phone code was applied to a different account');
        await recordFailure(caller, 'account_mismatch');
        throw OTP_INVALID();
      }

      // Independent check with the caller's own token before writing.
      const after = await authState(caller);
      if (!authConfirms(after, phone)) {
        logger.error({ operation: 'phone_confirm' }, 'Supabase Auth does not report the phone as confirmed after verification');
        await recordFailure(caller, 'auth_state_mismatch');
        throw AUTH_PROVIDER_ERROR();
      }

      await store.complete(caller.userId, phone, after.phoneConfirmedAt as string);
      return view(await store.get(caller.userId));
    },
  };
}

// Used when the server has no phone verification wiring (e.g. tests that do
// not exercise it): every call reports the missing configuration.
export function unconfiguredPhoneVerification(): PhoneVerificationService {
  const fail = async (): Promise<never> => {
    throw AppError.unavailable('This feature is not configured on the server', 'SERVER_NOT_CONFIGURED');
  };
  return { status: fail, start: fail, resend: fail, confirm: fail };
}
