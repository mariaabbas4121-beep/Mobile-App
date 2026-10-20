import type { Request, RequestHandler } from 'express';
import type { AccountStatus, Profile, ProfileRepository } from '../auth/auth.types.js';
import { AppError } from '../lib/errors.js';
import { getAuth } from './auth.middleware.js';

declare module 'express-serve-static-core' {
  interface Request {
    account?: Profile;
  }
}

const REFUSALS: Record<AccountStatus, AppError> = {
  active: AppError.forbidden(),
  restricted: AppError.forbidden('This action is not available while your account is restricted', 'ACCOUNT_RESTRICTED'),
  suspended: AppError.forbidden('Your account is suspended', 'ACCOUNT_SUSPENDED'),
  deletion_pending: AppError.forbidden('Your account is scheduled for deletion', 'ACCOUNT_DELETION_PENDING'),
};

// Refuses callers whose account status is not in `allowed`. Mount after
// requireAuth. The status is read from the database on every request, so a
// suspension takes effect immediately, not at token expiry, and the client
// cannot influence it.
export function requireAccountStatus(profiles: ProfileRepository, allowed: AccountStatus[] = ['active']): RequestHandler {
  return async (req, _res, next) => {
    const { user, accessToken } = getAuth(req);
    const profile = await profiles.getProfile(accessToken, user.id);
    if (!profile) throw new AppError(500, 'PROFILE_MISSING', 'Account profile is unavailable');
    if (!allowed.includes(profile.accountStatus)) throw REFUSALS[profile.accountStatus];
    req.account = profile;
    next();
  };
}

export function getAccount(req: Request): Profile {
  if (!req.account) throw new Error('getAccount called on a route without requireAccountStatus');
  return req.account;
}
