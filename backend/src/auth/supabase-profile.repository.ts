import type { SupabaseClients } from '../config/supabase.js';
import type { Logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';
import type { Profile, ProfileRepository, ProfileUpdate, Verification } from './auth.types.js';

// API field -> column. Only these can be written by a user; the database's
// column grants enforce the same list independently.
const UPDATABLE_COLUMNS: Record<keyof ProfileUpdate, string> = {
  displayName: 'display_name',
  city: 'city',
  neighborhood: 'neighborhood',
  bio: 'bio',
};

const PROFILE_COLUMNS =
  'id, display_name, city, neighborhood, bio, avatar_path, phone_verified_at, profile_completed_at, account_status, created_at, updated_at';
const VERIFICATION_COLUMNS = 'verification_type, status, verified_at, expires_at, status_changed_at';

interface ProfileRow {
  id: string;
  display_name: string | null;
  city: string | null;
  neighborhood: string | null;
  bio: string | null;
  avatar_path: string | null;
  phone_verified_at: string | null;
  profile_completed_at: string | null;
  account_status: Profile['accountStatus'];
  created_at: string;
  updated_at: string;
}

interface VerificationRow {
  verification_type: Verification['type'];
  status: Verification['status'];
  verified_at: string | null;
  expires_at: string | null;
  status_changed_at: string;
}

const toProfile = (r: ProfileRow): Profile => ({
  id: r.id,
  displayName: r.display_name,
  city: r.city,
  neighborhood: r.neighborhood,
  bio: r.bio,
  avatarPath: r.avatar_path,
  phoneVerifiedAt: r.phone_verified_at,
  profileCompletedAt: r.profile_completed_at,
  accountStatus: r.account_status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toVerification = (r: VerificationRow): Verification => ({
  type: r.verification_type,
  status: r.status,
  verifiedAt: r.verified_at,
  expiresAt: r.expires_at,
  statusChangedAt: r.status_changed_at,
});

export function createSupabaseProfileRepository(clients: SupabaseClients, logger: Logger): ProfileRepository {
  const fail = (operation: string, error: { code?: string }) => {
    // PostgREST error codes only; messages can echo query details.
    logger.error({ operation, code: error.code }, 'database query failed');
    return AppError.unavailable('Data service is temporarily unavailable', 'DATABASE_UNAVAILABLE');
  };

  return {
    async getProfile(accessToken, userId) {
      const { data, error } = await clients
        .forUser(accessToken)
        .from('profiles')
        .select(PROFILE_COLUMNS)
        .eq('id', userId)
        .maybeSingle<ProfileRow>();
      if (error) throw fail('get_profile', error);
      return data ? toProfile(data) : null;
    },

    async getVerifications(accessToken, userId) {
      const { data, error } = await clients
        .forUser(accessToken)
        .from('user_verifications')
        .select(VERIFICATION_COLUMNS)
        .eq('user_id', userId)
        .returns<VerificationRow[]>();
      if (error) throw fail('get_verifications', error);
      return (data ?? []).map(toVerification);
    },

    async updateProfile(accessToken, userId, changes) {
      const row: Record<string, string | null> = {};
      for (const [field, column] of Object.entries(UPDATABLE_COLUMNS)) {
        const value = changes[field as keyof ProfileUpdate];
        if (value !== undefined) row[column] = value;
      }
      const { data, error } = await clients
        .forUser(accessToken)
        .from('profiles')
        .update(row)
        .eq('id', userId)
        .select(PROFILE_COLUMNS)
        .maybeSingle<ProfileRow>();
      if (error) {
        if (error.code === '42501') throw AppError.forbidden();
        if (error.code === '23514') throw AppError.badRequest('INVALID_PROFILE', 'Profile values are not accepted');
        throw fail('update_profile', error);
      }
      return data ? toProfile(data) : null;
    },
  };
}
