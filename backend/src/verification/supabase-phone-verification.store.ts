import type { SupabaseClients } from '../config/supabase.js';
import type { Logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';
import type { VerificationStatus } from '../auth/auth.types.js';
import type { PhoneRecord, PhoneVerificationStore } from './phone.types.js';
import { PHONE_VERIFICATION_NOT_CONFIGURED } from './supabase-phone-auth.js';

// Postgres undefined column/function and PostgREST "not in the schema cache":
// the phone verification migration has not been applied to this database.
const SCHEMA_MISSING = new Set(['42703', '42883', 'PGRST202', 'PGRST204']);

interface ProfilePhoneRow {
  phone_e164: string | null;
  phone_verified_at: string | null;
  pending_phone_e164: string | null;
  phone_otp_sent_at: string | null;
}

interface PhoneVerificationRow {
  status: VerificationStatus;
  verified_at: string | null;
}

// Uses the secret key: verification state is writable by the server only
// (clients have no grant on these columns or functions). Callers pass the
// user id from the validated token.
export function createSupabasePhoneVerificationStore(clients: SupabaseClients, logger: Logger): PhoneVerificationStore {
  const fail = (operation: string, error: { code?: string }) => {
    // Codes raised by the phone_verification_* functions.
    if (error.code === 'PV409') {
      return AppError.conflict('NO_PENDING_PHONE_VERIFICATION', 'Request a new code for this number first');
    }
    if (error.code === 'PV403') return AppError.forbidden();
    if (error.code === 'PV404') return new AppError(500, 'PROFILE_MISSING', 'Account profile is unavailable');
    if (error.code && SCHEMA_MISSING.has(error.code)) {
      logger.error(
        { operation, code: error.code },
        'phone verification columns or functions are missing: apply supabase/migrations/20261026120000_phone_verification.sql (npm run db:push)',
      );
      return PHONE_VERIFICATION_NOT_CONFIGURED('database_migration_missing');
    }
    logger.error({ operation, code: error.code }, 'database query failed');
    return AppError.unavailable('Data service is temporarily unavailable', 'DATABASE_UNAVAILABLE');
  };

  const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await clients.admin().rpc(fn, args);
    if (error) throw fail(fn, error);
    return data as T;
  };

  return {
    async get(userId) {
      const db = clients.admin();
      const [profile, verification] = await Promise.all([
        db
          .from('profiles')
          .select('phone_e164, phone_verified_at, pending_phone_e164, phone_otp_sent_at')
          .eq('id', userId)
          .maybeSingle<ProfilePhoneRow>(),
        db
          .from('user_verifications')
          .select('status, verified_at')
          .eq('user_id', userId)
          .eq('verification_type', 'phone')
          .maybeSingle<PhoneVerificationRow>(),
      ]);
      if (profile.error) throw fail('get_phone_profile', profile.error);
      if (verification.error) throw fail('get_phone_verification', verification.error);
      if (!profile.data) throw new AppError(500, 'PROFILE_MISSING', 'Account profile is unavailable');

      const p = profile.data;
      return {
        status: verification.data?.status ?? 'not_started',
        verifiedAt: verification.data?.verified_at ?? null,
        phone: p.phone_e164,
        phoneVerifiedAt: p.phone_verified_at,
        pendingPhone: p.pending_phone_e164,
        otpSentAt: p.phone_otp_sent_at,
      } satisfies PhoneRecord;
    },

    async reserveSend(userId, cooldownSeconds) {
      const remaining = await rpc<number>('phone_verification_begin', {
        p_user_id: userId,
        p_cooldown_seconds: cooldownSeconds,
      });
      return typeof remaining === 'number' ? remaining : 0;
    },

    async releaseSend(userId) {
      await rpc('phone_verification_release', { p_user_id: userId });
    },

    async markPending(userId, phone, resend) {
      await rpc('phone_verification_pending', { p_user_id: userId, p_phone: phone, p_resend: resend });
    },

    async complete(userId, phone, verifiedAt) {
      await rpc('phone_verification_complete', { p_user_id: userId, p_phone: phone, p_verified_at: verifiedAt });
    },

    async recordFailure(userId, reason) {
      await rpc('phone_verification_failed', { p_user_id: userId, p_reason: reason });
    },

    async revoke(userId) {
      await rpc('phone_verification_revoke', { p_user_id: userId });
    },
  };
}
