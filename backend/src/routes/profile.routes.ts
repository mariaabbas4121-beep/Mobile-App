import { Router } from 'express';
import type { AuthGateway, ProfileRepository } from '../auth/auth.types.js';
import { profileUpdateBody, type ProfileUpdateBody } from '../auth/auth.schemas.js';
import { AppError } from '../lib/errors.js';
import { getAuth, requireAuth } from '../middleware/auth.middleware.js';
import { requireAccountStatus } from '../middleware/account-status.middleware.js';
import { validateBody } from '../middleware/validate.middleware.js';

export interface ProfileRouteDeps {
  gateway: AuthGateway;
  profiles: ProfileRepository;
}

export function profileRoutes({ gateway, profiles }: ProfileRouteDeps) {
  const router = Router();

  // Suspended and deletion-pending accounts cannot edit. The same rule is
  // enforced again by the database's Row-Level Security policy.
  router.patch(
    '/me',
    requireAuth(gateway),
    requireAccountStatus(profiles, ['active', 'restricted']),
    validateBody(profileUpdateBody),
    async (req, res) => {
      const { user, accessToken } = getAuth(req);
      const updated = await profiles.updateProfile(accessToken, user.id, req.body as ProfileUpdateBody);
      // RLS matched no row: the status changed after the check above.
      if (!updated) throw AppError.forbidden();
      res.status(200).json({ success: true, data: { profile: updated } });
    },
  );

  return router;
}
